export default function Header({
  repos,
  selectedRepoId,
  onSelectRepo,
  stats,
  statsLoading,
  rebuild,
  onRebuild,
  extra,
}) {
  return (
    <div className="header-controls">
      <label className="repo-label" htmlFor="repo-select">
        Repo
      </label>
      <select
        id="repo-select"
        className="repo-select"
        value={selectedRepoId}
        onChange={(e) => onSelectRepo(e.target.value)}
        disabled={repos.length === 0}
      >
        {repos.length === 0 && <option value="">No repos</option>}
        {repos.length > 0 && <option value="all">All repos</option>}
        {repos.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
      <div
        className="stats-pill"
        title="Total nodes and edges across all indexed repos"
      >
        <span className="stats-dot" />
        {statsLoading ? 'loading…' : `${stats.nodes} nodes · ${stats.edges} edges`}
      </div>
      <button
        className="rebuild-btn"
        onClick={onRebuild}
        disabled={rebuild.state === 'working' || !selectedRepoId}
        title="Re-scan the selected repo and rebuild its graph"
      >
        {rebuild.state === 'working' ? (
          <>
            <span className="spinner" /> Rebuilding…
          </>
        ) : (
          'Rebuild graph'
        )}
      </button>
      {extra}
      {rebuild.message && (
        <div className={`rebuild-status inline ${rebuild.state}`} role="status">
          {rebuild.message}
        </div>
      )}
    </div>
  );
}
