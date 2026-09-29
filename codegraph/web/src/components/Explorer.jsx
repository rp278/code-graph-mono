import { useCallback, useEffect, useMemo, useState } from 'react';
import { ReactFlow, Background, Controls, MiniMap, MarkerType } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api } from '../api';
import KgNode from './KgNode';
import RepoLinkEdge from './RepoLinkEdge';
import {
  colorForType,
  kindOf,
  layoutNeighborhood,
  relationColor,
  relationCounts,
  relationLabel,
  shortPath,
  buildRepoMap,
} from '../graphUtils';

const nodeTypes = { kgNode: KgNode };
const edgeTypes = { repoLink: RepoLinkEdge };

const OVERVIEW_LIMIT = 30; // entry points drawn on the canvas when nothing is selected
const DEFAULT_PER_SIDE = 48;
const ALL_HUB = '__all';
const REPO_PREFIX = '__repo:';

const trailLabel = (n) => n.label || n.id;

/**
 * Repository + node explorer.
 *
 * A code graph has thousands of nodes, so instead of drawing them all it
 * shows ONE node at a time together with everything directly connected to
 * it: what points at it on the left, what it points to on the right.
 * Pick a repo, find a node (search or entry points), then click through the
 * canvas to walk the graph. The breadcrumb lets you step back.
 */
