// Captures the sidebar "entry points" search results shown in the Explorer
// (all repos, one repo, and one search) into data/entry.json.
// Absolute local paths are stripped.
import { writeFileSync } from 'node:fs';

const API = process.env.API_URL || 'http://localhost:8000';
const MFE = 'tb-discovery-mfe';
const QUERY = 'selection-xapi';

const strip = (p) => (p || '').replace(/^.*?\/code-graph-wsp(?=\/)/, '');
const clean = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'string' ? strip(x) : x)));

const get = async (params) => {
  const res = await fetch(`${API}/api/graph/search?${new URLSearchParams(params)}`);
  if (!res.ok) throw new Error(`search ${res.status}`);
  return clean(await res.json());
};

const out = {
  all: await get({ q: '', repo_id: 'all', limit: 40 }),
  mfe: await get({ q: '', repo_id: MFE, limit: 40 }),
  sel: await get({ q: QUERY, repo_id: MFE, limit: 40 }),
};
writeFileSync(new URL('../data/entry.json', import.meta.url), JSON.stringify(out));
console.log('entry:', Object.entries(out).map(([k, v]) => `${k}=${v.nodes.length}`).join(' '));
