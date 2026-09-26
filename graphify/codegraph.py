"""codeGraph build entry point: multi-repo extraction with Neo4j export.

Usage:
    python -m graphify.codegraph --repos repos.json [--push] [--out merged.json]

``repos.json`` is a list of ``{"name": ..., "path": ...}`` objects. Every
node/edge is tagged with its source repository. With ``--push`` the merged
graph is loaded into Neo4j (see export_neo4j for connection overrides).

Pipeline per repo:
    1. collect files (excluding node_modules, dist, .git, ...)
    2. base AST extraction (graphify.extract)
    3. framework extraction (Fastify / React / SQL)
    4. tag every node/edge with the repo name
Then a link pass resolves ``fetches`` edges (direct literals and api-client
wrappers) to the concrete ``endpoint`` nodes they target, including across
repos.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .extract import extract
from .extract_frameworks import extract_frameworks, _endpoint_id, _path_matches
from .validate import validate_extraction as validate

SKIP_DIRS = {
    "node_modules", "dist", "build", ".git", ".venv", "venv",
    "__pycache__", "graphify-out", ".next", "coverage",
}
JS_SUFFIXES = {".js", ".jsx", ".ts", ".tsx"}


def collect_repo_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        if any(part in SKIP_DIRS for part in p.parts):
            continue
        files.append(p)
    return files


def _tag_repo(item: dict, repo: str) -> None:
    item["repo"] = repo
    if "gid" not in item and "id" in item:
        # gid stays globally unique; repo tag lives in its own property
        item["gid"] = item["id"]


def build_repos(repos: list[dict]) -> dict:
    """Build a merged, repo-tagged extraction for ``[{name, path}]``.

    Returns the merged extraction dict (with framework ``pending_edges``
    resolved to real ``fetches`` edges where a matching endpoint exists).
    """
    all_nodes: list[dict] = []
    all_edges: list[dict] = []
    repo_fw: dict[str, dict] = {}  # repo name -> merged framework info

    for repo in repos:
        name = repo["name"]
        root = Path(repo["path"])
        files = collect_repo_files(root)

        base = extract(files)
        if base.get("error"):
            print(f"[codegraph] warning: base extraction issue for {name}: {base['error']}", file=sys.stderr)

        fw_nodes: list[dict] = []
        fw_edges: list[dict] = []
        fw_pending: list[dict] = []
        api_clients: dict[str, list[str]] = {}
        client_calls: list[tuple[str, str, int, str]] = []  # (source_nid, callee, line, file)
        for f in files:
            if f.suffix in JS_SUFFIXES:
                fw = extract_frameworks(f, name)
                fw_nodes.extend(fw["nodes"])
                fw_edges.extend(fw["edges"])
                fw_pending.extend(fw["pending_edges"])
                for k, v in fw["api_clients"].items():
                    api_clients.setdefault(k, [])
                    for p in v:
                        if p not in api_clients[k]:
                            api_clients[k].append(p)
                for src_nid, callee, line in fw["client_calls"]:
                    client_calls.append((src_nid, callee, line, str(f)))
        repo_fw[name] = {
            "pending": fw_pending,
            "api_clients": api_clients,
            "client_calls": client_calls,
            "nodes": fw_nodes,
            "edges": fw_edges,
        }

        for n in base.get("nodes", []) + fw_nodes:
            _tag_repo(n, name)
        for e in base.get("edges", []) + fw_edges:
            _tag_repo(e, name)
        all_nodes.extend(base.get("nodes", []))
        all_nodes.extend(fw_nodes)
        all_edges.extend(base.get("edges", []))
        all_edges.extend(fw_edges)

    # ── link pass: resolve fetches to endpoint nodes ──────────────────────
    # endpoint registry: (method, path) -> node id
    endpoints: list[tuple[str, str, str]] = []
    for n in all_nodes:
        if n.get("node_type") == "endpoint":
            endpoints.append((n.get("method", "GET"), n.get("path", ""), n["id"]))

    def resolve(method: str, path: str) -> str | None:
        # exact static match first, then :param-tolerant match
        for em, ep, eid in endpoints:
            if em == method and ep == path:
                return eid
        for em, ep, eid in endpoints:
            if _path_matches(ep, path):
                return eid
        # fall back to any method on the same path
        for em, ep, eid in endpoints:
            if _path_matches(ep, path):
                return eid
        return None

    def make_fetches(src: str, method: str, path: str, source_file: str, line: str):
        tgt = resolve(method, path)
        if not tgt:
            return None
        return {
            "source": src,
            "target": tgt,
            "relation": "fetches",
            "confidence": "INFERRED",
            "source_file": source_file,
            "source_location": line,
            "weight": 0.8,
        }

    for repo in repos:
        name = repo["name"]
        fw = repo_fw[name]
        # 1. direct fetch literals (pending from the framework pass)
        for p in fw["pending"]:
            e = make_fetches(p["source"], p["pending_method"], p["pending_path"],
                             p["source_file"], p["source_location"])
            if e:
                _tag_repo(e, name)
                all_edges.append(e)
        # 2. api-client wrapper calls: component -> client fn -> api paths
        for src_nid, callee, line, sfile in fw["client_calls"]:
            paths = fw["api_clients"].get(callee)
            if not paths:
                continue
            for path in paths:
                e = make_fetches(src_nid, "GET", path, sfile, f"L{line}")
                if e:
                    _tag_repo(e, name)
                    all_edges.append(e)

    # dedupe edges
    seen: set[tuple] = set()
    deduped: list[dict] = []
    for e in all_edges:
        key = (e.get("source"), e.get("target"), e.get("relation"), e.get("repo"))
        if key not in seen:
            seen.add(key)
            deduped.append(e)

    merged = {"nodes": all_nodes, "edges": deduped}
    errors = validate(merged)
    if errors:
        print(f"[codegraph] validation warnings: {errors}", file=sys.stderr)
    return merged


def main() -> None:
    ap = argparse.ArgumentParser(description="codeGraph multi-repo build")
    ap.add_argument("--repos", required=True, help="JSON file: [{\"name\": ..., \"path\": ...}]")
    ap.add_argument("--push", action="store_true", help="push merged graph to Neo4j")
    ap.add_argument("--out", default=None, help="write merged extraction JSON here")
    args = ap.parse_args()

    repos = json.loads(Path(args.repos).read_text())
    merged = build_repos(repos)
    print(f"[codegraph] repos={len(repos)} nodes={len(merged['nodes'])} edges={len(merged['edges'])}")

    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(merged, indent=2))
        print(f"[codegraph] wrote {out}")

    if args.push:
        from .export_neo4j import push_codegraph
        stats = push_codegraph(merged)
        print(f"[codegraph] pushed to Neo4j: {stats}")


if __name__ == "__main__":
    main()
