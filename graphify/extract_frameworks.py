"""Framework-aware extraction for codeGraph: Fastify routes, React components/pages, SQL tables.

Complements the generic AST extractors in extract.py with framework-specific
knowledge:

- Fastify: ``fastify.get('/path', handler)`` -> ``endpoint`` nodes
- React: capitalized components returning JSX -> ``component`` nodes,
  ``fetch('/api/...')`` -> ``fetches`` edges, ``<Route path element>`` -> ``page`` nodes
- SQL: ``CREATE TABLE`` -> ``table`` nodes, query strings -> ``reads_table``/``writes_table``

Node IDs reuse the ``_make_id`` scheme from extract.py so framework nodes/edges
merge cleanly with the base AST extraction output.
"""
from __future__ import annotations

import re
from pathlib import Path

from .extract import _make_id

HTTP_METHODS = {"get", "post", "put", "delete", "patch", "options", "head"}
ROUTE_RECEIVERS = {"fastify", "app", "server", "router", "api"}
FETCH_FUNCTIONS = {"fetch", "request"}
# member-expression style HTTP clients, e.g. axios.get('/api/...')
HTTP_CLIENT_OBJECTS = {"axios"}

JS_SUFFIXES = {".js", ".jsx", ".ts", ".tsx"}


def _get_parser(suffix: str):
    from tree_sitter import Language, Parser

    if suffix in (".ts", ".tsx"):
        import tree_sitter_typescript as tslang
        language = Language(tslang.language_typescript())
    else:
        import tree_sitter_javascript as tslang
        language = Language(tslang.language())
    return Parser(language)


def _text(source: bytes, node) -> str:
    return source[node.start_byte:node.end_byte].decode("utf-8", errors="replace")


def _unquote(s: str) -> str:
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ("'", '"', "`"):
        return s[1:-1]
    return s


def _normalize_template(t: str) -> str:
    """Replace ``${...}`` substitutions in a template literal: ``:param`` when the
    substitution sits at a path-segment boundary, dropped elsewhere (e.g. query
    strings). Handles nested braces/quotes inside the substitution."""
    out: list[str] = []
    i, n = 0, len(t)
    while i < n:
        if t.startswith("${", i):
            boundary = bool(out) and out[-1] == "/"
            j = i + 2
            depth = 1
            while j < n and depth:
                c = t[j]
                if c in "'\"`":
                    q = c
                    j += 1
                    while j < n and t[j] != q:
                        j += 2 if t[j] == "\\" else 1
                    j += 1  # closing quote
                else:
                    if c == "{":
                        depth += 1
                    elif c == "}":
                        depth -= 1
                    j += 1
            if boundary:
                out.append(":param")
            i = j
        else:
            out.append(t[i])
            i += 1
    return "".join(out)


def _api_path_from_arg(source: bytes, arg_node) -> str | None:
    """Extract a normalized /api/... path from a string/template-string argument.

    Template substitutions at a path-segment boundary become ``:param``;
    substitutions elsewhere (e.g. query strings) are dropped.
    Returns None when the argument has no /api/ literal.
    """
    t = _text(source, arg_node)
    if "/api/" not in t and not t.rstrip("`'\"").endswith("/api"):
        return None
    if arg_node.type == "template_string":
        t = _normalize_template(t)
        t = _unquote(t)
    else:
        t = _unquote(t)
    # strip query string remnants and trailing slash (but keep root "/")
    t = t.split("?")[0].split("#")[0]
    if len(t) > 1 and t.endswith("/"):
        t = t.rstrip("/")
    # pure-numeric segments are almost always resource ids -> :param
    t = re.sub(r"/\d+(?=/|$)", "/:param", t)
    return t or None


def _path_matches(endpoint_path: str, fetch_path: str) -> bool:
    """Segment-wise match where :param segments act as wildcards."""
    es = endpoint_path.strip("/").split("/")
    fs = fetch_path.strip("/").split("/")
    if len(es) != len(fs):
        return False
    for e, f in zip(es, fs):
        if e.startswith(":") or f.startswith(":"):
            continue
        if e != f:
            return False
    return True


def _endpoint_id(method: str, path: str) -> str:
    return f"endpoint:{method.upper()}:{path}"


def _new_node(nid: str, label: str, node_type: str, source_file: str, line: int, **extra) -> dict:
    node = {
        "id": nid,
        "label": label,
        "file_type": "code",
        "node_type": node_type,
        "source_file": source_file,
        "source_location": f"L{line}",
    }
    node.update(extra)
    return node


