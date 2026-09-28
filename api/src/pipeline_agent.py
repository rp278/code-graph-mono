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
    tell us (a running agent hasn't written anything new yet)."""
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
                "run_status": _derive_run_status(state, cached.get("status")),
                "live_status": cached.get("live_status"),
            }
        )
    return out


def get_requirement(slug: str) -> dict[str, Any]:
    state = _read_state(slug)
    with _runs_lock:
        cached = _runs.get(slug, {})
    return {
        "slug": slug,
        "state": state,
        "run_status": _derive_run_status(state, cached.get("status")),
        "error": cached.get("error"),
        "live_status": cached.get("live_status"),
    }


def _headless_prompt(requirement_text: str, slug: str) -> str:
    return (
        "HEADLESS_MODE: true\n\n"
        "Run the `requirement-pipeline` skill "
        "(.cursor/skills/requirement-pipeline/SKILL.md) for the following "
        f"free-text requirement. Use slug `{slug}` exactly — it has "
        "already been reserved and a bootstrap state.json created for it "
        f"at codegraph/pipeline/{slug}/state.json with an `agent_id` field "
        "already set; preserve that field whenever you update the file, "
        "do not overwrite or remove it.\n\n"
        "You are running headlessly via the Cursor SDK, not in an "
        "interactive chat — there is no one to answer AskQuestion. Follow "
        ".cursor/rules/pipeline-gates.mdc's \"Headless mode\" section for "
        "every gate instead: write a `pending_gate` marker into this "
        "story's entry in state.json and end your turn, rather than "
        "asking a question and waiting.\n\n"
        f"Requirement:\n{requirement_text}"
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
    """Run one turn and update the in-memory status cache.

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
    try:
        with _runs_lock:
            _runs.setdefault(slug, {})
            _runs[slug]["status"] = "running"
            _runs[slug]["error"] = None
        _set_live_status(slug, "Starting…")
        run = agent.send(message)
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
        if getattr(result, "status", None) == "error":
            with _runs_lock:
                _runs[slug]["status"] = "error"
                _runs[slug]["error"] = f"agent run finished with status=error (run id {result.id})"
            return
        try:
            state = _read_state(slug)
            derived = _derive_run_status(state, None)
        except PipelineAgentError:
            derived = "error"
        with _runs_lock:
            _runs[slug]["status"] = derived
        done = derived == "done"
    except Exception as e:  # noqa: BLE001
        _set_live_status(slug, None)
        with _runs_lock:
            _runs.setdefault(slug, {})
            _runs[slug]["status"] = "error"
            _runs[slug]["error"] = f"{e}\n{traceback.format_exc()[-2000:]}"
    finally:
        if done:
            try:
                agent.close()
            except Exception:  # noqa: BLE001
                pass


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


def start_requirement(requirement_text: str) -> dict[str, Any]:
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

    # Bootstrap state.json *before* kicking off the agent, so agent_id is
    # recoverable even if the very first turn crashes or this process
    # restarts mid-run.
    _write_state(
        slug,
        {
            "requirement": requirement_text,
            "slug": slug,
            "agent_id": agent_id,
            "notes": [f"Started via dashboard (Cursor SDK, local runtime) at {_now()}."],
            "stories": {},
        },
    )

    with _runs_lock:
        _runs[slug] = {"status": "starting", "error": None}

    prompt = _headless_prompt(requirement_text, slug)
    thread = threading.Thread(target=_run_turn, args=(slug, agent, prompt), daemon=True)
    thread.start()

    return {"slug": slug, "agent_id": agent_id, "status": "starting"}


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

    with _runs_lock:
        current = _runs.get(slug, {}).get("status")
    if current == "running":
        raise PipelineAgentError(f"'{slug}' is already mid-turn — wait for it to finish")

    from cursor_sdk import Agent, AgentOptions

    agent = Agent.resume(
        agent_id,
        AgentOptions(
            api_key=api_key,
            model=_pipeline_model(),
            local=_local_agent_options(),
        ),
    )

    with _runs_lock:
        _runs[slug] = {"status": "starting", "error": None}

    thread = threading.Thread(target=_run_turn, args=(slug, agent, message), daemon=True)
    thread.start()

    return {"slug": slug, "agent_id": agent_id, "status": "starting"}
