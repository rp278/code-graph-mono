"""codegraph-api: FastAPI backend for the codeGraph agent.

Exposes the Neo4j-backed knowledge graph (built by our Graphify fork)
to the React dashboard, plus repo registration, graph rebuild triggers,
read-only Cypher queries, and a graph-grounded chat endpoint.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import threading
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from neo4j import GraphDatabase
from pydantic import BaseModel
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent  # api/
load_dotenv(BASE_DIR / ".env")  # optional: NEO4J_*, CURSOR_API_KEY, etc. live here

# Imported after load_dotenv() on purpose: pipeline_agent reads
# CURSOR_API_KEY from os.environ, and must see the value .env just loaded.
from . import ask_agent, pipeline_agent  # noqa: E402

REPOS_FILE = Path(os.environ.get("CODEGRAPH_REPOS", BASE_DIR / "repos.json"))
# Default: the `graphify` checkout next to `codegraph` in the workspace folder.
GRAPHIFY_DIR = Path(os.environ.get("GRAPHIFY_DIR", BASE_DIR.parent.parent / "graphify"))

NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "codegraph123")

# Bearer token gating every endpoint except /health. Empty (unset) means
# "open" — the default for local dev, where nothing is internet-facing.
# Any deployment reachable from the internet MUST set this.
API_TOKEN = os.environ.get("API_TOKEN", "")

# CORS: explicit origin allowlist instead of "*", since credentials-free
# wildcard CORS on a token-protected API is still a bad habit to leave in.
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get(
        "ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
    ).split(",")
    if o.strip()
]

STOPWORDS = {
    "what", "where", "which", "when", "does", "do", "the", "and", "for",
    "with", "from", "that", "this", "how", "are", "is", "it", "in", "of",
    "to", "a", "an", "there", "here", "show", "list", "give", "tell", "about",
    "between", "through", "call", "calls", "called",
}

WRITE_KEYWORDS = re.compile(
    r"\b(create|merge|delete|detach|set|remove|drop|alter|load)\b", re.IGNORECASE
)

app = FastAPI(title="codegraph-api", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


def require_token(authorization: Optional[str] = Header(None)) -> None:
    """Gate every route except /health. No-op when API_TOKEN is unset."""
    if not API_TOKEN:
        return
    expected = f"Bearer {API_TOKEN}"
    if not authorization or authorization != expected:
        raise HTTPException(401, "missing or invalid bearer token")


auth = Depends(require_token)

driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))


# ---------------------------------------------------------------- models

class RepoIn(BaseModel):
    name: str
    path: str
    language: str = "javascript"


class QueryIn(BaseModel):
    cypher: str
    params: dict[str, Any] = {}


class RebuildIn(BaseModel):
    repo_id: str


class AskIn(BaseModel):
    question: str
    repo_id: Optional[str] = None
    # Omit to start a new conversation; pass the id from a previous reply to
    # ask a follow-up in the same conversation.
    conversation_id: Optional[str] = None


class RequirementIn(BaseModel):
    requirement: str
    kind: Literal["feature", "bug"] = "feature"
    # Bug runs only: repos the reporter suspects (ids from /api/repos).
    # A hint for the agent, not a constraint. Ignored for features.
    repos: list[str] = []


class RequirementRespondIn(BaseModel):
    message: str


# ---------------------------------------------------------------- repos

def _repos_file() -> Path:
    """Local override wins: repos.local.json (gitignored) beats repos.json.

    Lets each machine keep its own repo paths without dirtying the
    tracked file, so `git pull` never conflicts.
    """
    local = BASE_DIR / "repos.local.json"
    return local if local.exists() else REPOS_FILE


def load_repos() -> list[dict[str, Any]]:
    f = _repos_file()
    if not f.exists():
        return []
    return json.loads(f.read_text())


def save_repos(repos: list[dict[str, Any]]) -> None:
    _repos_file().write_text(json.dumps(repos, indent=2))


@app.get("/health")
def health() -> dict[str, Any]:
    try:
        with driver.session() as s:
            s.run("RETURN 1").single()
        neo4j = "up"
    except Exception as e:  # noqa: BLE001
        neo4j = f"down: {e}"
    return {"status": "ok", "neo4j": neo4j}


@app.get("/api/repos", dependencies=[auth])
def list_repos() -> list[dict[str, Any]]:
    return load_repos()


@app.post("/api/repos", status_code=201, dependencies=[auth])
def register_repo(repo: RepoIn) -> dict[str, Any]:
    repos = load_repos()
    repo_id = re.sub(r"[^a-z0-9-]+", "-", repo.name.lower()).strip("-")
    if any(r["id"] == repo_id for r in repos):
        raise HTTPException(409, f"repo '{repo_id}' already registered")
    entry = {"id": repo_id, "name": repo.name, "path": repo.path,
             "language": repo.language}
    repos.append(entry)
    save_repos(repos)
    return entry


# ---------------------------------------------------------------- graph

@app.get("/api/graph", dependencies=[auth])
def get_graph(repo_id: Optional[str] = None, limit: int = 500) -> dict[str, Any]:
    """Nodes + edges for the React Flow dashboard.

    When a single repo is selected, its nodes are returned together with
    their direct neighbors — even when those neighbors live in another
    repo — so cross-repo links (frontend fetch -> backend endpoint)
    stay visible instead of being filtered out.
    """
    if repo_id == "all":
        repo_id = None
    with driver.session() as s:
        if repo_id:
            nodes = s.run(
                "MATCH (n:Node) WHERE n.repo = $repo "
                "OPTIONAL MATCH (n)--(m:Node) "
                "WITH collect(DISTINCT n) + collect(DISTINCT m) AS all "
                "UNWIND all AS x "
                "RETURN DISTINCT x.gid AS id, x.label AS label, "
                "x.type AS type, x.source_file AS file, x.repo AS repo "
                "LIMIT $limit",
                repo=repo_id, limit=limit,
            ).data()
            edges = s.run(
                "MATCH (n:Node) WHERE n.repo = $repo "
                "MATCH (n)-[e]-(m:Node) "
                "RETURN DISTINCT startNode(e).gid AS source, "
                "endNode(e).gid AS target, type(e) AS relation, "
                "e.confidence AS confidence LIMIT $limit",
                repo=repo_id, limit=limit,
            ).data()
        else:
            nodes = s.run(
                "MATCH (n:Node) RETURN n.gid AS id, n.label AS label, "
                "n.type AS type, n.source_file AS file, n.repo AS repo "
                "LIMIT $limit",
                limit=limit,
            ).data()
            edges = s.run(
                "MATCH (a:Node)-[e]->(b:Node) "
                "RETURN a.gid AS source, b.gid AS target, "
                "type(e) AS relation, e.confidence AS confidence LIMIT $limit",
                limit=limit,
            ).data()
    for i, e in enumerate(edges):
        e["id"] = f"e{i}"
    return {"nodes": nodes, "edges": edges}


@app.get("/api/graph/stats", dependencies=[auth])
def graph_stats() -> dict[str, Any]:
    with driver.session() as s:
        by_type = s.run(
            "MATCH (n:Node) RETURN n.repo AS repo, n.type AS type, "
            "count(*) AS c ORDER BY repo, type"
        ).data()
        edge_count = s.run(
            "MATCH ()-[e]->() RETURN count(e) AS c").single()["c"]
        node_count = s.run(
            "MATCH (n:Node) RETURN count(n) AS c").single()["c"]
    return {"nodes": node_count, "edges": edge_count, "by_type": by_type}


@app.get("/api/graph/tree", dependencies=[auth])
def get_graph_tree(repo_id: Optional[str] = None) -> dict[str, Any]:
    """Every node of the selected repo(s) plus only the parent->child edges
    (CONTAINS: file -> class/function, METHOD: class -> method).

    The dashboard builds a collapsible folder/file/symbol tree from this, so
    unlike /api/graph it is not capped at a few hundred nodes.
    """
    repo = None if repo_id in (None, "", "all") else repo_id
    with driver.session() as s:
        nodes = s.run(
            "MATCH (n:Node) WHERE $repo IS NULL OR n.repo = $repo "
            "RETURN n.gid AS id, n.label AS label, n.type AS type, "
            "n.source_file AS file, n.repo AS repo, "
            "n.source_location AS loc",
            repo=repo,
        ).data()
        edges = s.run(
            "MATCH (a:Node)-[e:CONTAINS|METHOD]->(b:Node) "
            "WHERE $repo IS NULL OR a.repo = $repo "
            "RETURN a.gid AS source, b.gid AS target",
            repo=repo,
        ).data()
    return {"nodes": nodes, "edges": edges}


@app.get("/api/graph/repo-links", dependencies=[auth])
def get_repo_links() -> dict[str, Any]:
    """Connections BETWEEN repositories, aggregated by (source repo, target
    repo, relation) with a count. Drives the "All repos" map in the dashboard."""
    with driver.session() as s:
        rows = s.run(
            "MATCH (a:Node)-[e]->(b:Node) "
            "WHERE a.repo IS NOT NULL AND b.repo IS NOT NULL AND a.repo <> b.repo "
            "RETURN a.repo AS source, b.repo AS target, type(e) AS relation, "
            "count(*) AS count "
            "ORDER BY count DESC"
        ).data()
    return {"links": rows}


_NODE_FIELDS = (
    "{id: x.gid, label: x.label, type: x.type, file: x.source_file, "
    "repo: x.repo, loc: x.source_location, degree: COUNT { (x)--() }}"
)


@app.get("/api/graph/search", dependencies=[auth])
def search_graph(
    q: str = "",
    repo_id: Optional[str] = None,
    type: Optional[str] = None,  # noqa: A002 -- query-string name
    limit: int = 40,
) -> dict[str, Any]:
    """Find nodes by label (case-insensitive substring) for the explorer.

    With an empty `q` this returns the repo's best entry points instead:
    packages, pages and endpoints first, then the most connected nodes.
    """
    repo = None if repo_id in (None, "", "all") else repo_id
    limit = max(1, min(limit, 200))
    needle = q.strip().lower()
    with driver.session() as s:
        rows = s.run(
            "MATCH (x:Node) "
            "WHERE ($repo IS NULL OR x.repo = $repo) "
            "AND ($type IS NULL OR x.type = $type) "
            "AND ($q = '' OR toLower(x.label) CONTAINS $q "
            "     OR toLower(coalesce(x.source_file, '')) CONTAINS $q) "
            "WITH x, "
            "  CASE x.type WHEN 'package' THEN 0 WHEN 'page' THEN 1 "
            "    WHEN 'endpoint' THEN 2 ELSE 3 END AS prio, "
            "  toLower(x.label) STARTS WITH $q AS starts, "
            "  COUNT { (x)--() } AS degree "
            "ORDER BY "
            "  CASE WHEN $q = '' THEN prio ELSE 0 END, "
            "  CASE WHEN $q <> '' AND starts THEN 0 ELSE 1 END, "
            "  degree DESC "
            "LIMIT $limit "
            "RETURN x.gid AS id, x.label AS label, x.type AS type, "
            "x.source_file AS file, x.repo AS repo, "
            "x.source_location AS loc, degree",
            repo=repo, type=type or None, q=needle, limit=limit,
        ).data()
        types = s.run(
            "MATCH (x:Node) WHERE $repo IS NULL OR x.repo = $repo "
            "RETURN x.type AS type, count(*) AS c ORDER BY c DESC",
            repo=repo,
        ).data()
    return {"nodes": rows, "types": types}


@app.get("/api/graph/neighborhood", dependencies=[auth])
def graph_neighborhood(node_id: str, limit: int = 150) -> dict[str, Any]:
    """One node plus its direct neighbors (both directions), across repos.

    This is what the explorer draws: a node is only ever shown together with
    the handful of nodes it is connected to, so the canvas stays readable no
    matter how big the graph is. `total` is the real neighbor-edge count, so
    the UI can say when the result was capped.
    """
    limit = max(1, min(limit, 500))
    with driver.session() as s:
        center = s.run(
            "MATCH (x:Node {gid: $id}) RETURN " + _NODE_FIELDS + " AS n",
            id=node_id,
        ).single()
        if center is None:
            raise HTTPException(404, f"node not found: {node_id}")
        total = s.run(
            "MATCH (c:Node {gid: $id})-[e]-(m:Node) WHERE m <> c "
            "RETURN count(e) AS c",
            id=node_id,
        ).single()["c"]
        rows = s.run(
            "MATCH (c:Node {gid: $id})-[e]-(x:Node) WHERE x <> c "
            "RETURN startNode(e).gid AS source, endNode(e).gid AS target, "
            "type(e) AS relation, e.confidence AS confidence, "
            + _NODE_FIELDS + " AS n "
            "ORDER BY COUNT { (x)--() } DESC LIMIT $limit",
            id=node_id, limit=limit,
        ).data()
    nodes: dict[str, Any] = {}
    edges: list[dict[str, Any]] = []
    for i, r in enumerate(rows):
        nodes[r["n"]["id"]] = r["n"]
        edges.append({
            "id": f"n{i}", "source": r["source"], "target": r["target"],
            "relation": r["relation"], "confidence": r["confidence"],
        })
    return {
        "center": center["n"],
        "nodes": list(nodes.values()),
        "edges": edges,
        "total": total,
    }


@app.post("/api/query", dependencies=[auth])
def run_query(q: QueryIn) -> dict[str, Any]:
    """Read-only Cypher passthrough for the dashboard / agent."""
    if WRITE_KEYWORDS.search(q.cypher):
        raise HTTPException(400, "only read queries are allowed here")
    try:
        with driver.session() as s:
            rows = s.run(q.cypher, **q.params).data()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"query failed: {e}")
    return {"rows": rows, "count": len(rows)}


# ---------------------------------------------------------------- rebuild

def _git_pull(path: Path) -> str:
    """Best-effort `git pull --ff-only` on an already-cloned repo.

    Returns a short status string; never raises. A repo that isn't a git
    checkout (e.g. a plain local folder during dev) is silently skipped
    so this stays safe to call unconditionally.
    """
    if not (path / ".git").exists():
        return f"{path}: not a git checkout, skipped"
    try:
        proc = subprocess.run(
            ["git", "pull", "--ff-only"],
            cwd=str(path), capture_output=True, text=True, timeout=60,
        )
    except subprocess.TimeoutExpired:
        return f"{path}: git pull timed out"
    if proc.returncode != 0:
        return f"{path}: git pull failed: {proc.stderr.strip()[-300:]}"
    return f"{path}: {proc.stdout.strip() or 'up to date'}"


# Single-flight guard: only one rebuild subprocess runs at a time (two
# concurrent `git pull`/extraction runs on the same checkout can race —
# e.g. git's own index.lock — and there's no benefit to running them
# in parallel anyway, since every run already rebuilds *all* repos).
_rebuild_lock = threading.Lock()
# If a rebuild request arrives while one is already in flight, it must
# not be dropped (that would silently lose whatever merge triggered it
# if no later merge ever re-triggers a rebuild) and must not run
# concurrently either. Instead it flags that one more full run is
# needed, which the in-flight request performs itself right after it
# finishes — guaranteeing every trigger is eventually reflected while
# capping the total work to at most 2 sequential runs per burst.
_rerun_lock = threading.Lock()
_rerun_needed = False


def _do_one_rebuild(repos: list[dict[str, Any]]) -> dict[str, Any]:
    """One full pull + extract + push cycle. See rebuild_graph for the
    single-flight/coalescing wrapper that calls this."""
    entry = GRAPHIFY_DIR / "graphify" / "codegraph.py"
    if not entry.exists():
        raise HTTPException(
            501,
            "graphify fork exporter not found yet "
            f"(expected {entry}); build the fork first",
        )
    pull_log = [_git_pull(GRAPHIFY_DIR)]
    pull_log += [_git_pull(Path(r["path"])) for r in repos]
    repos_json = json.dumps([{"name": r["id"], "path": r["path"]} for r in repos])
    tmp = BASE_DIR / ".rebuild-repos.json"
    tmp.write_text(repos_json)
    env = dict(os.environ)
    env.setdefault("NEO4J_URI", NEO4J_URI)
    env.setdefault("NEO4J_USER", NEO4J_USER)
    env.setdefault("NEO4J_PASSWORD", NEO4J_PASSWORD)
    # Prefer graphify's own venv interpreter (has neo4j/tree-sitter/etc.
    # installed) over a bare "python3", which resolves to the system
    # interpreter and lacks those deps.
    venv_python = GRAPHIFY_DIR / ".venv" / "bin" / "python3"
    python_bin = str(venv_python) if venv_python.exists() else "python3"
    try:
        proc = subprocess.run(
            [python_bin, "-m", "graphify.codegraph",
             "--repos", str(tmp), "--push"],
            capture_output=True, text=True, timeout=600, env=env,
            cwd=str(GRAPHIFY_DIR),
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "rebuild timed out after 10 minutes")
    finally:
        tmp.unlink(missing_ok=True)
    if proc.returncode != 0:
        raise HTTPException(500, f"rebuild failed: {proc.stderr[-2000:]}")
    return {"status": "ok", "repos": [r["id"] for r in repos],
            "pulled": pull_log, "log": proc.stdout[-2000:]}


@app.post("/api/graph/rebuild", dependencies=[auth])
def rebuild_graph(body: RebuildIn) -> dict[str, Any]:
    """Rebuild the knowledge graph with our Graphify fork and reload Neo4j.

    Pulls the latest commit for every registered repo (and the graphify
    fork itself) before extracting, so a rebuild triggered right after a
    merge actually reflects that merge instead of a stale on-disk
    checkout. Delegates to the fork's CLI (`python3 -m graphify.codegraph
    --repos <json> --push`). Rebuilds *all* registered repos so
    cross-repo edges (e.g. frontend fetches -> backend endpoints) resolve
    correctly.

    Single-flight: if a rebuild is already running when this is called,
    this request does not start a second one. It instead flags that the
    in-flight run should repeat once more after it finishes, so this
    trigger's changes are still guaranteed to be picked up (a fresh
    `git pull` happens on every run) without ever running two rebuilds
    concurrently.
    """
    global _rerun_needed
    repos = load_repos()
    if body.repo_id != "all" and not any(r["id"] == body.repo_id for r in repos):
        raise HTTPException(404, f"unknown repo '{body.repo_id}'")

    if not _rebuild_lock.acquire(blocking=False):
        with _rerun_lock:
            _rerun_needed = True
        return {
            "status": "queued",
            "detail": (
                "a rebuild was already running; a follow-up run will "
                "start right after it finishes and will pick up this "
                "change"
            ),
        }

    try:
        result = _do_one_rebuild(repos)
        while True:
            with _rerun_lock:
                pending = _rerun_needed
                _rerun_needed = False
            if not pending:
                break
            # Something else was queued while we ran — coalesce it into
            # exactly one more full run instead of dropping it.
            result = _do_one_rebuild(repos)
        return result
    finally:
        _rebuild_lock.release()


# ---------------------------------------------------------------- chat

def subgraph_for(question: str, repo_id: Optional[str]) -> list[dict[str, Any]]:
    terms = [w.strip("?,.:'\"") for w in question.lower().split()]
    keywords = [w for w in terms if len(w) > 3 and w not in STOPWORDS][:8]
    if not keywords:
        return []
    where = "AND n.repo = $repo" if repo_id else ""
    params: dict[str, Any] = {"kw": keywords, "repo": repo_id}
    cypher = (
        "MATCH (n:Node) WHERE any(k IN $kw WHERE toLower(n.label) "
        f"CONTAINS k) {where} "
        "OPTIONAL MATCH (n)-[e]-(m:Node) "
        "RETURN n.gid AS id, n.label AS label, n.type AS type, "
        "n.source_file AS file, n.repo AS repo, "
        "collect(DISTINCT m.label + ' [' + m.type + ']') AS neighbors "
        "LIMIT 25"
    )
    with driver.session() as s:
        return s.run(cypher, **params).data()


# ---------------------------------------------------------------- Ask AI (Cursor agent, read-only)

@app.post("/api/ask", status_code=202, dependencies=[auth])
def ask(body: AskIn) -> dict[str, Any]:
    """Ask a question about the codebase, answered by a read-only Cursor agent.

    Graph-grounded (a subgraph for the question is handed to the agent),
    and the agent can also open the real files. Returns at once with a
    conversation id; poll GET /api/ask/{conversation_id}.
    """
    repo_id = None if body.repo_id in (None, "", "all") else body.repo_id
    try:
        context = subgraph_for(body.question, repo_id)
    except Exception:  # noqa: BLE001 -- graph is a hint; the agent can still read files
        context = []
    try:
        return ask_agent.start_ask(body.question, repo_id, context, body.conversation_id)
    except ask_agent.AskError as e:
        raise HTTPException(400, str(e))


@app.get("/api/ask/{conversation_id}", dependencies=[auth])
def get_ask(conversation_id: str) -> dict[str, Any]:
    try:
        return ask_agent.get_ask(conversation_id)
    except ask_agent.AskError as e:
        raise HTTPException(404, str(e))


# ---------------------------------------------------------------- requirement pipeline (SDK-driven)

@app.get("/api/requirements", dependencies=[auth])
def list_requirements() -> list[dict[str, Any]]:
    """One row per requirement-pipeline run (reads codegraph/pipeline/*/state.json)."""
    return pipeline_agent.list_requirements()


@app.get("/api/requirements/{slug}", dependencies=[auth])
def get_requirement(slug: str) -> dict[str, Any]:
    try:
        return pipeline_agent.get_requirement(slug)
    except pipeline_agent.PipelineAgentError as e:
        raise HTTPException(404, str(e))


@app.post("/api/requirements", status_code=201, dependencies=[auth])
def start_requirement(body: RequirementIn) -> dict[str, Any]:
    """Start a new pipeline run via the Cursor SDK (local runtime).

    Fires the agent in a background thread and returns immediately with
    the new slug; poll GET /api/requirements/{slug} for progress. The
    agent runs headlessly (see pipeline-gates.mdc "Headless mode") and
    will pause at each gate — resume it via the /respond endpoint below.
    """
    try:
        return pipeline_agent.start_requirement(
            body.requirement, kind=body.kind, repos=body.repos
        )
    except pipeline_agent.PipelineAgentError as e:
        raise HTTPException(400, str(e))


@app.post("/api/requirements/{slug}/pause", dependencies=[auth])
def pause_requirement(slug: str) -> dict[str, Any]:
    """Pause a run that is mid-turn (cancels the agent's in-flight step).

    404 if the run doesn't exist, 409 if it isn't running.
    """
    try:
        return pipeline_agent.pause_requirement(slug)
    except pipeline_agent.PipelineAgentError as e:
        msg = str(e)
        if msg.startswith("no such requirement run"):
            raise HTTPException(404, msg)
        raise HTTPException(409, msg)


@app.post("/api/requirements/{slug}/resume", dependencies=[auth])
def resume_requirement(slug: str) -> dict[str, Any]:
    """Resume a paused run with the same agent. 404 if missing, 409 if not paused."""
    try:
        return pipeline_agent.resume_requirement(slug)
    except pipeline_agent.PipelineAgentError as e:
        msg = str(e)
        if msg.startswith("no such requirement run"):
            raise HTTPException(404, msg)
        if "not paused" in msg:
            raise HTTPException(409, msg)
        raise HTTPException(400, msg)


@app.delete("/api/requirements/{slug}", dependencies=[auth])
def delete_requirement(slug: str) -> dict[str, Any]:
    """Delete a run's record. Repos are not touched (branches and PRs stay).

    404 if the run doesn't exist, 409 if it is still mid-turn.
    """
    try:
        return pipeline_agent.delete_requirement(slug)
    except pipeline_agent.PipelineAgentError as e:
        msg = str(e)
        if msg.startswith("no such requirement run"):
            raise HTTPException(404, msg)
        if "still working" in msg:
            raise HTTPException(409, msg)
        raise HTTPException(400, msg)


@app.post("/api/requirements/{slug}/restart", status_code=201, dependencies=[auth])
def restart_requirement(slug: str) -> dict[str, Any]:
    """Restart a run from scratch under the SAME slug.

    Clears every gate and starts a fresh agent at Stage 1 on the stored
    report. Repos are not cleaned up (earlier branches stay). 404 if the run
    doesn't exist, 409 if it is still mid-turn.
    """
    try:
        return pipeline_agent.restart_requirement(slug)
    except pipeline_agent.PipelineAgentError as e:
        msg = str(e)
        if msg.startswith("no such requirement run"):
            raise HTTPException(404, msg)
        if "still working" in msg:
            raise HTTPException(409, msg)
        raise HTTPException(400, msg)


@app.post("/api/requirements/{slug}/respond", dependencies=[auth])
def respond_to_requirement(slug: str, body: RequirementRespondIn) -> dict[str, Any]:
    """Resume a paused agent with an approval/revision/update message.

    `message` is free text, same as typing a reply in chat would be,
    e.g. "gate 3_impl for shop-api: approved", "gate 1_stories for
    shop-web: revise — also cover ProductDetail", or a requirement
    change ("requirement changed: rename the field to is_on_sale").

    If the agent is mid-turn (e.g. working on another repo's story) the
    response is queued and sent automatically, in order, as soon as the
    agent is free -- the reply is `{"status": "queued", "queued": <n>}`
    instead of `"starting"`.
    """
    try:
        return pipeline_agent.respond_to_requirement(slug, body.message)
    except pipeline_agent.PipelineAgentError as e:
        raise HTTPException(400, str(e))
