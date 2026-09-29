import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';

// Feature and bug runs share one state machine but use different gate
// keys/names (see .cursor/rules/pipeline-gates.mdc and pipeline-bugfix.mdc).
const FEATURE_GATE_LABELS = {
  '1_stories': 'Stories',
  '2_plan': 'Plan',
  '3_impl': 'Implementation',
  '4_traceability': 'Traceability',
  '5_qa': 'QA checklist',
};
const BUG_GATE_LABELS = {
  '1_analysis': 'Analysis',
  '2_rootcause': 'Root cause',
  '3_repro': 'Reproduce',
  '4_fix': 'Fix',
};

function gatesFor(kind) {
  const labels = kind === 'bug' ? BUG_GATE_LABELS : FEATURE_GATE_LABELS;
  return { labels, order: Object.keys(labels) };
}

const STATUS_META = {
  idle: { label: 'Idle', cls: 'muted' },
  starting: { label: 'Starting…', cls: 'run-status-active' },
  running: { label: 'Running…', cls: 'run-status-active' },
  waiting_approval: { label: 'Waiting on you', cls: 'run-status-waiting' },
  done: { label: 'Done', cls: 'run-status-done' },
  paused: { label: 'Paused', cls: 'muted' },
  error: { label: 'Error', cls: 'run-status-error' },
};

