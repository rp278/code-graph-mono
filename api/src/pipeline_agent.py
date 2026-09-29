"""SDK-driven requirement-pipeline runs, launched from the dashboard.

Lets the "Requirements" tab in the React dashboard start and drive the
workspace's `requirement-pipeline` skill without anyone typing into a
Cursor chat — the skill runs headlessly via the Cursor SDK
(`cursor-sdk`, local runtime) instead, on the same machine/checkouts
this API server runs on.

Gate approval still works the same way conceptually — the skill still
enforces every one of the 5 mandatory gates (see
.cursor/rules/pipeline-gates.mdc) — it just can't call `AskQuestion`
headlessly. Instead (see that file's "Headless mode" section), the
agent writes a `pending_gate` marker into the story's entry in
`codegraph/pipeline/<slug>/state.json` and stops; approving/revising
from the dashboard resumes the same agent conversation with a message
describing the decision, exactly like typing a reply in chat would.

`state.json` is the single canonical file per run (DESIGN.md §10.2b) —
this module reads it directly for status, and additionally records
`agent_id` in it so a run can be resumed even after this API process
restarts (Agent.resume works across process boundaries; the in-memory
`_runs` registry is only a same-process optimization/cache, not the
source of truth).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import threading
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Optional

BASE_DIR = Path(__file__).resolve().parent.parent  # api/
PIPELINE_DIR = BASE_DIR.parent / "pipeline"  # codegraph/pipeline/
WORKSPACE_ROOT = Path(
    os.environ.get("PIPELINE_WORKSPACE_ROOT", str(BASE_DIR.parent.parent.parent))
)

# Local-runtime agents are ephemeral (in-memory only) *unless* a
# LocalAgentStoreConfig is passed -- and it must be the *same* one on
# every Agent.create() and Agent.resume() call, or the agent is
# unrecoverable the moment this process restarts (each restart got a
# fresh in-memory store with nothing in it -> AgentNotFoundError on
# every /respond, even though the close-agent bug fix was correct).
# See cursor_sdk's JsonlLocalAgentStore docstring: "Pass the same
# instance ... on Agent.create, Agent.resume, and local list/get APIs."
AGENT_STORE_DIR = BASE_DIR / ".agent-store"

# Read lazily (not cached at import time): main.py calls load_dotenv()
# to populate os.environ from .env, and this module must see that value
# regardless of exactly when it happened to be imported relative to that
# call. A module-level `CURSOR_API_KEY = os.environ.get(...)` constant
# would silently freeze at "" if this module is ever imported first.
def _cursor_api_key() -> str:
    return os.environ.get("CURSOR_API_KEY", "")


def _pipeline_model() -> str:
    return os.environ.get("PIPELINE_MODEL", "auto")

# Same-process cache of in-flight run status, keyed by slug. Not the
# source of truth (state.json + agent_id is) — just avoids re-reading
# disk on every poll and avoids double-starting a thread for the same
# slug while one is already running.
_runs: dict[str, dict[str, Any]] = {}
_runs_lock = threading.Lock()


class PipelineAgentError(Exception):
    """Raised for pipeline-agent-specific failures (config, not-found)."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _slugify(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return (s[:40].rstrip("-")) or "requirement"


def _unique_slug(base: str) -> str:
    slug = base
    n = 2
    while (PIPELINE_DIR / slug).exists():
        slug = f"{base}-{n}"
        n += 1
    return slug


def _state_file(slug: str) -> Path:
    return PIPELINE_DIR / slug / "state.json"


def _read_state(slug: str) -> dict[str, Any]:
    f = _state_file(slug)
    if not f.exists():
        raise PipelineAgentError(f"no such requirement run: '{slug}'")
    return json.loads(f.read_text())


def _write_state(slug: str, state: dict[str, Any]) -> None:
    f = _state_file(slug)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(state, indent=2) + "\n")


