# CodeGraph workspace — setup guide

Everything runs on your laptop. **No cloud VM and no cloud database are needed.**
Neo4j (for the graph view) is optional and runs in Docker.

## What you get

| Piece | Where it runs |
|---|---|
| API (FastAPI) and the pipeline agents | your machine, from `codegraph/api` |
| Dashboard (React) | your machine, from `codegraph/web` |
| Neo4j + graph builder (optional, for **View Graph**) | Docker, via `docker-compose.yml` |
| Work repos the agents read and change | cloned next to this repo (or linked from an existing checkout) |

## Setup, step by step

### 1. Install the prerequisites

| Tool | Why | Install |
|---|---|---|
| git | clone repos | `xcode-select --install` |
| Node 20+ | dashboard | `brew install node` |
| Python 3.10+ | API, Cursor SDK | `brew install python@3.12` |
| GitHub CLI `gh` | clones the work repos, opens PRs | `brew install gh`, then `gh auth login` (GitHub.com, HTTPS) |
| Docker Desktop | only for the graph view (Neo4j) | https://www.docker.com/products/docker-desktop |

You also need **access to the work repos** on GitHub (`MensWearhouse/*`, see
`repos.manifest.json`). They are private, so ask an org admin if `setup.sh` says you have no access.

### 2. Clone this repo

```bash
git clone git@github.com:rp278/code-graph-mono.git
cd code-graph-mono
./setup.sh --check     # verifies git, Node 20+, Python 3.10+, gh (changes nothing)
```

### 3. Run the setup script

```bash
./setup.sh
```

It is safe to re-run and never overwrites your settings. It will:

1. **Get the work repos** listed in `repos.manifest.json`, for each one in this order:
   a folder already in this directory; a checkout in `TB_REPOS_DIR` (default
   `~/Desktop/code`), which it symlinks; otherwise a fresh clone from GitHub with `gh`.
   Use `./setup.sh --no-clone` to skip cloning, or `./setup.sh --repos-only` to stop after this step.
2. Create the API's Python environment and install its dependencies.
3. Create `codegraph/api/.env` and `codegraph/api/repos.local.json` (the repo paths on this machine).
4. Run `npm install` for the dashboard.

Add `--with-graph` to also install the graph builder without Docker.

### 4. Add your Cursor key

Put your key in `codegraph/api/.env`:

```
CURSOR_API_KEY=...
```

Create one at https://cursor.com/dashboard/integrations. Never paste it in chat or commit it.

### 5. (Optional) Start Neo4j and build the graph

Skip this if you only need Ask AI and Fix Bugs. Otherwise set a password (8+ characters) in
`codegraph/api/.env` (`NEO4J_PASSWORD=...`), then:

```bash
docker compose --env-file codegraph/api/.env up -d neo4j        # once; it keeps running
docker compose --env-file codegraph/api/.env run --rm graphify  # builds the graph; repeat to refresh
```

