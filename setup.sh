#!/usr/bin/env bash
# One-shot setup for the CodeGraph workspace on a fresh machine.
#
#   git clone https://github.com/techfxs/code-graph-wsp.git && cd code-graph-wsp
#   ./setup.sh            # clone codegraph+graphify, link the tb-*-mfe repos, install, create config
#   ./setup.sh --check    # only verify prerequisites (changes nothing)
#   ./setup.sh --with-graph   # also install the graph builder (needs Neo4j to be useful)
#
# Safe to re-run: it never overwrites an existing .env / repos.local.json and
# never deletes anything. Secrets are never printed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OWNER="${GH_OWNER:-techfxs}"
REPOS="codegraph graphify"
# Work repos the pipelines target. They are NOT cloned here: they already live
# on disk and are symlinked into this folder (override the location with
# TB_REPOS_DIR).
TB_REPOS="tb-common-mfe tb-discovery-mfe tb-marketing-xapi tb-discovery-xapi tb-selection-xapi kairos-fabric"
TB_REPOS_DIR="${TB_REPOS_DIR:-$HOME/Desktop/code}"
CHECK_ONLY=0
WITH_GRAPH=0

for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --with-graph) WITH_GRAPH=1 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

ok()   { printf '  \033[32mok\033[0m   %s\n' "$*"; }
warn() { printf '  \033[33mwarn\033[0m %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; PROBLEMS=$((PROBLEMS + 1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
PROBLEMS=0

# --- prerequisites ---------------------------------------------------------
step "1. Prerequisites"

command -v git >/dev/null && ok "git $(git --version | awk '{print $3}')" || fail "git not found"

if command -v node >/dev/null; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$NODE_MAJOR" -ge 20 ]; then ok "node $(node --version)"; else fail "node $(node --version) is too old (need 20+)"; fi
else
  fail "node not found (install Node 20+ from https://nodejs.org or 'brew install node')"
fi
command -v npm >/dev/null && ok "npm $(npm --version)" || fail "npm not found"

# The Cursor SDK needs Python >= 3.10. macOS's stock python3 is often 3.9,
# so look for a newer one explicitly.
PYTHON=""
for cand in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$cand" >/dev/null && "$cand" -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null; then
    PYTHON="$cand"; break
  fi
done
if [ -n "$PYTHON" ]; then ok "python $($PYTHON --version | awk '{print $2}') ($PYTHON)"; else fail "Python 3.10+ not found (brew install python@3.12)"; fi

if command -v gh >/dev/null; then
  if gh auth status >/dev/null 2>&1; then ok "gh logged in"; else warn "gh installed but not logged in — run 'gh auth login' (the pipelines open/merge real PRs)"; fi
else
  warn "gh (GitHub CLI) not found — needed for the pipelines to open/merge PRs: brew install gh && gh auth login"
fi

if [ "$PROBLEMS" -gt 0 ]; then
  printf '\n%s problem(s) above must be fixed first.\n' "$PROBLEMS"; exit 1
fi
[ "$CHECK_ONLY" -eq 1 ] && { printf '\nAll prerequisites OK.\n'; exit 0; }

# --- clone repos -----------------------------------------------------------
step "2. Repositories (into $ROOT)"
for r in $REPOS; do
  if [ -d "$ROOT/$r/.git" ]; then
    ok "$r already present"
  else
    git clone --quiet "https://github.com/$OWNER/$r.git" "$ROOT/$r" && ok "cloned $r"
  fi
done

for r in $TB_REPOS; do
  if [ -e "$ROOT/$r" ]; then
    ok "$r already present"
  elif [ -d "$TB_REPOS_DIR/$r/.git" ]; then
    ln -s "$TB_REPOS_DIR/$r" "$ROOT/$r" && ok "linked $r -> $TB_REPOS_DIR/$r"
  else
    warn "$r not found in $TB_REPOS_DIR — clone it there, or set TB_REPOS_DIR, then re-run"
  fi
done

# --- api -------------------------------------------------------------------
step "3. API (codegraph/api)"
API="$ROOT/codegraph/api"
if [ ! -d "$API/.venv" ]; then "$PYTHON" -m venv "$API/.venv"; fi
"$API/.venv/bin/pip" install --quiet --upgrade pip
"$API/.venv/bin/pip" install --quiet -r "$API/requirements.txt"
ok "python dependencies installed"

if [ ! -f "$API/.env" ]; then cp "$API/.env.example" "$API/.env"; ok "created api/.env from .env.example"; else ok "api/.env already exists (left as is)"; fi

if [ ! -f "$API/repos.local.json" ]; then
  "$PYTHON" - "$ROOT" "$API/repos.local.json" <<'PY'
import json, sys
root, out = sys.argv[1], sys.argv[2]
java_repos = {"tb-discovery-xapi", "tb-selection-xapi"}
names = ("tb-common-mfe", "tb-discovery-mfe", "tb-marketing-xapi", "tb-discovery-xapi", "tb-selection-xapi", "kairos-fabric")
repos = [{"id": n, "name": n, "language": "java" if n in java_repos else "typescript", "path": f"{root}/{n}"} for n in names]
open(out, "w").write(json.dumps(repos, indent=2) + "\n")
PY
  ok "created api/repos.local.json for $ROOT"
else
  ok "api/repos.local.json already exists (left as is)"
fi

if grep -q -E '^CURSOR_API_KEY=.+' "$API/.env"; then
  ok "CURSOR_API_KEY is set in api/.env"
else
  warn "CURSOR_API_KEY is empty — edit codegraph/api/.env and paste a key from https://cursor.com/dashboard/integrations"
fi

# --- web + demo apps -------------------------------------------------------
step "4. Dashboard (npm install; the tb-*-mfe repos manage their own dependencies)"
WEB="$ROOT/codegraph/web"
if [ ! -f "$WEB/.env" ]; then cp "$WEB/.env.example" "$WEB/.env"; ok "created web/.env from .env.example"; else ok "web/.env already exists (left as is)"; fi
for d in "$WEB"; do
  (cd "$d" && npm install --no-audit --no-fund --silent) && ok "npm install: ${d#$ROOT/}"
done

# --- optional graph builder ------------------------------------------------
if [ "$WITH_GRAPH" -eq 1 ]; then
  step "5. Graph builder (graphify) — only useful with Neo4j running"
  G="$ROOT/graphify"
  if [ ! -d "$G/.venv" ]; then "$PYTHON" -m venv "$G/.venv"; fi
  "$G/.venv/bin/pip" install --quiet networkx tree-sitter tree-sitter-javascript tree-sitter-typescript neo4j
  ok "graphify dependencies installed"
fi

step "Done. Next steps"
cat <<EOF
  1. Put your key in  codegraph/api/.env   (CURSOR_API_KEY=...)
  2. Terminal A:  cd codegraph/api && .venv/bin/uvicorn src.main:app --port 8000
  3. Terminal B:  cd codegraph/web && npm run dev      -> http://localhost:5173
  4. Open the workspace in Cursor:  cursor code-graph.code-workspace
  Neo4j is optional — see SETUP.md ("With or without Neo4j").
EOF
