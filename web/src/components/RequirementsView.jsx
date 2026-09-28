import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';

const GATE_LABELS = {
  '1_stories': 'Stories',
  '2_plan': 'Plan',
  '3_impl': 'Implementation',
  '4_traceability': 'Traceability',
  '5_qa': 'QA checklist',
};
const GATE_ORDER = Object.keys(GATE_LABELS);

const STATUS_META = {
  idle: { label: 'Idle', cls: 'muted' },
  starting: { label: 'Starting…', cls: 'run-status-active' },
  running: { label: 'Running…', cls: 'run-status-active' },
  waiting_approval: { label: 'Waiting on you', cls: 'run-status-waiting' },
  done: { label: 'Done', cls: 'run-status-done' },
  error: { label: 'Error', cls: 'run-status-error' },
};

function StatusPill({ status }) {
  const meta = STATUS_META[status] || STATUS_META.idle;
  return <span className={`run-status-pill ${meta.cls}`}>{meta.label}</span>;
}

function GateTrack({ gates }) {
  return (
    <div className="gate-track">
      {GATE_ORDER.map((g) => {
        const v = gates?.[g];
        const cls =
          v === 'approved'
            ? 'gate-dot approved'
            : v === 'pending_reapproval'
            ? 'gate-dot pending'
            : 'gate-dot';
        return (
          <span key={g} className={cls} title={`${GATE_LABELS[g]}: ${v || 'not reached'}`} />
        );
      })}
    </div>
  );
}

// Full-width labeled step bar for the requirement detail view — one step
// per gate plus a synthetic final "Merged" step. A step is:
//   done      — gate approved (or, for the Merged step, merge_status
//               === 'merged')
//   waiting   — gate has a pending_gate marker, or is pending_reapproval
//               (a mid-run requirement change reset it) — needs the
//               user's approve/revise action
//   current   — the agent is actively working on this step right now
//               (first not-done, not-waiting step, only while the run's
//               overall status is starting/running)
//   upcoming  — hasn't been reached yet
const STAGE_STEPS = [...GATE_ORDER, 'merge'];
const STAGE_STEP_LABELS = { ...GATE_LABELS, merge: 'Merged' };

function storyHasEarlierApprovals(story) {
  const pending = story?.pending_gate?.gate;
  if (!pending) return false;
  const idx = GATE_ORDER.indexOf(pending);
  if (idx <= 0) return false;
  return GATE_ORDER.slice(0, idx).some((g) => story?.gates?.[g] === 'approved');
}

