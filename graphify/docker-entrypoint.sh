#!/bin/sh
# Rewrites the host paths in repos.local.json to the read-only mount at /repos
# (by repo name), then runs the graph build and pushes it to Neo4j.
set -eu

python - <<'PY'
import json
repos = json.load(open("/config/repos.json"))
for r in repos:
    r["path"] = "/repos/" + r["name"]
json.dump(repos, open("/tmp/repos.json", "w"))
print("repos:", ", ".join(r["name"] for r in repos))
PY

exec python -m graphify.codegraph --repos /tmp/repos.json --push "$@"