def _new_edge(src: str, tgt: str, relation: str, confidence: str, source_file: str, line: int, **extra) -> dict:
    edge = {
        "source": src,
        "target": tgt,
        "relation": relation,
        "confidence": confidence,
        "source_file": source_file,
        "source_location": f"L{line}",
        "weight": 1.0 if confidence == "EXTRACTED" else 0.8,
    }
    edge.update(extra)
    return edge


def _contains_jsx(source: bytes, node) -> bool:
    if node.type in ("jsx_element", "jsx_self_closing_element"):
        return True
    return any(_contains_jsx(source, c) for c in node.children)


def _iter_functions(source: bytes, root):
    """Yield (name, body_node) for top-level function declarations and arrow consts."""
    for child in root.children:
        if child.type == "function_declaration":
            name_node = child.child_by_field_name("name")
            body = child.child_by_field_name("body")
            if name_node is not None and body is not None:
                yield _text(source, name_node), body
        elif child.type == "lexical_declaration":
            for decl in child.children:
                if decl.type == "variable_declarator":
                    value = decl.child_by_field_name("value")
                    name_node = decl.child_by_field_name("name")
                    if value is not None and value.type == "arrow_function" and name_node is not None:
                        body = value.child_by_field_name("body")
                        if body is not None:
                            yield _text(source, name_node), body
        elif child.type == "export_statement":
            # export default function X() / export const X = ...
            for c in child.children:
                if c.type == "function_declaration":
                    name_node = c.child_by_field_name("name")
                    body = c.child_by_field_name("body")
                    if name_node is not None and body is not None:
                        yield _text(source, name_node), body
                elif c.type == "lexical_declaration":
                    for decl in c.children:
                        if decl.type == "variable_declarator":
                            value = decl.child_by_field_name("value")
                            name_node = decl.child_by_field_name("name")
                            if value is not None and value.type == "arrow_function" and name_node is not None:
                                body = value.child_by_field_name("body")
                                if body is not None:
                                    yield _text(source, name_node), body


def extract_fastify(path: Path, repo: str) -> dict:
    """Find fastify/app.get|post|put|delete|patch('/path', handler) route registrations."""
    if path.suffix not in JS_SUFFIXES:
        return {"nodes": [], "edges": [], "pending_edges": [], "api_clients": {}, "client_calls": [], "components": set()}
    try:
        parser = _get_parser(path.suffix)
        source = path.read_bytes()
        root = parser.parse(source).root_node
    except Exception as e:
        return {"nodes": [], "edges": [], "pending_edges": [], "api_clients": {}, "client_calls": [], "components": set(), "error": str(e)}

    stem = path.stem
    str_path = str(path)
    file_nid = _make_id(stem)
    nodes, edges = [], []
    seen: set[str] = set()

    def add_node(n):
        if n["id"] not in seen:
            seen.add(n["id"])
            nodes.append(n)

    def walk(node):
        if node.type == "call_expression":
            func = node.child_by_field_name("function")
            if func is not None and func.type == "member_expression":
                obj = func.child_by_field_name("object")
                prop = func.child_by_field_name("property")
                if (
                    obj is not None and prop is not None
                    and obj.type == "identifier"
                    and _text(source, obj) in ROUTE_RECEIVERS
                    and _text(source, prop) in HTTP_METHODS
                ):
                    args = node.child_by_field_name("arguments")
                    route_path = None
                    handler_name = None
                    if args is not None:
                        named = [c for c in args.children if c.is_named]
                        if named and named[0].type == "string":
                            route_path = _unquote(_text(source, named[0]))
                        for a in named[1:]:
                            if a.type == "identifier":
                                handler_name = _text(source, a)
                                break
                    if route_path:
                        line = node.start_point[0] + 1
                        method = _text(source, prop).upper()
                        eid = _endpoint_id(method, route_path)
                        add_node(_new_node(
                            eid, f"{method} {route_path}", "endpoint", str_path, line,
                            method=method, path=route_path,
                        ))
                        edges.append(_new_edge(file_nid, eid, "exposes_endpoint", "EXTRACTED", str_path, line))
                        if handler_name:
                            fn_nid = _make_id(stem, handler_name)
                            edges.append(_new_edge(eid, fn_nid, "handled_by", "EXTRACTED", str_path, line))
        for child in node.children:
            walk(child)

    walk(root)
    return {"nodes": nodes, "edges": edges, "pending_edges": [],
            "api_clients": {}, "client_calls": [], "components": set()}


