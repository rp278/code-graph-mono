import React, { useMemo } from 'react';
import { Easing, interpolate, useCurrentFrame } from 'remotion';
import data from '../data/tree.json';
import { buildTree, layoutTree, pathTo, COLORS, NODE_H, NODE_W, Layout, Row } from './tree';

export const W = 1920;
export const H = 1080;
export const STEP_FRAMES = 90;
const CLICK_AT = 24; // frame inside a step where the click lands
const MOVE_END = 62; // frame inside a step where the layout/camera settle
const CENTER = { x: W / 2, y: 450 };

type Step = {
  click: string | 'reset';
  title: string;
  sub: string;
};

type Cam = { cx: number; cy: number; z: number };

const ROOT = buildTree(data.nodes as never, data.edges as never);
const REPO_ID = 'repo:tb-discovery-xapi';
const repoRow = ROOT.children.find((r) => r.id === REPO_ID)!;
const fileChain =
  pathTo(repoRow, (r) => r.kind === 'file' && r.label === 'ProductListController.java') ??
  pathTo(repoRow, (r) => r.kind === 'file' && r.children.length > 5)!;
const fileRow = fileChain[fileChain.length - 1];
const classRow =
  fileRow.children.find((c) => c.children.length > 3) ?? fileRow.children[0];
const dirChain = fileChain.slice(1, -1); // folders between repo and file

export const TOTAL_ROWS = ROOT.count;
export const REPO_COUNT = ROOT.children.length;

const dirTitle = (d: Row) => `Open “${d.label}”`;

export { ROOT, STEPS, repoRow };

const STEPS: Step[] = [
  {
    click: 'root',
    title: 'Start with everything',
    sub: `${ROOT.children.length} repos, ${ROOT.count.toLocaleString()} symbols. The tree starts collapsed.`,
  },
  {
    click: repoRow.id,
    title: `Open a repo: ${repoRow.label}`,
    sub: 'The badge is how many items sit inside, so you can spot the big areas at a glance.',
  },
  ...dirChain.map((d) => ({
    click: d.id,
    title: dirTitle(d),
    sub: d.label.includes('/')
      ? 'Chains of single-child folders are merged into one row (a/b/c), so there are no dead clicks.'
      : 'Folders come first, then files, sorted naturally.',
  })),
  {
    click: fileRow.id,
    title: `Open a file: ${fileRow.label}`,
    sub: 'Files list their classes and functions, each with its source line.',
  },
  {
    click: classRow.id,
    title: `Open a class: ${classRow.label}`,
    sub: 'Methods hang under their class. Line numbers (L41) point at the exact code.',
  },
  {
    click: 'reset',
    title: 'Collapse all',
    sub: 'One click puts the whole codebase back to a single row.',
  },
];

export const TREE_STEPS = STEPS.length;
export const TREE_FRAMES = STEPS.length * STEP_FRAMES + 45;

// ---- precompute layouts and cameras -------------------------------------
const expandedSets: Set<string>[] = [new Set()];
STEPS.forEach((s) => {
  const prev = expandedSets[expandedSets.length - 1];
  if (s.click === 'reset') expandedSets.push(new Set(['root']));
  else expandedSets.push(new Set([...prev, s.click]));
});
const layouts: Layout[] = expandedSets.map((e) => layoutTree(ROOT, e));

function cameraFor(state: number): Cam {
  const L = layouts[state];
  let ids: string[];
  if (state === 0) ids = ['root'];
  else {
    const step = STEPS[state - 1];
    if (step.click === 'reset') ids = L.order;
    else {
      const kids = L.rows.get(step.click)!.children.map((c) => c.id).filter((id) => L.pos.has(id));
      ids = [step.click, ...(L.parentOf.has(step.click) ? [L.parentOf.get(step.click)!] : []), ...kids.slice(0, 9)];
    }
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  ids.forEach((id) => {
    const p = L.pos.get(id)!;
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  });
  const bw = maxX - minX + NODE_W;
  const bh = maxY - minY + NODE_H;
  const z = Math.max(0.7, Math.min(1.45, Math.min(1700 / bw, 640 / bh)));
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, z };
}
const cameras: Cam[] = layouts.map((_, i) => cameraFor(i));

const toScreen = (cam: Cam, p: { x: number; y: number }) => ({
  x: CENTER.x + (p.x - cam.cx) * cam.z,
  y: CENTER.y + (p.y - cam.cy) * cam.z,
});

const RESET_BTN = { x: 150, y: 70 };

