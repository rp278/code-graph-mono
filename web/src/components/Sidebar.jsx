import { TYPE_COLORS, TYPE_DESCRIPTIONS, colorForType, neighborsOf } from '../graphUtils';

export default function Sidebar({
  apiNodes,
  apiEdges,
  selectedId,
  onSelectNode,
  search,
  onSearchChange,
}) {
  const q = search.trim().toLowerCase();
  const matches = q
    ? apiNodes.filter((n) => (n.label || n.id || '').toLowerCase().includes(q)).slice(0, 12)
    : [];

  const selected = apiNodes.find((n) => n.id === selectedId) || null;
  const neighbors = selected ? neighborsOf(selected.id, apiNodes, apiEdges) : [];

  return (
    <aside className="sidebar">
      <div className="sidebar-section">
        <h3>Search nodes</h3>
        <input
          className="search-input"
          type="text"
          placeholder="Filter by label…"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        {q && (
          <div className="search-results">
            {matches.length === 0 ? (
              <div className="muted">No nodes match “{search}”.</div>
            ) : (
              matches.map((m) => (
                <button
                  key={m.id}
                  className="search-hit"
                  onClick={() => onSelectNode(m.id, true)}
                  title={m.id}
                >
                  <span
                    className="type-dot"
                    style={{ background: colorForType(m.type) }}
                  />
                  <span className="search-hit-label">{m.label || m.id}</span>
                  <span className="search-hit-type">{m.type}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      <div className="sidebar-section">
        <h3>Legend</h3>
        <div className="legend">
          {Object.entries(TYPE_COLORS).map(([type, color]) => (
            <div className="legend-row" key={type} title={TYPE_DESCRIPTIONS[type] || type}>
              <span className="type-dot" style={{ background: color }} />
              <span className="legend-type">{type}</span>
            </div>
          ))}
          <div className="legend-row" title="Edge drawn from an INFERRED relationship">
            <span className="edge-swatch dashed" />
            <span className="legend-type">inferred edge</span>
          </div>
          <div className="legend-row" title="Edge drawn from an AMBIGUOUS relationship">
            <span className="edge-swatch dotted" />
            <span className="legend-type">ambiguous edge</span>
          </div>
        </div>
      </div>

      <div className="sidebar-section details">
        <h3>Node details</h3>
        {!selected ? (
          <div className="muted">Click a node on the canvas to inspect it.</div>
        ) : (
          <div className="details-card">
            <div className="details-title">{selected.label || selected.id}</div>
            <div
              className="details-type"
              style={{
                color: colorForType(selected.type),
                background: `${colorForType(selected.type)}1f`,
              }}
            >
              {selected.type || 'unknown'}
            </div>
            {selected.file && (
              <div className="details-row">
                <span className="details-k">file</span>
                <span className="details-v mono">{selected.file}</span>
              </div>
            )}
            {selected.repo && (
              <div className="details-row">
                <span className="details-k">repo</span>
                <span className="details-v">{selected.repo}</span>
              </div>
            )}
            <div className="details-row">
              <span className="details-k">id</span>
              <span className="details-v mono small">{selected.id}</span>
            </div>
            <h4>Connections ({neighbors.length})</h4>
            {neighbors.length === 0 ? (
              <div className="muted">No connected nodes.</div>
            ) : (
              <div className="neighbor-list">
                {neighbors.map((nb) => (
                  <button
                    key={`${nb.id}-${nb.relation}-${nb.direction}`}
                    className="neighbor-row"
                    onClick={() => onSelectNode(nb.id, true)}
                    title={`${nb.direction === 'out' ? '→' : '←'} ${nb.relation} (${nb.confidence || 'EXTRACTED'})`}
                  >
                    <span
                      className="type-dot"
                      style={{ background: colorForType(nb.type) }}
                    />
                    <span className="neighbor-label">{nb.label}</span>
                    <span className="neighbor-rel">
                      {nb.direction === 'out' ? '→' : '←'} {nb.relation}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