// Same 24x24 stroke icon set for every run action, so the pills line up.
function ActionIcon({ children }) {
  return (
    <svg
      className="req-action-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function PauseIcon() {
  return (
    <ActionIcon>
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </ActionIcon>
  );
}

function PlayIcon() {
  return (
    <ActionIcon>
      <polygon points="6 3 20 12 6 21 6 3" />
    </ActionIcon>
  );
}

function RestartIcon() {
  return (
    <ActionIcon>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </ActionIcon>
  );
}

function TrashIcon() {
  return (
    <ActionIcon>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </ActionIcon>
  );
}

function StatusPill({ status }) {
  const meta = STATUS_META[status] || STATUS_META.idle;
  return <span className={`run-status-pill ${meta.cls}`}>{meta.label}</span>;
}

function GateTrack({ gates, kind }) {
  const { labels, order } = gatesFor(kind);
  return (
    <div className="gate-track">
      {order.map((g) => {
        const v = gates?.[g];
        const cls =
          v === 'approved'
            ? 'gate-dot approved'
            : v === 'pending_reapproval'
            ? 'gate-dot pending'
            : 'gate-dot';
        return (
          <span key={g} className={cls} title={`${labels[g]}: ${v || 'not reached'}`} />
        );
      })}
    </div>
  );
}

// Full-width labeled step bar for the requirement detail view — one step
// per gate, plus a synthetic final "Merged" step for feature runs only
// (bug runs never merge: they end at an open PR once the last gate is
// approved). A step is:
//   done      — gate approved (or, for the Merged step, merge_status
//               === 'merged')
//   waiting   — gate has a pending_gate marker, or is pending_reapproval
//               (a mid-run requirement change reset it) — needs the
//               user's approve/revise action
//   current   — the agent is actively working on this step right now
//               (first not-done, not-waiting step, only while the run's
//               overall status is starting/running)
//   upcoming  — hasn't been reached yet
// `awaiting` = this story has a gate that is waiting on the user: either
// open for approval right now, or already answered but queued behind the
// agent's current turn. It is per story, not per run, so a story can show
// "waiting" while the agent is busy on a different repo.
function computeStageSteps(
  story,
  runStatus,
  { isWorking = false, justApprovedGate = null, kind = 'feature', awaiting = false } = {}
) {
  const gates = story?.gates || {};
  const { labels, order } = gatesFor(kind);
  const steps = order.map((g) => {
    const v = gates[g];
    let status = 'upcoming';
    if (v === 'approved') status = 'done';
    else if (v === 'pending_reapproval' && runStatus === 'waiting_approval') status = 'waiting';
    else if (story?.pending_gate?.gate === g && awaiting) status = 'waiting';
    return { key: g, label: labels[g], status };
  });

  if (kind !== 'bug') {
    const merged = story?.merge_status === 'merged';
    steps.push({
      key: 'merge',
      label: 'Merged',
      status: merged ? 'done' : 'upcoming',
    });
  }

  // Only skip-ahead past a pending_gate if it is the gate the user just
  // approved. If the agent has already written the *next* gate (e.g.
  // 5_qa) while the turn is still wrapping up, that new pending_gate
  // is NOT approved yet — spinning the following step and hiding the
  // open gate was the snap-back bug.
  const agentBusy = runStatus === 'running' || runStatus === 'starting';
  if (agentBusy && isWorking) {
    const pendingKey = story?.pending_gate?.gate;
    if (pendingKey && pendingKey === justApprovedGate) {
      const pendingIdx = steps.findIndex((s) => s.key === pendingKey);
      if (pendingIdx !== -1) steps[pendingIdx].status = 'done';
      const idx = steps.findIndex((s) => s.status === 'upcoming');
      if (idx !== -1) steps[idx].status = 'current';
    } else if (pendingKey) {
      if (justApprovedGate) {
        const approvedIdx = steps.findIndex((s) => s.key === justApprovedGate);
        if (approvedIdx !== -1) steps[approvedIdx].status = 'done';
      }
      const pendingIdx = steps.findIndex((s) => s.key === pendingKey);
      if (pendingIdx !== -1) steps[pendingIdx].status = 'current';
    } else {
      const idx = steps.findIndex((s) => s.status === 'upcoming');
      if (idx !== -1) steps[idx].status = 'current';
    }
  }

  return steps;
}

function StageBar({ story, runStatus, isWorking, justApprovedGate, kind, awaiting }) {
  const steps = computeStageSteps(story, runStatus, {
    isWorking,
    justApprovedGate,
    kind,
    awaiting,
  });
  return (
    <div className="stage-bar">
      {steps.map((step, i) => (
        <div className="stage-step" key={step.key}>
          <div className="stage-step-track">
            {i > 0 && <span className={`stage-connector ${steps[i - 1].status === 'done' ? 'filled' : ''}`} />}
            <span className={`stage-node ${step.status}`}>
              {step.status === 'done' && '✓'}
              {step.status === 'current' && <span className="spinner" />}
            </span>
          </div>
          <span className={`stage-step-label ${step.status}`}>{step.label}</span>
        </div>
      ))}
    </div>
  );
}

function RequirementList({ items, selectedSlug, onSelect, loading, error, onRetry, kind }) {
  const empty =
    kind === 'bug'
      ? 'No bug runs yet — file one below.'
      : 'No features yet — start one below.';
  return (
    <div className="req-list">
      <div className="req-list-header">
        <span>{kind === 'bug' ? 'Bugs' : 'Features'}</span>
        {loading && <span className="spinner" />}
      </div>
      {error && (
        <div className="banner error">
          {error}{' '}
          <button className="link-btn" onClick={onRetry}>
            retry
          </button>
        </div>
      )}
      {!loading && !error && items.length === 0 && (
        <div className="req-list-empty muted">{empty}</div>
      )}
      {items.map((r) => (
        <button
          key={r.slug}
          className={`req-list-item ${r.slug === selectedSlug ? 'selected' : ''}`}
          onClick={() => onSelect(r.slug)}
        >
          <div className="req-list-item-top">
            <span className="req-slug mono">{r.slug}</span>
            <StatusPill status={r.run_status} />
          </div>
          <div className="req-list-item-text muted">
            {r.kind === 'bug' ? firstLine(r.requirement).replace(/^Bug:\s*/, '') : r.requirement}
          </div>
          <div className="req-list-item-stories">
            {Object.entries(r.stories || {}).map(([repo, s]) => (
              <span key={repo} className="req-story-chip">
                {repo}
                <GateTrack gates={s.gates} kind={r.kind} />
              </span>
            ))}
          </div>
          {(r.run_status === 'running' || r.run_status === 'starting') && (
            <div className="live-status-ticker small">
              <span className="live-status-dot" />
              {r.live_status?.text || 'Working…'}
            </div>
          )}
        </button>
      ))}
    </div>
  );
}

function StoryCard({
  repo,
  story,
  runStatus,
  isWorking,
  justApprovedGate,
  kind,
  pendingOpen,
  responseQueued,
}) {
  const { labels } = gatesFor(kind);
  return (
    <div className="story-card">
      <div className="story-card-header">
        <span className="story-repo mono">{repo}</span>
        <span className="story-stage muted">{story.stage}</span>
      </div>
      <StageBar
        story={story}
        runStatus={runStatus}
        isWorking={isWorking}
        justApprovedGate={justApprovedGate}
        kind={kind}
        awaiting={pendingOpen || responseQueued}
      />
      {story.pr_url && (
        <a className="story-pr-link" href={story.pr_url} target="_blank" rel="noreferrer">
          View PR ↗
        </a>
      )}
      {story.merge_status === 'merged' && <span className="merged-badge">Merged</span>}
      {responseQueued && (
        <div className="queued-note muted">
          Your response is queued — the agent will pick it up as soon as it finishes its
          current step.
        </div>
      )}
      {pendingOpen && !isWorking && (
        <div className="pending-gate-box">
          <div className="pending-gate-title">
            Waiting: Gate {story.pending_gate.gate} — {labels[story.pending_gate.gate] || story.pending_gate.gate}
          </div>
          {story.pending_gate.summary && (
            <div className="pending-gate-summary muted">{story.pending_gate.summary}</div>
          )}
        </div>
      )}
    </div>
  );
}

function RequirementDetail({
  slug,
  onRespond,
  responding,
  onPause,
  onResume,
  onRestart,
  onDelete,
  refreshKey,
}) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [revisionDrafts, setRevisionDrafts] = useState({});
  const [updateText, setUpdateText] = useState('');
  // Optimistic hide of the pending-approval panel from the moment the
  // user clicks Approve/Revise until this turn actually finishes and
  // a *new* gate is waiting. Without this, the old gate stays visible
  // (disk `pending_gate` isn't rewritten until the turn ends).
  const [dismissedPending, setDismissedPending] = useState(false);
  const dismissedGateRef = useRef(null);
  // Pause was clicked and is taking effect (the agent stops at its next safe point).
  const [pausing, setPausing] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api.getRequirement(slug);
      setDetail(d);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [slug]);

  useEffect(() => {
    setDismissedPending(false);
    dismissedGateRef.current = null;
    load();
  }, [load, refreshKey]);

  const isBusy =
    responding || detail?.run_status === 'running' || detail?.run_status === 'starting';
  const isRunning = detail?.run_status === 'running' || detail?.run_status === 'starting';
  const isPaused = detail?.run_status === 'paused';

  useEffect(() => {
    if (!isRunning) setPausing(false);
  }, [isRunning]);

  const pauseRun = async () => {
    setPausing(true);
    const ok = await onPause(slug);
    if (!ok) setPausing(false);
    else load();
  };

  // Re-show the panel only once the gate the user just acted on is
  // gone from disk (replaced by the next gate, or cleared because the
  // story finished). Do not re-show just because run_status briefly
  // still says waiting_approval — that's the old gate.
  useEffect(() => {
    if (!dismissedPending || isBusy || !detail) return;
    const dismissed = dismissedGateRef.current;
    if (!dismissed) {
      setDismissedPending(false);
      return;
    }
    if (dismissed.type === 'update') {
      setDismissedPending(false);
      dismissedGateRef.current = null;
      return;
    }
    const stillThere = Object.entries(detail.state.stories || {}).some(([repo, s]) => {
      const g = s.pending_gate;
      return (
        g &&
        dismissed.repo === repo &&
        dismissed.gate === g.gate &&
        dismissed.presentedAt === g.presented_at
      );
    });
    if (!stillThere) {
      setDismissedPending(false);
      dismissedGateRef.current = null;
    }
  }, [dismissedPending, isBusy, detail]);

  // Poll while the agent is actively working so the UI reflects progress
  // without the user needing to refresh. Also poll after the user has
  // dismissed the pending panel, so we notice the next gate as soon as
  // this turn finishes.
  useEffect(() => {
    if (!detail) return undefined;
    const active =
      detail.run_status === 'running' ||
      detail.run_status === 'starting' ||
      dismissedPending;
    if (!active) return undefined;
    const id = setInterval(load, 1500);
    return () => clearInterval(id);
  }, [detail, load, dismissedPending]);

  if (error) {
    return (
      <div className="banner error">
        {error}{' '}
        <button className="link-btn" onClick={load}>
          retry
        </button>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="veil">
        <span className="spinner large" />
        <span>Loading…</span>
      </div>
    );
  }

  const stories = Object.entries(detail.state.stories || {});
  const runKind = detail.state.kind || 'feature';
  const gateLabels = gatesFor(runKind).labels;
  const dismissed = dismissedGateRef.current;
  const dismissedRepo = dismissed?.type === 'gate' ? dismissed.repo : null;
  const agentBusy = detail.run_status === 'running' || detail.run_status === 'starting';
  const acted = detail.acted || [];
  const queuedMessages = (detail.queued || []).map((q) => q.message);

  // A gate is "open" (waiting on the user) when it's on disk and nobody has
  // answered that exact presentation of it yet. The server remembers
  // answers (`acted`) until the agent processes them, so this survives page
  // reloads and the agent still being mid-turn on some *other* story.
  const actedFor = (repo, pg) =>
    pg &&
    acted.find(
      (a) => a.repo === repo && a.gate === pg.gate && a.presented_at === pg.presented_at
    );
  const dismissedLocally = (repo, pg) =>
    dismissedPending &&
    dismissed?.type === 'gate' &&
    dismissed.repo === repo &&
    pg &&
    dismissed.gate === pg.gate &&
    dismissed.presentedAt === pg.presented_at;
  const updateDismissed = dismissedPending && dismissed?.type === 'update';
  const isOpenGate = (repo, s) =>
    !!s.pending_gate &&
    !updateDismissed &&
    !actedFor(repo, s.pending_gate) &&
    !dismissedLocally(repo, s.pending_gate);
  // The user's answer is sitting in the queue behind the agent's current turn.
  const isResponseQueued = (repo, s) => {
    const a = actedFor(repo, s.pending_gate);
    return (
      !!a && queuedMessages.some((m) => m.startsWith(`gate ${a.gate} for ${repo}:`))
    );
  };

  // Gates waiting on the user are shown even while the agent is busy with
  // another story: answering one just queues the response.
  const visiblePending = stories.filter(([repo, s]) => isOpenGate(repo, s));
  const showPendingPanel = visiblePending.length > 0;

  const approve = async (repo, gate) => {
    const presentedAt = stories.find(([r]) => r === repo)?.[1]?.pending_gate?.presented_at;
    dismissedGateRef.current = { type: 'gate', repo, gate, presentedAt: presentedAt || '' };
    setDismissedPending(true);
    const ok = await onRespond(slug, `gate ${gate} for ${repo}: approved`, load);
    if (!ok) {
      dismissedGateRef.current = null;
      setDismissedPending(false);
    }
  };
  const revise = async (repo, gate) => {
    const feedback = (revisionDrafts[`${repo}:${gate}`] || '').trim();
    const presentedAt = stories.find(([r]) => r === repo)?.[1]?.pending_gate?.presented_at;
    dismissedGateRef.current = { type: 'gate', repo, gate, presentedAt: presentedAt || '' };
    setDismissedPending(true);
    const ok = await onRespond(
      slug,
      `gate ${gate} for ${repo}: revise${feedback ? ' — ' + feedback : ''}`,
      load
    );
    if (!ok) {
      dismissedGateRef.current = null;
      setDismissedPending(false);
    }
  };
  const sendUpdate = async () => {
    const text = updateText.trim();
    if (!text) return;
    dismissedGateRef.current = { type: 'update' };
    setDismissedPending(true);
    const ok = await onRespond(slug, `requirement changed: ${text}`, load);
    if (!ok) {
      dismissedGateRef.current = null;
      setDismissedPending(false);
    } else setUpdateText('');
  };

  return (
    <div className="req-detail">
      <div className="req-detail-header">
        <h2 className="mono">{detail.slug}</h2>
        {isRunning ? (
          <>
            <span className="req-action-btn state running" role="status">
              <span className="spinner" />
              {pausing ? 'Pausing…' : 'Running…'}
            </span>
            <button
              type="button"
              className="req-icon-btn"
              onClick={pauseRun}
              disabled={pausing}
              aria-label="Pause"
              title="Pause: stop the agent where it is. You can resume, restart or delete it."
            >
              <PauseIcon />
            </button>
          </>
        ) : isPaused ? (
          <>
            <span className="req-action-btn state paused" role="status">
              <PauseIcon />
              Paused
            </span>
            <button
              type="button"
              className="req-icon-btn"
              onClick={() => onResume(slug)}
              aria-label="Resume"
              title="Resume: continue with the same agent. It re-checks what it had finished first."
            >
              <PlayIcon />
            </button>
          </>
        ) : (
          <StatusPill status={detail.run_status} />
        )}
        <div className="req-actions">
          <button
            type="button"
            className="req-action-btn"
            onClick={() => onRestart(slug)}
            disabled={isBusy}
            title={
              isBusy
                ? 'Wait for the current step to finish'
                : 'Start this run over from Stage 1 with all gates cleared (same slug, same report)'
            }
          >
            <RestartIcon />
            Restart
          </button>
          <button
            type="button"
            className="req-action-btn danger"
            onClick={() => onDelete(slug)}
            disabled={isBusy}
            title={
              isBusy
                ? 'Wait for the current step to finish'
                : 'Delete this run (branches and PRs in the repos are kept)'
            }
          >
            <TrashIcon />
            Delete
          </button>
        </div>
      </div>
      {(detail.run_status === 'running' || detail.run_status === 'starting') && (
        <div className="live-status-ticker">
          <span className="live-status-dot" />
          {detail.live_status?.text || 'Working…'}
        </div>
      )}
      {runKind === 'bug' ? (
        <div className="bug-report">
          <div className="bug-report-title">
            {firstLine(detail.state.requirement).replace(/^Bug:\s*/, '')}
          </div>
          {detail.state.repo_hints?.length > 0 && (
            <div className="bug-report-hints muted">
              Repo hint: {detail.state.repo_hints.join(', ')}
            </div>
          )}
          <pre className="bug-report-body mono">
            {detail.state.requirement.split('\n').slice(1).join('\n').trim()}
          </pre>
        </div>
      ) : (
        <p className="req-detail-text">{detail.state.requirement}</p>
      )}

      {detail.error && <div className="banner error">{detail.error}</div>}

      <div className="story-cards">
        {stories.map(([repo, story]) => (
          <StoryCard
            key={repo}
            repo={repo}
            story={story}
            runStatus={detail.run_status}
            pendingOpen={isOpenGate(repo, story)}
            responseQueued={isResponseQueued(repo, story)}
            isWorking={
              (dismissedPending && dismissedRepo === repo) ||
              (isBusy &&
                story.stage !== 'done' &&
                !isOpenGate(repo, story) &&
                !isResponseQueued(repo, story))
            }
            kind={runKind}
            justApprovedGate={
              dismissedPending && dismissed?.type === 'gate' && dismissed.repo === repo
                ? dismissed.gate
                : actedFor(repo, story.pending_gate)?.decision === 'approved'
                ? story.pending_gate.gate
                : null
            }
          />
        ))}
      </div>

      {showPendingPanel && (
        <div className="gate-actions">
          <h3>Pending approval</h3>
          {agentBusy && (
            <p className="muted gate-queue-hint">
              The agent is busy on another step. You can answer now — your response is queued
              and sent automatically, in order, as soon as it's free.
            </p>
          )}
          {visiblePending.map(([repo, s]) => {
            const gate = s.pending_gate.gate;
            const key = `${repo}:${gate}`;
            return (
              <div key={key} className="gate-action-row">
                <div>
                  <strong>{repo}</strong> — {gateLabels[gate] || gate}
                  {s.pending_gate.summary && (
                    <div className="muted pending-gate-summary">{s.pending_gate.summary}</div>
                  )}
                </div>
                <textarea
                  className="revise-input"
                  placeholder="Optional feedback if revising…"
                  rows={2}
                  value={revisionDrafts[key] || ''}
                  onChange={(e) =>
                    setRevisionDrafts((d) => ({ ...d, [key]: e.target.value }))
                  }
                  disabled={responding}
                />
                <div className="gate-action-buttons">
                  <button
                    className="rebuild-btn"
                    disabled={responding}
                    onClick={() => approve(repo, gate)}
                  >
                    {responding ? '…' : agentBusy ? 'Approve (queue)' : 'Approve'}
                  </button>
                  <button
                    className="link-btn"
                    disabled={responding}
                    onClick={() => revise(repo, gate)}
                  >
                    Send back for revision
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {(detail.run_status === 'waiting_approval' || detail.run_status === 'done') &&
        !isBusy &&
        !dismissedPending && (
        <div className="update-requirement-box">
          <h3>Update this requirement</h3>
          <p className="muted">
            Changes cascade per the pipeline's gate-invalidation rules — already-approved
            work only reopens if it's actually affected.
          </p>
          <textarea
            className="revise-input"
            placeholder="Describe what should change…"
            rows={3}
            value={updateText}
            onChange={(e) => setUpdateText(e.target.value)}
            disabled={isBusy}
          />
          <button
            className="rebuild-btn"
            disabled={isBusy || !updateText.trim()}
            onClick={sendUpdate}
          >
            {isBusy ? '…' : 'Submit change'}
          </button>
        </div>
      )}

      {detail.state.notes && detail.state.notes.length > 0 && (
        <details className="req-notes">
          <summary>History / notes ({detail.state.notes.length})</summary>
          <ul>
            {detail.state.notes.map((n, i) => (
              <li key={i} className="muted">
                {n}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// Turn the bug intake fields into the single text blob the pipeline gets.
// The first line ("Bug: <title>") also seeds the run's slug, so when no
// title is given we derive one from the first line of the pasted error.
function buildBugReport({ title, error, details }) {
  const firstErrorLine =
    error
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) || 'Untitled bug';
  const heading = title.trim() || firstErrorLine.slice(0, 80);
  return [
    `Bug: ${heading}`,
    '',
    'Error / stack trace:',
    error.trim(),
    details.trim() ? `\nExtra details:\n${details.trim()}` : null,
  ]
    .filter((p) => p !== null)
    .join('\n');
}

const firstLine = (text) => (text || '').split('\n').find((l) => l.trim()) || '';

export default function RequirementsView({ kind = 'feature', repos = [] }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState(null);
  const [selectedSlug, setSelectedSlug] = useState(null);
  const [newRequirement, setNewRequirement] = useState('');
  const [bugError, setBugError] = useState('');
  const [bugTitle, setBugTitle] = useState('');
  const [bugDetails, setBugDetails] = useState('');
  const [bugRepos, setBugRepos] = useState([]);
  const [starting, setStarting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [startError, setStartError] = useState(null);
  const [responding, setResponding] = useState(false);
  const pollRef = useRef(null);

  const visibleItems = items.filter((r) => (r.kind || 'feature') === kind);

  const loadList = useCallback(async () => {
    try {
      const r = await api.listRequirements();
      setItems(r);
      setListError(null);
    } catch (e) {
      setListError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  // Light polling of the list while anything is active, to keep status
  // pills fresh even if the user is looking at a different requirement.
  useEffect(() => {
    const anyActive = visibleItems.some((r) => r.run_status === 'running' || r.run_status === 'starting');
    if (!anyActive) return undefined;
    pollRef.current = setInterval(loadList, 2000);
    return () => clearInterval(pollRef.current);
  }, [items, kind, loadList]);

  useEffect(() => {
    setSelectedSlug(null);
  }, [kind]);

  const startNew = async () => {
    let text = newRequirement.trim();
    if (kind === 'bug') {
      if (!bugError.trim() || starting) return;
      text = buildBugReport({ title: bugTitle, error: bugError, details: bugDetails });
    } else if (!text || starting) {
      return;
    }
    setStarting(true);
    setStartError(null);
    try {
      const r = await api.startRequirement(text, kind, kind === 'bug' ? bugRepos : []);
      setNewRequirement('');
      setBugError('');
      setBugTitle('');
      setBugDetails('');
      setBugRepos([]);
      await loadList();
      setSelectedSlug(r.slug);
    } catch (e) {
      setStartError(e.message);
    } finally {
      setStarting(false);
    }
  };

  // Start the SAME run over from Stage 1: same slug and report, every gate
  // cleared, fresh agent. The repos are not cleaned up.
  const restart = async (slug) => {
    if (starting) return;
    if (
      !window.confirm(
        'Restart this run from scratch?\n\nAll gates are cleared and a new agent starts at ' +
          'Stage 1 on the same report. Branches, PRs and files already in the repos are kept ' +
          'and left alone.'
      )
    ) {
      return;
    }
    setStarting(true);
    setStartError(null);
    try {
      await api.restartRequirement(slug);
      await loadList();
      setSelectedSlug(slug);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setStartError(e.message);
    } finally {
      setStarting(false);
    }
  };

  // Pause: cancel the agent's in-flight step. Returns true if the request went through.
  const pause = async (slug) => {
    setStartError(null);
    try {
      await api.pauseRequirement(slug);
      await loadList();
      return true;
    } catch (e) {
      setStartError(e.message);
      return false;
    }
  };

  // Resume a paused run with the same agent.
  const resume = async (slug) => {
    if (starting) return;
    setStarting(true);
    setStartError(null);
    try {
      await api.resumeRequirement(slug);
      await loadList();
      setSelectedSlug(slug);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setStartError(e.message);
    } finally {
      setStarting(false);
    }
  };

  // Delete a run's record. Repos are not touched.
  const deleteRun = async (slug) => {
    if (starting) return;
    if (
      !window.confirm(
        `Delete ${slug}?\n\nThis removes the run and its history from the dashboard. ` +
          'It cannot be undone. Branches, PRs and files already in the repos are NOT removed.'
      )
    ) {
      return;
    }
    setStarting(true);
    setStartError(null);
    try {
      await api.deleteRequirement(slug);
      setSelectedSlug(null);
      await loadList();
    } catch (e) {
      setStartError(e.message);
    } finally {
      setStarting(false);
    }
  };

  const respond = async (slug, message, onDone) => {
    setResponding(true);
    try {
      await api.respondToRequirement(slug, message);
      await loadList();
      if (onDone) await onDone();
      return true;
    } catch (e) {
      setStartError(e.message);
      return false;
    } finally {
      setResponding(false);
    }
  };

  return (
    <div className="requirements-tab">
      <div className="req-sidebar">
        <RequirementList
          items={visibleItems}
          selectedSlug={selectedSlug}
          onSelect={setSelectedSlug}
          loading={loading}
          error={listError}
          onRetry={loadList}
          kind={kind}
        />
        <div className="new-req-box">
          <h3>{kind === 'bug' ? 'New bug' : 'New feature'}</h3>
          {kind === 'bug' ? (
            <>
              <textarea
                className="revise-input mono bug-error-input"
                placeholder="Paste the error message or stack trace…"
                aria-label="Error message or stack trace"
                rows={6}
                value={bugError}
                onChange={(e) => setBugError(e.target.value)}
                disabled={starting}
                spellCheck={false}
              />
              <input
                className="search-input"
                placeholder="Title (optional — derived from the error)"
                aria-label="Bug title"
                value={bugTitle}
                onChange={(e) => setBugTitle(e.target.value)}
                disabled={starting}
              />
              <div className="repo-pick" role="group" aria-label="Suspected repos">
                <span className="repo-pick-label muted">Repos</span>
                <button
                  type="button"
                  className={`repo-chip ${bugRepos.length === 0 ? 'active' : ''}`}
                  onClick={() => setBugRepos([])}
                  disabled={starting}
                  title="Let CodeGraph find the repo from the error"
                >
                  Not sure
                </button>
                {repos.map((r) => {
                  const on = bugRepos.includes(r.id);
                  return (
                    <button
                      key={r.id}
                      type="button"
                      className={`repo-chip ${on ? 'active' : ''}`}
                      onClick={() =>
                        setBugRepos((cur) =>
                          cur.includes(r.id) ? cur.filter((x) => x !== r.id) : [...cur, r.id]
                        )
                      }
                      disabled={starting}
                    >
                      {r.name || r.id}
                    </button>
                  );
                })}
              </div>
              <textarea
                className="revise-input"
                placeholder="Extra details (optional) — when it happens, what changed recently…"
                aria-label="Extra details"
                rows={2}
                value={bugDetails}
                onChange={(e) => setBugDetails(e.target.value)}
                disabled={starting}
              />
            </>
          ) : (
            <textarea
              className="revise-input"
              placeholder="Describe the feature in plain English…"
              rows={3}
              value={newRequirement}
              onChange={(e) => setNewRequirement(e.target.value)}
              disabled={starting}
            />
          )}
          {startError && <div className="banner error small">{startError}</div>}
          <button
            className="rebuild-btn"
            onClick={startNew}
            disabled={
              starting ||
              (kind === 'bug' ? !bugError.trim() : !newRequirement.trim())
            }
          >
            {starting ? 'Starting…' : kind === 'bug' ? 'Start fix pipeline' : 'Run through pipeline'}
          </button>
        </div>
      </div>
      <div className="req-main">
        {selectedSlug ? (
          <RequirementDetail
            slug={selectedSlug}
            onRespond={respond}
            responding={responding}
            onPause={pause}
            onResume={resume}
            onRestart={restart}
            onDelete={deleteRun}
            refreshKey={refreshKey}
          />
        ) : (
          <div className="empty-state">
            <h2>{kind === 'bug' ? 'Select a bug' : 'Select a feature'}</h2>
            <p className="muted">
              {kind === 'bug'
                ? 'Pick one from the list, or file a new bug on the left.'
                : 'Pick one from the list, or start a new one.'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
