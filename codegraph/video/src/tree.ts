// Port of codegraph/web/src/treeUtils.js (same tree building + dagre layout),
// with slightly larger rows so text stays readable at 1080p.
import dagre from 'dagre';

export type Row = {
  id: string;
  label: string;
  kind: 'root' | 'repo' | 'dir' | 'file' | 'node';
  children: Row[];
  count: number;
  type?: string;
  file?: string;
  repo?: string;
  loc?: string;
};

export type ApiNode = { id: string; label: string; type?: string; file?: string; repo?: string; loc?: string };
export type ApiEdge = { source: string; target: string };

export const NODE_W = 340;
export const NODE_H = 58;

export const COLORS = {
  root: '#e879f9',
  repo: '#e879f9',
  dir: '#60a5fa',
  file: '#94a3b8',
  node: '#34d399',
};

const KIND_ORDER: Record<string, number> = { dir: 0, file: 1, node: 2 };

const sortChildren = (list: Row[]) =>
  list.sort((a, b) => {
    const k = (KIND_ORDER[a.kind] ?? 3) - (KIND_ORDER[b.kind] ?? 3);
    return k !== 0 ? k : a.label.localeCompare(b.label, undefined, { numeric: true });
  });

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

function relativePath(file: string, repo: string) {
  const marker = `/${repo}/`;
  const i = file.indexOf(marker);
  return i >= 0 ? file.slice(i + marker.length) : file.replace(/^\/+/, '');
}

const makeRow = (id: string, label: string, kind: Row['kind'], extra: Partial<Row> = {}): Row => ({
  id,
  label,
  kind,
  children: [],
  count: 0,
  ...extra,
});

export function buildTree(apiNodes: ApiNode[], apiEdges: ApiEdge[]): Row {
  const byId = new Map<string, Row>();
  for (const n of apiNodes) {
    byId.set(
      n.id,
      makeRow(n.id, n.label || n.id, 'node', {
        type: n.type || 'code',
        file: n.file || '',
        repo: n.repo || '',
        loc: n.loc || '',
      })
    );
  }

  const hasParent = new Set<string>();
  for (const e of apiEdges) {
    const parent = byId.get(e.source);
    const child = byId.get(e.target);
    if (!parent || !child || parent === child || hasParent.has(child.id)) continue;
    parent.children.push(child);
    hasParent.add(child.id);
  }

  const repos = new Map<string, Row>();
  const getRepo = (name: string) => {
    if (!repos.has(name)) repos.set(name, makeRow(`repo:${name}`, name, 'repo', { repo: name }));
    return repos.get(name)!;
  };
  const dirs = new Map<string, Row>();
  const getDir = (repoName: string, segments: string[]) => {
    let parent = getRepo(repoName);
    let path = '';
    for (const seg of segments) {
      path += `/${seg}`;
      const key = `${repoName}:${path}`;
      let dir = dirs.get(key);
      if (!dir) {
        dir = makeRow(`dir:${key}`, seg, 'dir', { repo: repoName });
        dirs.set(key, dir);
        parent.children.push(dir);
      }
      parent = dir;
    }
    return parent;
  };

  const byFile = new Map<string, { repoName: string; rel: string; rows: Row[] }>();
  for (const row of byId.values()) {
    if (hasParent.has(row.id)) continue;
    const repoName = row.repo || 'unknown';
    const rel = row.file ? relativePath(row.file, repoName) : row.label;
    const key = `${repoName}\u0000${rel}`;
    if (!byFile.has(key)) byFile.set(key, { repoName, rel, rows: [] });
    byFile.get(key)!.rows.push(row);
  }
  for (const { repoName, rel, rows } of byFile.values()) {
    const segments = rel.split('/').filter(Boolean);
    const name = segments.pop() || rel;
    const parentDir = getDir(repoName, segments);
    let fileRow = rows.find((r) => r.label === name || baseName(r.file || '') === r.label);
    if (!fileRow) {
      fileRow = makeRow(`file:${repoName}:${rel}`, name, 'file', { repo: repoName, file: rel });
    } else {
      rows.splice(rows.indexOf(fileRow), 1);
    }
    fileRow.kind = 'file';
    for (const r of rows) fileRow.children.push(r);
    parentDir.children.push(fileRow);
  }

  const compress = (row: Row) => {
    row.children.forEach(compress);
    if (row.kind === 'dir' && row.children.length === 1 && row.children[0].kind === 'dir') {
      const only = row.children[0];
      row.label = `${row.label}/${only.label}`;
      row.id = only.id;
      row.children = only.children;
    }
  };

  const finish = (row: Row) => {
    sortChildren(row.children);
    let total = 0;
    for (const c of row.children) {
      finish(c);
      total += 1 + c.count;
    }
    row.count = total;
  };

  const repoRows = [...repos.values()]
    .filter((r) => r.label !== 'external')
    .sort((a, b) => a.label.localeCompare(b.label));
  repoRows.forEach((r) => {
    r.children.forEach(compress);
    finish(r);
  });

  const root = makeRow('root', 'All repos', 'root', { children: repoRows });
  finish(root);
  return root;
}

export type Layout = {
  pos: Map<string, { x: number; y: number }>; // node centers
  rows: Map<string, Row>;
  parentOf: Map<string, string>;
  order: string[];
};

export type Dims = { w: number; h: number; nodesep: number; ranksep: number };
export const VIDEO_DIMS: Dims = { w: NODE_W, h: NODE_H, nodesep: 12, ranksep: 90 };
/** Same row size and spacing as the real dashboard (treeUtils.js). */
export const APP_DIMS: Dims = { w: 270, h: 46, nodesep: 10, ranksep: 70 };

export function layoutTree(root: Row, expanded: Set<string>, dims: Dims = VIDEO_DIMS): Layout {
  const rows: Row[] = [];
  const links: [string, string][] = [];
  const walk = (row: Row, parent: Row | null) => {
    rows.push(row);
    if (parent) links.push([parent.id, row.id]);
    if (expanded.has(row.id)) row.children.forEach((c) => walk(c, row));
  };
  walk(root, null);

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: dims.nodesep, ranksep: dims.ranksep, marginx: 30, marginy: 30 });
  g.setDefaultEdgeLabel(() => ({}));
  rows.forEach((r) => g.setNode(r.id, { width: dims.w, height: dims.h }));
  links.forEach(([s, t]) => g.setEdge(s, t));
  dagre.layout(g);

  const pos = new Map<string, { x: number; y: number }>();
  const rowMap = new Map<string, Row>();
  const parentOf = new Map<string, string>();
  rows.forEach((r) => {
    const p = g.node(r.id);
    pos.set(r.id, { x: p.x, y: p.y });
    rowMap.set(r.id, r);
  });
  links.forEach(([s, t]) => parentOf.set(t, s));
  return { pos, rows: rowMap, parentOf, order: rows.map((r) => r.id) };
}

/** Depth-first search returning the chain of rows from `root` to the match. */
export function pathTo(root: Row, match: (r: Row) => boolean): Row[] | null {
  if (match(root)) return [root];
  for (const c of root.children) {
    const hit = pathTo(c, match);
    if (hit) return [root, ...hit];
  }
  return null;
}
