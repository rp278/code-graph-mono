import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyNodeChanges, applyEdgeChanges } from '@xyflow/react';
import { api } from './api';
import { layoutNodes, toFlowNode, toFlowEdge } from './graphUtils';
import Header from './components/Header';
import Sidebar from './components/Sidebar';
import GraphView from './components/GraphView';
import AskView from './components/AskView';
import RequirementsView from './components/RequirementsView';
import Landing from './components/Landing';
import { isFeatureDevelopmentEnabled } from './flags';
import AppShell from './components/AppShell';

export default function App() {
  const [repos, setRepos] = useState([]);
  const [reposLoading, setReposLoading] = useState(true);
  const [reposError, setReposError] = useState(null);
  const [selectedRepoId, setSelectedRepoId] = useState('');

  const [stats, setStats] = useState({ nodes: 0, edges: 0 });
  const [statsLoading, setStatsLoading] = useState(true);

  const [screen, setScreen] = useState(() => {
    const saved = sessionStorage.getItem('codegraph.screen') || 'home';
    // Don't restore a flag-gated screen when its flag is off.
    if (saved === 'features' && !isFeatureDevelopmentEnabled()) return 'home';
    return saved;
  });
  const [tab, setTab] = useState('graph');

  const [apiNodes, setApiNodes] = useState([]);
  const [apiEdges, setApiEdges] = useState([]);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState(null);

  // Dagre-positioned flow nodes/edges (no selection styling — that is derived).
  const [baseNodes, setBaseNodes] = useState([]);
  const [baseEdges, setBaseEdges] = useState([]);

  const [selectedId, setSelectedId] = useState(null);
  const [highlightId, setHighlightId] = useState(null);
  const [search, setSearch] = useState('');

  const [rebuild, setRebuild] = useState({ state: 'idle', message: '' });
  const rfRef = useRef(null);

  const goHome = useCallback(() => {
    setScreen('home');
    setTab('graph');
    sessionStorage.setItem('codegraph.screen', 'home');
  }, []);

  const chooseScreen = useCallback((id) => {
    setScreen(id);
    setTab('graph');
    sessionStorage.setItem('codegraph.screen', id);
  }, []);

  // ---- data loading ----
  const loadRepos = useCallback(async () => {
    setReposLoading(true);
    setReposError(null);
    try {
      const r = await api.getRepos();
      setRepos(r);
      setSelectedRepoId((prev) => prev || 'all');
    } catch (e) {
      setReposError(e.message);
    } finally {
      setReposLoading(false);
    }
  }, []);

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const s = await api.getStats();
      setStats({ nodes: s.nodes ?? 0, edges: s.edges ?? 0 });
    } catch {
      // keep previous stats on transient failure
    } finally {
      setStatsLoading(false);
    }
  }, []);

  const loadGraph = useCallback(async (repoId) => {
    if (!repoId) {
      setApiNodes([]);
      setApiEdges([]);
      return;
    }
    setGraphLoading(true);
    setGraphError(null);
    try {
      const g = await api.getGraph(repoId);
      setApiNodes(g.nodes || []);
      setApiEdges(g.edges || []);
      setSelectedId(null);
      setHighlightId(null);
      setSearch('');
    } catch (e) {
      setGraphError(e.message);
    } finally {
      setGraphLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRepos();
    loadStats();
  }, [loadRepos, loadStats]);

  useEffect(() => {
    loadGraph(selectedRepoId);
  }, [selectedRepoId, loadGraph]);

  // ---- dagre layout whenever the underlying graph data changes ----
  // Existing node positions are preserved so user drags survive re-renders.
  useEffect(() => {
    const positions = layoutNodes(apiNodes);
    setBaseNodes((prev) => {
      const prevPos = new Map(prev.map((n) => [n.id, n.position]));
      return apiNodes.map((n) => toFlowNode(n, prevPos.get(n.id) || positions[n.id] || { x: 0, y: 0 }));
    });
    setBaseEdges((apiEdges || []).map(toFlowEdge));
  }, [apiNodes, apiEdges]);

  // ---- derived presentation state ----
  const dimSet = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    return new Set(
      apiNodes.filter((n) => (n.label || n.id || '').toLowerCase().includes(q)).map((n) => n.id)
    );
  }, [search, apiNodes]);

  const nodes = useMemo(
    () =>
      baseNodes.map((n) => {
        const color = n.data.color;
        const active = n.id === selectedId || n.id === highlightId;
        const dimmed = dimSet && !dimSet.has(n.id);
        return {
          ...n,
          style: {
            opacity: dimmed ? 0.22 : 1,
            boxShadow: active
              ? `0 0 0 2px ${color}, 0 0 28px ${color}55`
              : '0 6px 18px rgba(0,0,0,0.5)',
            transition: 'opacity 0.2s ease',
          },
        };
      }),
    [baseNodes, selectedId, highlightId, dimSet]
  );

  const onNodesChange = useCallback(
    (changes) => setBaseNodes((ns) => applyNodeChanges(changes, ns)),
    []
  );
  const onEdgesChange = useCallback(
    (changes) => setBaseEdges((es) => applyEdgeChanges(changes, es)),
    []
  );

  // ---- interactions ----
  const focusNode = useCallback(
    (id) => {
      const n = baseNodes.find((x) => x.id === id);
      if (n && rfRef.current) {
        rfRef.current.setCenter(n.position.x + 105, n.position.y + 35, {
          zoom: 1.15,
          duration: 500,
        });
      }
    },
    [baseNodes]
  );

  const handleSelectNode = useCallback(
    (id, focus = false) => {
      setSelectedId(id);
      setHighlightId(null);
      if (focus) setTimeout(() => focusNode(id), 60);
    },
    [focusNode]
  );

  // Jump from a chat context chip back to the graph tab, highlighting the node.
  const jumpToNode = useCallback(
    (id) => {
      setScreen('graph');
      sessionStorage.setItem('codegraph.screen', 'graph');
      setTab('graph');
      setSelectedId(id);
      setHighlightId(id);
      setTimeout(() => focusNode(id), 80);
    },
    [focusNode]
  );

  const handleRebuild = useCallback(async () => {
    if (!selectedRepoId) return;
    setRebuild({ state: 'working', message: `Rebuilding graph for “${selectedRepoId}”…` });
    try {
      const r = await api.rebuild(selectedRepoId);
      const summary = r.status ? `Rebuild finished (${r.status}).` : 'Rebuild finished.';
      setRebuild({ state: 'done', message: summary });
      await loadGraph(selectedRepoId);
      await loadStats();
    } catch (e) {
      setRebuild({ state: 'error', message: `Rebuild failed: ${e.message}` });
    }
  }, [selectedRepoId, loadGraph, loadStats]);

  const isEmpty = !graphLoading && !graphError && apiNodes.length === 0;

  const graphActions = (
    <Header
      repos={repos}
      selectedRepoId={selectedRepoId}
      onSelectRepo={setSelectedRepoId}
      stats={stats}
      statsLoading={statsLoading}
      rebuild={rebuild}
      onRebuild={handleRebuild}
      extra={
        <button
          className={tab === 'chat' ? 'tab-chip active' : 'tab-chip'}
          onClick={() => setTab((t) => (t === 'chat' ? 'graph' : 'chat'))}
        >
          {tab === 'chat' ? 'Back to graph' : 'Ask AI'}
        </button>
      }
    />
  );

  const graphBody = (
    <>
      {reposError && (
        <div className="banner error" role="alert">
          {reposError}
          <button className="link-btn" onClick={loadRepos}>
            retry
          </button>
        </div>
      )}
      {reposLoading && <div className="banner info">Loading repositories…</div>}
      {tab === 'chat' ? (
        <AskView
          repos={repos}
          initialRepoId={selectedRepoId || 'all'}
          onJumpToNode={jumpToNode}
        />
      ) : (
        <div className="graph-tab">
          <Sidebar
            apiNodes={apiNodes}
            apiEdges={apiEdges}
            selectedId={selectedId}
            onSelectNode={handleSelectNode}
            search={search}
            onSearchChange={setSearch}
          />
          <div className="canvas-col">
            {graphLoading ? (
              <div className="veil">
                <span className="spinner large" />
                <span>Loading graph…</span>
              </div>
            ) : graphError ? (
              <div className="empty-state">
                <h2>Couldn&apos;t load the graph</h2>
                <p className="muted">{graphError}</p>
                <button className="rebuild-btn" onClick={() => loadGraph(selectedRepoId)}>
                  Retry
                </button>
              </div>
            ) : (
              <GraphView
                nodes={nodes}
                edges={baseEdges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeClick={handleSelectNode}
                onInit={(inst) => {
                  rfRef.current = inst;
                }}
                isEmpty={isEmpty}
                onRebuild={handleRebuild}
                rebuildWorking={rebuild.state === 'working'}
              />
            )}
          </div>
        </div>
      )}
    </>
  );

  if (screen === 'home') {
    return (
      <div className="app app-landing">
        <Landing onChoose={chooseScreen} />
      </div>
    );
  }

  const titles = {
    graph: 'View Graph',
    features: 'Feature Development',
    bugs: 'Fix Bugs',
    ask: 'Ask AI',
  };

  return (
    <div className="app">
      <AppShell
        title={titles[screen] || 'CodeGraph'}
        onHome={goHome}
        actions={screen === 'graph' ? graphActions : null}
      >
        {screen === 'graph' && graphBody}
        {screen === 'features' && <RequirementsView kind="feature" />}
        {screen === 'bugs' && <RequirementsView kind="bug" repos={repos} />}
        {screen === 'ask' && <AskView repos={repos} onJumpToNode={jumpToNode} />}
      </AppShell>
    </div>
  );
}