def extract_react(path: Path, repo: str) -> dict:
    """Find React components, <Route> pages, and /api/ fetch calls."""
    if path.suffix not in JS_SUFFIXES:
        return {"nodes": [], "edges": [], "pending_edges": [], "api_clients": {}, "client_calls": [], "components": set()}
    try:
        parser = _get_parser(path.suffix)
        source = path.read_bytes()
        root = parser.parse(source).root_node
    except Exception as e:
        return {"nodes": [], "edges": [], "pending_edges": [], "api_clients": {}, "client_calls": [], "components": set(), "error": str(e)}

    stem = path.stem
    str_path = str(path)
    file_nid = _make_id(stem)
    nodes: list[dict] = []
    edges: list[dict] = []
    pending_edges: list[dict] = []
    api_clients: dict[str, list[str]] = {}
    client_calls: list[tuple[str, str, int]] = []
    seen: set[str] = set()

    def add_node(n):
        if n["id"] not in seen:
            seen.add(n["id"])
            nodes.append(n)

    # Pass 1: component names (capitalized functions whose body contains JSX)
    components: set[str] = set()
    func_bodies: dict[str, object] = {}
    for fname, body in _iter_functions(source, root):
        func_bodies[fname] = body
        if fname[:1].isupper() and _contains_jsx(source, body):
            components.add(fname)
            line = body.start_point[0] + 1
            add_node(_new_node(_make_id(stem, fname), fname, "component", str_path, line))

    def current_source(func_stack: list[str]) -> str:
        # outermost enclosing component wins (calls are often nested inside
        # useEffect / async arrow-function callbacks)
        for fname in func_stack:
            if fname in components:
                return _make_id(stem, fname)
        return file_nid

    def handle_fetch_call(node, func_stack: list[str], explicit_method: str | None = None):
        args = node.child_by_field_name("arguments")
        if args is None:
            return
        named = [c for c in args.children if c.is_named]
        if not named:
            return
        api_path = _api_path_from_arg(source, named[0])
        if not api_path:
            return
        line = node.start_point[0] + 1
        src_nid = current_source(func_stack)
        # record api-client info when inside a named function (e.g. api.js wrappers)
        if func_stack:
            api_clients.setdefault(func_stack[-1], [])
            if api_path not in api_clients[func_stack[-1]]:
                api_clients[func_stack[-1]].append(api_path)
        pending_edges.append({
            "source": src_nid,
            "pending_method": explicit_method or "GET",
            "pending_path": api_path,
            "relation": "fetches",
            "confidence": "INFERRED",
            "source_file": str_path,
            "source_location": f"L{line}",
            "weight": 0.8,
        })

    def walk(node, func_stack: list[str]):
        t = node.type

        if t == "function_declaration":
            name_node = node.child_by_field_name("name")
            fname = _text(source, name_node) if name_node is not None else None
            body = node.child_by_field_name("body")
            if fname and body is not None:
                for c in body.children:
                    walk(c, func_stack + [fname])
                return

        if t == "variable_declarator":
            value = node.child_by_field_name("value")
            name_node = node.child_by_field_name("name")
            if value is not None and value.type == "arrow_function" and name_node is not None:
                fname = _text(source, name_node)
                body = value.child_by_field_name("body")
                if body is not None:
                    walk(body, func_stack + [fname])
                    return

        if t == "call_expression":
            func = node.child_by_field_name("function")
            if func is not None:
                if func.type == "identifier":
                    callee = _text(source, func)
                    if callee in FETCH_FUNCTIONS:
                        handle_fetch_call(node, func_stack)
                    elif func_stack:
                        # record plain identifier calls for the api-client link pass
                        client_calls.append((current_source(func_stack), callee, node.start_point[0] + 1))
                elif func.type == "member_expression":
                    obj = func.child_by_field_name("object")
                    prop = func.child_by_field_name("property")
                    if obj is not None and prop is not None and obj.type == "identifier":
                        obj_name, prop_name = _text(source, obj), _text(source, prop)
                        if obj_name in HTTP_CLIENT_OBJECTS and prop_name in HTTP_METHODS:
                            handle_fetch_call(node, func_stack, explicit_method=prop_name.upper())

        if t in ("jsx_element", "jsx_self_closing_element"):
            tag = None
            for c in node.children:
                if c.is_named and c.type == "identifier":
                    tag = _text(source, c)
                    break
            if tag == "Route":
                route_path, element_comp = None, None
                for c in node.children:
                    if c.is_named and c.type == "jsx_attribute":
                        aname = None
                        for ac in c.children:
                            if ac.is_named and ac.type == "property_identifier":
                                aname = _text(source, ac)
                                break
                        # value = last named child
                        named_kids = [ac for ac in c.children if ac.is_named]
                        aval = named_kids[-1] if named_kids else None
                        if aname == "path" and aval is not None and aval.type == "string":
                            route_path = _unquote(_text(source, aval))
                        elif aname == "element" and aval is not None:
                            # jsx_expression -> jsx_element / jsx_self_closing_element
                            def find_comp(n):
                                if n.type in ("jsx_element", "jsx_self_closing_element"):
                                    for kc in n.children:
                                        if kc.is_named and kc.type == "identifier":
                                            return _text(source, kc)
                                for kc in n.children:
                                    r = find_comp(kc)
                                    if r:
                                        return r
                                return None
                            element_comp = find_comp(aval)
                if route_path:
                    line = node.start_point[0] + 1
                    page_nid = f"page:{route_path}"
                    add_node(_new_node(page_nid, f"Page {route_path}", "page", str_path, line,
                                       route_path=route_path))
                    if element_comp:
                        comp_nid = _make_id(stem, element_comp)
                        edges.append(_new_edge(comp_nid, page_nid, "route", "EXTRACTED", str_path, line))

        for child in node.children:
            walk(child, func_stack)

    walk(root, [])
    return {"nodes": nodes, "edges": edges, "pending_edges": pending_edges,
            "api_clients": api_clients, "client_calls": client_calls,
            "components": components}


