#!/bin/sh
# Rewrites the host paths in repos.local.json to the read-only mounts (by repo
# name): a real folder in /workspace (cloned by setup.sh) wins, otherwise the
# repo is looked up in /repos (TB_REPOS_DIR, for symlinked checkouts). Then runs
# the graph build and pushes it to Neo4j.
set -eu

python - <<'PY'
import json, os, sys
repos = json.load(open("/config/repos.json"))
found = []
for r in repos:
    ws, ext = "/workspace/" + r["name"], "/repos/" + r["name"]
    if os.path.isdir(ws) and not os.path.islink(ws):
        r["path"] = ws
    elif os.path.isdir(ext):
        r["path"] = ext
    else:
        print("skip (not found):", r["name"], "- set TB_REPOS_DIR in codegraph/api/.env if it is a symlink", file=sys.stderr)
        continue
    found.append(r)
if not found:
    sys.exit("no work repos found - run ./setup.sh first")
json.dump(found, open("/tmp/repos.json", "w"))
print("repos:", ", ".join(r["name"] for r in found))
PY

exec python -m graphify.codegraph --repos /tmp/repos.json --push "$@"
