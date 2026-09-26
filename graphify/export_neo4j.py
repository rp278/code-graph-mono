"""Neo4j exporter for codeGraph.

Loads a merged multi-repo extraction into Neo4j with repository roots:

- ``Repo`` node per repository (``MERGE``d by name)
- ``Node`` node per entity with a globally-unique ``gid``, tagged with its repo
- ``CONTAINS`` edges from each ``Repo`` root to its nodes
- relationship edges between ``Node`` entities

Reloading a repo replaces only that repo's subgraph (idempotent per repo).
Connection details are overridable via NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD.
"""
from __future__ import annotations

import os
import re


def _config(uri=None, user=None, password=None):
    return (
        uri or os.environ.get("NEO4J_URI", "bolt://localhost:7687"),
        user or os.environ.get("NEO4J_USER", "neo4j"),
        password or os.environ.get("NEO4J_PASSWORD", "neo4j"),
    )


def _rel_type(relation: str) -> str:
    t = re.sub(r"[^A-Z0-9_]", "_", (relation or "RELATED").upper())
    return t or "RELATED"


def _node_props(n: dict, repo: str) -> dict:
    props = {
        "gid": n.get("gid", n["id"]),
        "label": n.get("label", n.get("id", "")),
        "type": n.get("node_type") or n.get("file_type", "code"),
        "source_file": n.get("source_file", ""),
        "source_location": n.get("source_location", ""),
        "repo": repo,
    }
    for k, v in n.items():
        if k not in props and isinstance(v, (str, int, float, bool)):
            props[k] = v
    return props


def push_codegraph(extraction: dict, uri=None, user=None, password=None) -> dict:
    """Push a merged extraction (nodes/edges already repo-tagged) to Neo4j.

    Repos are derived from the ``repo`` attribute on each node. For every repo
    present, that repo's existing ``Node`` subgraph is deleted before loading,
    making the push idempotent per repo while leaving other repos untouched.
    Returns a stats dict.
    """
    from neo4j import GraphDatabase

    uri, user, password = _config(uri, user, password)
    nodes = extraction.get("nodes", [])
    edges = extraction.get("edges", [])

    # dedupe nodes by gid (framework pass may re-declare base AST nodes)
    by_gid: dict[str, dict] = {}
    for n in nodes:
        gid = n.get("gid", n["id"])
        if gid in by_gid:
            by_gid[gid].update({k: v for k, v in n.items() if v is not None})
        else:
            by_gid[gid] = dict(n)
    nodes = list(by_gid.values())

    repos = sorted({n.get("repo", "unknown") for n in nodes})

    stats = {"repos": repos, "nodes": 0, "edges": 0, "skipped_edges": 0}
    driver = GraphDatabase.driver(uri, auth=(user, password))
    try:
        with driver.session() as session:
            # 1. per-repo replacement: delete this repo's nodes (Repo root persists)
            for repo in repos:
                session.run(
                    "MATCH (n:Node {repo: $repo}) DETACH DELETE n",
                    repo=repo,
                ).consume()
                session.run("MERGE (r:Repo {name: $repo})", repo=repo).consume()

            # 2. load nodes + CONTAINS edges
            for n in nodes:
                repo = n.get("repo", "unknown")
                props = _node_props(n, repo)
                session.run(
                    """
                    MERGE (r:Repo {name: $repo})
                    MERGE (n:Node {gid: $gid})
                    SET n += $props
                    MERGE (r)-[:CONTAINS]->(n)
                    """,
                    repo=repo,
                    gid=props["gid"],
                    props=props,
                ).consume()
                stats["nodes"] += 1

            # 3. load edges between Node entities
            gids = {n.get("gid", n["id"]) for n in nodes}
            for e in edges:
                src = e.get("source")
                tgt = e.get("target")
                if not src or not tgt or src not in gids or tgt not in gids:
                    stats["skipped_edges"] += 1
                    continue
                rel = _rel_type(e.get("relation", "RELATED"))
                eprops = {
                    "confidence": e.get("confidence", "INFERRED"),
                    "source_file": e.get("source_file", ""),
                    "source_location": e.get("source_location", ""),
                    "weight": float(e.get("weight", 1.0)),
                }
                session.run(
                    f"""
                    MATCH (a:Node {{gid: $src}}), (b:Node {{gid: $tgt}})
                    MERGE (a)-[r:{rel}]->(b)
                    SET r += $props
                    """,
                    src=src,
                    tgt=tgt,
                    props=eprops,
                ).consume()
                stats["edges"] += 1
    finally:
        driver.close()
    return stats


def repo_counts(uri=None, user=None, password=None) -> list[dict]:
    """Return node counts grouped by repo and type (verification helper)."""
    from neo4j import GraphDatabase

    uri, user, password = _config(uri, user, password)
    driver = GraphDatabase.driver(uri, auth=(user, password))
    try:
        with driver.session() as session:
            result = session.run(
                "MATCH (n:Node) RETURN n.repo AS repo, n.type AS type, count(*) AS c "
                "ORDER BY repo, type"
            )
            return [dict(r) for r in result]
    finally:
        driver.close()
