// Runs one real Ask AI question against the local API and records the live
// status lines + final answer, so the video shows genuine output.
import { writeFileSync } from 'node:fs';
const API = process.env.API_URL || 'http://localhost:8000';
const question = process.argv[2] || 'Where is GlobalScriptsSDK used in tb-discovery-mfe?';
const repo = process.argv[3] || 'tb-discovery-mfe';
const j = async (r) => { if (!r.ok) throw new Error(`${r.status} ${await r.text()}`); return r.json(); };
const started = await j(await fetch(`${API}/api/ask`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ question, repo_id: repo }),
}));
console.log('conversation', started.conversation_id);
const statuses = [];
const t0 = Date.now();
for (;;) {
  await new Promise((r) => setTimeout(r, 1000));
  const s = await j(await fetch(`${API}/api/ask/${started.conversation_id}`));
  const txt = s.live_status?.text;
  if (txt && statuses[statuses.length - 1]?.text !== txt) statuses.push({ t: (Date.now() - t0) / 1000, text: txt });
  if (s.status !== 'running') {
    const json = JSON.stringify({ question, repo, statuses, answer: s.answer, context: s.context, status: s.status, error: s.error, seconds: (Date.now() - t0) / 1000 }, null, 2);
    // never commit absolute local paths
    writeFileSync(new URL('../data/ask.json', import.meta.url), json.replace(/\/Users\/[^"\\]*?\/code-graph-wsp/g, '/code-graph-wsp'));
    console.log('done', s.status, statuses.length, 'statuses', ((Date.now() - t0) / 1000).toFixed(0) + 's');
    break;
  }
  if (Date.now() - t0 > 240000) { console.log('timeout'); break; }
}
