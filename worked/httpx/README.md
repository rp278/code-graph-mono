# httpx Corpus Benchmark — How to Reproduce

A synthetic 6-file Python codebase modeled after httpx's architecture. Tests graphify
on a realistic library codebase with clean layering: exceptions → models → auth/transport → client.

## Corpus (6 files)

All input files are in `raw/`:

```
raw/
├── exceptions.py   — full HTTPError hierarchy (RequestError, TransportError, HTTPStatusError, etc.)
├── models.py       — URL, Headers, Cookies, Request, Response with raise_for_status
├── auth.py         — BasicAuth, BearerAuth, DigestAuth (challenge-response), NetRCAuth
├── utils.py        — header normalization, query param flattening, content-type parsing
├── transport.py    — ConnectionPool, HTTPTransport, AsyncHTTPTransport, MockTransport, ProxyTransport
└── client.py       — Timeout, Limits, BaseClient, Client (sync), AsyncClient
```

## How to run

```bash
pip install graphifyy && graphify install
/graphify ./raw
```

Or from the CLI directly:

```bash
pip install graphifyy
graphify ./raw
```

## What to expect

- ~95 nodes, ~130 edges
- 4 communities: Exception Hierarchy, Models & Data, Auth & Transport, Client Layer
- God nodes: `client.py`, `models.py`, `transport.py`, `exceptions.py`, `BaseClient`, `Response`
- Surprising connections: `DigestAuth` ↔ `Response` (auth.py reads Response to parse WWW-Authenticate)
- All edges EXTRACTED — no inference needed, dependency graph is explicit

Full eval with scores and analysis: `review.md`
