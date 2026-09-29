"""npm package graph for codeGraph.

Turns every ``package.json`` that has a ``name`` into a ``package`` node and
connects them:

- ``depends_on``: package.json -> package, for dependencies that are themselves
  packages in the workspace (props: ``version_spec`` pinned by the consumer,
  ``latest`` = the version currently in source, ``drift`` = they differ)
- ``uses_package``: consuming package -> package, one edge per pair aggregated
  from real ``import`` / ``require`` statements (prop: ``count``)

The consuming package is the nearest ancestor folder that has a package.json,
so usage is attributed to e.g. ``packages/signin-signup`` rather than to the
repo root. Imports of a package in a known internal scope (e.g. ``@MensWearhouse/``)
whose source is not part of the workspace become an ``external`` stub node, so
they still show up as a dependency instead of being silently dropped.

Package ids are ``package:<name>`` and are global on purpose: one package, one
node, no matter how many repos use it.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

JS_SUFFIXES = {".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"}
DEP_FIELDS = ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies")

# from 'x' | import 'x' | import('x') | require('x')  -> package name (scoped or not)
_SPEC_RE = re.compile(
    r"""(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]((?:@[\w.-]+/)?[\w.-]+)(?:/[^'"]*)?['"]"""
)


def package_id(name: str) -> str:
    return f"package:{name}"


def _is_drift(spec: str, latest: str) -> bool:
    spec = (spec or "").strip()
    if not spec or not latest:
        return False
    if spec in ("*", "latest") or spec.startswith(("workspace:", "file:", "link:", "npm:", "git", "http")):
        return False
    if spec.startswith(">="):  # open-ended range: the current version satisfies it
        return False
    core = spec.lstrip("^~<>= ").split(" ")[0]
    if not core or not core[0].isdigit():
        return False
    return core != latest


def discover_packages(files_by_repo: dict[str, list[Path]]):
    """Return (pkg_nodes, units, by_name).

    units: {package.json folder -> package name}, by_name: {name -> node}."""
    nodes: list[dict] = []
    units: dict[Path, str] = {}
    by_name: dict[str, dict] = {}
    for repo, files in files_by_repo.items():
        for f in files:
            if f.name != "package.json":
                continue
            try:
                data = json.loads(f.read_text(encoding="utf-8", errors="replace"))
            except (OSError, ValueError):
                continue
            name = data.get("name")
            if not isinstance(name, str) or not name:
                continue
            units[f.parent] = name
            if name in by_name:
                continue
            node = {
                "id": package_id(name),
                "label": name,
                "file_type": "code",
                "node_type": "package",
                "source_file": str(f),
                "source_location": "L1",
                "version": str(data.get("version", "")),
                "private": bool(data.get("private", False)),
                "external": False,
                "repo": repo,
                "_deps": {
                    k: v
                    for field in DEP_FIELDS
                    for k, v in (data.get(field) or {}).items()
                    if isinstance(v, str)
                },
            }
            by_name[name] = node
            nodes.append(node)
    return nodes, units, by_name


def package_graph(files_by_repo: dict[str, list[Path]]):
    """Build package nodes and edges for all repos. Returns (nodes, edges)."""
    nodes, units, by_name = discover_packages(files_by_repo)
    if not nodes:
        return [], []

    scopes = {n["label"].split("/")[0] for n in nodes if n["label"].startswith("@")}
    edges: list[dict] = []
    stubs: dict[str, dict] = {}

    def target_for(name: str, repo: str) -> str | None:
        """Node id for a package name, creating an external stub for internal-scope names."""
        if name in by_name:
            return by_name[name]["id"]
        if name.startswith("@") and name.split("/")[0] in scopes:
            if name not in stubs:
                stubs[name] = {
                    "id": package_id(name), "label": name, "file_type": "code",
                    "node_type": "package", "source_file": "", "source_location": "L1",
                    "version": "", "private": False, "external": True, "repo": "external",
                }
            return stubs[name]["id"]
        return None

    def edge(src, tgt, relation, source_file, repo, **extra):
        e = {"source": src, "target": tgt, "relation": relation, "confidence": "EXTRACTED",
             "source_file": source_file, "source_location": "L1", "weight": 1.0, "repo": repo}
        e.update(extra)
        edges.append(e)

    # 1. declared dependencies (package.json -> package)
    for n in nodes:
        for dep, spec in n["_deps"].items():
            tgt = target_for(dep, n["repo"])
            if tgt is None or tgt == n["id"]:
                continue
            latest = by_name[dep]["version"] if dep in by_name else ""
            edge(n["id"], tgt, "depends_on", n["source_file"], n["repo"],
                 version_spec=spec, latest=latest, drift=_is_drift(spec, latest))

    # 2. real imports (consuming package -> package), aggregated per pair
    unit_dirs = set(units)
    counts: dict[tuple[str, str], dict] = {}
    for repo, files in files_by_repo.items():
        for f in files:
            if f.suffix not in JS_SUFFIXES:
                continue
            owner = None
            for parent in f.parents:
                if parent in unit_dirs:
                    owner = units[parent]
                    break
            if owner is None:
                continue
            try:
                text = f.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            if "from" not in text and "require" not in text and "import" not in text:
                continue
            for m in _SPEC_RE.finditer(text):
                name = m.group(1)
                if name == owner or (name not in by_name and not name.startswith("@")):
                    continue
                tgt = target_for(name, repo)
                if tgt is None:
                    continue
                key = (package_id(owner), tgt)
                rec = counts.setdefault(key, {"count": 0, "file": str(f), "repo": repo})
                rec["count"] += 1
    for (src, tgt), rec in counts.items():
        edge(src, tgt, "uses_package", rec["file"], rec["repo"], count=rec["count"])

    for n in nodes:
        n.pop("_deps", None)
    return nodes + list(stubs.values()), edges
