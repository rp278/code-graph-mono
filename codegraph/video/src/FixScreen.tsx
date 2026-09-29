import React, { useLayoutEffect, useRef } from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import graph from '../data/graph.json';
import { Shell, Spinner, Stage, TrackedCursor, CursorKey } from './AppUi';

type Beats = Record<string, { rel: number; dur: number }>;
const clampX = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

// ---- the real run (codegraph/pipeline/bug-uncaught-typeerror-products-map-is-n/state.json)
const SLUG = 'bug-uncaught-typeerror-products-map-is-n';
const TITLE = 'Uncaught TypeError: products.map is not a function';
const ERROR = `Uncaught TypeError: products.map is not a function
    at ProductList (http://localhost:5174/src/pages/ProductList.jsx:122:24)
    at renderWithHooks (react-dom_client.js:4400:19)
    at updateFunctionComponent (react-dom_client.js:5775:16)
    at beginWork (react-dom_client.js:6391:20)`;
const DETAILS = 'Home page also shows products.slice is not a function';
const REPORT_BODY = `Error / stack trace:\n${ERROR}\n\nExtra details:\n${DETAILS}`;

const GATES = [
  { key: '1_analysis', label: 'Analysis', stage: 'analysis', summary: 'Crash at ProductList.jsx:122 traces to a contract mismatch: shop-api GET /api/products returns { items, total }, but shop-web expects a bare array.' },
  { key: '2_rootcause', label: 'Root cause', stage: 'rootcause', summary: 'Restore the bare-array response in shop-api (schema + return). Scope fence: server.js only. Rejected: client-side unwrap, keeping the wrapper.' },
  { key: '3_repro', label: 'Reproduce', stage: 'repro', summary: 'On the unfixed code, 5 bug-condition tests fail (wrapped object) and 7 preservation tests pass. No source edited yet.' },
  { key: '4_fix', label: 'Fix', stage: 'fix', summary: 'Restored the array schema and return in server.js. npm test: 12/12 pass. PR #5 opened.' },
  { key: '5_qa', label: 'QA checklist', stage: 'qa', summary: 'QA checklist posted on PR #5: the original error is gone and nearby behavior is unchanged.' },
];
const LIVE = [
  ['Running `grep` — products.map', 'Finished `read` — src/pages/ProductList.jsx', 'Finished `read` — server.js'],
  ['Working…'],
  ['Running `shell` — npm test'],
  ['Running `edit` — server.js', 'Running `shell` — npm test'],
  ['Running `shell` — gh pr comment'],
];

const STATUS: Record<string, [string, string]> = {
  starting: ['Starting…', 'run-status-active'],
  running: ['Running…', 'run-status-active'],
  waiting_approval: ['Waiting on you', 'run-status-waiting'],
  done: ['Done', 'run-status-done'],
};
const Pill: React.FC<{ s: string }> = ({ s }) => <span className={`run-status-pill ${STATUS[s][1]}`}>{STATUS[s][0]}</span>;

