"""Ask AI: codebase Q&A powered by a Cursor agent (Cursor SDK, local runtime).

The "Ask AI" screen sends a question here. We answer it with a Cursor
agent:

  * The caller (main.py) pre-fetches a small knowledge-graph subgraph for
    the question and passes it in, so the agent knows *where to look*.
  * The agent can then open the real files to verify and to answer
    questions the graph alone cannot (what a function actually does).
  * It is strictly read-only: the built-in toolset is restricted to
    `read` / `grep` / `glob` / `ls`. It has no shell, edit, write, or
    delete tool at all -- this is enforced by the SDK at agent creation,
    not just requested in the prompt.

One conversation == one Cursor agent, so follow-up questions keep their
context. A turn runs in a background thread; the dashboard polls
`get_ask()` for live progress and the final answer (same pattern as the
requirement pipeline in pipeline_agent.py).

Conversations live in memory for this API process. After a restart, a
follow-up transparently resumes the same agent by its id (the agent
itself is persisted by the JSONL store in pipeline_agent), so only the
short-lived progress state is lost.
"""

from __future__ import annotations

import os
import threading
import traceback
from typing import Any, Optional

from . import pipeline_agent as _pa  # shares the Cursor key, local options and stream helpers

# Hard read-only guarantee (validated by the SDK when the agent is created or
# resumed). Anything not listed -- shell, edit, write, delete, network -- is
# simply not available to this agent.
READ_ONLY_TOOLS = ["read", "grep", "glob", "ls"]

_asks: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()


class AskError(Exception):
    """Raised for Ask-AI-specific failures (config, busy, expired)."""


def _ask_model() -> str:
    # Own setting so Ask AI can use a cheaper/faster model than the
    # pipeline; falls back to "auto" (Cursor picks).
    return os.environ.get("ASK_MODEL", "auto")


def _options(api_key: str) -> Any:
    from cursor_sdk import AgentOptions

    return AgentOptions(
        api_key=api_key,
        model=_ask_model(),
        name="codeGraph Ask AI",
        local=_pa._local_agent_options(),
        tools=READ_ONLY_TOOLS,
    )


def _build_prompt(question: str, repo_id: Optional[str], context: list[dict[str, Any]], first_turn: bool) -> str:
    graph = "\n".join(
        f"- {c.get('label')} ({c.get('type')}) in {c.get('file')} "
        f"[repo: {c.get('repo')}] neighbors: {', '.join((c.get('neighbors') or [])[:6])}"
        for c in context
    ) or "(no matching nodes found in the graph)"

    parts: list[str] = []
    if first_turn:
        parts.append(
            "You are codeGraph's Ask AI: you answer questions about the codebase "
            "in this workspace. You are READ-ONLY -- you can only read, search "
            "and list files; you cannot edit files or run commands, so never "
            "offer to. The workspace root contains `codegraph/`, `graphify/` and "
            "`code-repos/`, which holds one folder per work repo "
            "(e.g. `code-repos/tb-discovery-mfe/`).\n\n"
            "How to answer:\n"
            "1. Use the knowledge-graph context below to find WHERE to look "
            "(files, endpoints, who calls what, cross-repo links).\n"
            "2. Then open the actual files to confirm and to explain what the "
            "code really does. The graph only holds structure, and it is built "
            "from a checkout that may live elsewhere: a node's `source_file` is an "
            "absolute path ending in `<repo>/<path-in-repo>` (e.g. "
            "`.../tb-discovery-mfe/src/x.ts`), which maps to "
            "`<workspace>/code-repos/<repo>/<path-in-repo>`. If the local file and the "
            "graph disagree, trust the local file and say so.\n"
            "3. Be concrete and concise: name files, functions, endpoints "
            "(with paths and line numbers where useful). Use markdown. If you "
            "cannot tell, say what is missing instead of guessing."
        )
    if repo_id:
        parts.append(f"Scope: focus on the `{repo_id}` repo unless the question clearly needs another.")
    parts.append(f"Knowledge-graph context for this question:\n{graph}")
    parts.append(f"Question: {question}")
    return "\n\n".join(parts)