function clickTarget(step: Step, state: number, cam: Cam) {
  if (step.click === 'reset') return RESET_BTN;
  const p = layouts[state].pos.get(step.click);
  if (!p) return { x: W / 2, y: H / 2 };
  const s = toScreen(cam, p);
  return { x: s.x - 40 * cam.z, y: s.y };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = Easing.inOut(Easing.cubic);

// ---- rendering ------------------------------------------------------------
function NodeBox({ row, x, y, expanded, opacity, glow }: { row: Row; x: number; y: number; expanded: boolean; opacity: number; glow: number }) {
  const color = row.kind === 'node' ? COLORS.node : COLORS[row.kind];
  const hasKids = row.children.length > 0;
  return (
    <div
      style={{
        position: 'absolute',
        left: x - NODE_W / 2,
        top: y - NODE_H / 2,
        width: NODE_W,
        height: NODE_H,
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '0 16px',
        background: 'linear-gradient(180deg, #161d2a, #10151f)',
        border: `1px solid ${color}`,
        borderLeftWidth: 5,
        borderRadius: 10,
        fontFamily: '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        fontSize: 18,
        fontWeight: row.kind === 'repo' || row.kind === 'root' ? 700 : 500,
        color: '#e2e8f0',
        opacity,
        boxShadow: glow > 0 ? `0 0 0 ${2 + glow * 3}px ${color}, 0 0 ${30 * glow}px ${color}` : 'none',
        transform: `scale(${1 + glow * 0.04})`,
      }}
    >
      <span style={{ width: 14, textAlign: 'center', color }}>{hasKids ? (expanded ? '▾' : '▸') : '•'}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.label}</span>
      {hasKids && <Pill>{row.count.toLocaleString()}</Pill>}
      {!hasKids && row.loc && <Pill>{row.loc}</Pill>}
    </div>
  );
}

const Pill: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span
    style={{
      fontSize: 14,
      color: '#8b94a3',
      background: 'rgba(148,163,184,0.14)',
      borderRadius: 999,
      padding: '2px 10px',
    }}
  >
    {children}
  </span>
);

