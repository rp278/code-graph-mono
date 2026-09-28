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
from typing import Any, Optional

BASE_DIR = Path(__file__).resolve().parent.parent  # api/
PIPELINE_DIR = BASE_DIR.parent / "pipeline"  # codegraph/pipeline/
WORKSPACE_ROOT = Path(
    os.environ.get("PIPELINE_WORKSPACE_ROOT", str(BASE_DIR.parent.parent.parent))
)

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
            cached = _runs.get(d.name, {}).get("status")
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
                "run_status": _derive_run_status(state, cached),
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


def _run_turn(slug: str, agent: Any, message: str) -> None:
    try:
        with _runs_lock:
            _runs.setdefault(slug, {})
            _runs[slug]["status"] = "running"
            _runs[slug]["error"] = None
        run = agent.send(message)
        result = run.wait()
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
    except Exception as e:  # noqa: BLE001
        with _runs_lock:
            _runs.setdefault(slug, {})
            _runs[slug]["status"] = "error"
            _runs[slug]["error"] = f"{e}\n{traceback.format_exc()[-2000:]}"
    finally:
        try:
            agent.close()
        except Exception:  # noqa: BLE001
            pass


def start_requirement(requirement_text: str) -> dict[str, Any]:
    api_key = _cursor_api_key()
    if not api_key:
        raise PipelineAgentError(
            "CURSOR_API_KEY is not set in codegraph/api/.env — get one from "
            "https://cursor.com/dashboard/integrations"
        )
    if not requirement_text.strip():
        raise PipelineAgentError("requirement text is empty")

    from cursor_sdk import Agent, LocalAgentOptions

    slug = _unique_slug(_slugify(requirement_text))

    agent = Agent.create(
        api_key=api_key,
        model=_pipeline_model(),
        local=LocalAgentOptions(cwd=str(WORKSPACE_ROOT)),
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

    agent = Agent.resume(agent_id, AgentOptions(api_key=api_key))

    with _runs_lock:
        _runs[slug] = {"status": "starting", "error": None}

    thread = threading.Thread(target=_run_turn, args=(slug, agent, message), daemon=True)
    thread.start()

    return {"slug": slug, "agent_id": agent_id, "status": "starting"}
