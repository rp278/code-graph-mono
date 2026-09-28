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
        </button>
      ))}
    </div>
  );
}

function StoryCard({ repo, story }) {
  return (
    <div className="story-card">
      <div className="story-card-header">
        <span className="story-repo mono">{repo}</span>
        <span className="story-stage muted">{story.stage}</span>
      </div>
      <GateTrack gates={story.gates} />
      <div className="story-gate-labels muted">
        {GATE_ORDER.map((g) => (
          <span key={g}>{GATE_LABELS[g][0]}</span>
        ))}
      </div>
      {story.pr_url && (
        <a className="story-pr-link" href={story.pr_url} target="_blank" rel="noreferrer">
          View PR ↗
        </a>
      )}
      {story.merge_status === 'merged' && <span className="merged-badge">Merged</span>}
      {story.pending_gate && (
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
    load();
  }, [load]);

  // Poll while the agent is actively working so the UI reflects progress
  // without the user needing to refresh.
  useEffect(() => {
    if (!detail) return undefined;
    if (detail.run_status !== 'running' && detail.run_status !== 'starting') return undefined;
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [detail, load]);

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

  const approve = (repo, gate) => {
    onRespond(slug, `gate ${gate} for ${repo}: approved`, load);
  };
  const revise = (repo, gate) => {
    const feedback = (revisionDrafts[`${repo}:${gate}`] || '').trim();
    onRespond(
      slug,
      `gate ${gate} for ${repo}: revise${feedback ? ' — ' + feedback : ''}`,
      load
    );
  };
  const sendUpdate = () => {
    const text = updateText.trim();
    if (!text) return;
    onRespond(slug, `requirement changed: ${text}`, load);
    setUpdateText('');
  };

  return (
    <div className="req-detail">
      <div className="req-detail-header">
        <h2 className="mono">{detail.slug}</h2>
        <StatusPill status={detail.run_status} />
      </div>
      <p className="req-detail-text">{detail.state.requirement}</p>

      {detail.error && <div className="banner error">{detail.error}</div>}

      <div className="story-cards">
        {stories.map(([repo, story]) => (
          <StoryCard key={repo} repo={repo} story={story} />
        ))}
      </div>

      {pendingEntries.length > 0 && (
        <div className="gate-actions">
          <h3>Pending approval</h3>
          {pendingEntries.map(([repo, s]) => {
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
                  disabled={responding}
                />
                <div className="gate-action-buttons">
                  <button
                    className="rebuild-btn"
                    disabled={responding}
                    onClick={() => approve(repo, gate)}
                  >
                    Approve
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

      {(detail.run_status === 'waiting_approval' || detail.run_status === 'done') && (
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
            disabled={responding}
          />
          <button
            className="rebuild-btn"
            disabled={responding || !updateText.trim()}
            onClick={sendUpdate}
          >
            {responding ? '…' : 'Submit change & rerun'}
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
    pollRef.current = setInterval(loadList, 5000);
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
      if (onDone) setTimeout(onDone, 300);
    } catch (e) {
      setStartError(e.message);
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
