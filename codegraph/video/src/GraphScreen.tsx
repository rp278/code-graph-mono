import React, { useLayoutEffect, useRef, useState } from 'react';
import { Easing, interpolate, useCurrentFrame } from 'remotion';
import graph from '../data/graph.json';
import entry from '../data/entry.json';
// Real layout + styling helpers from the dashboard.
import {
  buildRepoMap,
  colorForType,
  kindOf,
  layoutNeighborhood,
  relationColor,
  relationCounts,
  relationLabel,
  shortPath,
  NODE_W,
  NODE_H,
  CENTER_W,
  CENTER_H,
} from '../../web/src/graphUtils.js';
import { Shell, Stage, TrackedCursor, CursorKey } from './AppUi';
import { TreeCanvas, TREE_CLICKS } from './TreeCanvas';

type Beats = Record<string, { rel: number; dur: number }>;
const PREFIX = '__repo:';
const MFE = 'tb-discovery-mfe';
const QUERY = 'selection-xapi';

// ---- data prepared once --------------------------------------------------
const repos = (graph.repos as { id: string; name: string }[]).map((r) => ({ id: r.id, name: r.name }));
const repoMap = buildRepoMap(repos, graph.repoCounts, graph.links, PREFIX);

const hood = graph.hood as { center: any; nodes: any[]; edges: any[]; total: number };
const hoodById = new Map<string, any>(hood.nodes.map((n) => [n.id, n]));
const hoodLayout = layoutNeighborhood(hood.center, hoodById, hood.edges, 48);

const hubCenter = { id: PREFIX + MFE, label: MFE, type: 'repo', repo: '', loc: `${(graph.repoCounts as any)[MFE]} nodes` };
const hubNodes = (entry.mfe.nodes as any[]).slice(0, 30);
const hubEdges = hubNodes.map((n, i) => ({ id: `o${i}`, source: hubCenter.id, target: n.id, relation: 'ENTRY', confidence: 'EXTRACTED' }));
const hubLayout = layoutNeighborhood(hubCenter, new Map(hubNodes.map((n) => [n.id, n])), hubEdges, 48);

// ---- generic canvas (pan/zoom camera, nodes, edges) -----------------------
type FlowNode = { id: string; x: number; y: number; w: number; h: number; o?: number; el: React.ReactNode };
type FlowEdge = { id: string; d: string; color: string; width: number; dash?: string; o?: number; arrow?: boolean };
type FlowLabel = { id: string; x: number; y: number; o?: number; el: React.ReactNode };

function useSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1100, h: 640 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && (el.offsetWidth !== size.w || el.offsetHeight !== size.h)) setSize({ w: el.offsetWidth, h: el.offsetHeight });
  });
  return { ref, size };
}