export const FixScreen: React.FC<{ beats: Beats }> = ({ beats }) => {
  const f = useCurrentFrame();
  const { f1, f2, f3, f4, f5, f6 } = { f1: beats.f1.rel, f2: beats.f2.rel, f3: beats.f3.rel, f4: beats.f4.rel, f5: beats.f5.rel, f6: beats.f6.rel };

  // form
  const tErr = f1 + 26; // click + paste
  const tStart = f1 + Math.round(beats.f1.dur * 0.78);
  // gate timeline: when each gate opens and when the human approves it
  const pend = [f2 + 235, f3 + 105, f4 + 55, f5 + 28, f5 + 140];
  const appr = [f3 + 36, f3 + 240, f4 + 235, f5 + 96, f5 + 214];
  const tMerged = f5 + 246;

  const started = f >= tStart + 4;
  const pasted = f >= tErr + 6;
  const merged = f >= tMerged;
  const doneN = appr.filter((a) => f >= a).length; // gates approved
  const waitingIdx = pend.findIndex((p, i) => f >= p && f < appr[i]);
  const currentIdx = waitingIdx >= 0 ? -1 : doneN < 5 ? doneN : -1;
  const mergingNow = doneN === 5 && !merged;
  const status = !started ? null : merged ? 'done' : waitingIdx >= 0 ? 'waiting_approval' : f < tStart + 30 ? 'starting' : 'running';

  const stepState = (k: number) => (f >= appr[k] ? 'done' : waitingIdx === k ? 'waiting' : currentIdx === k ? 'current' : 'upcoming');
  const steps = [
    ...GATES.map((g, k) => ({ key: g.key, label: g.label, status: stepState(k) })),
    { key: 'merge', label: 'Merged', status: merged ? 'done' : mergingNow ? 'current' : 'upcoming' },
  ];

  const liveOpts = currentIdx >= 0 ? LIVE[currentIdx] : mergingNow ? ['Running `shell` — gh pr merge --squash'] : ['Working…'];
  const since = currentIdx >= 0 ? (currentIdx === 0 ? tStart + 30 : appr[currentIdx - 1]) : appr[4];
  const live = liveOpts[Math.min(liveOpts.length - 1, Math.floor(Math.max(0, f - since) / 55))];
  const stage = merged ? 'done' : GATES[Math.min(4, waitingIdx >= 0 ? waitingIdx : doneN)].stage;
  const prOpen = f >= pend[3];
  const gateDots = GATES.map((g, k) => (f >= appr[k] ? 'gate-dot approved' : waitingIdx === k ? 'gate-dot pending' : 'gate-dot'));

  const main = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (main.current) main.current.scrollTop = main.current.scrollHeight;
  });

  const path: CursorKey[] = [
    { f: tErr, t: 'errbox@0.4,0.3' },
    { f: tStart, t: 'start' },
    { f: tStart + 60, t: [1180, 520] },
    { f: appr[0], t: 'approve' },
    { f: appr[1], t: 'approve' },
    { f: appr[2], t: 'approve' },
    { f: appr[3], t: 'approve' },
    { f: appr[4], t: 'approve' },
  ];
  const clicks = [tErr, tStart, ...appr];

  // typed text in the form
  const errText = pasted ? ERROR : '';
  const detailsText = pasted ? DETAILS : '';
  const formOn = !started;

  // callouts (screen space)
  const card = interpolate(f, [f2 + 140, f2 + 160, f3 - 6, f3 + 10], [0, 1, 1, 0], clampX);
  const arts = interpolate(f, [f6 - 4, f6 + 14], [0, 1], clampX);
  const overlay = (
    <>
      <TrackedCursor path={path} clicks={clicks} />
      <div style={{ position: 'absolute', right: 56, bottom: 120, width: 640, opacity: card, transform: `translateY(${(1 - card) * 12}px)`, ...calloutBox('#fb923c') }}>
        <div style={{ fontWeight: 700, color: '#fb923c', marginBottom: 10 }}>Found through the graph: two repos, one contract</div>
        <div style={row}><span style={chip('#a78bfa')}>shop-web</span> ProductList.jsx:122 calls <code>products.map(…)</code> and expects an array</div>
        <div style={{ textAlign: 'center', color: '#22d3ee', fontSize: 22, margin: '4px 0' }}>┆ fetches GET /api/products ┆</div>
        <div style={row}><span style={chip('#34d399')}>shop-api</span> now returns <code>{'{ items, total }'}</code> instead</div>
      </div>
      <div style={{ position: 'absolute', left: 60, right: 60, bottom: 110, display: 'flex', gap: 14, justifyContent: 'center', opacity: arts, transform: `translateY(${(1 - arts) * 12}px)` }}>
        {['bugfix.md', 'rootcause.md', 'repro.md', 'fix.md', 'qa-checklist.md'].map((a) => (
          <span key={a} style={{ ...calloutBox('#22d3ee'), padding: '10px 18px', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 22 }}>{a}</span>
        ))}
      </div>
    </>
  );

  return (
    <Stage overlay={overlay}>
      <Shell title="Fix Bugs">
        <div className="requirements-tab">
          <div className="req-sidebar">
            <div className="req-list">
              <div className="req-list-header"><span>Bugs</span></div>
              {!started && <div className="req-list-empty muted">No bug runs yet — file one below.</div>}
              {started && (
                <button className="req-list-item selected">
                  <div className="req-list-item-top">
                    <span className="req-slug mono">{SLUG}</span>
                    {status && <Pill s={status} />}
                  </div>
                  <div className="req-list-item-text muted">{TITLE}</div>
                  <div className="req-list-item-stories">
                    <span className="req-story-chip">
                      shop-api
                      <span className="gate-track">{gateDots.map((c, i) => (<span key={i} className={c} />))}</span>
                    </span>
                  </div>
                </button>
              )}
            </div>
            <div className="new-req-box">
              <h3>New bug</h3>
              <div data-t="errbox">
                <textarea className="revise-input mono bug-error-input" rows={6} readOnly placeholder="Paste the error message or stack trace…" value={formOn ? errText : ''} />
              </div>
              <input className="search-input" readOnly placeholder="Title (optional — derived from the error)" />
              <div className="repo-pick">
                <span className="repo-pick-label muted">Repos</span>
                <button className="repo-chip active">Not sure</button>
                {(graph.repos as any[]).slice(0, 2).map((r) => (
                  <button key={r.id} className="repo-chip">{r.name}</button>
                ))}
              </div>
              <textarea className="revise-input" rows={2} readOnly placeholder="Extra details (optional) — when it happens, what changed recently…" value={formOn ? detailsText : ''} />
              <button data-t="start" className="rebuild-btn" disabled={!pasted || started}>Start fix pipeline</button>
            </div>
          </div>

          <div className="req-main" ref={main}>
            {!started ? (
              <div className="empty-state">
                <h2>Select a bug</h2>
                <p className="muted">Pick one from the list, or file a new bug on the left.</p>
              </div>
            ) : (
              <div className="req-detail">
                <div className="req-detail-header">
                  <h2 className="mono">{SLUG}</h2>
                  {status && <Pill s={status} />}
                  <button className="tab-chip rerun-btn">↻ Rerun</button>
                </div>
                {(status === 'running' || status === 'starting') && (
                  <div className="live-status-ticker">
                    <span className="live-status-dot" />
                    {status === 'starting' ? 'Starting…' : live}
                  </div>
                )}
                <div className="bug-report">
                  <div className="bug-report-title">{TITLE}</div>
                  <pre className="bug-report-body mono">{REPORT_BODY}</pre>
                </div>
                <div className="story-cards">
                  <div className="story-card">
                    <div className="story-card-header">
                      <span className="story-repo mono">shop-api</span>
                      <span className="story-stage muted">{stage}</span>
                    </div>
                    <div className="stage-bar">
                      {steps.map((step, i) => (
                        <div className="stage-step" key={step.key}>
                          <div className="stage-step-track">
                            {i > 0 && <span className={`stage-connector ${steps[i - 1].status === 'done' ? 'filled' : ''}`} />}
                            <span className={`stage-node ${step.status}`}>
                              {step.status === 'done' && '✓'}
                              {step.status === 'current' && <Spinner />}
                            </span>
                          </div>
                          <span className={`stage-step-label ${step.status}`}>{step.label}</span>
                        </div>
                      ))}
                    </div>
                    {prOpen && <a className="story-pr-link">View PR ↗</a>}
                    {merged && <span className="merged-badge">Merged</span>}
                    {waitingIdx >= 0 && (
                      <div className="pending-gate-box">
                        <div className="pending-gate-title">Waiting: Gate {GATES[waitingIdx].key} — {GATES[waitingIdx].label}</div>
                        <div className="pending-gate-summary muted">{GATES[waitingIdx].summary}</div>
                      </div>
                    )}
                  </div>
                </div>
                {waitingIdx >= 0 && (
                  <div className="gate-actions">
                    <h3>Pending approval</h3>
                    <div className="gate-action-row">
                      <div>
                        <strong>shop-api</strong> — {GATES[waitingIdx].label}
                        <div className="muted pending-gate-summary">{GATES[waitingIdx].summary}</div>
                      </div>
                      <textarea className="revise-input" rows={2} readOnly placeholder="Optional feedback if revising…" />
                      <div className="gate-action-buttons">
                        <button data-t="approve" className="rebuild-btn">Approve</button>
                        <button className="link-btn">Send back for revision</button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </Shell>
    </Stage>
  );
};

const calloutBox = (color: string): React.CSSProperties => ({
  padding: '18px 24px',
  borderRadius: 16,
  background: 'rgba(13,20,32,0.97)',
  border: `1px solid ${color}`,
  boxShadow: `0 0 34px ${color}33`,
  color: '#e2e8f0',
  fontFamily: '-apple-system, "Segoe UI", sans-serif',
  fontSize: 24,
  lineHeight: 1.35,
});
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 12 };
const chip = (c: string): React.CSSProperties => ({ border: `1px solid ${c}`, color: c, borderRadius: 8, padding: '2px 10px', fontWeight: 700, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 22 });
