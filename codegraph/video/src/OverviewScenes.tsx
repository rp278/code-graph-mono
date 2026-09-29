import React from 'react';
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { Brand, Stage, TrackedCursor, CursorKey } from './AppUi';
import graph from '../data/graph.json';

type Beats = Record<string, { rel: number; dur: number }>;
const clampX = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

const OPTIONS = [
  { id: 'graph', title: 'View Graph', blurb: 'Explore how your repos, files, and APIs actually connect.' },
  { id: 'ask', title: 'Ask AI', blurb: 'Ask anything about the code. Answers come from the graph and the real files.' },
  { id: 'bugs', title: 'Fix Bugs', blurb: 'Describe what broke. The pipeline traces it, patches it, and verifies.' },
];

/** The dashboard's real landing page, with the three workflows lit up in turn. */
export const IntroScene: React.FC<{ beats: Beats }> = ({ beats }) => {
  const f = useCurrentFrame();
  const { i1, i2 } = beats;
  const lit = [i1.rel + Math.round(i1.dur * 0.6), i1.rel + Math.round(i1.dur * 0.78), i1.rel + Math.round(i1.dur * 0.92)];
  const clickAt = i2.rel + i2.dur - 8;
  const path: CursorKey[] = [
    { f: lit[0], t: 'opt:graph@0.7,0.5' },
    { f: lit[1], t: 'opt:ask@0.7,0.5' },
    { f: lit[2], t: 'opt:bugs@0.7,0.5' },
    { f: clickAt, t: 'opt:graph@0.7,0.5' },
  ];
  const active = f >= clickAt ? 0 : lit.filter((t) => f >= t - 8).length - 1;
  const rise = (i: number) => interpolate(f, [6 + i * 6, 22 + i * 6], [0, 1], clampX);
  return (
    <Stage overlay={<TrackedCursor path={path} clicks={[clickAt]} travel={26} />}>
      <div className="app app-landing" style={{ height: '100%' }}>
        <div className="landing">
          <div className="landing-bg" aria-hidden="true">
            <div className="landing-orb landing-orb-a" />
            <div className="landing-orb landing-orb-b" />
            <div className="landing-orb landing-orb-c" />
            <div className="landing-grid" />
          </div>
          <div className="landing-frame">
            <div className="landing-left" style={{ opacity: rise(0) }}>
              <Brand size="lg" />
              <p className="landing-lede">
                One workspace for seeing the system, shipping features, and closing bugs — grounded in the live knowledge graph.
              </p>
            </div>
            <div className="landing-rule" aria-hidden="true" />
            <nav className="landing-right">
              {OPTIONS.map((o, i) => (
                <button
                  key={o.id}
                  data-t={`opt:${o.id}`}
                  className="landing-option"
                  style={{
                    opacity: rise(i + 1),
                    transform: `translateX(${(1 - rise(i + 1)) * 30 + (active === i ? 6 : 0)}px)`,
                    borderColor: active === i ? 'rgba(139, 92, 246, 0.7)' : undefined,
                    boxShadow: active === i ? '0 12px 40px rgba(0,0,0,0.35), 0 0 0 1px rgba(139,92,246,0.25)' : undefined,
                  }}
                >
                  <span className="landing-option-body">
                    <span className="landing-option-title">{o.title}</span>
                    <span className="landing-option-blurb">{o.blurb}</span>
                  </span>
                  <span className="landing-option-arrow" style={{ color: active === i ? '#22d3ee' : undefined }}>→</span>
                </button>
              ))}
            </nav>
          </div>
        </div>
      </div>
    </Stage>
  );
};

const TILES = [
  { title: 'View Graph', line: 'See how repos, files and APIs connect', color: '#a78bfa', foot: `${graph.repos.length} repos · ${graph.stats.nodes.toLocaleString()} nodes` },
  { title: 'Ask AI', line: 'Plain-English answers with real files and lines', color: '#22d3ee', foot: 'read-only agent' },
  { title: 'Fix Bugs', line: 'Test-proven fixes through five approval gates', color: '#34d399', foot: 'human approves every change' },
];

export const OutroScene: React.FC<{ beats: Beats }> = ({ beats }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const o1 = beats.o1;
  const tag = interpolate(f, [o1.rel + 20, o1.rel + 44], [0, 1], clampX);
  const end = interpolate(f, [o1.rel + o1.dur - 20, o1.rel + o1.dur + 10], [0, 1], clampX);
  return (
    <AbsoluteFill style={{ background: 'radial-gradient(1200px 700px at 50% 30%, #12203a 0%, #0a0e14 70%)', color: '#e2e8f0', fontFamily: '-apple-system, "Segoe UI", Roboto, sans-serif', alignItems: 'center' }}>
      <div style={{ marginTop: 110, display: 'flex', alignItems: 'center', gap: 22, opacity: interpolate(f, [0, 16], [0, 1], clampX) }}>
        <Img src={staticFile('logo.svg')} style={{ width: 96, height: 96 }} />
        <div style={{ fontSize: 76, fontWeight: 800 }}>CodeGraph</div>
      </div>
      <div style={{ display: 'flex', gap: 34, marginTop: 90 }}>
        {TILES.map((t, i) => {
          const p = spring({ frame: f - 14 - i * 10, fps, config: { damping: 15 } });
          return (
            <div key={t.title} style={{ width: 520, height: 290, padding: 36, borderRadius: 20, boxSizing: 'border-box', background: 'linear-gradient(180deg,#161d2a,#10151f)', border: `1px solid ${t.color}`, borderTopWidth: 6, opacity: Math.max(0, Math.min(1, p)), transform: `translateY(${(1 - p) * 44}px)` }}>
              <div style={{ fontSize: 50, fontWeight: 800, color: t.color }}>{t.title}</div>
              <div style={{ fontSize: 30, color: '#cbd5e1', marginTop: 16, lineHeight: 1.3 }}>{t.line}</div>
              <div style={{ fontSize: 24, color: '#8b94a3', marginTop: 22 }}>{t.foot}</div>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 80, fontSize: 46, fontWeight: 700, opacity: tag, transform: `translateY(${(1 - tag) * 14}px)`, textAlign: 'center' }}>
        The graph is the map. <span style={{ color: '#22d3ee' }}>The code is the truth.</span> A human approves every change.
      </div>
      <AbsoluteFill style={{ background: '#05080c', opacity: 0 * end }} />
    </AbsoluteFill>
  );
};