def start_ask(
    question: str,
    repo_id: Optional[str],
    context: list[dict[str, Any]],
    conversation_id: Optional[str] = None,
) -> dict[str, Any]:
    """Start (or continue) a conversation. Returns immediately; poll get_ask()."""
    api_key = _pa._cursor_api_key()
    if not api_key:
        raise AskError(
            "CURSOR_API_KEY is not set in codegraph/api/.env — get one from "
            "https://cursor.com/dashboard/integrations"
        )
    question = (question or "").strip()
    if not question:
        raise AskError("question is empty")

    from cursor_sdk import Agent, AgentNotFoundError

    agent = None
    first_turn = True
    if conversation_id:
        with _lock:
            entry = _asks.get(conversation_id)
            if entry and entry["status"] == "running":
                raise AskError("This conversation is still answering — wait for it to finish")
            agent = entry.get("agent") if entry else None
        first_turn = False
        if agent is None:
            # Process restarted (or first sight of this id): resume from the store.
            try:
                agent = Agent.resume(conversation_id, _options(api_key))
            except AgentNotFoundError:
                raise AskError("That conversation has expired — start a new one")
    else:
        agent = Agent.create(_options(api_key))
        conversation_id = agent.agent_id

    with _lock:
        _asks[conversation_id] = {
            "agent": agent,
            "status": "running",
            "question": question,
            "answer": None,
            "error": None,
            "live_status": {"text": "Starting…", "at": _pa._now()},
            "context": context,
        }

    prompt = _build_prompt(question, repo_id, context, first_turn)
    threading.Thread(target=_run_ask, args=(conversation_id, agent, prompt), daemon=True).start()
    return {"conversation_id": conversation_id, "status": "running", "context": context}


def _set_live(conversation_id: str, text: Optional[str]) -> None:
    with _lock:
        entry = _asks.get(conversation_id)
        if entry is not None:
            entry["live_status"] = {"text": text, "at": _pa._now()} if text else None


def _run_ask(conversation_id: str, agent: Any, prompt: str) -> None:
    # Deliberately never agent.close(): that tears the agent down for good and
    # would break follow-up questions (see _run_one_turn in pipeline_agent.py).
    try:
        run = agent.send(prompt)
        texts: list[str] = []
        for msg in run.messages():
            desc = _pa._describe_message(msg)
            if desc:
                _set_live(conversation_id, desc)
            if getattr(msg, "type", None) == "assistant":
                for block in getattr(getattr(msg, "message", None), "content", ()) or ():
                    t = getattr(block, "text", None)
                    if t:
                        texts.append(t)
        result = run.wait()
        _set_live(conversation_id, None)
        if getattr(result, "status", None) == "error":
            with _lock:
                _asks[conversation_id].update(
                    status="error", error=f"The agent run failed (run id {result.id}). Try again."
                )
            return
        answer = (getattr(result, "result", None) or "".join(texts)).strip()
        with _lock:
            _asks[conversation_id].update(
                status="done", answer=answer or "The agent returned no answer.", error=None
            )
    except Exception as e:  # noqa: BLE001
        _set_live(conversation_id, None)
        with _lock:
            _asks.setdefault(conversation_id, {}).update(
                status="error", error=f"{e}\n{traceback.format_exc()[-1200:]}"
            )


def get_ask(conversation_id: str) -> dict[str, Any]:
    with _lock:
        entry = _asks.get(conversation_id)
        if entry is None:
            raise AskError("unknown conversation (the API may have restarted) — ask again")
        return {
            "conversation_id": conversation_id,
            "status": entry["status"],
            "question": entry["question"],
            "answer": entry["answer"],
            "error": entry["error"],
            "live_status": entry["live_status"],
            "context": entry["context"],
        }
