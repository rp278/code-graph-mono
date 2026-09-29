#!/usr/bin/env bash
# One-shot setup for the CodeGraph workspace on a fresh machine.
#
#   git clone git@github.com:rp278/code-graph-mono.git && cd code-graph-mono
#   ./setup.sh            # get the work repos, install api + dashboard, create config
#   ./setup.sh --check    # only verify prerequisites (changes nothing)
#   ./setup.sh --with-graph   # also install the graph builder (needs Neo4j to be useful)
#   ./setup.sh --no-clone     # never clone missing work repos (only link existing ones)
#   ./setup.sh --repos-only   # only do step 2 (get/link the work repos), then stop
#
# Safe to re-run: it never overwrites an existing .env / repos.local.json and
# never deletes anything. Secrets are never printed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# codegraph/ (api + web) and graphify/ are part of THIS repo (monorepo), so
# there is nothing to clone for them.
# Work repos the pipelines target are listed in repos.manifest.json. They are
# NOT part of this repo; they live in code-repos/ (git-ignored). For each one,
# step 2 uses (in order): a folder already in code-repos/; a checkout in
# TB_REPOS_DIR (symlinked); otherwise a fresh clone from GitHub with `gh`
# (skip with --no-clone).
MANIFEST="${REPOS_MANIFEST:-$ROOT/repos.manifest.json}"
TB_REPOS_DIR="${TB_REPOS_DIR:-$HOME/Desktop/code}"
CODE_REPOS="$ROOT/code-repos"
CHECK_ONLY=0
WITH_GRAPH=0
NO_CLONE=0
REPOS_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --with-graph) WITH_GRAPH=1 ;;
    --no-clone) NO_CLONE=1 ;;
    --repos-only) REPOS_ONLY=1 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

# --- work repos ------------------------------------------------------------
step "2. Work repos (from $(basename "$MANIFEST"), into code-repos/)"
for r in codegraph graphify; do
  [ -d "$ROOT/$r" ] && ok "$r/ is part of this repo" || fail "$r/ is missing — is this a full checkout of the monorepo?"
done
[ -f "$MANIFEST" ] || { fail "$MANIFEST not found"; exit 1; }
mkdir -p "$CODE_REPOS"

GH_READY=0
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then GH_READY=1; fi

MISSING=0
while IFS=$'\t' read -r name github _lang; do
  if [ -e "$CODE_REPOS/$name" ] || [ -L "$CODE_REPOS/$name" ]; then
    ok "$name already present in code-repos/"
  elif [ -d "$TB_REPOS_DIR/$name/.git" ]; then
    ln -s "$TB_REPOS_DIR/$name" "$CODE_REPOS/$name" && ok "linked $name -> $TB_REPOS_DIR/$name"
  elif [ "$NO_CLONE" -eq 1 ]; then
    warn "$name not found (skipped: --no-clone). Clone $github into code-repos/, or set TB_REPOS_DIR"; MISSING=$((MISSING + 1))
  elif [ "$GH_READY" -ne 1 ]; then
    warn "$name not found and gh is not logged in — run 'gh auth login', then re-run ./setup.sh"; MISSING=$((MISSING + 1))
  elif ! gh repo view "$github" >/dev/null 2>&1; then
    warn "$name: no access to github.com/$github — ask an org admin for access, then re-run ./setup.sh"; MISSING=$((MISSING + 1))
  elif gh repo clone "$github" "$CODE_REPOS/$name" -- --quiet --filter=blob:none >/dev/null 2>&1; then
    ok "cloned $github -> code-repos/$name/"
  else
    warn "$name: clone of $github failed (network or auth?) — re-run ./setup.sh"; MISSING=$((MISSING + 1))
  fi
done < <("$PYTHON" -c '
import json, sys
for r in json.load(open(sys.argv[1])):
    print("\t".join([r["name"], r["github"], r.get("language", "")]))
' "$MANIFEST")

if [ "$MISSING" -gt 0 ]; then
  warn "$MISSING work repo(s) missing — Ask AI / pipelines / graph will skip them until they are present"
fi
[ "$REPOS_ONLY" -eq 1 ] && { printf '\nWork repos done.\n'; exit 0; }

# --- api -------------------------------------------------------------------
step "3. API (codegraph/api)"
API="$ROOT/codegraph/api"
if [ ! -d "$API/.venv" ]; then "$PYTHON" -m venv "$API/.venv"; fi
"$API/.venv/bin/pip" install --quiet --upgrade pip
"$API/.venv/bin/pip" install --quiet -r "$API/requirements.txt"
ok "python dependencies installed"

if [ ! -f "$API/.env" ]; then cp "$API/.env.example" "$API/.env"; ok "created api/.env from .env.example"; else ok "api/.env already exists (left as is)"; fi

if [ ! -f "$API/repos.local.json" ]; then
  "$PYTHON" - "$ROOT" "$API/repos.local.json" "$MANIFEST" <<'PY'
import json, sys
root, out, manifest = sys.argv[1], sys.argv[2], sys.argv[3]
repos = [
    {"id": r["name"], "name": r["name"], "language": r.get("language", "typescript"), "path": f"{root}/code-repos/{r['name']}"}
    for r in json.load(open(manifest))
]
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
  "$G/.venv/bin/pip" install --quiet networkx tree-sitter tree-sitter-javascript tree-sitter-typescript tree-sitter-java neo4j
  ok "graphify dependencies installed"
fi

step "Done. Next steps"
cat <<EOF
  1. Put your key in  codegraph/api/.env   (CURSOR_API_KEY=...)
  2. Terminal A:  cd codegraph/api && .venv/bin/uvicorn src.main:app --port 8000
  3. Terminal B:  cd codegraph/web && npm run dev      -> http://localhost:5173
  4. Open this folder in Cursor:  cursor .
  Neo4j is optional — see SETUP.md ("With or without Neo4j").
EOF