# ── SQL ───────────────────────────────────────────────────────────────────────

_CREATE_TABLE_RE = re.compile(
    r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`\"'\[]?(\w+)[`\"'\]]?",
    re.IGNORECASE,
)


def extract_sql(path: Path, repo: str) -> dict:
    """Find CREATE TABLE statements and table references in query strings (regex-based)."""
    if path.suffix not in JS_SUFFIXES:
        return {"nodes": [], "edges": [], "pending_edges": [], "api_clients": {}, "client_calls": [], "components": set()}
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        return {"nodes": [], "edges": [], "pending_edges": [], "api_clients": {}, "client_calls": [], "components": set(), "error": str(e)}

    stem = path.stem
    str_path = str(path)
    file_nid = _make_id(stem)
    nodes, edges = [], []
    seen: set[str] = set()

    tables = {m.group(1) for m in _CREATE_TABLE_RE.finditer(text)}
    for table in sorted(tables):
        tid = f"table:{table}"
        if tid not in seen:
            seen.add(tid)
            nodes.append(_new_node(tid, table, "table", str_path, 1, table_name=table))

    # classify references per (table) — one edge per relation type per file
    for table in sorted(tables):
        tid = f"table:{table}"
        read_re = re.compile(r"\b(?:FROM|JOIN)\s+[`\"'\[]?" + re.escape(table) + r"\b", re.IGNORECASE)
        write_re = re.compile(
            r"\b(?:INTO|UPDATE)\s+[`\"'\[]?" + re.escape(table)
            + r"\b|\bDELETE\s+FROM\s+[`\"'\[]?" + re.escape(table) + r"\b",
            re.IGNORECASE,
        )
        line = 1
        m = read_re.search(text)
        if m:
            line = text.count("\n", 0, m.start()) + 1
            edges.append(_new_edge(file_nid, tid, "reads_table", "INFERRED", str_path, line))
        m = write_re.search(text)
        if m:
            line = text.count("\n", 0, m.start()) + 1
            edges.append(_new_edge(file_nid, tid, "writes_table", "INFERRED", str_path, line))

    return {"nodes": nodes, "edges": edges, "pending_edges": [],
            "api_clients": {}, "client_calls": [], "components": set()}


def _merge_results(results: list[dict]) -> dict:
    nodes, edges, pending = [], [], []
    api_clients: dict[str, list[str]] = {}
    client_calls: list[tuple[str, str, int]] = []
    components: set[str] = set()
    for r in results:
        nodes.extend(r.get("nodes", []))
        edges.extend(r.get("edges", []))
        pending.extend(r.get("pending_edges", []))
        for k, v in r.get("api_clients", {}).items():
            api_clients.setdefault(k, [])
            for p in v:
                if p not in api_clients[k]:
                    api_clients[k].append(p)
        client_calls.extend(r.get("client_calls", []))
        components.update(r.get("components", set()))
    return {"nodes": nodes, "edges": edges, "pending_edges": pending,
            "api_clients": api_clients, "client_calls": client_calls,
            "components": components}


def extract_frameworks(path: Path, repo: str) -> dict:
    """Run all framework extractors on a JS/TS file. Returns nodes, edges,
    pending_edges (fetches awaiting endpoint resolution), api_clients,
    client_calls, and components."""
    return _merge_results([
        extract_fastify(path, repo),
        extract_react(path, repo),
        extract_sql(path, repo),
    ])
