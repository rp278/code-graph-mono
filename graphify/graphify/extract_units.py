"""Workspace units: the apps/ and packages/ inside a monorepo.

Some repos are only a wrapper around several deployables and libraries
(e.g. ``tb-common-mfe`` holds ``apps/tb-global-navigation`` plus a dozen
``packages/*``). Treating the whole repo as one blob hides which *app* a
piece of code belongs to. This pass:

* tags every node of such a repo with ``unit`` (``apps/tb-global-navigation``),
  ``unit_kind`` (``app`` | ``package``) and ``deployable`` (has a Dockerfile);
* adds one node per unit (``node_type`` = ``app`` / ``workspace_package``);
* adds aggregated ``depends_on`` edges between units, weighted by how many
  import edges connect them, so "which app pulls in which package" is one
  hop instead of hundreds.

Repos without ``apps/<x>/`` or ``packages/<x>/`` folders are left untouched.
"""
from __future__ import annotations

import re
from collections import Counter
from pathlib import Path

UNIT_DIRS = {"apps": "app", "packages": "package", "libs": "package"}
_IMPORT_RELATIONS = {"imports_from", "imports"}


def unit_of(root: Path, source_file: str) -> str | None:
    """``apps/<name>`` / ``packages/<name>`` for a file inside ``root``, else None."""
    if not source_file:
        return None
    try:
        rel = Path(source_file).resolve().relative_to(root.resolve())
    except (ValueError, OSError):
        return None
    parts = rel.parts
    if len(parts) >= 3 and parts[0] in UNIT_DIRS:
        return f"{parts[0]}/{parts[1]}"
    return None


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


def annotate_units(repo: str, root: Path, nodes: list[dict], edges: list[dict]) -> tuple[list[dict], list[dict]]:
    """Tag ``nodes`` (all of one repo) with their unit; return (unit_nodes, unit_edges)."""
    unit_by_node: dict[str, str] = {}
    for n in nodes:
        u = unit_of(root, n.get("source_file", ""))
        if u:
            n["unit"] = u
            n["unit_kind"] = UNIT_DIRS[u.split("/")[0]]
            unit_by_node[n["id"]] = u
    if not unit_by_node:
        return [], []

    units = sorted(set(unit_by_node.values()))
    counts = Counter(unit_by_node.values())
    unit_nodes: list[dict] = []
    uid: dict[str, str] = {}
    for u in units:
        kind = UNIT_DIRS[u.split("/")[0]]
        d = root / u
        uid[u] = f"{repo}::unit_{_slug(u)}"
        unit_nodes.append({
            "id": uid[u],
            "label": u.split("/", 1)[1],
            "file_type": "code",
            "node_type": "app" if kind == "app" else "workspace_package",
            "source_file": str(d),
            "source_location": "L1",
            "unit": u,
            "unit_kind": kind,
            "deployable": (d / "Dockerfile").exists(),
            "file_count_nodes": counts[u],
            "repo": repo,
            "gid": uid[u],
        })

    dep: Counter = Counter()
    for e in edges:
        if e.get("relation") not in _IMPORT_RELATIONS:
            continue
        a, b = unit_by_node.get(e.get("source")), unit_by_node.get(e.get("target"))
        if a and b and a != b:
            dep[(a, b)] += 1
    unit_edges = [
        {
            "source": uid[a], "target": uid[b], "relation": "depends_on",
            "confidence": "EXTRACTED", "source_file": "", "source_location": "L1",
            "weight": float(c), "import_count": c, "repo": repo,
        }
        for (a, b), c in sorted(dep.items())
    ]
    return unit_nodes, unit_edges
