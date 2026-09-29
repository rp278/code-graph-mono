import dagre from 'dagre';
import { colorForType } from './graphUtils';

// Colors per tree row kind (symbols fall back to their graph type color).
const KIND_COLORS = {
  root: '#e879f9',
  repo: '#e879f9',
  dir: '#60a5fa',
  file: '#94a3b8',
  node: '#34d399',
};

export const TREE_NODE_W = 270;
export const TREE_NODE_H = 46;

const KIND_ORDER = { dir: 0, file: 1, node: 2 };

function sortChildren(list) {
  list.sort((a, b) => {
    const k = (KIND_ORDER[a.kind] ?? 3) - (KIND_ORDER[b.kind] ?? 3);
    return k !== 0 ? k : a.label.localeCompare(b.label, undefined, { numeric: true });
  });
}

const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);

// Path of `file` relative to the repo checkout, found via the repo folder
// name (source_file is an absolute path from the machine that built the graph).
function relativePath(file, repo) {
  const marker = `/${repo}/`;
  const i = file.indexOf(marker);
  return i >= 0 ? file.slice(i + marker.length) : file.replace(/^\/+/, '');
}

function makeRow(id, label, kind, extra = {}) {
  return { id, label, kind, children: [], count: 0, ...extra };
}

/**
 * Build a folder -> file -> class/function -> method tree.
 *
 *   apiNodes: [{id, label, type, file, repo, loc}]
 *   apiEdges: [{source, target}]   (parent -> child only)
 *
 * Returns the root row. For a single repo the repo row is the root;
 * otherwise a virtual "All repos" row sits above the repo rows.
 */
export function buildTree(apiNodes, apiEdges, repoId) {
  const byId = new Map();
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

  // parent -> child links (first parent wins; ignore self links)
  const hasParent = new Set();
  for (const e of apiEdges) {
    const parent = byId.get(e.source);
    const child = byId.get(e.target);
    if (!parent || !child || parent === child || hasParent.has(child.id)) continue;
    parent.children.push(child);
    hasParent.add(child.id);
  }

  // Repo rows + directory trie
  const repos = new Map();
  const getRepo = (name) => {
    if (!repos.has(name)) repos.set(name, makeRow(`repo:${name}`, name, 'repo', { repo: name }));
    return repos.get(name);
  };
  const dirs = new Map();
  const getDir = (repoName, segments) => {
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

  // Top-level nodes are group by source file; the node labelled like the file
  // is the file row, anything else in that file hangs under it.
  const byFile = new Map();
  for (const row of byId.values()) {
    if (hasParent.has(row.id)) continue;
    const repoName = row.repo || 'unknown';
    const rel = row.file ? relativePath(row.file, repoName) : row.label;
    const key = `${repoName}\u0000${rel}`;
    if (!byFile.has(key)) byFile.set(key, { repoName, rel, rows: [] });
    byFile.get(key).rows.push(row);
  }
  for (const { repoName, rel, rows } of byFile.values()) {
    const segments = rel.split('/').filter(Boolean);
    const name = segments.pop() || rel;
    const parentDir = getDir(repoName, segments);
    let fileRow = rows.find((r) => r.label === name || baseName(r.file) === r.label);
    if (!fileRow) {
      fileRow = makeRow(`file:${repoName}:${rel}`, name, 'file', { repo: repoName, file: rel });
    } else {
      rows.splice(rows.indexOf(fileRow), 1);
    }
    fileRow.kind = 'file';
    for (const r of rows) fileRow.children.push(r);
    parentDir.children.push(fileRow);
  }

  // Collapse chains of single-child folders into "a/b/c"
  const compress = (row) => {
    row.children.forEach(compress);
    if (row.kind === 'dir' && row.children.length === 1 && row.children[0].kind === 'dir') {
      const only = row.children[0];
      row.label = `${row.label}/${only.label}`;
      row.id = only.id;
      row.children = only.children;
    }
  };

  // Sort, count descendants, precompute
  const finish = (row) => {
    sortChildren(row.children);
    let total = 0;
    for (const c of row.children) {
      finish(c);
      total += 1 + c.count;
    }
    row.count = total;
  };

  const repoRows = [...repos.values()].sort((a, b) => a.label.localeCompare(b.label));
  repoRows.forEach((r) => {
    r.children.forEach(compress);
    finish(r);
  });

  if (repoId && repoId !== 'all' && repos.has(repoId)) return repos.get(repoId);
  const root = makeRow('root', 'All repos', 'root', { children: repoRows });
  finish(root);
  return root;
}

/** Ids of rows to expand on first render: just the root. */
export function defaultExpanded(root) {
  return new Set(root ? [root.id] : []);
}

/**
 * Lay out only the visible part of the tree (expanded branches), left to right.
 * Returns { nodes, edges } ready for React Flow.
 */
export function layoutTree(root, expanded) {
  if (!root) return { nodes: [], edges: [] };

  const rows = [];
  const links = [];
  const walk = (row, parent) => {
    rows.push(row);
    if (parent) links.push([parent.id, row.id]);
    if (expanded.has(row.id)) row.children.forEach((c) => walk(c, row));
  };
  walk(root, null);

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 10, ranksep: 70, marginx: 30, marginy: 30 });
  g.setDefaultEdgeLabel(() => ({}));
  rows.forEach((r) => g.setNode(r.id, { width: TREE_NODE_W, height: TREE_NODE_H }));
  links.forEach(([s, t]) => g.setEdge(s, t));
  dagre.layout(g);

  const nodes = rows.map((r) => {
    const p = g.node(r.id);
    const color = r.kind === 'node' ? colorForType(r.type === 'code' ? 'function' : r.type) : KIND_COLORS[r.kind];
    return {
      id: r.id,
      type: 'treeNode',
      position: { x: p.x - TREE_NODE_W / 2, y: p.y - TREE_NODE_H / 2 },
      draggable: false,
      data: {
        label: r.label,
        kind: r.kind,
        type: r.type,
        file: r.file || '',
        loc: r.loc || '',
        count: r.count,
        childCount: r.children.length,
        expanded: expanded.has(r.id),
        color,
      },
    };
  });

  const edges = links.map(([s, t]) => ({
    id: `${s}->${t}`,
    source: s,
    target: t,
    type: 'smoothstep',
    style: { stroke: '#334155', strokeWidth: 1.4 },
  }));

  return { nodes, edges };
}

/** Find a row by id (depth first). */
export function findRow(root, id) {
  if (!root) return null;
  if (root.id === id) return root;
  for (const c of root.children) {
    const hit = findRow(c, id);
    if (hit) return hit;
  }
  return null;
}