function FlowCanvas({ nodes, edges, labels = [], opacity = 1, size, padding = 0.18, maxZoom = 1.1, topBar = 56 }: {
  nodes: FlowNode[]; edges: FlowEdge[]; labels?: FlowLabel[]; opacity?: number; size: { w: number; h: number };
  padding?: number; maxZoom?: number; topBar?: number;
}) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  nodes.forEach((n) => {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
  });
  const bw = maxX - minX, bh = maxY - minY;
  const availH = size.h - topBar;
  const z = Math.min(maxZoom, size.w / (bw * (1 + 2 * padding)), availH / (bh * (1 + 2 * padding)));
  const tx = size.w / 2 - ((minX + maxX) / 2) * z;
  const ty = topBar + availH / 2 - ((minY + maxY) / 2) * z;
  const colors = [...new Set(edges.filter((e) => e.arrow).map((e) => e.color))];
  return (
    <div style={{ position: 'absolute', inset: 0, opacity, overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: 'radial-gradient(#1f2937 1.6px, transparent 1.6px)',
          backgroundSize: `${26 * z}px ${26 * z}px`,
          backgroundPosition: `${tx}px ${ty}px`,
        }}
      />
      <div style={{ position: 'absolute', left: 0, top: 0, transformOrigin: '0 0', transform: `translate(${tx}px, ${ty}px) scale(${z})` }}>
        <svg width={1} height={1} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
          <defs>
            {colors.map((c) => (
              <marker key={c} id={`arr-${c.slice(1)}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill={c} />
              </marker>
            ))}
          </defs>
          {edges.map((e) => (
            <path
              key={e.id}
              d={e.d}
              fill="none"
              stroke={e.color}
              strokeWidth={e.width}
              strokeDasharray={e.dash}
              opacity={e.o ?? 1}
              markerEnd={e.arrow ? `url(#arr-${e.color.slice(1)})` : undefined}
            />
          ))}
        </svg>
        {nodes.map((n) => (
          <div key={n.id} style={{ position: 'absolute', left: n.x, top: n.y, opacity: n.o ?? 1 }}>
            {n.el}
          </div>
        ))}
        {labels.map((l) => (
          <div key={l.id} style={{ position: 'absolute', left: l.x, top: l.y, opacity: l.o ?? 1 }}>
            {l.el}
          </div>
        ))}
      </div>
    </div>
  );
}

const KgNode: React.FC<{ label: string; kind: string; color: string; repo?: string; loc?: string; center?: boolean; foreign?: boolean; hint?: string; ring?: boolean; dataT?: string }> = ({
  label, kind, color, repo, loc, center, foreign, ring, dataT,
}) => (
  <div
    data-t={dataT}
    className={`kg-node${center ? ' kg-node-center' : ''}`}
    style={{ ['--node-color' as string]: color, boxShadow: ring ? `0 0 0 3px ${color}, 0 0 26px ${color}` : undefined }}
  >
    <div className="kg-node-label">{label}</div>
    <div className="kg-node-meta">
      <span className="kg-node-kind" style={{ color }}>{kind}</span>
      {repo && <span className={foreign ? 'kg-node-repo foreign' : 'kg-node-repo'}>{repo}</span>}
      {loc && <span className="kg-node-loc">{loc}</span>}
    </div>
  </div>
);

const ease = Easing.out(Easing.cubic);
const clampX = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const pop = (f: number, at: number, len = 14) => interpolate(f, [at, at + len], [0, 1], clampX);

// smooth curve through dagre waypoints (same as RepoLinkEdge)
function pathThrough(pts: { x: number; y: number }[]) {
  if (pts.length < 2) return '';
  if (pts.length === 2) return `M ${pts[0].x} ${pts[0].y} L ${pts[1].x} ${pts[1].y}`;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const last = i === pts.length - 2;
    const to = last ? pts[i + 1] : { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 };
    d += ` Q ${pts[i].x} ${pts[i].y} ${to.x} ${to.y}`;
  }
  return d;
}

const bezier = (sx: number, sy: number, tx: number, ty: number) => {
  const c = Math.max(40, Math.abs(tx - sx) * 0.5);
  return `M${sx},${sy} C${sx + c},${sy} ${tx - c},${ty} ${tx},${ty}`;
};

// ---- the three canvases ---------------------------------------------------
function RepoMap({ f, size, opacity, highlightFrom, highlightTo }: { f: number; size: { w: number; h: number }; opacity: number; highlightFrom: number; highlightTo: number }) {
  const nodes: FlowNode[] = repoMap.nodes.map((n: any, i: number) => ({
    id: n.id,
    x: n.position.x,
    y: n.position.y,
    w: 260,
    h: 64,
    o: pop(f, 24 + i * 5),
    el: (
      <div style={{ width: 260, height: 64 }}>
        <KgNode label={n.data.label} kind="repo" color={n.data.color} loc={n.data.loc} />
      </div>
    ),
  }));
  const edges: FlowEdge[] = repoMap.edges.map((e: any, i: number) => ({
    id: e.id,
    d: pathThrough(e.data.points),
    color: e.style.stroke,
    width: e.style.strokeWidth,
    dash: e.style.strokeDasharray,
    o: pop(f, 60 + i * 4, 18) * 0.9,
    arrow: true,
  }));
  const labels: FlowLabel[] = repoMap.edges.map((e: any, i: number) => {
    const pts = e.data.points;
    const mid = pts.length % 2 ? pts[(pts.length - 1) / 2] : { x: (pts[pts.length / 2 - 1].x + pts[pts.length / 2].x) / 2, y: (pts[pts.length / 2 - 1].y + pts[pts.length / 2].y) / 2 };
    const key = `lbl:${e.source.replace(PREFIX, '')}>${e.target.replace(PREFIX, '')}`;
    const hot = key === `lbl:${MFE}>tb-selection-xapi`;
    const glow = hot ? interpolate(f, [highlightFrom, highlightFrom + 12, highlightTo - 12, highlightTo], [0, 1, 1, 0], clampX) : 0;
    return {
      id: e.id,
      x: mid.x,
      y: mid.y,
      o: pop(f, 66 + i * 4, 16),
      el: (
        <div
          data-t={key}
          className="repo-link-label"
          style={{ position: 'relative', transform: 'translate(-50%, -50%)', boxShadow: glow ? `0 0 0 2px #fb923c, 0 0 ${22 * glow}px #fb923c` : undefined }}
        >
          {e.data.lines.map((l: any) => (
            <div className="repo-link-line" key={`${l.reverse ? 'r' : 'f'}:${l.relation}`}>
              <span className="repo-link-dot" style={{ background: l.color }} />
              <span>{l.reverse ? '← ' : ''}{l.label}</span>
              <b>×{l.count}</b>
            </div>
          ))}
        </div>
      ),
    };
  });
  return <FlowCanvas nodes={nodes} edges={edges} labels={labels} size={size} opacity={opacity} maxZoom={1.05} />;
}

