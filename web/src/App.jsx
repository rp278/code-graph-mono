import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import Header from './components/Header';
import Explorer from './components/Explorer';
import AskView from './components/AskView';
import TreeView from './components/TreeView';
import RequirementsView from './components/RequirementsView';
import Landing from './components/Landing';
import { isFeatureDevelopmentEnabled } from './flags';
import AppShell from './components/AppShell';

export default function App() {
  const [repos, setRepos] = useState([]);
  const [reposLoading, setReposLoading] = useState(true);
  const [reposError, setReposError] = useState(null);
  const [selectedRepoId, setSelectedRepoId] = useState('');

  const [stats, setStats] = useState({ nodes: 0, edges: 0, byType: [] });
  const [statsLoading, setStatsLoading] = useState(true);

  const [screen, setScreen] = useState(() => {
    const saved = sessionStorage.getItem('codegraph.screen') || 'home';
    // Don't restore a flag-gated screen when its flag is off.
    if (saved === 'features' && !isFeatureDevelopmentEnabled()) return 'home';
    return saved;
  });
  const [tab, setTab] = useState('graph');
  // 'graph' = repo + node explorer (default); 'tree' = collapsible folder/file/symbol tree.
  const [graphView, setGraphView] = useState(() => sessionStorage.getItem('codegraph.graphView') || 'graph');
  const chooseGraphView = useCallback((v) => {
    setGraphView(v);
    sessionStorage.setItem('codegraph.graphView', v);
  }, []);

  // Explorer navigation: the nodes visited so far, last = the one on screen.
  const [trail, setTrail] = useState([]);
  // Bumped after a rebuild so the explorer / tree refetch.
  const [graphVersion, setGraphVersion] = useState(0);

  const [rebuild, setRebuild] = useState({ state: 'idle', message: '' });

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
      setStats({ nodes: s.nodes ?? 0, edges: s.edges ?? 0, byType: s.by_type || [] });
    } catch {
      // keep previous stats on transient failure
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRepos();
    loadStats();
  }, [loadRepos, loadStats]);

  // Node count per repo, for the repository list.
  const repoCounts = useMemo(() => {
    const m = {};
    for (const row of stats.byType) m[row.repo] = (m[row.repo] || 0) + row.c;
    return m;
  }, [stats.byType]);

  // Picking another repo starts over at that repo's overview.
  const selectRepo = useCallback((id) => {
    setSelectedRepoId(id);
    setTrail([]);
  }, []);

  // Jump from an Ask AI context chip to the node in the explorer.
  const jumpToNode = useCallback(
    (id) => {
      chooseScreen('graph');
      chooseGraphView('graph');
      setTrail([{ id, label: id }]);
    },
    [chooseScreen, chooseGraphView]
  );

  const handleRebuild = useCallback(async () => {
    if (!selectedRepoId) return;
    setRebuild({ state: 'working', message: `Rebuilding graph for “${selectedRepoId}”…` });
    try {
      const r = await api.rebuild(selectedRepoId);
      const summary = r.status ? `Rebuild finished (${r.status}).` : 'Rebuild finished.';
      setRebuild({ state: 'done', message: summary });
      await loadStats();
      setGraphVersion((v) => v + 1);
    } catch (e) {
      setRebuild({ state: 'error', message: `Rebuild failed: ${e.message}` });
    }
  }, [selectedRepoId, loadStats]);

  const graphActions = (
    <Header
      repos={repos}
      selectedRepoId={selectedRepoId}
      onSelectRepo={selectRepo}
      stats={stats}
      statsLoading={statsLoading}
      rebuild={rebuild}
      onRebuild={handleRebuild}
      extra={
        <>
          <button
            className={tab !== 'chat' && graphView === 'graph' ? 'tab-chip active' : 'tab-chip'}
            onClick={() => {
              chooseGraphView('graph');
              setTab('graph');
            }}
            title="Pick a repo and a node, then follow its connections"
          >
            Explore
          </button>
          <button
            className={tab !== 'chat' && graphView === 'tree' ? 'tab-chip active' : 'tab-chip'}
            onClick={() => {
              chooseGraphView('tree');
              setTab('graph');
            }}
            title="Folders, files and symbols as an expandable tree"
          >
            Tree
          </button>
          <button
            className={tab === 'chat' ? 'tab-chip active' : 'tab-chip'}
            onClick={() => setTab((t) => (t === 'chat' ? 'graph' : 'chat'))}
          >
            {tab === 'chat' ? 'Back to graph' : 'Ask AI'}
          </button>
        </>
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
      ) : graphView === 'tree' ? (
        <div className="graph-tab">
          <div className="canvas-col">
            <TreeView repoId={selectedRepoId || 'all'} reloadToken={`${stats.nodes}:${graphVersion}`} />
          </div>
        </div>
      ) : (
        <Explorer
          repos={repos}
          repoCounts={repoCounts}
          totalNodes={stats.nodes}
          selectedRepoId={selectedRepoId || 'all'}
          onSelectRepo={selectRepo}
          trail={trail}
          setTrail={setTrail}
          reloadToken={graphVersion}
          onRebuild={handleRebuild}
          rebuildWorking={rebuild.state === 'working'}
        />
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
