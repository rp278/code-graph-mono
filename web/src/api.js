// Thin client for the codegraph-api backend.
// Base URL is configurable via VITE_API_URL (defaults to local dev server).
// Bearer token is configurable via VITE_API_TOKEN — required whenever the
// API has API_TOKEN set (i.e. any deployment reachable from the internet).

const BASE = (import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const TOKEN = import.meta.env.VITE_API_TOKEN || '';

async function request(path, { method = 'GET', body } = {}) {
  let res;
  try {
    const headers = body ? { 'Content-Type': 'application/json' } : {};
    if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`Cannot reach the API at ${BASE}. Is codegraph-api running?`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API error ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

export const api = {
  getRepos: () => request('/api/repos'),
  getGraph: (repoId) =>
    request(!repoId || repoId === 'all' ? '/api/graph' : `/api/graph?repo_id=${encodeURIComponent(repoId)}`),
  getStats: () => request('/api/graph/stats'),
  rebuild: (repoId) => request('/api/graph/rebuild', { method: 'POST', body: { repo_id: repoId } }),
  chat: (question, repoId) =>
    request('/api/chat', { method: 'POST', body: { question, repo_id: repoId } }),
  query: (cypher, params = {}) => request('/api/query', { method: 'POST', body: { cypher, params } }),
};

export const API_BASE = BASE;