export default function Explorer({
  repos,
  repoCounts,
  totalNodes,
  selectedRepoId,
  onSelectRepo,
  trail,
  setTrail,
  reloadToken,
  onRebuild,
  rebuildWorking,
}) {
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [search, setSearch] = useState({ nodes: [], types: [] });
  const [searching, setSearching] = useState(true);
  const [searchError, setSearchError] = useState(null);

  const [hood, setHood] = useState(null);
  const [hoodLoading, setHoodLoading] = useState(false);
  const [hoodError, setHoodError] = useState(null);

  const [hiddenRel, setHiddenRel] = useState(() => new Set());
  const [showAll, setShowAll] = useState(false);

  // Connections between repositories (drives the "All repos" map).
  const [repoLinks, setRepoLinks] = useState([]);
  useEffect(() => {
    let cancelled = false;
    api
      .getRepoLinks()
      .then((r) => !cancelled && setRepoLinks(r.links || []))
      .catch(() => !cancelled && setRepoLinks([]));
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const focus = trail.length ? trail[trail.length - 1] : null;
  const focusId = focus?.id || null;
  const repoId = selectedRepoId || 'all';

  // ---- search / entry points for the side list -------------------------
  useEffect(() => {
    let cancelled = false;
    setSearching(true);
    setSearchError(null);
    const t = setTimeout(() => {
      api
        .searchGraph(query, repoId, typeFilter, 40)
        .then((r) => !cancelled && setSearch({ nodes: r.nodes || [], types: r.types || [] }))
        .catch((e) => !cancelled && setSearchError(e.message))
        .finally(() => !cancelled && setSearching(false));
    }, query ? 220 : 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, repoId, typeFilter, reloadToken]);

  // Changing repo starts a fresh search.
  useEffect(() => {
    setTypeFilter('');
  }, [repoId]);

  // ---- neighborhood of the focused node --------------------------------
  useEffect(() => {
    setHiddenRel(new Set());
    setShowAll(false);
    if (!focusId) {
      setHood(null);
      setHoodError(null);
      return undefined;
    }
    let cancelled = false;
    setHoodLoading(true);
    setHoodError(null);
    api
      .getNeighborhood(focusId)
      .then((r) => {
        if (cancelled) return;
        setHood(r);
        // Give the breadcrumb the real label (jumps only know the id).
        setTrail((prev) =>
          prev.some((t) => t.id === focusId && t.label !== trailLabel(r.center))
            ? prev.map((t) => (t.id === focusId ? { ...t, label: trailLabel(r.center) } : t))
            : prev
        );
      })
      .catch((e) => !cancelled && setHoodError(e.message))
      .finally(() => !cancelled && setHoodLoading(false));
    return () => {
      cancelled = true;
    };
  }, [focusId, reloadToken, setTrail]);

  // ---- navigation ------------------------------------------------------
  // Start a new trail (from the side list).
  const startAt = useCallback(
    (node) => setTrail([{ id: node.id, label: trailLabel(node) }]),
    [setTrail]
  );
  // Continue the trail (from the canvas). Clicking something already in the
  // trail steps back to it instead of growing a loop.
  const goTo = useCallback(
    (node) =>
      setTrail((prev) => {
        const i = prev.findIndex((t) => t.id === node.id);
        if (i >= 0) return prev.slice(0, i + 1);
        return [...prev, { id: node.id, label: trailLabel(node) }].slice(-14);
      }),
    [setTrail]
  );
  const goBack = useCallback(() => setTrail((prev) => prev.slice(0, -1)), [setTrail]);
  const goOverview = useCallback(() => setTrail([]), [setTrail]);

  const toggleRelation = useCallback((rel) => {
    setHiddenRel((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });
  }, []);

  // ---- what the canvas shows -------------------------------------------
  // With a focus: that node + neighbors. Without: the repo hub + entry points
  // (or, for "All repos", the repos themselves).
  const view = useMemo(() => {
    if (focusId) {
      if (!hood || hood.center.id !== focusId) return null;
      return { center: hood.center, nodes: hood.nodes, edges: hood.edges, total: hood.total, overview: false };
    }
    if (repoId === 'all') {
      const center = { id: ALL_HUB, label: 'All repositories', type: 'repo', repo: '', loc: `${totalNodes} nodes` };
      const nodes = repos.map((r) => ({
        id: REPO_PREFIX + r.id,
        label: r.name,
        type: 'repo',
        repo: '',
        loc: `${repoCounts[r.id] || 0} nodes`,
        degree: repoCounts[r.id] || 0,
      }));
      const edges = nodes.map((n, i) => ({
        id: `o${i}`,
        source: center.id,
        target: n.id,
        relation: 'ENTRY',
        confidence: 'EXTRACTED',
      }));
      return { center, nodes, edges, total: nodes.length, overview: true, repoMap: true };
    }
    const repo = repos.find((r) => r.id === repoId);
    const center = {
      id: `${REPO_PREFIX}${repoId}`,
      label: repo?.name || repoId,
      type: 'repo',
      repo: '',
      loc: `${repoCounts[repoId] || 0} nodes`,
    };
    const nodes = search.nodes.slice(0, OVERVIEW_LIMIT);
    const edges = nodes.map((n, i) => ({
      id: `o${i}`,
      source: center.id,
      target: n.id,
      relation: 'ENTRY',
      confidence: 'EXTRACTED',
    }));
    return { center, nodes, edges, total: nodes.length, overview: true };
  }, [focusId, hood, repoId, repos, repoCounts, totalNodes, search.nodes]);

  const relations = useMemo(() => (view ? relationCounts(view.edges) : []), [view]);

  const flow = useMemo(() => {
    if (!view) return { nodes: [], edges: [], hidden: 0, shownEdges: 0 };
    // "All repos": repositories as nodes, arrows for real cross-repo links.
    if (view.repoMap) return buildRepoMap(repos, repoCounts, repoLinks, REPO_PREFIX);
    const visible = view.edges.filter((e) => !hiddenRel.has(e.relation));
    const byId = new Map(view.nodes.map((n) => [n.id, n]));
    const { positions, hidden } = layoutNeighborhood(
      view.center,
      byId,
      visible,
      showAll ? 500 : DEFAULT_PER_SIDE
    );

    const centerRepo = view.center.repo;
    const toFlowNode = (n, isCenter) => {
      const kind = n.type === 'repo' ? 'repo' : kindOf(n);
      return {
        id: n.id,
        type: 'kgNode',
        position: positions[n.id],
        draggable: false,
        data: {
          label: n.label || n.id,
          kind,
          color: colorForType(kind),
          repo: n.repo,
          loc: n.loc,
          isCenter,
          foreignRepo: !!(n.repo && centerRepo && n.repo !== centerRepo),
          hint: n.file ? shortPath(n.file, n.repo) : '',
        },
      };
    };
    const nodes = [toFlowNode(view.center, true)];
    for (const n of view.nodes) if (positions[n.id]) nodes.push(toFlowNode(n, false));

    const labelled = visible.length <= 10;
    const edges = [];
    for (const e of visible) {
      if (!positions[e.source] || !positions[e.target]) continue;
      const color = relationColor(e.relation);
      edges.push({
        id: e.id,
        source: e.source,
        target: e.target,
        label: labelled ? relationLabel(e.relation) : undefined,
        animated: e.relation === 'CALLS',
        markerEnd: view.overview ? undefined : { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
        style: {
          stroke: color,
          strokeWidth: 1.5,
          strokeDasharray: e.confidence === 'INFERRED' ? '7 5' : undefined,
          opacity: 0.85,
        },
        labelStyle: { fill: '#94a3b8', fontSize: 10, fontWeight: 600 },
        labelBgStyle: { fill: '#0d1420', fillOpacity: 0.9 },
        labelBgPadding: [3, 5],
        labelBgBorderRadius: 4,
      });
    }
    return { nodes, edges, hidden, shownEdges: visible.length };
  }, [view, hiddenRel, showAll, repos, repoCounts, repoLinks]);

  const onNodeClick = useCallback(
    (_, node) => {
      const id = node.id;
      if (id === focusId || id === ALL_HUB) return;
      if (id.startsWith(REPO_PREFIX)) {
        const target = id.slice(REPO_PREFIX.length);
        if (target !== repoId) onSelectRepo(target);
        return;
      }
      const apiNode = view?.nodes.find((n) => n.id === id);
      if (apiNode) goTo(apiNode);
    },
    [focusId, repoId, onSelectRepo, view, goTo]
  );

  // ---- render ----------------------------------------------------------
  if (totalNodes === 0 && repos.length > 0 && !searching && search.nodes.length === 0 && !query) {
    return (
      <div className="canvas-col">
        <div className="empty-state">
          <div className="empty-icon" aria-hidden="true">
            ◇
          </div>
          <h2>No graph data yet</h2>
          <p>
            The knowledge graph hasn&apos;t been built yet.
            <br />
            Hit rebuild to scan the codebase and generate nodes and edges.
          </p>
          <button className="rebuild-btn" onClick={onRebuild} disabled={rebuildWorking}>
            {rebuildWorking ? 'Rebuilding…' : 'Build the graph'}
          </button>
        </div>
      </div>
    );
  }

  const center = view?.center;
  const focusKind = center && !view.overview ? kindOf(center) : null;
  const flowKey = `${focusId || `overview:${repoId}`}|${[...hiddenRel].sort().join(',')}|${showAll}|${reloadToken}|${
    view ? view.nodes.length : 0
  }|${repoLinks.length}`;

  return (
    <div className="graph-tab">
      <aside className="sidebar explorer-side">
        <div className="sidebar-section">
          <h3>Repository</h3>
          <div className="repo-list">
            <button
              className={repoId === 'all' ? 'repo-row active' : 'repo-row'}
              onClick={() => onSelectRepo('all')}
            >
              <span className="repo-row-name">All repos</span>
              <span className="repo-row-count">{totalNodes}</span>
            </button>
            {repos.map((r) => (
              <button
                key={r.id}
                className={repoId === r.id ? 'repo-row active' : 'repo-row'}
                onClick={() => onSelectRepo(r.id)}
                title={r.path}
              >
                <span className="repo-row-name">{r.name}</span>
                <span className="repo-row-count">{repoCounts[r.id] ?? ''}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="sidebar-section">
          <h3>Find a node</h3>
          <input
            className="search-input"
            type="text"
            placeholder={repoId === 'all' ? 'Search all repos…' : `Search ${repoId}…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {search.types.length > 1 && (
            <div className="chip-row">
              <button className={!typeFilter ? 'mini-chip active' : 'mini-chip'} onClick={() => setTypeFilter('')}>
                all
              </button>
              {search.types.map((t) => (
                <button
                  key={t.type}
                  className={typeFilter === t.type ? 'mini-chip active' : 'mini-chip'}
                  onClick={() => setTypeFilter(typeFilter === t.type ? '' : t.type)}
                >
                  {t.type} <span className="mini-chip-n">{t.c}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="sidebar-section results-section">
          <h3>
            {query || typeFilter ? `Matches${searching ? '…' : ` (${search.nodes.length})`}` : 'Entry points'}
          </h3>
          {searchError && <div className="muted">{searchError}</div>}
          <div className="result-list">
            {search.nodes.length === 0 && !searching && !searchError && (
              <div className="muted">Nothing matches.</div>
            )}
            {search.nodes.map((n) => {
              const kind = kindOf(n);
              return (
                <button
                  key={n.id}
                  className={n.id === focusId ? 'result-row active' : 'result-row'}
                  onClick={() => startAt(n)}
                  title={shortPath(n.file, n.repo) || n.id}
                >
                  <span className="type-dot" style={{ background: colorForType(kind) }} />
                  <span className="result-main">
                    <span className="result-label">{n.label || n.id}</span>
                    <span className="result-meta">
                      {kind}
                      {repoId === 'all' && n.repo ? ` · ${n.repo}` : ''} · {n.degree} links
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* focus node info */}
        {view && !view.overview && center && (
          <div className="focus-card">
            <div className="focus-title">{center.label}</div>
            <div className="focus-kind" style={{ color: colorForType(focusKind), background: `${colorForType(focusKind)}1f` }}>
              {focusKind}
            </div>
            {center.repo && <div className="focus-row"><span>repo</span>{center.repo}</div>}
            {center.file && (
              <div className="focus-row">
                <span>file</span>
                <code>{shortPath(center.file, center.repo)}{center.loc ? `:${center.loc.replace(/^L/, '')}` : ''}</code>
              </div>
            )}
            <div className="focus-row">
              <span>links</span>
              {view.total}
              {view.total > view.edges.length ? ` (showing ${view.edges.length})` : ''}
            </div>
            <div className="focus-legend">
              <span>← used by / parent</span>
              <span>uses / children →</span>
            </div>
          </div>
        )}

      </aside>

      <div className="canvas-col">
        {/* breadcrumb + relation filters */}
        <div className="explorer-bar">
          <div className="crumbs">
            <button className="crumb" onClick={goBack} disabled={trail.length === 0} title="Back one step">
              ←
            </button>
            <button className={trail.length === 0 ? 'crumb current' : 'crumb'} onClick={goOverview}>
              {repoId === 'all' ? 'All repos' : repoId}
            </button>
            {trail.slice(-6).map((t, i, arr) => (
              <span className="crumb-wrap" key={t.id}>
                <span className="crumb-sep">›</span>
                <button
                  className={i === arr.length - 1 ? 'crumb current' : 'crumb'}
                  onClick={() => goTo(t)}
                  title={t.label}
                >
                  {t.label}
                </button>
              </span>
            ))}
          </div>
          {view && !view.overview && relations.length > 0 && (
            <div className="chip-row rel-row">
              <span className="rel-hint">
                {relations.length > 1 ? 'Show:' : 'Relation:'}
              </span>
              {relations.map(({ relation, count }) => {
                const off = hiddenRel.has(relation);
                return (
                  <button
                    key={relation}
                    className={off ? 'rel-chip off' : 'rel-chip'}
                    style={{ '--rel-color': relationColor(relation) }}
                    onClick={() => toggleRelation(relation)}
                    title={off ? 'Show these connections' : 'Hide these connections'}
                  >
                    <span className="rel-swatch" />
                    {relationLabel(relation)} <span className="mini-chip-n">{count}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* canvas */}
        {hoodError ? (
          <div className="empty-state">
            <h2>Couldn&apos;t load this node</h2>
            <p className="muted">{hoodError}</p>
            <button className="rebuild-btn" onClick={goOverview}>
              Back to overview
            </button>
          </div>
        ) : !view ? (
          <div className="veil">
            <span className="spinner large" />
            <span>Loading connections…</span>
          </div>
        ) : (
          <div className="graph-wrap">
            <ReactFlow
              key={flowKey}
              nodes={flow.nodes}
              edges={flow.edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodeClick={onNodeClick}
              nodesDraggable={false}
              nodesConnectable={false}
              colorMode="dark"
              fitView
              fitViewOptions={{ padding: 0.18, maxZoom: 1.1 }}
              minZoom={0.1}
              maxZoom={2.2}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant="dots" gap={26} size={1.6} />
              <Controls position="bottom-right" showInteractive={false} />
              <MiniMap
                position="bottom-left"
                pannable
                zoomable
                nodeColor={(n) => n.data?.color || '#64748b'}
                maskColor="rgba(10, 14, 20, 0.75)"
              />
            </ReactFlow>
            {view.overview && flow.nodes.length <= 1 && !searching && (
              <div className="empty-state">
                <h2>Nothing to show</h2>
                <p className="muted">No nodes match. Try a different search or repository.</p>
              </div>
            )}
            {(flow.hidden > 0 || (!view.overview && view.total > view.edges.length)) && (
              <div className="cap-note">
                {flow.hidden > 0 && (
                  <>
                    {flow.hidden} more connection{flow.hidden === 1 ? '' : 's'} hidden.{' '}
                    <button className="link-btn" onClick={() => setShowAll(true)}>
                      Show all
                    </button>{' '}
                    or narrow it with the relation chips.{' '}
                  </>
                )}
                {!view.overview && view.total > view.edges.length && (
                  <>Only the {view.edges.length} most-connected of {view.total} links were loaded.</>
                )}
              </div>
            )}
            {view.overview && (
              <div className="overview-hint">
                {repoId === 'all'
                  ? flow.shownEdges > 0
                    ? 'Arrows show which repository depends on / calls another. Click a repository to open it'
                    : 'No links between repositories yet. Click a repository to open it'
                  : 'Click an entry point, or search on the left, to start exploring'}
              </div>
            )}
            {hoodLoading && (
              <div className="veil light">
                <span className="spinner large" />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}