export const TreeScene: React.FC = () => {
  const frame = useCurrentFrame();
  const stepIdx = Math.min(Math.floor(frame / STEP_FRAMES), STEPS.length - 1);
  const local = frame - stepIdx * STEP_FRAMES;
  const step = STEPS[stepIdx];

  const prevL = layouts[stepIdx];
  const nextL = layouts[stepIdx + 1];
  const prevCam = cameras[stepIdx];
  const nextCam = cameras[stepIdx + 1];

  const t = ease(interpolate(local, [CLICK_AT + 2, MOVE_END], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
  const cam: Cam = {
    cx: lerp(prevCam.cx, nextCam.cx, t),
    cy: lerp(prevCam.cy, nextCam.cy, t),
    z: Math.exp(lerp(Math.log(prevCam.z), Math.log(nextCam.z), t)),
  };
  // After the last step, the final state just holds.
  const lastHold = frame >= STEPS.length * STEP_FRAMES;

  const ids = new Set([...prevL.order, ...nextL.order]);
  const placed = new Map<string, { x: number; y: number; o: number; row: Row; parent?: string }>();
  ids.forEach((id) => {
    const a = prevL.pos.get(id);
    const b = nextL.pos.get(id);
    const row = (nextL.rows.get(id) ?? prevL.rows.get(id))!;
    if (a && b) {
      placed.set(id, { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), o: 1, row, parent: nextL.parentOf.get(id) });
    } else if (b) {
      const pid = nextL.parentOf.get(id)!;
      const from = prevL.pos.get(pid) ?? b;
      placed.set(id, { x: lerp(from.x, b.x, t), y: lerp(from.y, b.y, t), o: t, row, parent: pid });
    } else if (a) {
      const pid = prevL.parentOf.get(id)!;
      const to = nextL.pos.get(pid) ?? a;
      placed.set(id, { x: lerp(a.x, to.x, t), y: lerp(a.y, to.y, t), o: 1 - t, row, parent: pid });
    }
  });

  const expandedNow = (id: string) => (local >= CLICK_AT ? expandedSets[stepIdx + 1] : expandedSets[stepIdx]).has(id);

  // Cursor
  const startPos =
    stepIdx === 0
      ? { x: W * 0.72, y: H * 0.86 }
      : clickTarget(STEPS[stepIdx - 1], stepIdx, cameras[stepIdx]);
  const prevStart = startPos;
  const target = clickTarget(step, stepIdx, prevCam);
  const moveT = ease(interpolate(local, [0, CLICK_AT - 2], [0, 1], { extrapolateRight: 'clamp' }));
  let cursor = { x: lerp(prevStart.x, target.x, moveT), y: lerp(prevStart.y, target.y, moveT) };
  if (local >= CLICK_AT && step.click !== 'reset') {
    const p = placed.get(step.click);
    if (p) {
      const s = toScreen(cam, p);
      cursor = { x: s.x - 40 * cam.z, y: s.y };
    }
  }
  const ripple = interpolate(local, [CLICK_AT, CLICK_AT + 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const glow = interpolate(local, [CLICK_AT - 6, CLICK_AT + 4, CLICK_AT + 40], [0, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  const captionIn = interpolate(local, [4, 20], [0, 1], { extrapolateRight: 'clamp' });
  const captionOut = lastHold ? 1 : interpolate(local, [STEP_FRAMES - 8, STEP_FRAMES], [1, 0.0], { extrapolateLeft: 'clamp' });

  // Edges
  const edges: React.ReactNode[] = [];
  placed.forEach((c, id) => {
    if (!c.parent) return;
    const p = placed.get(c.parent);
    if (!p) return;
    const sx = p.x + NODE_W / 2, sy = p.y, tx = c.x - NODE_W / 2, ty = c.y;
    const mx = (sx + tx) / 2;
    edges.push(
      <path key={id} d={`M${sx},${sy} C${mx},${sy} ${mx},${ty} ${tx},${ty}`} stroke="#3b4a63" strokeWidth={2} fill="none" opacity={Math.min(c.o, p.o)} />
    );
  });

  const dot = 30 * cam.z;
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#0a0e14', overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: 'radial-gradient(#243044 2px, transparent 2px)',
          backgroundSize: `${dot}px ${dot}px`,
          backgroundPosition: `${CENTER.x - cam.cx * cam.z}px ${CENTER.y - cam.cy * cam.z}px`,
          opacity: 0.8,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          transformOrigin: '0 0',
          transform: `translate(${CENTER.x - cam.cx * cam.z}px, ${CENTER.y - cam.cy * cam.z}px) scale(${cam.z})`,
        }}
      >
        <svg width={1} height={1} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
          {edges}
        </svg>
        {[...placed.entries()].map(([id, c]) => (
          <NodeBox key={id} row={c.row} x={c.x} y={c.y} expanded={expandedNow(id)} opacity={c.o} glow={id === step.click && !lastHold ? glow : 0} />
        ))}
      </div>

      {/* toolbar, mirrors the real "Collapse all" chip */}
      <div style={{ position: 'absolute', left: 40, top: 40, display: 'flex', alignItems: 'center', gap: 16, fontFamily: '-apple-system, "Segoe UI", sans-serif' }}>
        <div
          style={{
            padding: '12px 22px',
            borderRadius: 999,
            border: `1px solid ${step.click === 'reset' && glow > 0.2 ? '#22d3ee' : '#2a3547'}`,
            background: '#11161f',
            color: '#e2e8f0',
            fontSize: 22,
            boxShadow: step.click === 'reset' ? `0 0 ${24 * glow}px #22d3ee` : 'none',
          }}
        >
          Collapse all
        </div>
        <span style={{ fontSize: 20, color: '#8b94a3' }}>Click a folder, file or class to expand it</span>
      </div>

      {/* cursor + click ripple */}
      {!lastHold && (
        <>
          <div
            style={{
              position: 'absolute',
              left: cursor.x - 30 * ripple,
              top: cursor.y - 30 * ripple,
              width: 60 * ripple,
              height: 60 * ripple,
              borderRadius: '50%',
              border: '3px solid #22d3ee',
              opacity: ripple > 0 ? 1 - ripple : 0,
            }}
          />
          <svg width={36} height={36} viewBox="0 0 24 24" style={{ position: 'absolute', left: cursor.x - 4, top: cursor.y - 3, filter: 'drop-shadow(0 3px 6px rgba(0,0,0,0.6))' }}>
            <path d="M4 2 L4 19 L8.5 15 L11.5 22 L14 21 L11 14 L17 14 Z" fill="#fff" stroke="#0a0e14" strokeWidth={1.4} strokeLinejoin="round" />
          </svg>
        </>
      )}

      {/* caption */}
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 230, background: 'linear-gradient(180deg, rgba(10,14,20,0), rgba(10,14,20,0.94) 55%)' }} />
      <div
        style={{
          position: 'absolute',
          left: 120,
          right: 120,
          bottom: 56,
          opacity: captionIn * captionOut,
          transform: `translateY(${(1 - captionIn) * 14}px)`,
          fontFamily: '-apple-system, "Segoe UI", Roboto, sans-serif',
        }}
      >
        <div style={{ fontSize: 22, color: '#22d3ee', letterSpacing: 2, textTransform: 'uppercase', fontWeight: 600 }}>
          Step {Math.min(stepIdx + 1, STEPS.length)} of {STEPS.length}
        </div>
        <div style={{ fontSize: 50, fontWeight: 700, color: '#f1f5f9', marginTop: 6 }}>{step.title}</div>
        <div style={{ fontSize: 28, color: '#94a3b8', marginTop: 6 }}>{step.sub}</div>
      </div>
    </div>
  );
};
