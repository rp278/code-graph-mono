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
import os
import re
import sys
from pathlib import Path

from .extract import extract, _make_id
from .extract_packages import package_graph
from .extract_services import find_service_calls, match_endpoint, service_id
from .extract_backends import extract_next, extract_spring, fastify_prefixes, spring_base_path
from .extract_frameworks import extract_frameworks, _endpoint_id, _path_matches
from .validate import validate_extraction as validate

SKIP_DIRS = {
    "node_modules", "dist", "build", ".git", ".venv", "venv",
    "__pycache__", "graphify-out", ".next", "coverage",
}
# Extra folder names to skip, per machine: CODEGRAPH_SKIP_DIRS=name1,name2
SKIP_DIRS |= {d.strip() for d in os.environ.get("CODEGRAPH_SKIP_DIRS", "").split(",") if d.strip()}
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


_TEST_DIRS = {"__tests__", "__mocks__", "__snapshots__", "e2e", "visual-tests"}
_TEST_NAME_RE = re.compile(r"(\.(test|spec|stories)\.[jt]sx?$)|(Tests?\.java$)")


def _is_test_file(p: Path) -> bool:
    """Test/mock/story files must not create framework nodes (fake endpoints
    such as ``/ping`` registered on a throwaway test app)."""
    parts = p.parts
    if any(part in _TEST_DIRS for part in parts):
        return True
    if p.suffix == ".java" and "test" in parts:  # Maven src/test/java
        return True
    return bool(_TEST_NAME_RE.search(p.name))


def _tag_repo(item: dict, repo: str) -> None:
    item["repo"] = repo
    if "gid" not in item and "id" in item:
        # gid stays globally unique; repo tag lives in its own property
        item["gid"] = item["id"]


def _namespace_repo(repo: str, nodes: list[dict], edges: list[dict],
                    pending: list[dict], calls: list[tuple]) -> list[tuple]:
    """Prefix every node id of ``repo`` with ``<repo>::``.

    Ids come from file stems, so ``index.ts`` / ``route.ts`` / same-named
    files in different repos used to collapse into one node and produce
    false cross-repo edges. References to ids that are not nodes of this repo
    are left untouched. Returns the rewritten ``calls`` list.
    """
    ids = {n["id"] for n in nodes if "id" in n}

    def ns(i):
        return f"{repo}::{i}" if i in ids else i

    for n in nodes:
        if "gid" in n:
            n["gid"] = ns(n["gid"])
        n["id"] = ns(n["id"])
    for e in edges:
        e["source"] = ns(e.get("source"))
        e["target"] = ns(e.get("target"))
    for p in pending:
        p["source"] = ns(p["source"])
    return [(ns(s), c, ln, f) for s, c, ln, f in calls]


