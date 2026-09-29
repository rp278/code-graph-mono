# CodeGraph workspace — setup guide

Everything runs on your laptop. **No cloud VM and no cloud database are needed.**
Neo4j (for the graph view) is optional and runs in Docker.

## What you get

| Piece | Where it runs |
|---|---|
| API (FastAPI) and the pipeline agents | your machine, from `codegraph/api` |
| Dashboard (React) | your machine, from `codegraph/web` |
| Neo4j (optional, for **View Graph**) | one Docker container |
| Graph builder `graphify` (optional) | your machine, from `graphify/` |
| Work repos the agents read and change | `code-repos/` in this repo (cloned, or linked from an existing checkout; git-ignored) |

## Setup, step by step

### 1. Install the prerequisites

| Tool | Why | Install |
|---|---|---|
| git | clone repos | `xcode-select --install` |
| Node 20+ | dashboard | `brew install node` |
| Python 3.10+ | API, Cursor SDK | `brew install python@3.12` |
| GitHub CLI `gh` | clones the work repos, opens PRs | `brew install gh`, then `gh auth login` (GitHub.com, HTTPS) |
| Docker Desktop | only for the graph view (runs Neo4j) | https://www.docker.com/products/docker-desktop |

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
   a folder already in `code-repos/`; a checkout in `TB_REPOS_DIR` (default
   `~/Desktop/code`), which it symlinks; otherwise a fresh clone from GitHub with `gh`.
   Use `./setup.sh --no-clone` to skip cloning, or `./setup.sh --repos-only` to stop after this step.
2. Create the API's Python environment and install its dependencies.
3. Create `codegraph/api/.env` and `codegraph/api/repos.local.json` (the repo paths on this machine).
4. Run `npm install` for the dashboard.

Add `--with-graph` to also install the graph builder (needed for the graph view).

### 4. Add your Cursor key

Put your key in `codegraph/api/.env`:

```
CURSOR_API_KEY=...
```

Create one at https://cursor.com/dashboard/integrations. Never paste it in chat or commit it.

### 5. (Optional) Start Neo4j and build the graph

Skip this if you only need Ask AI and Fix Bugs. Otherwise pick a password (8+ characters), put it in
`codegraph/api/.env` as `NEO4J_PASSWORD=...`, and start Neo4j once (it keeps running and restarts with Docker):

```bash
docker run -d --name codegraph-neo4j --restart unless-stopped \
  -p 127.0.0.1:7474:7474 -p 127.0.0.1:7687:7687 \
  -v codegraph_neo4j:/data -e NEO4J_AUTH=neo4j/<your-password> neo4j:5
```

Then build the graph (install the builder once with `./setup.sh --with-graph`):

```bash
cd graphify
NEO4J_PASSWORD=<your-password> .venv/bin/python -m graphify.codegraph \
  --repos ../codegraph/api/repos.local.json --push
```

Repeat the second command whenever you want to refresh the graph. Check
http://127.0.0.1:8000/health → `"neo4j":"up"` once the API is running.

### 6. Start the API and the dashboard

```bash
# Terminal A — API (restart it after pulling changes; there is no auto-reload)
cd codegraph/api && .venv/bin/uvicorn src.main:app --port 8000

# Terminal B — dashboard → http://localhost:5173
cd codegraph/web && npm run dev
```

### 7. Open the folder in Cursor

```bash
cursor .
```

The work repos are in `code-repos/`, so you see them in the sidebar next to `codegraph/` and `graphify/`.

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
| `API_TOKEN` | No | Set only if the API is reachable from the internet |

Model ids: `claude-sonnet-5-5`, `claude-opus-5-5`, `gpt-5.6-sol`, `composer-2`,
`gemini-3.8-flash`, … (the SDK lists all of them; `auto` lets Cursor choose).

## With or without Neo4j

| | What works |
|---|---|
| **No Neo4j** (simplest) | Ask AI, Fix Bugs, Feature Development. Whenever the graph has no answer or is unreachable, the agents search the code themselves and say so in their artifacts. The **View Graph** screen is empty. |
| **Neo4j** | Everything, including View Graph and graph-assisted analysis. |

Neo4j runs in one Docker container (step 5). Without Docker, install Neo4j Desktop and create a local 5.x
DBMS instead; the settings and the graph build command are the same.

The dashboard's **Rebuild** button also builds the graph, but it first runs `git pull --ff-only` in every
work repo. Prefer the command in step 5. A local build reads your checkouts, so it also reflects uncommitted
changes.

### Graph builder notes

- By default the build writes a `graphify-out/` cache folder **inside each work repo** (it shows up as
  untracked in `git status`). To keep the repos clean, set `GRAPHIFY_CACHE_DIR` to a folder outside them,
  e.g. `GRAPHIFY_CACHE_DIR=$HOME/.cache/graphify`, when you run the build.
- The cache is keyed by file content only, so after changing the extractors, delete the cache folder.

### Neo4j container notes

- If another Neo4j already uses ports 7474/7687, change the left side of the `-p` options and set
  `NEO4J_URI` in `codegraph/api/.env` to match (e.g. `bolt://localhost:7688`).
- `NEO4J_AUTH` only takes effect when the volume is first created. To change the password later, remove
  the container and volume (`docker rm -f codegraph-neo4j && docker volume rm codegraph_neo4j`, this
  deletes the graph), then start it again and rebuild the graph.
- Stop or start it with `docker stop codegraph-neo4j` / `docker start codegraph-neo4j`.

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
- **`neo4j: down` in `/health`** — fine if you're running without Neo4j; otherwise start it (`docker start codegraph-neo4j`) and check `NEO4J_PASSWORD` and the ports.
- **Python too old** — the Cursor SDK needs 3.10+ (`brew install python@3.12`), then delete `codegraph/api/.venv` and re-run `./setup.sh`.
- **A run stuck at "Idle" after a restart** — restarting the API kills in-flight agents; select the run and click **Restart**.
