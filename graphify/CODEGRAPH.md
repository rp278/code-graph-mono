# CODEGRAPH.md — codeGraph framework layer (graphify fork)

This fork extends upstream Graphify with a **framework-aware extraction layer**
built for [codeGraph](https://github.com/techfxs/codegraph): a multi-repo code
intelligence tool that merges per-repository graphs into one Neo4j database and
grounds an AI agent's answers in real code structure.

Upstream Graphify provides deterministic AST extraction (`extract.py`),
graph building, clustering, and reporting. This fork adds:

| Module | Purpose |
|---|---|
| `graphify/extract_frameworks.py` | Fastify route, React component/page, and SQL table extraction (tree-sitter + regex) |
| `graphify/codegraph.py` | Multi-repo build entry: `[{name, path}]` registry, repo tagging, cross-repo `fetches` link pass, CLI |
| `graphify/export_neo4j.py` | Neo4j exporter with `Repo` roots, repo-scoped idempotent replacement, env-overridable connection |

Plus `.jsx` support in `collect_files()` (`extract.py`), `CODE_EXTENSIONS`
(`detect.py`), and the watch lists (`watch.py`).

## Usage

```bash
# 1. describe your repos
cat > repos.json <<'EOF'
[
  {"name": "shop-api", "path": "/path/to/shop-api"},
  {"name": "shop-web", "path": "/path/to/shop-web"}
]
EOF

# 2. build the merged graph
python -m graphify.codegraph --repos repos.json --out merged.json

# 3. load it into Neo4j (connection via NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD,
#    defaults: bolt://localhost:7687, neo4j / neo4j)
python -m graphify.codegraph --repos repos.json --push
```

## Graph model

**Node types** (`node_type` property; every node also carries `repo`):

- `endpoint` — `endpoint:GET:/api/products/:id`, with `method` and `path` props.
  Created from `fastify.get/post/put/delete/patch(...)` (also `app.*`) calls.
  The route receiver must be literally `fastify`/`app`/`server`/`router`/`api`,
  so `db.prepare(...).get(...)` chains are not misread as routes.
- `component` — capitalized functions returning JSX (declarations and arrow
  consts, incl. `export default function`).
- `page` — `page:/products`, from `<Route path="..." element={<X/>} />`.
- `table` — `table:products`, from `CREATE TABLE` statements.
- plus all upstream AST nodes (files, functions, imports, …).

**Edge types** (new): `exposes_endpoint` (file → endpoint), `handled_by`
(endpoint → named handler fn), `fetches` (component/file → endpoint, INFERRED),
`route` (component → page), `reads_table` / `writes_table` (file → table).

**Cross-repo linking.** A frontend rarely calls `fetch('/api/...')` directly;
it goes through an API-client module (`api.js`). The build therefore works in
two passes: per-file extraction records which wrapper functions hit which
`/api/` paths (`api_clients`) and every plain identifier call (`client_calls`);
the link pass then resolves wrapper calls to the concrete `endpoint` nodes —
across repositories — with segment-wise matching where `:param` segments act
as wildcards (`/api/products/${id}` matches `GET /api/products/:id`).

**Neo4j layout.** Each repo gets a `Repo` root node; every entity is a `Node`
with a globally-unique `gid`, its `repo` tag, and a `CONTAINS` edge from its
repo root. Re-pushing a repo deletes only that repo's `Node` subgraph first,
so reloads are idempotent per repo and never disturb other repos.

## Example queries

```cypher
-- which frontend components hit the products API, across repos?
MATCH (c:Node)-[:FETCHES]->(e:Node)
WHERE c.repo <> e.repo
RETURN c.label, c.repo, e.label, e.repo;

-- trace a page to the data it reads
MATCH (page:Node {gid:'page:/products'})<-[:ROUTE]-(comp:Node)
      -[:FETCHES]->(ep:Node)<-[:EXPOSES_ENDPOINT]-(srv:Node)
RETURN page.label, comp.label, ep.label, srv.repo;

-- inventory per repo
MATCH (n:Node) RETURN n.repo AS repo, n.type AS type, count(*) AS c
ORDER BY repo, type;
```

## Verified against

`shop-api` (Fastify + SQLite) and `shop-web` (React) produce 40 nodes /
52 edges in Neo4j, including 7 `endpoint` nodes, 9 `component` nodes,
4 `page` nodes, 1 `table` node, and 7 cross-repo `fetches` edges
(e.g. `ProductList [shop-web] -[:FETCHES]-> GET /api/products [shop-api]`).

## Known limitations

- The upstream JS extractor models ES `import` but not CommonJS `require()`,
  so `server.js → require('./db')` has no `imports_from` edge yet.
- `fetches` resolution is path-based; two repos exposing the same
  `method + path` share one `endpoint` node (first repo wins the `repo` tag).
- Endpoint path matching is segment-wise; numeric segments (`/42`) are treated
  as `:param`, which is a heuristic tuned for REST-style APIs.