function computeStageSteps(story, runStatus, { isWorking = false, justApprovedGate = null } = {}) {
  const gates = story?.gates || {};
  const steps = GATE_ORDER.map((g) => {
    const v = gates[g];
    let status = 'upcoming';
    if (v === 'approved') status = 'done';
    else if (v === 'pending_reapproval' && runStatus === 'waiting_approval') status = 'waiting';
    else if (story?.pending_gate?.gate === g && runStatus === 'waiting_approval') status = 'waiting';
    return { key: g, label: GATE_LABELS[g], status };
  });

  const merged = story?.merge_status === 'merged';
  steps.push({
    key: 'merge',
    label: 'Merged',
    status: merged ? 'done' : 'upcoming',
  });

  // Only skip-ahead past a pending_gate if it is the gate the user just
  // approved. If the agent has already written the *next* gate (e.g.
  // 5_qa) while the turn is still wrapping up, that new pending_gate
  // is NOT approved yet — spinning Merged and hiding the QA window
  // was the snap-back bug.
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

function StageBar({ story, runStatus, isWorking, justApprovedGate }) {
  const steps = computeStageSteps(story, runStatus, { isWorking, justApprovedGate });
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

function RequirementList({ items, selectedSlug, onSelect, loading, error, onRetry }) {
  return (
    <div className="req-list">
      <div className="req-list-header">
        <span>Requirements</span>
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
        <div className="req-list-empty muted">No requirements yet — start one below.</div>
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
          <div className="req-list-item-text muted">{r.requirement}</div>
          <div className="req-list-item-stories">
            {Object.entries(r.stories || {}).map(([repo, s]) => (
              <span key={repo} className="req-story-chip">
                {repo}
                <GateTrack gates={s.gates} />
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

function StoryCard({ repo, story, runStatus, isWorking, justApprovedGate }) {
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
      />
      {story.pr_url && (
        <a className="story-pr-link" href={story.pr_url} target="_blank" rel="noreferrer">
          View PR ↗
        </a>
      )}
      {story.merge_status === 'merged' && <span className="merged-badge">Merged</span>}
      {story.pending_gate && !isWorking && runStatus === 'waiting_approval' && (
        <div className="pending-gate-box">
          <div className="pending-gate-title">
            Waiting: Gate {story.pending_gate.gate} — {GATE_LABELS[story.pending_gate.gate] || story.pending_gate.gate}
          </div>
          {story.pending_gate.summary && (
            <div className="pending-gate-summary muted">{story.pending_gate.summary}</div>
          )}
        </div>
      )}
    </div>
  );
}

function RequirementDetail({ slug, onRespond, responding }) {
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
  }, [load]);

  const isBusy =
    responding || detail?.run_status === 'running' || detail?.run_status === 'starting';

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
  const pendingEntries = stories.filter(([, s]) => s.pending_gate);
  const dismissed = dismissedGateRef.current;
  const dismissedRepo = dismissed?.type === 'gate' ? dismissed.repo : null;
  const visiblePending = pendingEntries.filter(([repo, s]) => {
    if (!dismissedPending || !dismissed) return true;
    if (dismissed.type === 'update') return false;
    return !(
      dismissed.repo === repo &&
      dismissed.gate === s.pending_gate.gate &&
      dismissed.presentedAt === s.pending_gate.presented_at
    );
  });
  // Only show the Approve/Revise form when the agent has actually
  // paused and this gate is ready — including the first Stories gate.
  // During the initial analysis turn (and any later in-flight turn)
  // `pending_gate` can already exist on disk for another story, or
  // not exist yet at all; showing the panel then looks like a request
  // for approval before the story is ready.
  const showPendingPanel =
    detail.run_status === 'waiting_approval' && !isBusy && visiblePending.length > 0;

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
        <StatusPill status={detail.run_status} />
      </div>
      {(detail.run_status === 'running' || detail.run_status === 'starting') && (
        <div className="live-status-ticker">
          <span className="live-status-dot" />
          {detail.live_status?.text || 'Working…'}
        </div>
      )}
      <p className="req-detail-text">{detail.state.requirement}</p>

      {detail.error && <div className="banner error">{detail.error}</div>}

      <div className="story-cards">
        {stories.map(([repo, story]) => (
          <StoryCard
            key={repo}
            repo={repo}
            story={story}
            runStatus={detail.run_status}
            isWorking={
              (dismissedPending && dismissedRepo === repo) ||
              (isBusy &&
                !dismissedPending &&
                story.stage !== 'done' &&
                (!story.pending_gate || storyHasEarlierApprovals(story)))
            }
            justApprovedGate={
              dismissedPending && dismissed?.type === 'gate' && dismissed.repo === repo
                ? dismissed.gate
                : null
            }
          />
        ))}
      </div>

      {showPendingPanel && (
        <div className="gate-actions">
          <h3>Pending approval</h3>
          {visiblePending.map(([repo, s]) => {
            const gate = s.pending_gate.gate;
            const key = `${repo}:${gate}`;
            return (
              <div key={key} className="gate-action-row">
                <div>
                  <strong>{repo}</strong> — {GATE_LABELS[gate] || gate}
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
                  disabled={isBusy}
                />
                <div className="gate-action-buttons">
                  <button
                    className="rebuild-btn"
                    disabled={isBusy}
                    onClick={() => approve(repo, gate)}
                  >
                    {isBusy ? '…' : 'Approve'}
                  </button>
                  <button
                    className="link-btn"
                    disabled={isBusy}
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
            {isBusy ? '…' : 'Submit change & rerun'}
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

export default function RequirementsView() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState(null);
  const [selectedSlug, setSelectedSlug] = useState(null);
  const [newRequirement, setNewRequirement] = useState('');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState(null);
  const [responding, setResponding] = useState(false);
  const pollRef = useRef(null);

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
    const anyActive = items.some((r) => r.run_status === 'running' || r.run_status === 'starting');
    if (!anyActive) return undefined;
    pollRef.current = setInterval(loadList, 2000);
    return () => clearInterval(pollRef.current);
  }, [items, loadList]);

  const startNew = async () => {
    const text = newRequirement.trim();
    if (!text || starting) return;
    setStarting(true);
    setStartError(null);
    try {
      const r = await api.startRequirement(text);
      setNewRequirement('');
      await loadList();
      setSelectedSlug(r.slug);
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
          items={items}
          selectedSlug={selectedSlug}
          onSelect={setSelectedSlug}
          loading={loading}
          error={listError}
          onRetry={loadList}
        />
        <div className="new-req-box">
          <h3>New requirement</h3>
          <textarea
            className="revise-input"
            placeholder="Describe the feature in plain English…"
            rows={3}
            value={newRequirement}
            onChange={(e) => setNewRequirement(e.target.value)}
            disabled={starting}
          />
          {startError && <div className="banner error small">{startError}</div>}
          <button
            className="rebuild-btn"
            onClick={startNew}
            disabled={starting || !newRequirement.trim()}
          >
            {starting ? 'Starting…' : 'Run through pipeline'}
          </button>
        </div>
      </div>
      <div className="req-main">
        {selectedSlug ? (
          <RequirementDetail slug={selectedSlug} onRespond={respond} responding={responding} />
        ) : (
          <div className="empty-state">
            <h2>Select a requirement</h2>
            <p className="muted">Pick one from the list, or start a new one.</p>
          </div>
        )}
      </div>
    </div>
  );
}