def _derive_run_status(state: dict[str, Any], cached: Optional[str]) -> str:
    """Best-effort status derived from state.json content, falling back
    to the in-memory cache (e.g. "running") when the file alone can't
    tell us (a running agent hasn't written anything new yet).

    IMPORTANT: "running"/"starting" from the cache must win over
    whatever's on disk. state.json's `pending_gate` for the *previous*
    gate is still sitting there the entire time the current turn is
    in flight (the agent only clears/rewrites it once this turn
    finishes) -- so checking pending_gate first made every in-progress
    turn report as "waiting_approval" the whole time it was running.
    That let the dashboard re-enable Approve/Revise mid-turn, so a
    second click (or an auto-retry) would hit the real "already
    mid-turn" 400 guard in respond_to_requirement -- confusing/looks
    like repeated errors even though nothing was actually broken.
    """
    if cached in ("running", "starting", "paused"):
        return cached
    stories = state.get("stories", {})
    if any(s.get("pending_gate") for s in stories.values()):
        return "waiting_approval"
    if stories and all(s.get("stage") == "done" for s in stories.values()):
        return "done"
    if any(s.get("merge_status") == "merged" for s in stories.values()) and all(
        s.get("stage") in ("done", "7-merge-pending") for s in stories.values()
    ):
        return "waiting_approval"  # merged but not yet marked done — needs a look
    return cached or "idle"