def build_repos(repos: list[dict]) -> dict:
    """Build a merged, repo-tagged extraction for ``[{name, path}]``.

    Returns the merged extraction dict (with framework ``pending_edges``
    resolved to real ``fetches`` edges where a matching endpoint exists).
    """
    all_nodes: list[dict] = []
    all_edges: list[dict] = []
    repo_fw: dict[str, dict] = {}  # repo name -> merged framework info

    files_by_repo = {r["name"]: collect_repo_files(Path(r["path"])) for r in repos}
    svc_calls: list[dict] = []  # files that read <X>_XAPI_BASE_URL (service-to-service calls)

    for repo in repos:
        name = repo["name"]
        root = Path(repo["path"])
        files = files_by_repo[name]

        base = extract(files)
        if base.get("error"):
            print(f"[codegraph] warning: base extraction issue for {name}: {base['error']}", file=sys.stderr)

        fw_nodes: list[dict] = []
        fw_edges: list[dict] = []
        fw_pending: list[dict] = []
        api_clients: dict[str, list[str]] = {}
        client_calls: list[tuple[str, str, int, str]] = []  # (source_nid, callee, line, file)
        prefix_by_file = fastify_prefixes(files)  # Fastify plugin URL prefixes
        java_base = spring_base_path(root)  # spring.webflux.base-path
        for f in files:
            if _is_test_file(f):
                continue
            if f.suffix == ".java":
                sp = extract_spring(f, name, java_base)
                fw_nodes.extend(sp["nodes"])
                fw_edges.extend(sp["edges"])
            if f.suffix in JS_SUFFIXES:
                sc = find_service_calls(f)
                if sc:
                    svc_calls.append({"repo": name, "file": str(f),
                                      "file_nid": f"{name}::{_make_id(f.stem)}", **sc})
                fw = extract_frameworks(f, name, prefix_by_file.get(str(f.resolve()), ""))
                nx = extract_next(f, name)  # Next.js route.ts / page.tsx
                fw_nodes.extend(fw["nodes"] + nx["nodes"])
                fw_edges.extend(fw["edges"] + nx["edges"])
                fw_pending.extend(fw["pending_edges"])
                for k, v in fw["api_clients"].items():
                    api_clients.setdefault(k, [])
                    for p in v:
                        if p not in api_clients[k]:
                            api_clients[k].append(p)
                for src_nid, callee, line in fw["client_calls"]:
                    client_calls.append((src_nid, callee, line, str(f)))
        client_calls = _namespace_repo(
            name,
            base.get("nodes", []) + fw_nodes,
            base.get("edges", []) + fw_edges,
            fw_pending,
            client_calls,
        )
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

    # ── package graph: publishable packages + who depends on / imports them ──
    pkg_nodes, pkg_edges = package_graph(files_by_repo)
    for n in pkg_nodes:
        _tag_repo(n, n["repo"])
    for e in pkg_edges:
        _tag_repo(e, e["repo"])
    all_nodes.extend(pkg_nodes)
    all_edges.extend(pkg_edges)

    # ── link pass: resolve fetches to endpoint nodes ──────────────────────
    # endpoint registry: (method, path) -> node id
    endpoints: list[tuple[str, str, str]] = []
    for n in all_nodes:
        if n.get("node_type") == "endpoint":
            endpoints.append((n.get("method", "GET"), n.get("path", ""), n["id"]))

    # ── proxy links: a Next.js catch-all route whose URL names another repo
    # (e.g. /api-replatform/v1/selection-xapi/[...path] -> tb-selection-xapi)
    # forwards to that repo's endpoints.
    repo_names = [r["name"] for r in repos]
    endpoint_nodes = [n for n in all_nodes if n.get("node_type") == "endpoint"]

    # ── service dependencies: a file reading <X>_XAPI_BASE_URL calls tb-<x>-xapi ──
    node_ids = {n["id"] for n in all_nodes}
    registered = set(repo_names)
    svc_nodes: dict[str, dict] = {}
    eps_by_repo: dict[str, list[tuple[list[str], dict]]] = {}
    for t in endpoint_nodes:
        segs = [s for s in t.get("path", "").split("/") if s]
        eps_by_repo.setdefault(t.get("repo"), []).append((segs, t))

    for call in svc_calls:
        if call["file_nid"] not in node_ids:
            continue
        for target, line in call["services"].items():
            if target == call["repo"]:
                continue
            sid = service_id(target)
            if sid not in svc_nodes:
                real = target in registered
                svc_nodes[sid] = {
                    "id": sid, "label": target, "file_type": "code", "node_type": "service",
                    "source_file": "", "source_location": "L1", "external": not real,
                }
                _tag_repo(svc_nodes[sid], target if real else "external")
            all_edges.append({
                "source": call["file_nid"], "target": sid, "relation": "calls_service",
                "confidence": "EXTRACTED", "source_file": call["file"],
                "source_location": f"L{line}", "weight": 1.0, "repo": call["repo"],
            })
            # narrow to the target's real endpoints using the path literals in this file
            svc_name = target.replace("tb-", "", 1)  # e.g. marketing-xapi
            for ep_segs, ep in eps_by_repo.get(target, []):
                rel = ep_segs[2:] if ep_segs[:2] == ["api", svc_name] else ep_segs
                if not rel:
                    continue
                best = None
                for lit in call["literals"]:
                    lit = lit[1:] if lit and lit[0] == svc_name else lit
                    kind = match_endpoint(rel, lit)
                    if kind == "exact":
                        best = "exact"
                        break
                    if kind == "prefix":
                        best = "prefix"
                if best:
                    all_edges.append({
                        "source": call["file_nid"], "target": ep["id"], "relation": "fetches",
                        "confidence": "INFERRED", "source_file": call["file"],
                        "source_location": f"L{line}", "weight": 0.8 if best == "exact" else 0.5,
                        "repo": call["repo"],
                    })
    all_nodes.extend(svc_nodes.values())

    # Second rule: the catch-all's static URL prefix covers another repo's
    # endpoints (e.g. /api/common/store-locator/:path* -> /api/common/store-locator/...).
    # Needs >= 2 static segments so a bare /api/:path* does not link to everything.
    for n in endpoint_nodes:
        if not n.get("catch_all"):
            continue
        prefix: list[str] = []
        for s in (s for s in n.get("path", "").split("/") if s):
            if s.startswith(":"):
                break
            prefix.append(s)
        if len(prefix) < 2:
            continue
        for t in endpoint_nodes:
            if t.get("repo") == n.get("repo") or t is n:
                continue
            tsegs = [s for s in t.get("path", "").split("/") if s]
            if len(tsegs) > len(prefix) and tsegs[: len(prefix)] == prefix:
                all_edges.append({
                    "source": n["id"], "target": t["id"],
                    "relation": "proxies_to", "confidence": "INFERRED",
                    "source_file": n.get("source_file", ""),
                    "source_location": n.get("source_location", "L1"),
                    "weight": 0.7, "repo": n.get("repo"),
                })

    for n in endpoint_nodes:
        if not n.get("catch_all"):
            continue
        segs = [s for s in n.get("path", "").split("/") if s]
        for target_repo in repo_names:
            if target_repo == n.get("repo"):
                continue
            if any(s == target_repo or target_repo.endswith("-" + s) for s in segs):
                for t in endpoint_nodes:
                    if t.get("repo") == target_repo:
                        all_edges.append({
                            "source": n["id"], "target": t["id"],
                            "relation": "proxies_to", "confidence": "INFERRED",
                            "source_file": n.get("source_file", ""),
                            "source_location": n.get("source_location", "L1"),
                            "weight": 0.8, "repo": n.get("repo"),
                        })

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