function NeighborCanvas({ f, size, opacity, center, byId, edges: rawEdges, layout, overview, ringId, centerRepo }: {
  f: number; size: { w: number; h: number }; opacity: number; center: any; byId: Map<string, any>; edges: any[];
  layout: any; overview: boolean; ringId?: string; centerRepo?: string;
}) {
  const pos = layout.positions as Record<string, { x: number; y: number }>;
  const nodes: FlowNode[] = [];
  const cKind = center.type === 'repo' ? 'repo' : kindOf(center);
  nodes.push({
    id: center.id, x: pos[center.id].x, y: pos[center.id].y, w: CENTER_W, h: CENTER_H, o: pop(f, 0, 10),
    el: <KgNode center label={center.label} kind={cKind} color={colorForType(cKind)} repo={center.repo} loc={center.loc} />,
  });
  const order = [...byId.keys()].filter((id) => pos[id]);
  const edges: FlowEdge[] = [];
  order.forEach((id, i) => {
    const n = byId.get(id);
    const kind = kindOf(n);
    const o = pop(f, 8 + i * 2.2, 12);
    nodes.push({
      id, x: pos[id].x, y: pos[id].y, w: NODE_W, h: NODE_H, o,
      el: <KgNode label={n.label} kind={kind} color={colorForType(kind)} repo={n.repo} loc={n.loc} foreign={!!(n.repo && centerRepo && n.repo !== centerRepo)} ring={id === ringId} dataT={`node:${id}`} />,
    });
  });
  rawEdges.forEach((e: any) => {
    if (!pos[e.source] || !pos[e.target]) return;
    const sw = e.source === center.id ? CENTER_W : NODE_W;
    const sh = e.source === center.id ? CENTER_H : NODE_H;
    const th = e.target === center.id ? CENTER_H : NODE_H;
    const other = e.source === center.id ? e.target : e.source;
    const idx = Math.max(0, order.indexOf(other));
    edges.push({
      id: e.id,
      d: bezier(pos[e.source].x + sw, pos[e.source].y + sh / 2, pos[e.target].x, pos[e.target].y + th / 2),
      color: relationColor(e.relation),
      width: 1.5,
      dash: e.confidence === 'INFERRED' ? '7 5' : undefined,
      o: pop(f, 10 + idx * 2.2, 14) * 0.85,
      arrow: !overview,
    });
  });
  return <FlowCanvas nodes={nodes} edges={edges} size={size} opacity={opacity} />;
}

