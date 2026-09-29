"""Backend/route extractors for codeGraph beyond plain Fastify calls.

- Spring (Java): ``@RestController`` classes with ``@RequestMapping`` /
  ``@GetMapping`` / ... -> ``endpoint`` nodes (base path from application.yml)
- Next.js app router: ``app/**/route.ts`` exported HTTP handlers -> ``endpoint``
  nodes, ``app/**/page.tsx`` -> ``page`` nodes (URL derived from the folders)
- Fastify plugin prefixes: ``instance.register(plugin, { prefix: '/v1/x' })``
  -> the URL prefix that applies to every route defined in that plugin file

Endpoint ids include the repo name so identically named routes in different
repos (e.g. ``GET /ping``) stay separate nodes.

All extraction here is regex based, on purpose: the constructs are simple,
annotation- or convention-driven, and it avoids needing extra parsers.
"""
from __future__ import annotations

import re
from pathlib import Path

from .extract import _make_id
from .extract_frameworks import _new_edge, _new_node

HTTP_VERBS = ("GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS")


def repo_endpoint_id(repo: str, method: str, path: str) -> str:
    return f"endpoint:{repo}:{method.upper()}:{path}"


def _join_paths(*parts: str) -> str:
    joined = "/".join(p.strip("/") for p in parts if p and p.strip("/"))
    return "/" + joined if joined else "/"


def _line_of(text: str, index: int) -> int:
    return text.count("\n", 0, index) + 1


# ── Spring ────────────────────────────────────────────────────────────────────

_ANNOTATION_ARGS = r"\(((?:[^()]|\([^()]*\))*)\)"
_SPRING_CONTROLLER_RE = re.compile(r"@(?:RestController|Controller)\b")
_SPRING_CLASS_RE = re.compile(r"\bclass\s+\w+")
_SPRING_REQUEST_MAPPING_RE = re.compile(r"@RequestMapping\s*" + _ANNOTATION_ARGS)
_SPRING_METHOD_MAPPING_RE = re.compile(r"@(Get|Post|Put|Delete|Patch|Request)Mapping\s*(?:" + _ANNOTATION_ARGS + r")?")
_STRING_RE = re.compile(r'"([^"]*)"')


def _annotation_path(args: str | None) -> str:
    """First path literal from annotation args: ``("/x")``, ``(value = "/x")``,
    ``(path = {"/x", "/y"})`` (first wins)."""
    if not args:
        return ""
    m = re.search(r'\b(?:value|path)\s*=\s*\{?\s*"([^"]*)"', args)
    if m:
        return m.group(1)
    m = re.match(r'\s*\{?\s*"([^"]*)"', args)
    return m.group(1) if m else ""


def _spring_path(raw: str) -> str:
    """``/x/{id}`` and ``/x/{id:[0-9]+}`` -> ``/x/:id``."""
    return re.sub(r"\{(\w+)(?::[^}]*)?\}", r":\1", raw)


def spring_base_path(repo_root: Path) -> str:
    """``spring.webflux.base-path`` / ``server.servlet.context-path`` (yml or properties)."""
    resources = repo_root / "src" / "main" / "resources"
    for name in ("application.yml", "application.yaml", "application.properties"):
        f = resources / name
        if not f.exists():
            continue
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        m = re.search(r"^\s*(?:base-path|context-path)\s*:\s*(\S+)", text, re.M)
        if m:
            return m.group(1).strip("'\"")
        m = re.search(r"(?:base-path|context-path)\s*=\s*(\S+)", text)
        if m:
            return m.group(1).strip("'\"")
    return ""


def extract_spring(path: Path, repo: str, base_path: str = "") -> dict:
    """Endpoint nodes for a Spring ``@RestController`` / ``@Controller`` class."""
    empty = {"nodes": [], "edges": []}
    if path.suffix != ".java":
        return empty
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return empty
    if not _SPRING_CONTROLLER_RE.search(text):
        return empty
    class_match = _SPRING_CLASS_RE.search(text)
    if not class_match:
        return empty

    head = text[: class_match.start()]
    cm = _SPRING_REQUEST_MAPPING_RE.search(head)
    class_prefix = _annotation_path(cm.group(1)) if cm else ""

    str_path = str(path)
    file_nid = _make_id(path.stem)
    nodes: list[dict] = []
    edges: list[dict] = []
    seen: set[str] = set()

    for m in _SPRING_METHOD_MAPPING_RE.finditer(text, class_match.start()):
        kind, args = m.group(1), m.group(2)
        if kind == "Request":
            vm = re.search(r"\bmethod\s*=\s*\{?\s*(?:RequestMethod\.)?(\w+)", args or "")
            verb = vm.group(1).upper() if vm and vm.group(1).upper() in HTTP_VERBS else "GET"
        else:
            verb = kind.upper()
        full = _spring_path(_join_paths(base_path, class_prefix, _annotation_path(args)))
        eid = repo_endpoint_id(repo, verb, full)
        if eid in seen:
            continue
        seen.add(eid)
        line = _line_of(text, m.start())
        nodes.append(_new_node(eid, f"{verb} {full}", "endpoint", str_path, line,
                               method=verb, path=full, framework="spring"))
        edges.append(_new_edge(file_nid, eid, "exposes_endpoint", "EXTRACTED", str_path, line))
    return {"nodes": nodes, "edges": edges}


# ── Next.js app router ────────────────────────────────────────────────────────

