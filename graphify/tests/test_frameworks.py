"""Tests for the codeGraph framework extractors: Fastify, React, SQL."""
from __future__ import annotations
from pathlib import Path
import pytest

from graphify.extract_frameworks import (
    extract_fastify, extract_react, extract_sql, extract_frameworks,
    _api_path_from_arg, _path_matches, _endpoint_id,
)
from graphify.codegraph import build_repos

FIXTURES = Path(__file__).parent / "fixtures"


def _node_map(r):
    return {n["id"]: n for n in r["nodes"]}


def _edges(r, relation=None):
    if relation:
        return [e for e in r["edges"] if e["relation"] == relation]
    return r["edges"]


def _edge_pairs(r, relation):
    nm = _node_map(r)
    return {
        (nm.get(e["source"], {}).get("label", e["source"]),
         nm.get(e["target"], {}).get("label", e["target"]))
        for e in _edges(r, relation)
    }


# ── Fastify ─────────────────────────────────────────────────────────────────

def test_fastify_finds_routes():
    r = extract_fastify(FIXTURES / "sample_fastify.js", "test-repo")
    labels = [n["label"] for n in r["nodes"]]
    assert "GET /api/widgets" in labels
    assert "POST /api/widgets" in labels
    assert "GET /api/widgets/:id" in labels


def test_fastify_endpoint_ids():
    r = extract_fastify(FIXTURES / "sample_fastify.js", "test-repo")
    ids = {n["id"] for n in r["nodes"]}
    assert "endpoint:GET:/api/widgets" in ids
    assert "endpoint:POST:/api/widgets" in ids


def test_fastify_exposes_edges():
    r = extract_fastify(FIXTURES / "sample_fastify.js", "test-repo")
    assert len(_edges(r, "exposes_endpoint")) == 3


def test_fastify_named_handler_edge():
    r = extract_fastify(FIXTURES / "sample_fastify.js", "test-repo")
    handled = _edges(r, "handled_by")
    assert len(handled) == 1
    assert "listwidgets" in handled[0]["target"].lower()


def test_fastify_ignores_db_chains():
    # db.prepare(...).get(...) must not be mistaken for fastify.get(...)
    r = extract_fastify(FIXTURES / "sample_fastify.js", "test-repo")
    labels = [n["label"] for n in r["nodes"]]
    assert not any(l.startswith("GET") and "widgets" not in l for l in labels)
    assert len(_edges(r, "exposes_endpoint")) == 3


def test_fastify_no_dangling_edges():
    r = extract_fastify(FIXTURES / "sample_fastify.js", "test-repo")
    ids = {n["id"] for n in r["nodes"]}
    ids.add("sample_fastify")  # file node id (created by base extraction)
    for e in r["edges"]:
        assert e["source"] in ids, e
        # handled_by may point at function nodes created by base extraction
        if e["relation"] != "handled_by":
            assert e["target"] in ids, e


# ── React ───────────────────────────────────────────────────────────────────

def test_react_finds_components():
    r = extract_react(FIXTURES / "sample_react.jsx", "test-repo")
    comps = {n["label"] for n in r["nodes"] if n.get("node_type") == "component"}
    assert {"WidgetList", "WidgetDetail", "NotFound", "App"} <= comps


def test_react_lowercase_helper_not_component():
    r = extract_react(FIXTURES / "sample_react.jsx", "test-repo")
    comps = {n["label"] for n in r["nodes"] if n.get("node_type") == "component"}
    assert "request" not in comps
    assert "fetchWidgets" not in comps


def test_react_finds_pages_and_route_edges():
    r = extract_react(FIXTURES / "sample_react.jsx", "test-repo")
    pages = {n["label"] for n in r["nodes"] if n.get("node_type") == "page"}
    assert "Page /widgets" in pages
    assert "Page /widgets/:id" in pages
    assert "Page *" in pages
    routes = _edges(r, "route")
    assert len(routes) == 3


def test_react_records_api_clients():
    r = extract_react(FIXTURES / "sample_react.jsx", "test-repo")
    assert r["api_clients"]["fetchWidgets"] == ["/api/widgets"]


def test_react_pending_fetches():
    r = extract_react(FIXTURES / "sample_react.jsx", "test-repo")
    pending = r["pending_edges"]
    # WidgetDetail's direct fetch(`/api/widgets/42`) -> normalized to /api/widgets/:param
    by_path = {p["pending_path"] for p in pending}
    assert "/api/widgets/:param" in by_path
    # request() wrapper call inside fetchWidgets is recorded as api_client, and
    # also appears as a pending edge from the file (fetch wrapper)
    assert "/api/widgets" in by_path


# ── SQL ─────────────────────────────────────────────────────────────────────

def test_sql_finds_table():
    r = extract_sql(FIXTURES / "sample_fastify.js", "test-repo")
    tables = {n["label"] for n in r["nodes"] if n.get("node_type") == "table"}
    assert tables == {"widgets"}


def test_sql_reads_and_writes():
    r = extract_sql(FIXTURES / "sample_fastify.js", "test-repo")
    assert len(_edges(r, "reads_table")) == 1
    assert len(_edges(r, "writes_table")) == 1


# ── path helpers ────────────────────────────────────────────────────────────

def test_endpoint_id():
    assert _endpoint_id("get", "/api/products/:id") == "endpoint:GET:/api/products/:id"


def test_path_matches():
    assert _path_matches("/api/products/:id", "/api/products/:param")
    assert _path_matches("/api/products", "/api/products")
    assert not _path_matches("/api/products", "/api/products/:param")
    assert not _path_matches("/api/categories", "/api/products")


# ── combined + multi-repo build ──────────────────────────────────────────────

def test_extract_frameworks_combined():
    r = extract_frameworks(FIXTURES / "sample_fastify.js", "test-repo")
    types = {n.get("node_type") for n in r["nodes"]}
    assert {"endpoint", "table"} <= types


def test_build_repos_links_fetches(tmp_path):
    # two tiny repos: an API repo and a web repo using an api-client wrapper
    api = tmp_path / "mini-api"
    api.mkdir()
    (api / "server.js").write_text(
        "const fastify = require('fastify')();\n"
        "fastify.get('/api/widgets', async () => []);\n"
        "fastify.get('/api/widgets/:id', async () => ({}));\n"
    )
    web = tmp_path / "mini-web"
    web.mkdir()
    (web / "api.js").write_text(
        "export async function fetchWidgets() {\n"
        "  const r = await fetch('/api/widgets');\n"
        "  return r.json();\n"
        "}\n"
    )
    (web / "List.jsx").write_text(
        "export function WidgetList() {\n"
        "  fetchWidgets();\n"
        "  return <ul><li>x</li></ul>;\n"
        "}\n"
    )
    merged = build_repos([
        {"name": "mini-api", "path": str(api)},
        {"name": "mini-web", "path": str(web)},
    ])
    assert not merged.get("error")
    repos = {n["repo"] for n in merged["nodes"]}
    assert repos == {"mini-api", "mini-web"}

    nm = {n["id"]: n for n in merged["nodes"]}
    fetches = [e for e in merged["edges"] if e["relation"] == "fetches"]
    assert fetches, "expected at least one fetches edge"
    # cross-repo: component in mini-web -> endpoint in mini-api
    cross = [
        e for e in fetches
        if nm[e["source"]].get("repo") == "mini-web"
        and nm[e["target"]].get("repo") == "mini-api"
    ]
    assert cross, "expected a cross-repo fetches edge"
    targets = {nm[e["target"]]["label"] for e in cross}
    assert "GET /api/widgets" in targets
