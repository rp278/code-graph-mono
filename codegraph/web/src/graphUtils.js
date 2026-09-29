import dagre from 'dagre';
import { MarkerType } from '@xyflow/react';

// Color palette per knowledge-graph node kind.
export const TYPE_COLORS = {
  endpoint: '#f472b6', // pink   - API route
  page: '#a78bfa', // violet - routed page
  package: '#2dd4bf', // teal   - npm package (publishable or app)
  service: '#fb7185', // rose   - upstream service reached via <X>_XAPI_BASE_URL
  file: '#94a3b8', // slate  - source file
  function: '#34d399', // green  - function / method
  class: '#fbbf24', // amber  - class / type
  repo: '#e879f9', // fuchsia- repository root
  component: '#60a5fa', // blue   - React component
  table: '#fb923c', // orange - DB table
};

export const DEFAULT_TYPE_COLOR = '#c084fc';

export const colorForType = (t) => TYPE_COLORS[t] || DEFAULT_TYPE_COLOR;

export const TYPE_DESCRIPTIONS = {
  endpoint: 'API route exposed by a backend (or called by a frontend)',
  page: 'Routed page view',
  package: 'npm package: publishable library or app (package.json)',
  service: 'Upstream service called through a *_XAPI_BASE_URL env var',
  file: 'Source file',
  function: 'Function or method',
  class: 'Class, interface or type',
  repo: 'Repository',
};

/**
 * The graph stores every source symbol as type "code". Split it into
 * file / function / class using the label so the canvas is easier to read.
 */
export function kindOf(node) {
  const t = node.type || 'code';
  if (t !== 'code') return t;
  const label = node.label || '';
  if (label.endsWith(')')) return 'function';
  if (/\.[A-Za-z0-9]{1,6}$/.test(label)) return 'file';
  return 'class';
}

// Edge styling per relation.
export const RELATION_STYLE = {
  IMPORTS_FROM: { color: '#38bdf8', label: 'imports' },
  IMPORTS: { color: '#38bdf8', label: 'imports' },
  CALLS: { color: '#34d399', label: 'calls' },
  CONTAINS: { color: '#64748b', label: 'contains' },
  METHOD: { color: '#a78bfa', label: 'method' },
  EXPOSES_ENDPOINT: { color: '#f472b6', label: 'exposes endpoint' },
  ROUTE: { color: '#fbbf24', label: 'route' },
  ENTRY: { color: '#475569', label: 'entry point' },
  PROXIES_TO: { color: '#fb923c', label: 'proxies to' },
  FETCHES: { color: '#22d3ee', label: 'fetches' },
  DEPENDS_ON: { color: '#2dd4bf', label: 'depends on' },
  USES_PACKAGE: { color: '#5eead4', label: 'uses package' },
  CALLS_SERVICE: { color: '#fb7185', label: 'calls service' },
};
const DEFAULT_RELATION_COLOR = '#94a3b8';

export const relationColor = (r) => RELATION_STYLE[r]?.color || DEFAULT_RELATION_COLOR;
export const relationLabel = (r) => RELATION_STYLE[r]?.label || (r || '').toLowerCase().replace(/_/g, ' ');

const RELATION_ORDER = ['EXPOSES_ENDPOINT', 'ROUTE', 'CALLS', 'IMPORTS_FROM', 'IMPORTS', 'METHOD', 'CONTAINS'];
const relationRank = (r) => {
  const i = RELATION_ORDER.indexOf(r);
  return i < 0 ? RELATION_ORDER.length : i;
};

export const NODE_W = 236;
export const NODE_H = 52;
export const CENTER_W = 300;
export const CENTER_H = 72;

const ROW_GAP = 16; // vertical gap between nodes in a column
const COL_GAP = 90; // horizontal gap between columns
const ROWS_PER_COLUMN = 11;

