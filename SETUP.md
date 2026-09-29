# CodeGraph workspace — setup on a new machine

Everything runs on your laptop. **No cloud VM and no cloud database are needed.**
Neo4j is optional (see [With or without Neo4j](#with-or-without-neo4j)).

## Quick start

```bash
git clone git@github.com:rp278/code-graph-mono.git
cd code-graph-mono
./setup.sh --check     # verifies git, Node 20+, Python 3.10+, gh
./setup.sh             # links the work repos, installs codegraph + graphify, creates config
```

Then:

1. Paste your Cursor key into `codegraph/api/.env`
   (`CURSOR_API_KEY=...`, create one at https://cursor.com/dashboard/integrations).
   Never paste it in chat or commit it.
2. Terminal A — API: `cd codegraph/api && .venv/bin/uvicorn src.main:app --port 8000`
3. Terminal B — dashboard: `cd codegraph/web && npm run dev` → http://localhost:5173
4. Open the workspace in Cursor: `cursor code-graph.code-workspace`

The dashboard's **Feature Development** screen is hidden by default. To show it, set the cookie
`cg_feature_development_enabled=true` for `localhost:5173` (browser dev tools, Application, Cookies). The
**View Graph**, **Ask AI** and **Fix Bugs** screens are always available.

Smoke test: open **Ask AI** and ask a question about a component in `tb-discovery-mfe`
(e.g. *"Where is GlobalScriptsSDK used?"*). An answer that names real files and line
numbers means Cursor SDK, the API and the dashboard are all working.

> This is **one repo**: `codegraph/` (API + dashboard), `graphify/` (graph builder)
> and `.cursor/` (pipeline rules) are all tracked here. The pipeline agents run from
> this folder and read `.cursor/` from it, so keep the work-repo links
> (`tb-common-mfe/`, `tb-discovery-mfe/`, `tb-marketing-xapi/`, `tb-discovery-xapi/`,
> `tb-selection-xapi/`, `kairos-fabric/`) beside them. Those are **symlinks** to your existing checkouts in
> `~/Desktop/code` (set `TB_REPOS_DIR` if they live elsewhere), so there are no
> second copies — but pipeline runs would touch your real working trees.

## What lives where

| Path | What it is |
|---|---|
| `.cursor/` (this repo) | Pipeline rules and the two skills (feature + bug-fix) the agents follow |
| `codegraph/` | API (`api/`, FastAPI) + dashboard (`web/`, React) |
| `graphify/` | Graph builder (optional — only used with Neo4j) |
| `tb-common-mfe/`, `tb-discovery-mfe/`, `tb-marketing-xapi/`, `tb-discovery-xapi/`, `tb-selection-xapi/`, `kairos-fabric/` | Symlinks to the work repos in `~/Desktop/code` that the pipelines change |

## Settings (`codegraph/api/.env`)

| Variable | Needed? | Meaning |
|---|---|---|
| `CURSOR_API_KEY` | **Yes** | Powers Ask AI and the Fix Bugs / Feature pipelines |
| `ASK_MODEL` | No | Model for Ask AI (default `auto`) |
| `PIPELINE_MODEL` | No | Model for the pipelines (default `auto`) |
| `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` | Only with Neo4j | Graph database connection |
| `API_TOKEN` | No | Set only if the API is reachable from the internet |

Model ids: `claude-sonnet-5-5`, `claude-opus-5-5`, `gpt-5.6-sol`, `composer-2`,
`gemini-3.8-flash`, … (the SDK lists all of them; `auto` lets Cursor choose).

## With or without Neo4j

| | What works |
|---|---|
| **No Neo4j** (simplest) | Ask AI, Fix Bugs, Feature Development. Whenever the graph has no answer or is unreachable, the agents search the code themselves and say so in their artifacts. The **View Graph** screen is empty. |
| **Local Neo4j** | Everything, including View Graph and graph-assisted analysis. |

To add a local Neo4j:

```bash
docker run -d --name neo4j -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/choose-a-password neo4j:5
# (or install Neo4j Desktop and create a local 5.x DBMS)
```

Then set `NEO4J_PASSWORD=choose-a-password` in `codegraph/api/.env`, and:

```bash
./setup.sh --with-graph                         # installs the graph builder
cd graphify
NEO4J_PASSWORD=choose-a-password .venv/bin/python -m graphify.codegraph \
  --repos ../codegraph/api/repos.local.json --push
```

(The dashboard's **Rebuild** button does the same thing.) Check
http://127.0.0.1:8000/health → `"neo4j":"up"`. A local build reads your local
checkouts, so it also reflects uncommitted changes.

## GitHub access (needed for the pipelines)

The pipelines open real pull requests (the feature pipeline also merges them;
the **bug-fix pipeline stops at an open PR and never merges**), so the machine
needs write access to the work repos' GitHub remotes (currently `MensWearhouse/*`) even if they are public:

```bash
brew install gh
gh auth login          # choose GitHub.com + HTTPS, log in as an account with write access
```

## Optional: auto-rebuild the graph on merge

The "Rebuild codeGraph" GitHub Action is **off by default**. To turn it on, set
the repository variable `CODEGRAPH_REBUILD_URL` (e.g. `http://<host>/api/graph/rebuild`)
and, if that API requires a token, the secret `CODEGRAPH_API_TOKEN`.

## Before a demo

- Restart the API after pulling changes (it has no auto-reload).
- Run one bug through all four gates once, end to end.
- Make sure `tb-common-mfe` and `tb-discovery-mfe` are on their default branch, clean, with no leftover pipeline branch checked out.

## Troubleshooting

- **`ModuleNotFoundError: cursor_sdk`** — re-run `./setup.sh` (installs `cursor-sdk`), and start uvicorn from `codegraph/api/.venv`.
- **"CURSOR_API_KEY is not set"** — key missing or empty in `codegraph/api/.env`; restart the API.
- **Dashboard says "Cannot reach the API"** — the API isn't running on port 8000, or the dashboard's origin isn't allowed: set `ALLOWED_ORIGINS` in `codegraph/api/.env` (default allows `localhost:5173`).
- **`neo4j: down` in `/health`** — fine if you're running without Neo4j; otherwise start it and check `NEO4J_PASSWORD`.
- **Python too old** — the Cursor SDK needs 3.10+ (`brew install python@3.12`), then delete `codegraph/api/.venv` and re-run `./setup.sh`.
- **A run stuck at "Idle" after a restart** — restarting the API kills in-flight agents; select the run and click **Restart**.
