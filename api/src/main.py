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
import urllib.request
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from neo4j import GraphDatabase
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent.parent  # api/
REPOS_FILE = Path(os.environ.get("CODEGRAPH_REPOS", BASE_DIR / "repos.json"))
GRAPHIFY_DIR = Path(os.environ.get("GRAPHIFY_DIR", "/home/hatch/workspace/graphify"))

NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "codegraph123")

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-20250514")

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
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

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


class ChatIn(BaseModel):
    question: str
    repo_id: Optional[str] = None


# ---------------------------------------------------------------- repos

def load_repos() -> list[dict[str, Any]]:
    if not REPOS_FILE.exists():
        return []
    return json.loads(REPOS_FILE.read_text())


def save_repos(repos: list[dict[str, Any]]) -> None:
    REPOS_FILE.write_text(json.dumps(repos, indent=2))


@app.get("/health")
def health() -> dict[str, Any]:
    try:
        with driver.session() as s:
            s.run("RETURN 1").single()
        neo4j = "up"
    except Exception as e:  # noqa: BLE001
        neo4j = f"down: {e}"
    return {"status": "ok", "neo4j": neo4j}


@app.get("/api/repos")
def list_repos() -> list[dict[str, Any]]:
    return load_repos()


@app.post("/api/repos", status_code=201)
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

@app.get("/api/graph")
def get_graph(repo_id: Optional[str] = None, limit: int = 500) -> dict[str, Any]:
    """Nodes + edges for the React Flow dashboard."""
    where = "WHERE n.repo = $repo" if repo_id else ""
    params: dict[str, Any] = {"limit": limit}
    if repo_id:
        params["repo"] = repo_id
    with driver.session() as s:
        nodes = s.run(
            f"MATCH (n:Node) {where} RETURN n.gid AS id, n.label AS label, "
            f"n.type AS type, n.source_file AS file, n.repo AS repo "
            f"LIMIT $limit",
            **params,
        ).data()
        edges = s.run(
            f"MATCH (a:Node)-[e]->(b:Node) {where.replace('n.', 'a.')} "
            f"RETURN a.gid AS source, b.gid AS target, "
            f"type(e) AS relation, e.confidence AS confidence LIMIT $limit",
            **params,
        ).data()
    for i, e in enumerate(edges):
        e["id"] = f"e{i}"
    return {"nodes": nodes, "edges": edges}


@app.get("/api/graph/stats")
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


@app.post("/api/query")
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

@app.post("/api/graph/rebuild")
def rebuild_graph(body: RebuildIn) -> dict[str, Any]:
    """Rebuild the knowledge graph with our Graphify fork and reload Neo4j.

    Delegates to the fork's CLI (`python3 -m graphify.codegraph --repos
    <json> --push`). Rebuilds *all* registered repos so cross-repo edges
    (e.g. frontend fetches -> backend endpoints) resolve correctly.
    """
    repos = load_repos()
    if body.repo_id != "all" and not any(r["id"] == body.repo_id for r in repos):
        raise HTTPException(404, f"unknown repo '{body.repo_id}'")
    entry = GRAPHIFY_DIR / "graphify" / "codegraph.py"
    if not entry.exists():
        raise HTTPException(
            501,
            "graphify fork exporter not found yet "
            f"(expected {entry}); build the fork first",
        )
    repos_json = json.dumps([{"name": r["id"], "path": r["path"]} for r in repos])
    tmp = BASE_DIR / ".rebuild-repos.json"
    tmp.write_text(repos_json)
    env = dict(os.environ)
    env.setdefault("NEO4J_URI", NEO4J_URI)
    env.setdefault("NEO4J_USER", NEO4J_USER)
    env.setdefault("NEO4J_PASSWORD", NEO4J_PASSWORD)
    try:
        proc = subprocess.run(
            ["python3", "-m", "graphify.codegraph",
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
            "log": proc.stdout[-2000:]}


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


def ask_claude(question: str, context: list[dict[str, Any]]) -> str:
    context_text = "\n".join(
        f"- {c['label']} ({c['type']}) in {c['file']} "
        f"[repo: {c['repo']}] neighbors: {', '.join(c['neighbors'][:6])}"
        for c in context
    ) or "(no graph context found)"
    payload = {
        "model": ANTHROPIC_MODEL,
        "max_tokens": 1024,
        "system": (
            "You are codeGraph, an AI assistant that answers questions about "
            "a codebase using its knowledge graph. Answer from the graph "
            "context below. Be concrete: name files, functions, endpoints. "
            "If the context is insufficient, say what is missing instead of "
            "guessing."
        ),
        "messages": [{
            "role": "user",
            "content": f"Knowledge graph context:\n{context_text}\n\n"
                       f"Question: {question}",
        }],
    }
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(payload).encode(),
        headers={
            "content-type": "application/json",
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = json.loads(resp.read().decode())
    return "".join(
        b.get("text", "") for b in body.get("content", []) if b.get("type") == "text"
    )


@app.post("/api/chat")
def chat(body: ChatIn) -> dict[str, Any]:
    context = subgraph_for(body.question, body.repo_id)
    if not ANTHROPIC_API_KEY:
        return {
            "answer": None,
            "message": (
                "Set ANTHROPIC_API_KEY to enable AI answers. "
                "Graph context retrieved below."
            ),
            "context": context,
        }
    try:
        answer = ask_claude(body.question, context)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LLM call failed: {e}")
    return {"answer": answer, "context": context}
