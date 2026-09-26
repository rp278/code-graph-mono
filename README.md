# codeGraph

AI agent that answers questions about your codebase using a knowledge graph.
Scan repositories → build a graph of components, endpoints, tables and their
relationships → ask questions grounded in real code.

## Layout

- `api/` — Python FastAPI backend (repo registry, graph queries, rebuild trigger, chat)
- `web/` — React dashboard (React Flow graph visualization + chat UI)

The knowledge graph itself is built by our customized Graphify fork
(`techfxs/graphify`) and stored in Neo4j.

## Quick start

Prerequisites: Neo4j running (Bolt on `localhost:7687`), Python 3.12, Node 20+.

```bash
# 1. backend
cd api
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
NEO4J_PASSWORD=<your-password> .venv/bin/uvicorn src.main:app --port 8000

# 2. frontend
cd ../web
npm install
npm run dev        # -> http://localhost:5173
```

Registered repos live in `api/repos.json`. Trigger a graph rebuild from the
dashboard's Rebuild button or:

```bash
curl -X POST localhost:8000/api/graph/rebuild \
  -H 'Content-Type: application/json' -d '{"repo_id":"all"}'
```

## Chat

`POST /api/chat` answers questions grounded in the graph. Set
`ANTHROPIC_API_KEY` for AI-generated answers; without it the endpoint still
returns the retrieved graph context.

## API overview

| Method | Path | Purpose |
|---|---|---|
| GET | /health | liveness + Neo4j status |
| GET/POST | /api/repos | repo registry |
| GET | /api/graph?repo_id= | nodes + edges for visualization |
| GET | /api/graph/stats | counts by type |
| POST | /api/query | read-only Cypher passthrough |
| POST | /api/graph/rebuild | rebuild graph via Graphify fork |
| POST | /api/chat | graph-grounded Q&A |
