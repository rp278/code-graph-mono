// Building blocks that let the video reuse the dashboard's real stylesheet.
import React, { useLayoutEffect, useRef, useState } from 'react';
import { Easing, Img, interpolate, staticFile, useCurrentFrame } from 'remotion';
import '../../web/src/index.css';

export const APP_W = 1422;
export const APP_H = 741;
export const SCALE = 1920 / APP_W; // 1.35
const SUB_H = 80;

// Frame-by-frame rendering needs a deterministic page: no CSS animation or
// transitions (the spinner and landing orbs are driven from the frame instead).
const FREEZE = `
.vid-root *, .vid-root *::before, .vid-root *::after { animation: none !important; transition: none !important; }
.vid-root { font-family: var(--sans); }
.vid-root ::-webkit-scrollbar { display: none; }
`;

/** 1920x1080 canvas with the dashboard rendered at its real size, scaled up. */
export const Stage: React.FC<{ children: React.ReactNode; overlay?: React.ReactNode }> = ({ children, overlay }) => (
  <div className="vid-root" style={{ position: 'absolute', inset: 0, background: '#05080c', overflow: 'hidden' }}>
    <style>{FREEZE}</style>
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: APP_W,
        height: APP_H,
        transformOrigin: '0 0',
        transform: `scale(${SCALE})`,
        overflow: 'hidden',
      }}
    >
      {children}
    </div>
    <div style={{ position: 'absolute', left: 0, right: 0, top: APP_H * SCALE, height: SUB_H, background: '#05080c' }} />
    {overlay}
  </div>
);

export const Brand: React.FC<{ size?: 'sm' | 'lg' }> = ({ size = 'sm' }) => (
  <div className={`brand brand-${size}`}>
    <Img className="brand-mark" src={staticFile('logo.svg')} style={{ width: size === 'lg' ? 72 : 36, height: size === 'lg' ? 72 : 36 }} />
    <div className="brand-text">
      <h1>CodeGraph</h1>
      {size === 'lg' && <span className="brand-sub">knowledge graph for your codebase</span>}
    </div>
  </div>
);

export const Shell: React.FC<{ title: string; actions?: React.ReactNode; children: React.ReactNode }> = ({ title, actions, children }) => (
  <div className="app" style={{ height: '100%' }}>
    <div className="app-shell">
      <header className="shell-header">
        <Brand size="sm" />
        <div className="shell-rule" aria-hidden="true" />
        <h2 className="shell-title">{title}</h2>
        <div className="shell-actions">{actions}</div>
      </header>
      <div className="shell-body">{children}</div>
    </div>
  </div>
);

export const Spinner: React.FC<{ large?: boolean }> = ({ large }) => {
  const frame = useCurrentFrame();
  return <span className={`spinner${large ? ' large' : ''}`} style={{ transform: `rotate(${frame * 14}deg)` }} />;
};

/** Mouse pointer (used inside canvases, in app coordinates). */
export const Cursor: React.FC<{ x: number; y: number; ripple?: number; size?: number }> = ({ x, y, ripple = 0, size = 26 }) => (
  <>
    {ripple > 0 && ripple < 1 && (
      <div
        style={{
          position: 'absolute',
          left: x - 22 * ripple,
          top: y - 22 * ripple,
          width: 44 * ripple,
          height: 44 * ripple,
          borderRadius: '50%',
          border: '2px solid #22d3ee',
          opacity: 1 - ripple,
          pointerEvents: 'none',
        }}
      />
    )}
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ position: 'absolute', left: x - 3, top: y - 2, pointerEvents: 'none', filter: 'drop-shadow(0 3px 5px rgba(0,0,0,0.6))' }}>
      <path d="M4 2 L4 19 L8.5 15 L11.5 22 L14 21 L11 14 L17 14 Z" fill="#fff" stroke="#0a0e14" strokeWidth={1.4} strokeLinejoin="round" />
    </svg>
  </>
);

// ---- cursor that finds its targets in the DOM -----------------------------
export type CursorKey = { f: number; t: string | [number, number] };

const easeMove = Easing.inOut(Easing.cubic);

/**
 * Screen-space cursor. `path` lists where the pointer should be (an element
 * with data-t="name", optionally "name@fx,fy" for a spot inside it) and the
 * frame it arrives there; `clicks` are the frames of a click.
 */
export const TrackedCursor: React.FC<{ path: CursorKey[]; clicks?: number[]; travel?: number }> = ({ path, clicks = [], travel = 22 }) => {
  const frame = useCurrentFrame();
  const ref = useRef<HTMLDivElement>(null);
  const [rects, setRects] = useState<Record<string, [number, number]>>({});

  const names = [...new Set(path.filter((p) => typeof p.t === 'string').map((p) => p.t as string))];
  useLayoutEffect(() => {
    const root = ref.current?.getBoundingClientRect();
    if (!root) return;
    const scale = root.width / 1920 || 1;
    const next: Record<string, [number, number]> = {};
    for (const n of names) {
      const [name, spot] = n.split('@');
      const el = document.querySelector(`[data-t="${name}"]`);
      if (!el) continue;
      const b = el.getBoundingClientRect();
      const [fx, fy] = spot ? spot.split(',').map(Number) : [0.5, 0.5];
      next[n] = [(b.left - root.left + b.width * fx) / scale, (b.top - root.top + b.height * fy) / scale];
    }
    // Keep the last known spot of elements that are temporarily not on screen.
    const merged = { ...rects, ...next };
    if (JSON.stringify(merged) !== JSON.stringify(rects)) setRects(merged);
  });

  const resolve = (k: CursorKey): [number, number] | null => (typeof k.t === 'string' ? rects[k.t] ?? null : k.t);

  let pos: [number, number] = [960, 900];
  const first = resolve(path[0]);
  if (first) pos = first;
  for (let i = 1; i < path.length; i++) {
    const a = resolve(path[i - 1]);
    const b = resolve(path[i]);
    if (!b) continue;
    const start = Math.max(path[i - 1].f, path[i].f - travel);
    if (frame >= path[i].f) pos = b;
    else if (frame >= start && a) {
      const t = easeMove((frame - start) / (path[i].f - start));
      pos = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      break;
    } else {
      if (a) pos = a;
      break;
    }
  }

  const c = clicks.find((f) => frame >= f && frame < f + 12);
  const ripple = c === undefined ? 0 : (frame - c) / 12;
  const show = frame >= path[0].f - 10;
  return (
    <div ref={ref} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', opacity: show ? 1 : 0 }}>
      <Cursor x={pos[0]} y={pos[1]} ripple={ripple} size={34} />
    </div>
  );
};

/** Burned-in narration text under the app (also works with sound off). */
export const Subtitle: React.FC<{ text: string; from: number; dur: number }> = ({ text, from, dur }) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [from, from + 6, from + dur - 4, from + dur + 2], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  if (o <= 0) return null;
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: APP_H * SCALE,
        height: SUB_H,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 120px',
        opacity: o,
        textAlign: 'center',
        color: '#e2e8f0',
        fontFamily: '-apple-system, "Segoe UI", Roboto, sans-serif',
        fontSize: 26,
        lineHeight: 1.25,
        borderTop: '1px solid #141b26',
      }}
    >
      {text}
    </div>
  );
};

export const fade = (frame: number, len: number, inF = 10, outF = 10) =>
  interpolate(frame, [0, inF, len - outF, len], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
