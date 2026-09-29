import React, { useLayoutEffect, useRef } from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import graph from '../data/graph.json';
import { Shell, Spinner, Stage, TrackedCursor, CursorKey } from './AppUi';

type Beats = Record<string, { rel: number; dur: number }>;
const clampX = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

// ---- a real run on the real repos (codegraph/pipeline/bug-typeerror-cannot-read-properties-of):
// the Cursor SDK agent, 4 gates, PR https://github.com/MensWearhouse/tb-discovery-mfe/pull/1907
const SLUG = 'bug-typeerror-cannot-read-properties-of';
const REPO = 'tb-discovery-mfe';
const TITLE = "TypeError: Cannot read properties of undefined (reading 'toLowerCase')";
const ERROR = `TypeError: Cannot read properties of undefined (reading 'toLowerCase')
 ❯ slugify helpers/formatters.ts:47:33
     45|  */
     46| export const slugify = (queryValue: string) =>
     47|   encodeURIComponent(queryValue.toLowerCase().replace(/ /g, '-'));
       |                                 ^`;
const REPORT_BODY = `Error / stack trace:\n${ERROR}`;

// Summaries below are condensed from the gate summaries the agent actually wrote for this run.
const GATES = [
  { key: '1_analysis', label: 'Analysis', stage: '1-analysis', summary: "Stack and the live graph both point at helpers/formatters.ts slugify (line 47), which calls queryValue.toLowerCase() with no guard. Expected: return '' without throwing; string inputs keep today's slug. Scope fence: slugify only." },
  { key: '2_rootcause', label: 'Root cause', stage: '2-rootcause', summary: "Commit 98b94cfc5 removed the earlier typeof !== 'string' check, so undefined input throws. Proposed fix: restore that one guard only. Preservation: string inputs keep identical encodeURIComponent output." },
  { key: '3_repro', label: 'Reproduce', stage: '3-repro', summary: 'On the unfixed code, 2 bug-condition tests fail with the TypeError at formatters.ts:47:33, matching the root cause, and 15 preservation tests pass. No non-test source changed.' },
  { key: '4_fix', label: 'Fix', stage: '4-fix', summary: "Restored the typeof !== 'string' → '' guard in slugify. All 17 formatters tests pass; lint clean; scope fence honored. PR #1907 is open." },
];
const LIVE = [
  ['Running `shell` — codeGraph query "slugify"', 'Finished `read` — helpers/formatters.ts'],
  ['Running `shell` — git log -S toLowerCase', 'Finished `read` — helpers/formatters.ts'],
  ['Running `edit` — helpers/__tests__/formatters.test.ts', 'Running `shell` — npm test'],
  ['Running `edit` — helpers/formatters.ts', 'Running `shell` — npm test', 'Running `shell` — gh pr create'],
];

const STATUS: Record<string, [string, string]> = {
  starting: ['Starting…', 'run-status-active'],
  running: ['Running…', 'run-status-active'],
  waiting_approval: ['Waiting on you', 'run-status-waiting'],
  done: ['Done', 'run-status-done'],
};
const Pill: React.FC<{ s: string }> = ({ s }) => <span className={`run-status-pill ${STATUS[s][1]}`}>{STATUS[s][0]}</span>;

