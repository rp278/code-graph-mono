import React from 'react';
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS } from './tree';
import { REPO_COUNT, TOTAL_ROWS } from './TreeScene';

const FONT = '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

const Bg: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill
    style={{
      background: 'radial-gradient(1200px 700px at 50% 35%, #12203a 0%, #0a0e14 70%)',
      fontFamily: FONT,
      color: '#e2e8f0',
      alignItems: 'center',
      justifyContent: 'center',
    }}
  >
    {children}
  </AbsoluteFill>
);

export const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 14 } });
  const t1 = interpolate(frame, [18, 38], [0, 1], clamp);
  const t2 = interpolate(frame, [38, 58], [0, 1], clamp);
  return (
    <Bg>
      <Img src={staticFile('logo.svg')} style={{ width: 170, height: 170, transform: `scale(${pop})` }} />
      <div style={{ fontSize: 96, fontWeight: 800, marginTop: 30, opacity: t1, transform: `translateY(${(1 - t1) * 20}px)` }}>
        codeGraph <span style={{ color: '#22d3ee' }}>Tree view</span>
      </div>
      <div style={{ fontSize: 38, color: '#94a3b8', marginTop: 16, opacity: t2, transform: `translateY(${(1 - t2) * 20}px)` }}>
        Your whole codebase, one click at a time
      </div>
    </Bg>
  );
};

const LEVELS = [
  { name: 'Folder', example: 'controller', color: COLORS.dir },
  { name: 'File', example: 'ProductListController.java', color: COLORS.file },
  { name: 'Class / function', example: 'ProductListController', color: COLORS.node },
  { name: 'Method', example: '.getProductList()   L41', color: COLORS.node },
];

export const Concept: React.FC = () => {
  const frame = useCurrentFrame();
  const head = interpolate(frame, [0, 20], [0, 1], clamp);
  const stats = interpolate(frame, [14, 34], [0, 1], clamp);
  const count = Math.round(interpolate(frame, [14, 60], [0, TOTAL_ROWS], clamp));
  return (
    <Bg>
      <div style={{ position: 'absolute', top: 110, textAlign: 'center', opacity: head }}>
        <div style={{ fontSize: 30, color: '#22d3ee', letterSpacing: 3, textTransform: 'uppercase', fontWeight: 600 }}>The idea</div>
        <div style={{ fontSize: 68, fontWeight: 800, marginTop: 10 }}>Thousands of symbols. One hierarchy.</div>
      </div>

      <div style={{ position: 'absolute', top: 330, display: 'flex', gap: 90, opacity: stats }}>
        <Stat value={REPO_COUNT} label="repositories" />
        <Stat value={count} label="folders, files & symbols" />
      </div>

      <div style={{ position: 'absolute', top: 600, display: 'flex', alignItems: 'center', gap: 20 }}>
        {LEVELS.map((l, i) => {
          const at = 70 + i * 22;
          const p = interpolate(frame, [at, at + 16], [0, 1], clamp);
          return (
            <React.Fragment key={l.name}>
              <div
                style={{
                  width: 360,
                  padding: '22px 26px',
                  borderRadius: 14,
                  background: 'linear-gradient(180deg,#161d2a,#10151f)',
                  border: `1px solid ${l.color}`,
                  borderLeftWidth: 6,
                  opacity: p,
                  transform: `translateY(${(1 - p) * 24}px)`,
                }}
              >
                <div style={{ fontSize: 32, fontWeight: 700 }}>{l.name}</div>
                <div style={{ fontSize: 22, color: '#94a3b8', marginTop: 8, fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.example}</div>
              </div>
              {i < LEVELS.length - 1 && <div style={{ fontSize: 44, color: '#475569', opacity: p }}>›</div>}
            </React.Fragment>
          );
        })}
      </div>
      <div style={{ position: 'absolute', bottom: 110, fontSize: 34, color: '#94a3b8', opacity: interpolate(frame, [160, 176], [0, 1], clamp) }}>
        Everything starts collapsed. You open only what you need.
      </div>
    </Bg>
  );
};

const Stat: React.FC<{ value: number; label: string }> = ({ value, label }) => (
  <div style={{ textAlign: 'center' }}>
    <div style={{ fontSize: 120, fontWeight: 800, color: '#f1f5f9', fontVariantNumeric: 'tabular-nums' }}>{value.toLocaleString()}</div>
    <div style={{ fontSize: 30, color: '#8b94a3' }}>{label}</div>
  </div>
);

const FEATURES = [
  { title: 'Click to expand', body: 'Open folders, files and classes on demand', color: '#60a5fa' },
  { title: 'Live counts', body: 'Badges show how much sits inside each branch', color: '#e879f9' },
  { title: 'Source lines', body: 'Every symbol shows the line it lives on', color: '#34d399' },
  { title: 'Collapse all', body: 'Reset the whole tree in one click', color: '#22d3ee' },
];

export const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const head = interpolate(frame, [0, 18], [0, 1], clamp);
  const end = interpolate(frame, [120, 145], [0, 1], clamp);
  return (
    <Bg>
      <div style={{ position: 'absolute', top: 120, fontSize: 68, fontWeight: 800, opacity: head }}>Find your way around any repo</div>
      <div style={{ position: 'absolute', top: 340, display: 'flex', gap: 30 }}>
        {FEATURES.map((f, i) => {
          const p = spring({ frame: frame - 16 - i * 10, fps, config: { damping: 15 } });
          return (
            <div
              key={f.title}
              style={{
                width: 400,
                height: 260,
                padding: 32,
                borderRadius: 18,
                background: 'linear-gradient(180deg,#161d2a,#10151f)',
                border: `1px solid ${f.color}`,
                borderTopWidth: 6,
                boxSizing: 'border-box',
                opacity: Math.max(0, Math.min(1, p)),
                transform: `translateY(${(1 - p) * 40}px)`,
              }}
            >
              <div style={{ fontSize: 40, fontWeight: 700, color: f.color }}>{f.title}</div>
              <div style={{ fontSize: 28, color: '#94a3b8', marginTop: 16, lineHeight: 1.35 }}>{f.body}</div>
            </div>
          );
        })}
      </div>
      <div style={{ position: 'absolute', bottom: 130, display: 'flex', alignItems: 'center', gap: 22, opacity: end }}>
        <Img src={staticFile('logo.svg')} style={{ width: 84, height: 84 }} />
        <div style={{ fontSize: 52, fontWeight: 800 }}>
          codeGraph <span style={{ color: '#22d3ee' }}>Tree view</span>
        </div>
      </div>
    </Bg>
  );
};
