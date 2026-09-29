// Captures the real data the View Graph screen shows: repos, stats,
// cross-repo links and the neighborhood of one interesting endpoint.
import { writeFileSync } from 'node:fs';
const API = process.env.API_URL || 'http://localhost:8000';
const get = async (p) => { const r = await fetch(API + p); if (!r.ok) throw new Error(p + ' ' + r.status); return r.json(); };
const strip = (p) => (p || '').replace(/^.*?\/code-graph-wsp(?=\/)/, '');
const clean = (n) => ({ ...n, file: strip(n.file) });

const repos = await get('/api/repos');
const stats = await get('/api/graph/stats');
const links = (await get('/api/graph/repo-links')).links;

// Pick a focus endpoint with cross-repo consumers: the busiest endpoint node.
const ends = (await get('/api/graph/search?q=&repo_id=all&type=endpoint&limit=60')).nodes;
const cand = process.argv[2] ? ends.find((n) => n.label.includes(process.argv[2])) : ends.sort((a, b) => b.degree - a.degree)[0];
const hood = await get('/api/graph/neighborhood?node_id=' + encodeURIComponent(cand.id));
const byTypeRepo = {};
for (const r of stats.by_type) byTypeRepo[r.repo] = (byTypeRepo[r.repo] || 0) + r.c;

const trim = (n) => clean(n);
writeFileSync(new URL('../data/graph.json', import.meta.url), JSON.stringify({
  repos, stats: { nodes: stats.nodes, edges: stats.edges }, repoCounts: byTypeRepo, links,
  candidates: ends.slice(0, 12).map((n) => ({ label: n.label, repo: n.repo, degree: n.degree })),
  hood: { center: trim(hood.center), nodes: hood.nodes.map(trim), edges: hood.edges, total: hood.total },
}, null, 1));
console.log('focus:', cand.label, '| repo', cand.repo, '| neighbors', hood.nodes.length, 'edges', hood.edges.length, 'total', hood.total);
console.log(ends.slice(0, 12).map((n) => `${n.degree} ${n.repo} ${n.label}`).join('\n'));