/**
 * Lay a node out with its neighbors "hub and spoke" style:
 * the focus node sits in the middle, things that point AT it (importers,
 * callers, parents) fill columns on the left, things it points TO
 * (imports, calls, children) fill columns on the right. Every column holds
 * at most ROWS_PER_COLUMN nodes, so big neighborhoods grow sideways instead
 * of into one endless vertical list.
 *
 *   center : {id, ...}
 *   nodes  : Map id -> node   (neighbors only)
 *   edges  : [{source, target, relation, confidence}] (all touch the center)
 *
 * Returns { positions: {id: {x,y}}, side: {id: 'in'|'out'}, hidden: number }.
 */
export function layoutNeighborhood(center, nodes, edges, maxPerSide = 48) {
  // Which side is each neighbor on, and by which relation is it grouped?
  const info = new Map(); // id -> { out, in, relation, degree }
  for (const e of edges) {
    const outgoing = e.source === center.id;
    const id = outgoing ? e.target : e.source;
    const n = nodes.get(id);
    if (!n) continue;
    let rec = info.get(id);
    if (!rec) {
      rec = { out: 0, in: 0, relation: e.relation, degree: n.degree || 0 };
      info.set(id, rec);
    } else if (relationRank(e.relation) < relationRank(rec.relation)) {
      rec.relation = e.relation;
    }
    if (outgoing) rec.out += 1;
    else rec.in += 1;
  }

  const left = [];
  const right = [];
  for (const [id, rec] of info) {
    (rec.in > rec.out ? left : right).push({ id, ...rec });
  }
  const order = (a, b) =>
    relationRank(a.relation) - relationRank(b.relation) ||
    b.degree - a.degree ||
    String(nodes.get(a.id)?.label).localeCompare(String(nodes.get(b.id)?.label));
  left.sort(order);
  right.sort(order);

  const positions = { [center.id]: { x: -CENTER_W / 2, y: -CENTER_H / 2 } };
  const side = {};
  let hidden = 0;

  const place = (list, dir) => {
    const shown = list.slice(0, maxPerSide);
    hidden += list.length - shown.length;
    // Balance the columns so we don't get one full column and a stub.
    const cols = Math.max(1, Math.ceil(shown.length / ROWS_PER_COLUMN));
    const perCol = Math.ceil(shown.length / cols);
    shown.forEach((item, i) => {
      const col = Math.floor(i / perCol);
      const rowsHere = col === cols - 1 ? shown.length - perCol * col : perCol;
      const row = i - col * perCol;
      const colHeight = rowsHere * NODE_H + (rowsHere - 1) * ROW_GAP;
      const y = -colHeight / 2 + row * (NODE_H + ROW_GAP);
      const offset = CENTER_W / 2 + COL_GAP + col * (NODE_W + COL_GAP);
      const x = dir > 0 ? offset : -offset - NODE_W;
      positions[item.id] = { x, y };
      side[item.id] = dir > 0 ? 'out' : 'in';
    });
  };
  place(left, -1);
  place(right, 1);

  return { positions, side, hidden };
}

/** Distinct relations (with counts) in a list of edges, in display order. */
export function relationCounts(edges) {
  const m = new Map();
  for (const e of edges) m.set(e.relation, (m.get(e.relation) || 0) + 1);
  return [...m.entries()]
    .map(([relation, count]) => ({ relation, count }))
    .sort((a, b) => relationRank(a.relation) - relationRank(b.relation) || b.count - a.count);
}

const INFERRED_RELATIONS = new Set(['PROXIES_TO', 'FETCHES']);

/**
 * "All repos" map: one node per repository, one arrow per connected pair.
 *
 *   repos     : [{id, name}]
 *   repoCounts: { [repoId]: nodeCount }
 *   links     : [{source, target, relation, count}]  (repo NAMES, from /api/graph/repo-links)
 *   prefix    : node-id prefix the Explorer uses to recognise repo nodes
 *
 * The arrow points from the repo that depends on / calls to the one it
 * depends on; its label lists the relations behind it ("uses package ×9 ·
 * depends on ×10"). A reverse direction is appended as "← fetches ×1".
 * Repos are laid out left-to-right with dagre, so consumers end up on the
 * left and the libraries / services they use on the right.
 */