Check http://127.0.0.1:8000/health → `"neo4j":"up"` once the API is running.
More detail is in [Docker](#docker-graph-database-and-graph-builder).

### 6. Start the API and the dashboard

```bash
# Terminal A — API (restart it after pulling changes; there is no auto-reload)
cd codegraph/api && .venv/bin/uvicorn src.main:app --port 8000

# Terminal B — dashboard → http://localhost:5173
cd codegraph/web && npm run dev
```

### 7. Open the workspace in Cursor

```bash
cursor code-graph.code-workspace
```

### Smoke test

Open **Ask AI** and ask about a component, e.g. *"Where is GlobalScriptsSDK used?"* in
`tb-discovery-mfe`. An answer that names real files and line numbers means the Cursor SDK,
the API and the dashboard all work.

The dashboard's **Feature Development** screen is hidden by default. To show it, set the cookie
`cg_feature_development_enabled=true` for `localhost:5173` (browser dev tools, Application, Cookies).
**View Graph**, **Ask AI** and **Fix Bugs** are always available.

## Work repos

`repos.manifest.json` is the list of repos the agents work on (name, GitHub `owner/repo`, language).
To use different repos, edit it and re-run `./setup.sh`; the pipelines and graph follow
`codegraph/api/repos.local.json`, which `setup.sh` generates from it.

The pipeline agents **change these repos** (branches, commits, PRs). A clone made by `setup.sh`
is dedicated to that, which is the safest choice. If you link an existing checkout instead, pipeline
runs will touch your real working tree, so keep it clean and on its default branch.

## Settings (`codegraph/api/.env`)

| Variable | Needed? | Meaning |
|---|---|---|
| `CURSOR_API_KEY` | **Yes** | Powers Ask AI and the Fix Bugs / Feature pipelines |
| `ASK_MODEL` | No | Model for Ask AI (default `auto`) |
| `PIPELINE_MODEL` | No | Model for the pipelines (default `auto`) |
| `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` | Only with Neo4j | Graph database connection |
| `TB_REPOS_DIR` | Only if repos are symlinks | Folder the symlinked repos really live in (added by `setup.sh`; the Docker graph job needs it) |
| `API_TOKEN` | No | Set only if the API is reachable from the internet |

Model ids: `claude-sonnet-5-5`, `claude-opus-5-5`, `gpt-5.6-sol`, `composer-2`,
`gemini-3.8-flash`, … (the SDK lists all of them; `auto` lets Cursor choose).

## With or without Neo4j

| | What works |
|---|---|
| **No Neo4j** (simplest) | Ask AI, Fix Bugs, Feature Development. Whenever the graph has no answer or is unreachable, the agents search the code themselves and say so in their artifacts. The **View Graph** screen is empty. |
| **Neo4j** | Everything, including View Graph and graph-assisted analysis. |

The easiest way to get Neo4j is Docker (below). Without Docker, install Neo4j Desktop, create a local
5.x DBMS, set `NEO4J_PASSWORD` in `codegraph/api/.env`, and build the graph:

```bash
./setup.sh --with-graph                         # installs the graph builder
cd graphify
NEO4J_PASSWORD=<your-password> .venv/bin/python -m graphify.codegraph \
  --repos ../codegraph/api/repos.local.json --push
```

(The dashboard's **Rebuild** button also builds the graph, but it first runs `git pull --ff-only`
in every work repo. Prefer the commands above.) A local build reads your checkouts, so it also
reflects uncommitted changes.

## Docker (graph database and graph builder)

`docker-compose.yml` runs Neo4j and the graph build in containers. The API, the dashboard and the
pipeline agents stay on your machine on purpose: they need your git/`gh` credentials and
toolchains, and they edit the real work repos.

```bash
# Neo4j (data persists in a Docker volume; it restarts with Docker)
docker compose --env-file codegraph/api/.env up -d neo4j

# Build the graph and push it to that Neo4j (repos are mounted read-only)
docker compose --env-file codegraph/api/.env run --rm graphify
```

Run `./setup.sh` first: the graph job needs `codegraph/api/repos.local.json`.

Notes:

- The graph job finds each repo by name: a cloned folder in this directory, or, for symlinked repos,
  under `TB_REPOS_DIR`. It never runs git and never writes into the repos; its extraction cache lives
  in the `code-graph_graphify_cache` volume. If you change the extractors, reset the cache with
  `docker volume rm code-graph_graphify_cache`, because entries are keyed by file content only.
- Ports 7474/7687 are bound to `127.0.0.1`. If another Neo4j already uses them, set
  `NEO4J_HTTP_PORT` / `NEO4J_BOLT_PORT` in `codegraph/api/.env` and match `NEO4J_URI`.
- `NEO4J_PASSWORD` only takes effect when the volume is first created. To change it later:
  `docker compose --env-file codegraph/api/.env down -v` (this deletes the graph; rebuild it with the
  `graphify` job).

## GitHub access (needed for the pipelines)

The pipelines open real pull requests (the feature pipeline also merges them; the **bug-fix pipeline
stops at an open PR and never merges**), so the machine needs write access to the work repos' GitHub
remotes (currently `MensWearhouse/*`) even if they are public. `gh auth login` (step 1) covers this.

## Optional: auto-rebuild the graph on merge

The "Rebuild codeGraph" GitHub Action is **off by default**. To turn it on, set
the repository variable `CODEGRAPH_REBUILD_URL` (e.g. `http://<host>/api/graph/rebuild`)
and, if that API requires a token, the secret `CODEGRAPH_API_TOKEN`.

## Before a demo

- Restart the API after pulling changes (it has no auto-reload).
- Run one bug through all four gates once, end to end.
- Make sure `tb-common-mfe` and `tb-discovery-mfe` are on their default branch, clean, with no leftover pipeline branch checked out.

## Troubleshooting

- **`setup.sh`: "no access to github.com/…"** — your GitHub account can't read that repo; ask an org admin for access, then re-run `./setup.sh`.
- **`setup.sh`: "gh is not logged in"** — run `gh auth login`, then re-run `./setup.sh`.
- **`ModuleNotFoundError: cursor_sdk`** — re-run `./setup.sh` (installs `cursor-sdk`), and start uvicorn from `codegraph/api/.venv`.
- **"CURSOR_API_KEY is not set"** — key missing or empty in `codegraph/api/.env`; restart the API.
- **Dashboard says "Cannot reach the API"** — the API isn't running on port 8000, or the dashboard's origin isn't allowed: set `ALLOWED_ORIGINS` in `codegraph/api/.env` (default allows `localhost:5173`).
- **`neo4j: down` in `/health`** — fine if you're running without Neo4j; otherwise start it (`up -d neo4j`) and check `NEO4J_PASSWORD` and the ports.
- **Graph job says "skip (not found)"** — the repos are symlinks and the container can't follow them; set `TB_REPOS_DIR` in `codegraph/api/.env` to the folder they point to.
- **Python too old** — the Cursor SDK needs 3.10+ (`brew install python@3.12`), then delete `codegraph/api/.venv` and re-run `./setup.sh`.
- **A run stuck at "Idle" after a restart** — restarting the API kills in-flight agents; select the run and click **Restart**.
