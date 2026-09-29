"""Service-to-service dependencies for codeGraph.

A frontend/BFF reaches another service through a base URL read from the
environment, e.g. ``process.env.MARKETING_XAPI_BASE_URL`` or
``NEXT_PUBLIC_SELECTION_XAPI_BACKEND_URL``. That never shows up as a literal
``/api/...`` URL, so the fetch extractor cannot link it. Here we:

1. detect ``<X>_XAPI_BASE_URL`` / ``NEXT_PUBLIC_<X>_XAPI_BACKEND_URL`` in a file
   -> that file calls service ``tb-<x>-xapi`` (edge ``calls_service`` to a
   ``service`` node that lives in the target repo);
2. collect the path literals of the same file (``/v1/content/${path}``,
   ``/feature-flags/${brand}``...) so the caller can narrow the dependency to the
   target's real endpoints.

A service that is not one of the registered repos (e.g. ``tb-txn-util-xapi``)
becomes an ``external`` stub so the dependency is still visible.
"""
from __future__ import annotations

import re
from pathlib import Path

from .extract_frameworks import _normalize_template

# DISCOVERY_XAPI_BASE_URL, NEXT_PUBLIC_SELECTION_XAPI_BACKEND_URL, TXN_UTIL_XAPI_BASE_URL
ENV_RE = re.compile(r"\b(?:NEXT_PUBLIC_)?([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*?)_XAPI_(?:BASE|BACKEND)_URL\b")
_STRING_RE = re.compile(r"""'([^'\n]{2,200})'|"([^"\n]{2,200})"|`([^`]{2,200})`""")
_SEGMENT_RE = re.compile(r"^[\w\-.:]+$")


def service_repo_name(env_prefix: str) -> str:
    """``TXN_UTIL`` -> ``tb-txn-util-xapi``."""
    return f"tb-{env_prefix.lower().replace('_', '-')}-xapi"


def service_id(repo: str) -> str:
    return f"service:{repo}"


def _path_literals(text: str) -> list[list[str]]:
    """Normalised path literals of a file, as segment lists (``:param`` for ``${..}``)."""
    out: list[list[str]] = []
    seen: set[tuple] = set()
    for m in _STRING_RE.finditer(text):
        raw, is_template = (m.group(1) or m.group(2), False) if (m.group(1) or m.group(2)) else (m.group(3), True)
        if "://" in raw or " " in raw or "/" not in raw:
            continue
        s = _normalize_template(raw) if is_template else raw
        s = s.split("?")[0].split("#")[0].strip("/")
        segs = s.split("/")
        if not segs or not all(_SEGMENT_RE.match(x) for x in segs):
            continue
        key = tuple(segs)
        if key not in seen:
            seen.add(key)
            out.append(segs)
    return out


def find_service_calls(path: Path) -> dict | None:
    """``{"services": {repo_name: first_line}, "literals": [[seg, ...], ...]}`` or None."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    if "_XAPI_" not in text:
        return None
    services: dict[str, int] = {}
    for m in ENV_RE.finditer(text):
        repo = service_repo_name(m.group(1))
        services.setdefault(repo, text.count("\n", 0, m.start()) + 1)
    if not services:
        return None
    return {"services": services, "literals": _path_literals(text)}


def _seg_eq(a: str, b: str) -> bool:
    return a == b or a.startswith(":") or b.startswith(":")


def match_endpoint(rel_segments: list[str], literal: list[str]) -> str | None:
    """'exact' when the literal is the endpoint path (params are wildcards),
    'prefix' when it is a proper leading part, else None.

    Params alone never make a match: at least one static segment must be equal
    on both sides, otherwise ``/${x}`` would hit every one-segment endpoint and
    ``a/b`` every ``/:cacheName/:key``. A prefix needs >= 2 segments and must end
    in a static segment (``/v1/store-locator``, not ``/feature-flags/${brand}``).
    """
    n = len(literal)
    if n == 0 or n > len(rel_segments):
        return None
    if not all(_seg_eq(x, y) for x, y in zip(rel_segments, literal)):
        return None
    if not any(not x.startswith(":") and x == y for x, y in zip(rel_segments, literal)):
        return None
    if n == len(rel_segments):
        return "exact"
    if n >= 2 and not literal[-1].startswith(":"):
        return "prefix"
    return None