def list_requirements() -> list[dict[str, Any]]:
    """One summary row per codegraph/pipeline/<slug>/state.json."""
    out: list[dict[str, Any]] = []
    if not PIPELINE_DIR.exists():
        return out
    for d in sorted(PIPELINE_DIR.iterdir()):
        if not d.is_dir():
            continue
        f = d / "state.json"
        if not f.exists():
            continue
        try:
            state = json.loads(f.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        with _runs_lock:
            cached = _runs.get(d.name, {})
        out.append(
            {
                "slug": d.name,
                "requirement": state.get("requirement"),
                "stories": {
                    repo: {
                        "stage": s.get("stage"),
                        "gates": s.get("gates"),
                        "pending_gate": s.get("pending_gate"),
                        "pr_url": s.get("pr_url"),
                        "merge_status": s.get("merge_status"),
                    }
                    for repo, s in state.get("stories", {}).items()
                },
                "kind": state.get("kind") or "feature",
                "run_status": _derive_run_status(state, cached.get("status")),
                "live_status": cached.get("live_status"),
            }
        )
    return out


_GATE_RESPONSE_RE = re.compile(
    r"^\s*gate\s+(\S+)\s+for\s+(\S+?):\s*(approved|revise)\b", re.IGNORECASE
)


def _parse_gate_response(message: str, state: dict[str, Any]) -> Optional[dict[str, Any]]:
    """If `message` answers a gate that is *currently pending* in state.json
    (e.g. "gate 1_analysis for shop-api: approved"), describe which exact
    presentation of the gate it answers. Anything else (requirement
    changes, answers to stale gates) returns None and is simply forwarded."""
    m = _GATE_RESPONSE_RE.match(message or "")
    if not m:
        return None
    gate, repo, decision = m.group(1), m.group(2), m.group(3).lower()
    pg = ((state.get("stories") or {}).get(repo) or {}).get("pending_gate") or {}
    if pg.get("gate") != gate or not pg.get("presented_at"):
        return None
    return {"repo": repo, "gate": gate, "presented_at": pg["presented_at"], "decision": decision}


def _same_gate(a: dict[str, Any], b: dict[str, Any]) -> bool:
    return (a["repo"], a["gate"], a["presented_at"]) == (b["repo"], b["gate"], b["presented_at"])


def _live_acted(entry: dict[str, Any], state: dict[str, Any]) -> list[dict[str, Any]]:
    """Responses the user already gave whose gate is *still* the pending
    one on disk -- i.e. the agent hasn't processed them yet, so the
    dashboard must not offer that gate for approval again. Once the agent
    clears or replaces the gate, the entry stops matching and drops out."""
    out = []
    for a in entry.get("acted") or []:
        pg = ((state.get("stories") or {}).get(a["repo"]) or {}).get("pending_gate") or {}
        if pg.get("gate") == a["gate"] and pg.get("presented_at") == a["presented_at"]:
            out.append(a)
    return out


def get_requirement(slug: str) -> dict[str, Any]:
    state = _read_state(slug)
    with _runs_lock:
        cached = _runs.get(slug, {})
        acted = _live_acted(cached, state)
        if "acted" in cached:
            cached["acted"] = acted
        queued = [dict(q) for q in (cached.get("queued") or [])]
    return {
        "slug": slug,
        "state": state,
        "run_status": _derive_run_status(state, cached.get("status")),
        "error": cached.get("error"),
        "live_status": cached.get("live_status"),
        # Gate responses given but not yet processed by the agent, and the
        # raw messages still waiting for the agent to be free.
        "acted": acted,
        "queued": queued,
    }


def _clean_repo_hints(repos: Optional[list[str]]) -> list[str]:
    """Normalize user-supplied repo hints: strip, drop blanks/dupes, cap."""
    out: list[str] = []
    for r in repos or []:
        r = (r or "").strip()
        if r and r not in out:
            out.append(r)
    return out[:10]


def _headless_prompt(
    requirement_text: str,
    slug: str,
    kind: str = "feature",
    repo_hints: Optional[list[str]] = None,
    restart: Optional[dict[str, Any]] = None,
) -> str:
    common = (
        "HEADLESS_MODE: true\n\n"
    )
    headless_rule = (
        "You are running headlessly via the Cursor SDK, not in an "
        "interactive chat — there is no one to answer AskQuestion. Follow "
        ".cursor/rules/pipeline-gates.mdc's \"Headless mode\" section for "
        "every gate instead: write a `pending_gate` marker into this "
        "story's entry in state.json and end your turn, rather than "
        "asking a question and waiting.\n\n"
    )
    restart_rule = ""
    if restart:
        old = restart.get("previous_branches") or []
        old_line = (
            "Branches left behind by earlier attempts: "
            + ", ".join(f"`{b}`" for b in old)
            + ". "
            if old
            else "No earlier branch was recorded. "
        )
        restart_rule = (
            f"THIS IS RESTART #{restart['attempt'] - 1} (attempt {restart['attempt']}) "
            "of this run. Every gate was reset and the earlier agent's "
            "context was discarded: start again at Stage 1 / Gate 1 and treat "
            "anything an earlier attempt wrote as untrusted history, not as "
            "evidence. The repos were deliberately NOT cleaned up. "
            + old_line
            + "Do NOT delete, reset, force-push or build on those branches, "
            "and never discard uncommitted changes. Before you create your "
            "story branch, make sure the checkout is on its base branch (if it "
            "is on a leftover `pipeline/...` branch, switch back to the branch "
            "that one was cut from — `git reflog` shows it — and if you cannot "
            "tell which, say so under Open questions at Gate 1). Cut a NEW "
            f"story branch with the suffix `-r{restart['attempt']}` appended to "
            "the usual name, and write fresh artifacts under "
            f"`.pipeline/{slug}/` on it.\n\n"
        )
    state_rule = (
        f"Use slug `{slug}` exactly — it has already been reserved and a "
        f"bootstrap state.json created for it at "
        f"codegraph/pipeline/{slug}/state.json with an `agent_id` field "
        "already set; preserve that field whenever you update the file, "
        "do not overwrite or remove it.\n\n"
    )

    if kind == "bug":
        hints = _clean_repo_hints(repo_hints)
        hint_line = (
            f"Repo hints from the reporter (a starting point, NOT a "
            f"constraint — follow the evidence if it points elsewhere): "
            f"{', '.join(hints)}\n\n"
            if hints
            else             "The reporter gave no repo hints — locate the bug from the "
            "signals in the error text.\n\n"
        )
        graph_rule = (
            "The codeGraph is a helper, not a dependency: query it with a "
            "short timeout, and if it errors, is unreachable, or finds no "
            "matching node, do NOT stop or fail — locate the bug yourself "
            "by searching the code in the workspace repos (see Stage 1 of "
            "the skill) and say in bugfix.md which path you used.\n\n"
        )
        return (
            common
            + "Run the `bug-fix-pipeline` skill "
            "(.cursor/skills/bug-fix-pipeline/SKILL.md) for the bug report "
            "below. This is a bug-fix run, not a new-feature run: its "
            "state.json has `\"kind\": \"bug\"` and its gates are "
            "`1_analysis`, `2_rootcause`, `3_repro`, `4_fix` "
            "(see .cursor/rules/pipeline-bugfix.mdc). Prefer the smallest "
            "change that restores expected behavior, and make no non-test "
            "source changes before Gate 3. The run ends when Gate 4 is "
            "approved, with the PR left open (never merge it).\n\n"
            + state_rule
            + restart_rule
            + headless_rule
            + graph_rule
            + hint_line
            + f"Bug report:\n{requirement_text}"
        )

    return (
        common
        + "Run the `requirement-pipeline` skill "
        "(.cursor/skills/requirement-pipeline/SKILL.md) for the following "
        "free-text requirement. "
        + state_rule
        + restart_rule
        + headless_rule
        + f"Requirement:\n{requirement_text}"
    )


def _tool_arg_hint(args: Any) -> str:
    """Best-effort one-line detail from a tool call's args (a file path,
    shell command, search query, ...) for a live-status line. Tool
    schemas aren't a stable/documented contract, so this is intentionally
    forgiving -- worst case it just returns "" and we fall back to the
    tool name alone."""
    if not isinstance(args, Mapping):
        return ""
    for key in ("path", "file_path", "target_file", "command", "query", "pattern", "url"):
        v = args.get(key)
        if isinstance(v, str) and v:
            return v[:80]
    return ""


def _describe_message(msg: Any) -> Optional[str]:
    """Turn one streamed SDK message into a short human-readable status
    line, or None if it's not worth surfacing. This is what makes the
    dashboard's "live status" possible: rather than blocking silently on
    run.wait() until an entire turn finishes (which can take minutes),
    _run_turn iterates the run's message stream and stashes the latest
    description here on every event."""
    kind = getattr(msg, "type", None)
    if kind == "thinking":
        text = (getattr(msg, "text", "") or "").strip().replace("\n", " ")
        return f"Thinking: {text[:140]}" if text else "Thinking…"
    if kind == "tool_call":
        name = getattr(msg, "name", "") or "tool"
        status = getattr(msg, "status", "")
        hint = _tool_arg_hint(getattr(msg, "args", None))
        suffix = f" — {hint}" if hint else ""
        if status == "completed":
            return f"Finished `{name}`{suffix}"
        if status == "error":
            return f"`{name}` errored{suffix}"
        return f"Running `{name}`{suffix}"
    if kind == "assistant":
        content = getattr(getattr(msg, "message", None), "content", ()) or ()
        for block in content:
            text = getattr(block, "text", None)
            if text and text.strip():
                return text.strip().replace("\n", " ")[:160]
        return None
    if kind == "status":
        text = (getattr(msg, "message", "") or getattr(msg, "status", "") or "").strip()
        return text or None
    return None


def _set_live_status(slug: str, text: Optional[str]) -> None:
    with _runs_lock:
        _runs.setdefault(slug, {})
        _runs[slug]["live_status"] = {"text": text, "at": _now()} if text else None


def _run_turn(slug: str, agent: Any, message: str) -> None:
    """Run a turn, then keep running any responses that were queued while
    it was in flight (one turn per queued message, in order).

    A run is one agent conversation, so turns are strictly serial. When
    the user answers a gate for another repo mid-turn, the answer is
    queued by `respond_to_requirement` and picked up here the moment the
    current turn ends -- atomically with the status change, so a new
    /respond can never sneak in between and start a second, concurrent
    turn on the same agent.
    """
    next_message: Optional[str] = message
    while next_message is not None:
        next_message = _run_one_turn(slug, agent, next_message)


def _drop_pending_responses(slug: str) -> None:
    """Forget queued/acted responses (call with _runs_lock held). Used when
    a run errors or finishes: queued messages would otherwise fire
    against a state they were never meant for, and `acted` markers would
    block the user from retrying."""
    entry = _runs.get(slug)
    if entry:
        entry["queued"] = []
        entry["acted"] = []


def _run_one_turn(slug: str, agent: Any, message: str) -> Optional[str]:
    """Run one turn and update the in-memory status cache. Returns the
    next queued message to send, if any.

    Deliberately does *not* close the agent except when the whole run
    has reached a terminal "done" state. `agent.close()` sends a
    CloseAgent RPC that tears the agent down for good (Agent.resume()
    can never find it again afterwards) -- and a turn ending because
    the skill wrote a `pending_gate` and paused for approval is a
    *normal, expected pause*, not completion. Closing there would
    (and did, before this fix) make every subsequent approve/revise
    click 404 with AgentNotFoundError.
    """
    done = False
    next_message: Optional[str] = None
    try:
        with _runs_lock:
            _runs.setdefault(slug, {})
            _runs[slug]["status"] = "running"
            _runs[slug]["error"] = None
            _runs[slug].pop("pause_requested", None)
        _set_live_status(slug, "Starting…")
        run = agent.send(message)
        with _runs_lock:
            _runs[slug]["run"] = run
            pause_now = bool(_runs[slug].get("pause_requested"))
        if pause_now:
            # Pause was clicked while the turn was still starting up.
            _cancel_run_quietly(run)
        # Iterate the stream ourselves (instead of just run.wait()) so the
        # dashboard has something to show while a turn is in flight --
        # a single turn can easily take minutes across several tool
        # calls. run.wait() below is then effectively free: the stream
        # is already fully drained, so it returns the cached terminal
        # result instead of making a new blocking RPC.
        for msg in run.messages():
            desc = _describe_message(msg)
            if desc:
                _set_live_status(slug, desc)
        result = run.wait()
        _set_live_status(slug, None)
        with _runs_lock:
            was_paused = bool(_runs[slug].pop("pause_requested", False))
            _runs[slug].pop("run", None)
            res_status = getattr(result, "status", None)
            # A pause that lost the race with a turn finishing normally (e.g. it
            # just wrote a pending_gate) is ignored: the run carries on as usual.
            if res_status == "cancelled" or (was_paused and res_status not in ("finished", None)):
                # Paused by the user: not an error, and not "done". Queued
                # responses are kept and are sent after the run is resumed.
                _runs[slug]["status"] = "paused"
                _runs[slug]["error"] = None
                return None
        if getattr(result, "status", None) == "error":
            with _runs_lock:
                dropped = len(_runs[slug].get("queued") or [])
                _runs[slug]["status"] = "error"
                _runs[slug]["error"] = (
                    f"agent run finished with status=error (run id {result.id})"
                    + (f"; {dropped} queued response(s) were discarded — send them again" if dropped else "")
                )
                _drop_pending_responses(slug)
            return None
        try:
            state = _read_state(slug)
            derived = _derive_run_status(state, None)
        except PipelineAgentError:
            derived = "error"
        with _runs_lock:
            queued = _runs[slug].get("queued") or []
            if queued and derived not in ("done", "error"):
                # Hand the next queued response to the same agent. Status is
                # flipped in the same critical section, so the run is never
                # observably idle in between.
                next_message = queued.pop(0)["message"]
                _runs[slug]["status"] = "starting"
            else:
                _runs[slug]["status"] = derived
                if derived in ("done", "error"):
                    _drop_pending_responses(slug)
        done = derived == "done"
    except Exception as e:  # noqa: BLE001
        _set_live_status(slug, None)
        next_message = None
        with _runs_lock:
            _runs.setdefault(slug, {})
            _runs[slug].pop("run", None)
            if _runs[slug].pop("pause_requested", False):
                # Cancelling can make the event stream raise; that is the
                # pause taking effect, not a failure.
                _runs[slug]["status"] = "paused"
                _runs[slug]["error"] = None
                return None
            _runs[slug]["status"] = "error"
            _runs[slug]["error"] = f"{e}\n{traceback.format_exc()[-2000:]}"
            _drop_pending_responses(slug)
    finally:
        if done:
            try:
                agent.close()
            except Exception:  # noqa: BLE001
                pass
    return next_message


def _local_agent_options() -> Any:
    """Build the LocalAgentOptions used for every create/resume call.

    Must be identical (same cwd, same JSONL store rootDir) every time --
    a local-runtime agent with no explicit `store` config is held only
    in this process's memory, so it silently becomes unrecoverable the
    moment the API process restarts (Ctrl-C, crash, code reload, ...):
    every subsequent Agent.resume() 404s with AgentNotFoundError even
    though the agent was never explicitly closed. Pointing `store` at a
    JsonlLocalAgentStore backed by a directory on disk makes agent
    metadata (agents/runs/run_events/checkpoints, as .ndjson files)
    survive process restarts, which is the whole point of persisting
    `agent_id` in state.json in the first place.
    """
    from cursor_sdk import LocalAgentOptions, LocalAgentStoreConfig

    AGENT_STORE_DIR.mkdir(parents=True, exist_ok=True)
    return LocalAgentOptions(
        cwd=str(WORKSPACE_ROOT),
        store=LocalAgentStoreConfig(type="jsonl", root_dir=str(AGENT_STORE_DIR)),
    )


def start_requirement(
    requirement_text: str,
    kind: str = "feature",
    repos: Optional[list[str]] = None,
) -> dict[str, Any]:
    api_key = _cursor_api_key()
    if not api_key:
        raise PipelineAgentError(
            "CURSOR_API_KEY is not set in codegraph/api/.env — get one from "
            "https://cursor.com/dashboard/integrations"
        )
    if not requirement_text.strip():
        raise PipelineAgentError("requirement text is empty")

    from cursor_sdk import Agent

    slug = _unique_slug(_slugify(requirement_text))

    agent = Agent.create(
        api_key=api_key,
        model=_pipeline_model(),
        local=_local_agent_options(),
    )
    agent_id = agent.agent_id

    kind = kind if kind in ("feature", "bug") else "feature"
    repo_hints = _clean_repo_hints(repos) if kind == "bug" else []

    # Bootstrap state.json *before* kicking off the agent, so agent_id is
    # recoverable even if the very first turn crashes or this process
    # restarts mid-run.
    state: dict[str, Any] = {
        "requirement": requirement_text,
        "slug": slug,
        "kind": kind,
        "agent_id": agent_id,
        "notes": [f"Started via dashboard (Cursor SDK, local runtime) at {_now()}."],
        "stories": {},
    }
    if repo_hints:
        state["repo_hints"] = repo_hints
    _write_state(slug, state)

    with _runs_lock:
        _runs[slug] = {"status": "starting", "error": None}

    prompt = _headless_prompt(requirement_text, slug, kind=kind, repo_hints=repo_hints)
    thread = threading.Thread(target=_run_turn, args=(slug, agent, prompt), daemon=True)
    thread.start()

    return {"slug": slug, "agent_id": agent_id, "status": "starting"}


def _cancel_run_quietly(run: Any) -> None:
    """Ask the SDK to cancel a run. An already-finished run raises
    UnsupportedRunOperationError; that just means there is nothing to stop."""
    try:
        run.cancel()
    except Exception:  # noqa: BLE001
        pass


_RESUME_MESSAGE = (
    "The user paused this run while you were working and has now resumed it. "
    "Your last step may have been cut off part-way. Before continuing, re-read "
    "this run's state.json and check the repo (`git status`, `git log`, the "
    "`.pipeline/<slug>/` artifacts) to see what was actually finished, redo "
    "anything half-done, and then carry on from where you were. Gate rules are "
    "unchanged: still stop at each gate for approval, and never merge."
)


def pause_requirement(slug: str) -> dict[str, Any]:
    """Pause a run that is mid-turn by cancelling its in-flight SDK run.

    The agent stops where it is; its conversation, `state.json` and the repos
    are left as they are (a step may be half-finished, and the resume message
    tells the agent to check). Responses queued meanwhile are kept and sent
    after Resume. Idempotent-ish: pausing a run that is not running is refused.
    """
    _read_state(slug)  # raises "no such requirement run" if missing
    with _runs_lock:
        entry = _runs.get(slug) or {}
        if entry.get("status") not in ("running", "starting"):
            raise PipelineAgentError(f"'{slug}' is not running, so there is nothing to pause")
        entry["pause_requested"] = True
        run = entry.get("run")
    _set_live_status(slug, "Pausing…")
    if run is not None:
        # If the turn is still starting up (`run` not created yet), the turn
        # thread sees `pause_requested` and cancels as soon as it has the run.
        _cancel_run_quietly(run)
    return {"slug": slug, "status": "pausing"}


def resume_requirement(slug: str) -> dict[str, Any]:
    """Resume a paused run: same agent, same conversation, with a message
    telling it to re-check what it had finished before the pause."""
    _read_state(slug)
    with _runs_lock:
        status = (_runs.get(slug) or {}).get("status")
    if status != "paused":
        raise PipelineAgentError(f"'{slug}' is not paused")
    return respond_to_requirement(slug, _RESUME_MESSAGE)


_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


def delete_requirement(slug: str) -> dict[str, Any]:
    """Delete a run's record (`codegraph/pipeline/<slug>/`).

    Only the run record goes. The repos are deliberately NOT touched: any
    branch, PR or `.pipeline/<slug>/` files an attempt left behind stay
    where they are. Refused while the run is mid-turn, since an in-flight
    agent can't be stopped and would just recreate state.json. The slug is
    validated and the resolved path must sit directly inside PIPELINE_DIR.
    """
    if not _SLUG_RE.match(slug or ""):
        raise PipelineAgentError(f"no such requirement run: '{slug}'")
    _read_state(slug)  # raises "no such requirement run" if missing
    run_dir = (PIPELINE_DIR / slug).resolve()
    if run_dir.parent != PIPELINE_DIR.resolve():
        raise PipelineAgentError(f"no such requirement run: '{slug}'")
    with _runs_lock:
        cached = _runs.get(slug, {}).get("status")
        if cached in ("running", "starting"):
            raise PipelineAgentError(
                f"'{slug}' is still working -- wait for it to pause at a gate "
                "before deleting it"
            )
        shutil.rmtree(run_dir)
        _runs.pop(slug, None)
    return {"slug": slug, "deleted": True}


def restart_requirement(slug: str) -> dict[str, Any]:
    """Restart a run from scratch, keeping its slug and original report.

    Every gate is cleared and a brand-new agent (fresh context) starts at
    Stage 1. The repos are deliberately NOT cleaned up: the earlier
    attempt's branches, PRs and `.pipeline/<slug>/` files stay where they
    are (recorded under `restarts` in state.json and passed to the new
    agent, which is told to leave them alone and cut a new `-r<N>` branch).
    Refused while the run is mid-turn, since an in-flight agent can't be
    stopped and would keep writing to the repos. The earlier agent is just
    abandoned, not closed: it is idle at a gate and holds nothing.
    """
    api_key = _cursor_api_key()
    if not api_key:
        raise PipelineAgentError(
            "CURSOR_API_KEY is not set in codegraph/api/.env — get one from "
            "https://cursor.com/dashboard/integrations"
        )
    state = _read_state(slug)  # raises "no such requirement run" if missing
    with _runs_lock:
        cached = _runs.get(slug, {}).get("status")
    if cached in ("running", "starting"):
        raise PipelineAgentError(
            f"'{slug}' is still working -- wait for it to pause at a gate "
            "before restarting it"
        )
    text = state.get("requirement") or ""
    if not text.strip():
        raise PipelineAgentError(f"'{slug}' has no stored requirement text to restart")

    kind = state.get("kind") or "feature"
    repo_hints = state.get("repo_hints") or []

    stories = state.get("stories") or {}
    restarts = list(state.get("restarts") or [])
    restarts.append(
        {
            "at": _now(),
            "agent_id": state.get("agent_id"),
            "stories": {
                repo: {
                    "stage": s.get("stage"),
                    "gates": s.get("gates"),
                    "branch": s.get("branch"),
                    "pr_url": s.get("pr_url"),
                }
                for repo, s in stories.items()
            },
        }
    )
    previous_branches: list[str] = []
    for r in restarts:
        for s in r["stories"].values():
            b = s.get("branch")
            if b and b not in previous_branches:
                previous_branches.append(b)
    attempt = len(restarts) + 1

    from cursor_sdk import Agent

    # Create the new agent *before* touching state.json, so a failure here
    # leaves the existing run exactly as it was.
    agent = Agent.create(
        api_key=api_key,
        model=_pipeline_model(),
        local=_local_agent_options(),
    )

    new_state: dict[str, Any] = {
        "requirement": text,
        "slug": slug,
        "kind": kind,
        "agent_id": agent.agent_id,
        "notes": list(state.get("notes") or [])
        + [
            f"Restarted from scratch at {_now()} (attempt {attempt}): all gates "
            "cleared, new agent. Repos were not cleaned up"
            + (f"; earlier branches: {', '.join(previous_branches)}." if previous_branches else ".")
        ],
        "restarts": restarts,
        "stories": {},
    }
    if repo_hints:
        new_state["repo_hints"] = repo_hints
    _write_state(slug, new_state)

    with _runs_lock:
        _runs[slug] = {"status": "starting", "error": None}

    prompt = _headless_prompt(
        text,
        slug,
        kind=kind,
        repo_hints=repo_hints,
        restart={"attempt": attempt, "previous_branches": previous_branches},
    )
    thread = threading.Thread(target=_run_turn, args=(slug, agent, prompt), daemon=True)
    thread.start()

    return {"slug": slug, "agent_id": agent.agent_id, "status": "starting", "attempt": attempt}


def respond_to_requirement(slug: str, message: str) -> dict[str, Any]:
    api_key = _cursor_api_key()
    if not api_key:
        raise PipelineAgentError("CURSOR_API_KEY is not set in codegraph/api/.env")

    state = _read_state(slug)
    agent_id = state.get("agent_id")
    if not agent_id:
        raise PipelineAgentError(
            f"'{slug}' has no recorded agent_id in state.json — it may not "
            "have been started via the dashboard, so it can't be resumed "
            "this way"
        )

    acted = _parse_gate_response(message, state)

    with _runs_lock:
        entry = _runs.setdefault(slug, {})
        entry["acted"] = _live_acted(entry, state)
        if acted and any(_same_gate(a, acted) for a in entry["acted"]):
            raise PipelineAgentError(
                "This gate already has a response that is queued or being "
                "processed — wait for the agent to pick it up"
            )
        if entry.get("status") in ("running", "starting"):
            # The agent is mid-turn (possibly on another repo's story). Turns
            # are strictly serial, so don't reject: queue the response; the
            # running turn loop sends it as soon as the agent is free.
            if acted:
                entry["acted"].append(acted)
            entry.setdefault("queued", []).append({"message": message, "at": _now()})
            return {
                "slug": slug,
                "agent_id": agent_id,
                "status": "queued",
                "queued": len(entry["queued"]),
            }
        # Idle: claim the run *before* the slow Agent.resume() so two
        # near-simultaneous responses can't both start a turn.
        previous = (entry.get("status"), entry.get("error"))
        entry["status"] = "starting"
        entry["error"] = None
        if acted:
            entry["acted"].append(acted)

    try:
        from cursor_sdk import Agent, AgentOptions

        agent = Agent.resume(
            agent_id,
            AgentOptions(
                api_key=api_key,
                model=_pipeline_model(),
                local=_local_agent_options(),
            ),
        )
    except Exception:
        with _runs_lock:
            entry["status"], entry["error"] = previous
            if acted and acted in entry["acted"]:
                entry["acted"].remove(acted)
        raise

    thread = threading.Thread(target=_run_turn, args=(slug, agent, message), daemon=True)
    thread.start()

    return {"slug": slug, "agent_id": agent_id, "status": "starting"}