// ---- screen ----------------------------------------------------------------
const Sidebar: React.FC<{ repoId: string; query: string; results: any[]; types: { type: string; c: number }[]; activeId?: string; showFocus: boolean }> = ({
  repoId, query, results, types, activeId, showFocus,
}) => {
  const center = hood.center;
  const kind = kindOf(center);
  return (
    <aside className="sidebar explorer-side">
      <div className="sidebar-section">
        <h3>Repository</h3>
        <div className="repo-list">
          <button className={repoId === 'all' ? 'repo-row active' : 'repo-row'}>
            <span className="repo-row-name">All repos</span>
            <span className="repo-row-count">{graph.stats.nodes}</span>
          </button>
          {repos.map((r) => (
            <button key={r.id} data-t={`repo:${r.id}`} className={repoId === r.id ? 'repo-row active' : 'repo-row'}>
              <span className="repo-row-name">{r.name}</span>
              <span className="repo-row-count">{(graph.repoCounts as any)[r.id] ?? ''}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="sidebar-section">
        <h3>Find a node</h3>
        <div data-t="search">
          <input className="search-input" readOnly value={query} placeholder={repoId === 'all' ? 'Search all repos…' : `Search ${repoId}…`} />
        </div>
        {types.length > 1 && (
          <div className="chip-row">
            <button className="mini-chip active">all</button>
            {types.slice(0, 4).map((t) => (
              <button key={t.type} className="mini-chip">{t.type} <span className="mini-chip-n">{t.c}</span></button>
            ))}
          </div>
        )}
      </div>
      <div className="sidebar-section results-section">
        <h3>{query ? `Matches (${results.length})` : 'Entry points'}</h3>
        <div className="result-list">
          {results.slice(0, 8).map((n) => {
            const k = kindOf(n);
            return (
              <button key={n.id} data-t={`result:${n.id}`} className={n.id === activeId ? 'result-row active' : 'result-row'}>
                <span className="type-dot" style={{ background: colorForType(k) }} />
                <span className="result-main">
                  <span className="result-label">{n.label || n.id}</span>
                  <span className="result-meta">{k}{repoId === 'all' && n.repo ? ` · ${n.repo}` : ''} · {n.degree} links</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {showFocus && (
        <div className="focus-card">
          <div className="focus-title">{center.label}</div>
          <div className="focus-kind" style={{ color: colorForType(kind), background: `${colorForType(kind)}1f` }}>{kind}</div>
          <div className="focus-row"><span>repo</span>{center.repo}</div>
          <div className="focus-row"><span>file</span><code>{shortPath(center.file, center.repo)}:{String(center.loc).replace(/^L/, '')}</code></div>
          <div className="focus-row"><span>links</span>{hood.total}</div>
          <div className="focus-legend"><span>← used by / parent</span><span>uses / children →</span></div>
        </div>
      )}
    </aside>
  );
};

export const GraphScreen: React.FC<{ beats: Beats; treeStepFrames: number }> = ({ beats, treeStepFrames }) => {
  const f = useCurrentFrame();
  const { ref, size } = useSize();

  const g2 = beats.g2.rel, g3 = beats.g3.rel, g4 = beats.g4.rel;
  const tRepoClick = g3 + 16;
  const tSearchClick = g3 + 100;
  const tType = tSearchClick + 12;
  const tResultClick = g3 + 200;
  const tTreeClick = g4 + 12;
  const tTreeStart = tTreeClick + 16;

  const view: 'map' | 'hub' | 'hood' | 'tree' = f >= tTreeClick + 6 ? 'tree' : f >= tResultClick + 4 ? 'hood' : f >= tRepoClick + 4 ? 'hub' : 'map';
  const cf = (at: number) => interpolate(f, [at, at + 10], [0, 1], clampX);
  const repoId = f >= tRepoClick ? MFE : 'all';
  const typed = Math.max(0, Math.min(QUERY.length, Math.floor((f - tType) / 2.2)));
  const query = f >= tType ? QUERY.slice(0, typed) : '';
  const searching = query.length >= 3;
  const results = searching ? (entry.sel.nodes as any[]) : repoId === 'all' ? (entry.all.nodes as any[]) : (entry.mfe.nodes as any[]);
  const proxyRow = (entry.sel.nodes as any[]).find((n) => n.label === hood.center.label);
  const types = searching ? (entry.sel.types as any[]) : repoId === 'all' ? (entry.all.types as any[]) : (entry.mfe.types as any[]);

  const inTree = view === 'tree';
  const rels = relationCounts(hood.edges);

  const path: CursorKey[] = [
    { f: g2 + 30, t: `lbl:${MFE}>tb-selection-xapi` },
    { f: tRepoClick, t: `repo:${MFE}` },
    { f: tSearchClick, t: 'search@0.4,0.5' },
    { f: tResultClick, t: `result:${proxyRow?.id}@0.4,0.5` },
    { f: tTreeClick, t: 'chip:tree' },
  ];

  const actions = (
    <div className="header-controls">
      <label className="repo-label">Repo</label>
      <select className="repo-select" value={repoId} onChange={() => {}}>
        <option value="all">All repos</option>
        {repos.map((r) => (<option key={r.id} value={r.id}>{r.name}</option>))}
      </select>
      <div className="stats-pill"><span className="stats-dot" />{graph.stats.nodes} nodes · {graph.stats.edges} edges</div>
      <button className="rebuild-btn">Rebuild graph</button>
      <button className={!inTree ? 'tab-chip active' : 'tab-chip'}>Explore</button>
      <button data-t="chip:tree" className={inTree ? 'tab-chip active' : 'tab-chip'}>Tree</button>
      <button className="tab-chip">Ask AI</button>
    </div>
  );

  const trailLabel = hood.center.label;
  return (
    <Stage overlay={f < tTreeClick + 20 ? <TrackedCursor path={path} clicks={[tRepoClick, tSearchClick, tResultClick, tTreeClick]} /> : null}>
      <Shell title="View Graph" actions={actions}>
        <div className="graph-tab">
          {!inTree && <Sidebar repoId={repoId} query={query} results={results} types={types} activeId={view === 'hood' ? hood.center.id : undefined} showFocus={view === 'hood'} />}
          <div className="canvas-col">
            {!inTree && (
              <div className="explorer-bar">
                <div className="crumbs">
                  <button className="crumb" disabled>←</button>
                  <button className={view === 'hood' ? 'crumb' : 'crumb current'}>{repoId === 'all' ? 'All repos' : repoId}</button>
                  {view === 'hood' && (
                    <span className="crumb-wrap"><span className="crumb-sep">›</span><button className="crumb current">{trailLabel}</button></span>
                  )}
                </div>
                {view === 'hood' && (
                  <div className="chip-row rel-row">
                    <span className="rel-hint">{rels.length > 1 ? 'Show:' : 'Relation:'}</span>
                    {rels.map(({ relation, count }: any) => (
                      <button key={relation} className="rel-chip" style={{ ['--rel-color' as string]: relationColor(relation) }}>
                        <span className="rel-swatch" />{relationLabel(relation)} <span className="mini-chip-n">{count}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="graph-wrap" ref={ref}>
              {view === 'map' && <RepoMap f={f} size={size} opacity={1 - cf(tRepoClick + 4)} highlightFrom={g2 + 30} highlightTo={g3} />}
              {view === 'hub' && (
                <NeighborCanvas f={f - (tRepoClick + 4)} size={size} opacity={cf(tRepoClick + 4)} center={hubCenter} byId={new Map(hubNodes.map((n) => [n.id, n]))} edges={hubEdges} layout={hubLayout} overview />
              )}
              {view === 'hood' && (
                <NeighborCanvas f={f - (tResultClick + 4)} size={size} opacity={cf(tResultClick + 4)} center={hood.center} byId={hoodById} edges={hood.edges} layout={hoodLayout} overview={false} centerRepo={hood.center.repo} />
              )}
              {view === 'tree' && (
                <div style={{ position: 'absolute', inset: 0, opacity: cf(tTreeClick + 6) }}>
                  <TreeCanvas frame={Math.max(0, f - tTreeStart)} width={size.w} height={size.h} stepFrames={treeStepFrames} />
                </div>
              )}
              {view === 'map' && (
                <div className="overview-hint" style={{ position: 'absolute', bottom: 16, left: 0, right: 0, textAlign: 'center', fontSize: 12.5, opacity: pop(f, 100) * (1 - cf(tRepoClick)) }}>
                  Arrows show which repository depends on / calls another. Click a repository to open it
                </div>
              )}
            </div>
          </div>
        </div>
      </Shell>
    </Stage>
  );
};

export const graphTreeFrames = (stepFrames: number) => TREE_CLICKS * stepFrames;
