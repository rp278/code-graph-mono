// The Tree view canvas as embedded in the dashboard walkthrough: same rows,
// classes and spacing as the real app, driven by a scripted cursor.
import React from 'react';
import { Easing, interpolate } from 'remotion';
import { ROOT, STEPS } from './TreeScene';
import { APP_DIMS, COLORS, Layout, Row, layoutTree } from './tree';
import { Cursor } from './AppUi';

const DIMS = APP_DIMS;
const clickSteps = STEPS.filter((s) => s.click !== 'reset');
export const TREE_CLICKS = clickSteps.length;

const sets: Set<string>[] = [new Set()];
clickSteps.forEach((s) => sets.push(new Set([...sets[sets.length - 1], s.click])));
const layouts: Layout[] = sets.map((e) => layoutTree(ROOT, e, DIMS));

type Cam = { cx: number; cy: number; z: number };

function cameraFor(state: number, w: number, h: number): Cam {
  const L = layouts[state];
  let ids: string[] = ['root'];
  if (state > 0) {
    const id = clickSteps[state - 1].click;
    const kids = L.rows.get(id)!.children.map((c) => c.id).filter((k) => L.pos.has(k));
    ids = [id, ...(L.parentOf.has(id) ? [L.parentOf.get(id)!] : []), ...kids.slice(0, 10)];
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  ids.forEach((id) => {
    const p = L.pos.get(id)!;
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  });
  const bw = maxX - minX + DIMS.w + 60;
  const bh = maxY - minY + DIMS.h + 60;
  const z = Math.max(0.55, Math.min(1.25, Math.min(w / bw, h / bh)));
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, z };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = Easing.inOut(Easing.cubic);

export const TreeCanvas: React.FC<{ frame: number; width: number; height: number; stepFrames: number }> = ({
  frame,
  width,
  height,
  stepFrames,
}) => {
  const cams = layouts.map((_, i) => cameraFor(i, width, height));
  const idx = Math.min(Math.floor(frame / stepFrames), clickSteps.length - 1);
  const local = frame - idx * stepFrames;
  const clickAt = stepFrames * 0.28;
  const moveEnd = stepFrames * 0.85;
  const prev = layouts[idx];
  const next = layouts[idx + 1];
  const t = ease(interpolate(local, [clickAt + 1, moveEnd], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
  const done = frame >= clickSteps.length * stepFrames;
  const cam: Cam = {
    cx: lerp(cams[idx].cx, cams[idx + 1].cx, t),
    cy: lerp(cams[idx].cy, cams[idx + 1].cy, t),
    z: Math.exp(lerp(Math.log(cams[idx].z), Math.log(cams[idx + 1].z), t)),
  };
  const center = { x: width / 2, y: height / 2 };
  const toScreen = (p: { x: number; y: number }, c: Cam) => ({ x: center.x + (p.x - c.cx) * c.z, y: center.y + (p.y - c.cy) * c.z });

  const placed = new Map<string, { x: number; y: number; o: number; row: Row; parent?: string }>();
  new Set([...prev.order, ...next.order]).forEach((id) => {
    const a = prev.pos.get(id);
    const b = next.pos.get(id);
    const row = (next.rows.get(id) ?? prev.rows.get(id))!;
    if (a && b) placed.set(id, { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), o: 1, row, parent: next.parentOf.get(id) });
    else if (b) {
      const pid = next.parentOf.get(id)!;
      const from = prev.pos.get(pid) ?? b;
      placed.set(id, { x: lerp(from.x, b.x, t), y: lerp(from.y, b.y, t), o: t, row, parent: pid });
    }
  });

  const clickId = clickSteps[idx].click;
  const expandedNow = (id: string) => (local >= clickAt ? sets[idx + 1] : sets[idx]).has(id);

  // cursor: from the previous click target to this one, then follows the node
  const posIn = (state: number, id: string) => {
    const p = layouts[state].pos.get(id);
    return p ? toScreen({ x: p.x - 60, y: p.y }, cams[state]) : { x: width * 0.7, y: height * 0.85 };
  };
  const from = idx === 0 ? { x: width * 0.72, y: height * 0.9 } : posIn(idx, clickSteps[idx - 1].click);
  const to = posIn(idx, clickId);
  const mv = ease(interpolate(local, [0, clickAt - 2], [0, 1], { extrapolateRight: 'clamp' }));
  let cur = { x: lerp(from.x, to.x, mv), y: lerp(from.y, to.y, mv) };
  const pl = placed.get(clickId);
  if (local >= clickAt && pl) cur = toScreen({ x: pl.x - 60, y: pl.y }, cam);
  const ripple = interpolate(local, [clickAt, clickAt + 10], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  const edges: React.ReactNode[] = [];
  placed.forEach((c, id) => {
    if (!c.parent) return;
    const p = placed.get(c.parent);
    if (!p) return;
    const sx = p.x + DIMS.w / 2, sy = p.y, tx = c.x - DIMS.w / 2, ty = c.y, mx = (sx + tx) / 2;
    edges.push(<path key={id} d={`M${sx},${sy} C${mx},${sy} ${mx},${ty} ${tx},${ty}`} stroke="#334155" strokeWidth={1.4} fill="none" opacity={Math.min(c.o, p.o)} />);
  });

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: 'radial-gradient(#1f2937 1.6px, transparent 1.6px)',
          backgroundSize: `${26 * cam.z}px ${26 * cam.z}px`,
          backgroundPosition: `${center.x - cam.cx * cam.z}px ${center.y - cam.cy * cam.z}px`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          transformOrigin: '0 0',
          transform: `translate(${center.x - cam.cx * cam.z}px, ${center.y - cam.cy * cam.z}px) scale(${cam.z})`,
        }}
      >
        <svg width={1} height={1} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>{edges}</svg>
        {[...placed.entries()].map(([id, c]) => {
          const color = c.row.kind === 'node' ? COLORS.node : COLORS[c.row.kind];
          const kids = c.row.children.length > 0;
          const glow = id === clickId && !done ? interpolate(local, [clickAt - 3, clickAt + 2, clickAt + stepFrames * 0.5], [0, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : 0;
          return (
            <div
              key={id}
              className={`tree-node tree-node-${c.row.kind}`}
              style={{
                ['--node-color' as string]: color,
                position: 'absolute',
                left: c.x - DIMS.w / 2,
                top: c.y - DIMS.h / 2,
                width: DIMS.w,
                height: DIMS.h,
                opacity: c.o,
                boxShadow: glow > 0 ? `0 0 0 ${1 + glow * 2}px ${color}, 0 0 ${18 * glow}px ${color}` : undefined,
              }}
            >
              <span className="tree-chevron">{kids ? (expandedNow(id) ? '▾' : '▸') : '•'}</span>
              <span className="tree-label">{c.row.label}</span>
              {kids && <span className="tree-count">{c.row.count}</span>}
              {!kids && c.row.loc && <span className="tree-loc">{c.row.loc}</span>}
            </div>
          );
        })}
      </div>
      <div className="tree-toolbar">
        <button className="tab-chip">Collapse all</button>
        <span className="tree-hint">Click a folder, file or class to expand it</span>
      </div>
      {!done && <Cursor x={cur.x} y={cur.y} ripple={ripple} />}
    </div>
  );
};
