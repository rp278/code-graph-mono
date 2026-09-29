# codeGraph — workspace context

This workspace is one monorepo (codegraph API + dashboard, graphify, pipeline rules)
plus symlinked work repos that together form a cross-repo code knowledge graph with
an agent API and dashboard. Branch `main` (the work repos may use `master`).

## The repos

| Repo | What it is |
|---|---|
| `tb-common-mfe` | Work repo (Nx monorepo of shared micro-frontends). Symlink to `~/Desktop/code/tb-common-mfe`. |
| `tb-discovery-mfe` | Work repo (Next.js discovery micro-frontend). Symlink to `~/Desktop/code/tb-discovery-mfe`. |
| `tb-marketing-xapi` | Work repo (TypeScript experience API). Symlink to `~/Desktop/code/tb-marketing-xapi`. |
| `tb-discovery-xapi` | Work repo (Java/Maven experience API). Symlink to `~/Desktop/code/tb-discovery-xapi`. |
| `tb-selection-xapi` | Work repo (Java/Maven experience API). Symlink to `~/Desktop/code/tb-selection-xapi`. |
| `kairos-fabric` | Work repo (TypeScript design-system library, published as `@MensWearhouse/kairos-fabric`). Symlink to `~/Desktop/code/kairos-fabric`. |
| `ecom-content-stack` | Work repo (Java). Cloned by `setup.sh` from `MensWearhouse/ecom-content-stack` (default branch `develop`). |
| `graphify` | Fork of upstream graphify (tree-sitter code-graph extractor). Heavily customized — see below. |
| `codegraph` | The agent: FastAPI backend (`api/`, port 8000) + React dashboard (`web/`, port 5173), Neo4j as the graph store. |

## What the system does

Builds a knowledge graph across **multiple repos**, links frontend `fetch()` calls to
backend API endpoints **across repo boundaries**, stores it in Neo4j, and serves it
through a dashboard (graph visualization + repo filtering) and an Ask-AI chat that
answers questions grounded in the graph.

## The pipeline (deterministic — no LLM at build time)

```
source files → extraction (per repo) → link pass (global) → JSON → Neo4j → API/dashboard
```

1. **Extraction, per repo** (`graphify/graphify/codegraph.py::build_repos`):
   - Base AST extraction from upstream (`graphify/extract.py` — functions, classes,
     imports, calls, inheritance; one extractor per language).
   - **Our framework extractors** (`graphify/extract_frameworks.py` — created for this
     project, does not exist upstream):
     - `extract_fastify` — `fastify.get/post/put/delete/patch('/path', handler)` →
       `endpoint` nodes, handler→endpoint edges, table read/write detection.
     - `extract_react` — capitalized JSX functions → `component` nodes, `pages/` files →
       `page` nodes; tracks `fetch('/api/...')` and api-client wrappers.
     - `extract_sql` — `CREATE TABLE` / table reads/writes → `table` nodes.
   - Unresolvable `fetch()` calls become **`pending_edges`** (IOUs: "X fetches
     GET /api/products, target unknown"). Api-client wrappers are recorded as
     `api_clients` + `client_calls` for two-hop resolution.
   - Every node/edge is tagged `repo: <name>` and given a globally unique `gid`.
2. **Link pass** (`codegraph.py::build_repos`, after all repos are extracted):
   - Builds a global `(method, path) → node` endpoint registry across all repos.
   - `resolve()`: exact match → `:param`-tolerant segment match (`/api/products/42`
     matches endpoint `/api/products/:id`) → any-method fallback.
   - Emits `fetches` edges (`confidence: INFERRED`), including wrapper chains
     (component → helper → endpoint). Dedupes by (source, target, relation, repo).
   - Design rule: **extractors observe (one file at a time), linkers connect (globally).**
     Keep them separate.
3. **Export** (`graphify/export_neo4j.py::push_codegraph`):
   - Per-repo `DETACH DELETE` then `MERGE` by `gid` → rebuilds are idempotent, no duplicates.
   - `(:Repo {name})-[:CONTAINS]->(:Node)`, edges as `MERGE (a)-[:FETCHES]->(b)`.
   - `python3 -m graphify.codegraph --repos <repos.json> --push [--out merged.json]`
4. **Query time**: the chat pulls a subgraph from Neo4j and sends it to
   `gpt-4o-mini` to compose the answer. The LLM **never** creates nodes/edges.

## Graph model

- **Node types**: file/code, function, class, component, page, endpoint, table.
- **Edge relations**: `contains`, `calls`, `imports`, `imports_from`, `inherits`,
  `uses`, `fetches`, `reads`, `writes`. The first group is de-facto standard
  (cf. LSIF/SCIP); `fetches` is our custom cross-repo edge.
- **Node props**: `id`, `gid`, `label`, `node_type`, `repo`, `source_file`,
  `source_location` (`L<line>`), `confidence` (`EXTRACTED` = seen in source,
  `INFERRED` = derived by a fixed rule), `weight`, plus `method`/`path` on endpoints.
- **Known issue**: `source_file` is the absolute path on the build machine — not
  portable. Rebuild on a new machine to fix stale paths. Planned: repo-relative paths.

## Running it (Mac)

- Neo4j: Neo4j Desktop, `bolt://localhost:7687`.
- API: `cd codegraph/api && .venv/bin/uvicorn src.main:app --port 8000`
  (`.env`: `CURSOR_API_KEY` (required), `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`
  (only if you run Neo4j); `GRAPHIFY_DIR` defaults to the sibling `graphify` folder).
  Neo4j is optional: Ask AI and the bug pipeline work without it (graph steps fall
  back to searching the code). See `SETUP.md` at the workspace root.
- Dashboard: `cd codegraph/web && npm run dev` → http://localhost:5173
- Rebuild graph: `cd graphify && python3 -m graphify.codegraph --repos ../codegraph/api/repos.local.json --push`
- `codegraph/api/repos.local.json` = gitignored per-machine repo list
  (`[{id, name, path}]`); `repos.json` is the tracked default (old cloud paths — don't use on Mac).

## Conventions

- One monorepo holds `codegraph/`, `graphify/`, `.cursor/`, `setup.sh` and
  `SETUP.md`. The work repos (`repos.manifest.json`) are NOT part of it: they are
  clones or symlinks to separate checkouts (gitignored). Never auto-sync.
- Secrets live in `.env` files only — never in chat, never in git.
- Dashboard: single repo selector in the header (default "All repos"); selecting one
  repo includes its direct cross-repo neighbors; chat scope label is centered.
- Test prompts: "Which frontend components call the products API?",
  "How does the product list page get its data?"