export function buildRepoMap(registered, repoCounts, links, prefix) {
  // Services outside the workspace (e.g. tb-txn-util-xapi) live in the "external"
  // pseudo-repo; show it too so those dependencies are not silently dropped.
  const known = new Set(registered.map((r) => r.name));
  const extras = new Set();
  for (const l of links) for (const n of [l.source, l.target]) if (!known.has(n)) extras.add(n);
  const repos = [...registered, ...[...extras].map((n) => ({ id: n, name: n, extra: true }))];
  const idByName = new Map(repos.map((r) => [r.name, r.id]));

  // Group links per unordered repo pair, remembering each direction.
  const pairs = new Map();
  for (const l of links) {
    if (!idByName.has(l.source) || !idByName.has(l.target)) continue;
    const [a, b] = [l.source, l.target].sort();
    const key = `${a}|${b}`;
    const p = pairs.get(key) || { a, b, fwd: {}, back: {} }; // fwd = a -> b
    const side = l.source === a ? p.fwd : p.back;
    side[l.relation] = (side[l.relation] || 0) + l.count;
    pairs.set(key, p);
  }

  const sum = (o) => Object.values(o).reduce((s, n) => s + n, 0);
  // One label line per relation, biggest first; `reverse` marks the opposite direction.
  const linesOf = (o, reverse) =>
    Object.entries(o)
      .sort((x, y) => y[1] - x[1])
      .map(([relation, count]) => ({
        relation,
        count,
        reverse,
        label: relationLabel(relation),
        color: relationColor(relation),
      }));

  const NODE_MAP_W = 260;
  const NODE_MAP_H = 64;
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 70, ranksep: 300, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const r of repos) g.setNode(prefix + r.id, { width: NODE_MAP_W, height: NODE_MAP_H });

  const edges = [];
  for (const p of pairs.values()) {
    const forward = sum(p.fwd) >= sum(p.back);
    const main = forward ? p.fwd : p.back;
    const other = forward ? p.back : p.fwd;
    const from = prefix + idByName.get(forward ? p.a : p.b);
    const to = prefix + idByName.get(forward ? p.b : p.a);
    const total = sum(main) + sum(other);
    const topRelation = Object.entries(main).sort((x, y) => y[1] - x[1])[0][0];
    const color = relationColor(topRelation);
    const lines = [...linesOf(main, false), ...linesOf(other, true)];
    g.setEdge(from, to);
    edges.push({
      id: `rl:${from}>${to}`,
      source: from,
      target: to,
      type: 'repoLink',
      data: { lines, points: [] }, // points filled in after layout
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 18, height: 18 },
      style: {
        stroke: color,
        strokeWidth: 1.5 + Math.min(3.5, Math.log10(total + 1) * 1.6),
        strokeDasharray: INFERRED_RELATIONS.has(topRelation) ? '7 5' : undefined,
        opacity: 0.9,
      },
    });
  }

  dagre.layout(g);
  // dagre routes each edge around the nodes it passes; keep those waypoints.
  for (const e of edges) e.data.points = g.edge(e.source, e.target).points;

  const linked = new Set(edges.flatMap((e) => [e.source, e.target]));
  const nodes = repos.map((r) => {
    const id = prefix + r.id;
    const pos = g.node(id);
    return {
      id,
      type: 'kgNode',
      position: { x: pos.x - NODE_MAP_W / 2, y: pos.y - NODE_MAP_H / 2 },
      draggable: false,
      data: {
        label: r.name,
        kind: 'repo',
        color: colorForType('repo'),
        loc: r.extra ? 'not in workspace' : `${repoCounts[r.id] || 0} nodes`,
        hint: linked.has(id) ? '' : 'no links to other repos',
        isCenter: false,
      },
    };
  });
  return { nodes, edges, hidden: 0, shownEdges: edges.length };
}

/** Path of `file` relative to the repo checkout (source_file is absolute). */
export function shortPath(file, repo) {
  if (!file) return '';
  const marker = repo ? `/${repo}/` : null;
  const i = marker ? file.indexOf(marker) : -1;
  return i >= 0 ? file.slice(i + marker.length) : file;
}
