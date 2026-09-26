# codegraph-web

React dashboard for **codeGraph** — the AI agent that maps your codebase into a
knowledge graph stored in Neo4j.

## What it does

- **Graph tab** — interactive visualization of the knowledge graph
  (`@xyflow/react` canvas with dagre auto-layout): repo selector, node-type
  legend, label search with dim/highlight, click-to-inspect node details with
  neighbor connections, minimap, pan/zoom.
- **Ask AI tab** — chat against the graph. When no LLM key is configured on the
  backend, answers fall back to retrieved graph context shown as clickable
  chips that jump back to the graph and highlight the node.
- **Rebuild** — re-scan the selected repo and rebuild its graph from the header.

## Prerequisites

The `codegraph-api` backend must be running (default `http://127.0.0.1:8000`).

## Run

```bash
npm install
npm run dev      # -> http://localhost:5173
```

Point at a different backend with `VITE_API_URL`:

```bash
VITE_API_URL=http://my-api:8000 npm run dev
# or copy .env.example to .env and edit it
```

## Build

```bash
npm run build    # -> dist/
npm run preview  # serve the production build locally
```

## Stack

Vite + React 19, `@xyflow/react` v12 (graph canvas), `dagre` (auto-layout),
plain CSS dark theme. No UI framework.