// the same 24x24 stroke icons as the dashboard's run actions
const Icon: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <svg className="req-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);
const PauseIcon = () => (<Icon><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></Icon>);
const RestartIcon = () => (<Icon><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></Icon>);
const TrashIcon = () => (<Icon><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M10 11v6" /><path d="M14 11v6" /></Icon>);

export const FixScreen: React.FC<{ beats: Beats }> = ({ beats }) => {
  const f = useCurrentFrame();
  const { f1, f2, f3, f4, f5, f6 } = { f1: beats.f1.rel, f2: beats.f2.rel, f3: beats.f3.rel, f4: beats.f4.rel, f5: beats.f5.rel, f6: beats.f6.rel };

  // form
  const tErr = f1 + 26; // click + paste
  const tStart = f1 + Math.round(beats.f1.dur * 0.78);

  // gate timeline: when each gate opens and when the human approves it
  const pend = [f2 + 235, f3 + 105, f4 + 45, f5 + 30];
  const appr = [f3 + 36, f3 + 300, f4 + 235, f5 + 290];
  const tDone = appr[3] + 10; // approving Gate 4 finishes the run; the PR stays open

  const started = f >= tStart + 4;
  const pasted = f >= tErr + 6;
  const done = f >= tDone;
  const doneN = appr.filter((a) => f >= a).length; // gates approved
  const waitingIdx = pend.findIndex((p, i) => f >= p && f < appr[i]);
  const currentIdx = waitingIdx >= 0 || done ? -1 : doneN < 4 ? doneN : -1;
  const status = !started ? null : done ? 'done' : waitingIdx >= 0 ? 'waiting_approval' : f < tStart + 30 ? 'starting' : 'running';
  const isRunning = status === 'running' || status === 'starting';

  const stepState = (k: number) => (f >= appr[k] ? 'done' : waitingIdx === k ? 'waiting' : currentIdx === k ? 'current' : 'upcoming');
  // one step per gate; bug runs have no "Merged" step
  const steps = GATES.map((g, k) => ({ key: g.key, label: g.label, status: stepState(k) }));

  const liveOpts = currentIdx >= 0 ? LIVE[currentIdx] : ['Working…'];
  const since = currentIdx >= 0 ? (currentIdx === 0 ? tStart + 30 : appr[currentIdx - 1]) : appr[3];
  const live = liveOpts[Math.min(liveOpts.length - 1, Math.floor(Math.max(0, f - since) / 55))];
  const stage = done ? 'done' : GATES[Math.min(3, waitingIdx >= 0 ? waitingIdx : doneN)].stage;
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
    { f: appr[3] + 50, t: [1290, 690] },
  ];
  const clicks = [tErr, tStart, ...appr];

  // typed text in the form
  const errText = pasted ? ERROR : '';
  const formOn = !started;

  // callouts (screen space)
  const card = interpolate(f, [f2 + 50, f2 + 70, f2 + 205, f2 + 228], [0, 1, 1, 0], clampX);
  const prNote = interpolate(f, [tDone + 6, tDone + 24, f6 - 6, f6 + 10], [0, 1, 1, 0], clampX);
  const arts = interpolate(f, [f6 - 4, f6 + 14], [0, 1], clampX);
  const overlay = (
    <>
      <TrackedCursor path={path} clicks={clicks} />
      <div style={{ position: 'absolute', right: 56, bottom: 120, width: 700, opacity: card, transform: `translateY(${(1 - card) * 12}px)`, ...calloutBox('#fb923c') }}>
        <div style={{ fontWeight: 700, color: '#fb923c', marginBottom: 10 }}>Found through the graph</div>
        <div style={row}><span style={chip('#34d399')}>{REPO}</span> <code>slugify()</code> in helpers/formatters.ts: the stack frame</div>
        <div style={{ ...row, margin: '10px 0' }}><span style={chip('#22d3ee')}>IMPORTS_FROM</span> colorSlug, productCardHelpers, PdpComponent, SEO schema…</div>
        <div style={row}><span style={chip('#a78bfa')}>tb-common-mfe</span> same-named helpers: ruled out</div>
      </div>
      <div style={{ position: 'absolute', right: 56, bottom: 120, width: 700, opacity: prNote, transform: `translateY(${(1 - prNote) * 12}px)`, ...calloutBox('#34d399') }}>
        <div style={{ fontWeight: 700, color: '#34d399', marginBottom: 8 }}>Run done. PR #1907 stays open.</div>
        <div>The pipeline never merges. A person reviews and merges it.</div>
      </div>
      <div style={{ position: 'absolute', left: 60, right: 60, bottom: 110, display: 'flex', gap: 14, justifyContent: 'center', opacity: arts, transform: `translateY(${(1 - arts) * 12}px)` }}>
        {['bugfix.md', 'rootcause.md', 'repro.md', 'fix.md'].map((a) => (
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
                      {REPO}
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
              <textarea className="revise-input" rows={2} readOnly placeholder="Extra details (optional) — when it happens, what changed recently…" />
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
                  {isRunning ? (
                    <>
                      <span className="req-action-btn state running" role="status"><Spinner />Running…</span>
                      <button className="req-icon-btn" aria-label="Pause"><PauseIcon /></button>
                    </>
                  ) : (
                    status && <Pill s={status} />
                  )}
                  <div className="req-actions">
                    <button className="req-action-btn" disabled={isRunning}><RestartIcon />Restart</button>
                    <button className="req-action-btn danger" disabled={isRunning}><TrashIcon />Delete</button>
                  </div>
                </div>
                {isRunning && (
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
                      <span className="story-repo mono">{REPO}</span>
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
                        <strong>{REPO}</strong> — {GATES[waitingIdx].label}
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
