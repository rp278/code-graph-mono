// Saves the live tree from the codeGraph API to data/tree.json so the video
// renders offline and deterministically. Absolute local paths are stripped.
import { writeFileSync } from 'node:fs';

const API = process.env.API_URL || 'http://localhost:8000';
const res = await fetch(`${API}/api/graph/tree`);
if (!res.ok) throw new Error(`API returned ${res.status}`);
const { nodes, edges } = await res.json();

const strip = (p) => (p || '').replace(/^.*?\/code-graph-wsp(?=\/)/, '');
const slim = nodes.map((n) => ({
  id: n.id,
  label: n.label,
  type: n.type,
  file: strip(n.file),
  repo: n.repo,
  loc: n.loc,
}));

writeFileSync(new URL('../data/tree.json', import.meta.url), JSON.stringify({ nodes: slim, edges }));
console.log(`saved ${slim.length} nodes, ${edges.length} edges`);