_NEXT_ROUTE_FILES = {"route.ts", "route.js", "route.tsx", "route.jsx"}
_NEXT_PAGE_FILES = {"page.tsx", "page.jsx", "page.ts", "page.js"}
_NEXT_EXPORT_RES = [
    re.compile(r"export\s+(?:async\s+)?function\s+(" + "|".join(HTTP_VERBS) + r")\b"),
    re.compile(r"export\s+(?:const|let|var)\s+(" + "|".join(HTTP_VERBS) + r")\b"),
]
_NEXT_EXPORT_LIST_RE = re.compile(r"export\s*\{([^}]*)\}")


def _next_segment(seg: str) -> str | None:
    """Folder name -> URL segment (None = contributes nothing)."""
    if seg.startswith("(") and seg.endswith(")"):  # route group
        return None
    if seg.startswith("@"):  # parallel route slot
        return None
    m = re.fullmatch(r"\[\[\.\.\.(\w+)\]\]|\[\.\.\.(\w+)\]", seg)
    if m:
        return f":{m.group(1) or m.group(2)}*"
    m = re.fullmatch(r"\[(\w+)\]", seg)
    if m:
        return f":{m.group(1)}"
    return seg


def next_url_for(path: Path, repo: str) -> str | None:
    """URL of a Next app-router file, or None when it is not under an ``app`` dir."""
    s = str(path)
    marker = f"/{repo}/"
    i = s.find(marker)
    rel = s[i + len(marker):] if i >= 0 else s.lstrip("/")
    parts = rel.split("/")[:-1]
    if "app" not in parts:
        return None
    segs = [_next_segment(p) for p in parts[parts.index("app") + 1:]]
    return "/" + "/".join(x for x in segs if x)


def extract_next(path: Path, repo: str) -> dict:
    """Next.js app-router ``route.ts`` handlers -> endpoints, ``page.tsx`` -> pages."""
    empty = {"nodes": [], "edges": []}
    name = path.name
    if name not in _NEXT_ROUTE_FILES and name not in _NEXT_PAGE_FILES:
        return empty
    url = next_url_for(path, repo)
    if url is None:
        return empty
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return empty

    str_path = str(path)
    file_nid = _make_id(path.stem)
    nodes: list[dict] = []
    edges: list[dict] = []
    catch_all = url.endswith("*")

    if name in _NEXT_PAGE_FILES:
        pid = f"page:{repo}:{url}"
        nodes.append(_new_node(pid, f"Page {url}", "page", str_path, 1, route_path=url))
        edges.append(_new_edge(file_nid, pid, "route", "EXTRACTED", str_path, 1))
        return {"nodes": nodes, "edges": edges}

    verbs: dict[str, int] = {}
    for rx in _NEXT_EXPORT_RES:
        for m in rx.finditer(text):
            verbs.setdefault(m.group(1), _line_of(text, m.start()))
    for m in _NEXT_EXPORT_LIST_RE.finditer(text):
        for v in re.findall(r"\b(" + "|".join(HTTP_VERBS) + r")\b", m.group(1)):
            verbs.setdefault(v, _line_of(text, m.start()))
    for verb, line in sorted(verbs.items()):
        eid = repo_endpoint_id(repo, verb, url)
        nodes.append(_new_node(eid, f"{verb} {url}", "endpoint", str_path, line,
                               method=verb, path=url, framework="next", catch_all=catch_all))
        edges.append(_new_edge(file_nid, eid, "exposes_endpoint", "EXTRACTED", str_path, line))
    return {"nodes": nodes, "edges": edges}


# ── Fastify plugin prefixes ───────────────────────────────────────────────────

_IMPORT_RE = re.compile(r"""import\s+(?:type\s+)?(\w+)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"]([^'"]+)['"]""")
_REGISTER_RE = re.compile(r"""\.register\(\s*(\w+)\s*(?:,\s*\{([^}]*)\})?""")
_PREFIX_RE = re.compile(r"""prefix\s*:\s*['"`]([^'"`]*)['"`]""")
_RESOLVE_SUFFIXES = (".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.js")


def _resolve_import(from_file: Path, spec: str, known: set[Path]) -> Path | None:
    if not spec.startswith("."):
        return None
    base = (from_file.parent / spec).resolve()
    for suffix in ("",) + _RESOLVE_SUFFIXES:
        cand = Path(str(base) + suffix)
        if cand in known:
            return cand
    return None


def fastify_prefixes(files: list[Path]) -> dict[str, str]:
    """Map route-file path -> URL prefix from nested ``register(plugin, {prefix})`` calls."""
    js = [f.resolve() for f in files if f.suffix in (".ts", ".tsx", ".js", ".jsx")]
    known = set(js)
    children: dict[Path, list[tuple[Path, str]]] = {}
    is_child: set[Path] = set()
    for f in js:
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if ".register(" not in text:
            continue
        imports = {}
        for m in _IMPORT_RE.finditer(text):
            target = _resolve_import(f, m.group(2), known)
            if target is not None:
                imports[m.group(1)] = target
        for m in _REGISTER_RE.finditer(text):
            target = imports.get(m.group(1))
            if target is None or target == f:
                continue
            pm = _PREFIX_RE.search(m.group(2) or "")
            children.setdefault(f, []).append((target, pm.group(1) if pm else ""))
            is_child.add(target)

    result: dict[str, str] = {}

    def walk(file: Path, prefix: str, depth: int = 0) -> None:
        if depth > 8:
            return
        for child, own in children.get(file, []):
            total = _join_paths(prefix, own) if (prefix or own) else ""
            if total and total != "/":
                result[str(child)] = total
            walk(child, total if total != "/" else "", depth + 1)

    for root in [f for f in children if f not in is_child]:
        walk(root, "")
    return result
