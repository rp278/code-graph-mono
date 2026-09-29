import React, { useLayoutEffect, useRef } from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import ask from '../data/ask.json';
import graph from '../data/graph.json';
import { colorForType } from '../../web/src/graphUtils.js';
import { renderRich } from '../../web/src/components/richText.jsx';
import { Shell, Spinner, Stage, TrackedCursor, CursorKey } from './AppUi';

type Beats = Record<string, { rel: number; dur: number }>;
const clampX = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

const REPO = 'tb-discovery-mfe';
const repos = (graph.repos as { id: string; name: string }[]).map((r) => ({ id: r.id, name: r.name }));
const SUGGESTIONS = ['How does the catalog app handle internationalization?', 'Which xapi endpoints does this app call?'];

// Live status lines, taken from the real run (paths shortened).
const STATUSES = ['Starting…', 'Finished `glob`', 'Finished `grep` — tb-discovery-mfe', 'Finished `read` — app/[locale]/layout.tsx'];

// The real answer, split into blocks that appear one after another.
const BLOCKS: string[] = (ask.answer as string)
  .split(/(```[\s\S]*?```)/g)
  .flatMap((part) => (part.startsWith('```') ? [part] : part.split('\n').filter((l) => l.trim() !== '')));

// Real graph-context chips; prefer ones that relate to the question.
const ctxAll = (ask.context as any[]) || [];
const related = ctxAll.filter((c) => /globalscripts|layout/i.test(`${c.label} ${c.file}`));
const CTX = (related.length >= 3 ? related : ctxAll).slice(0, 6);

export const AskScreen: React.FC<{ beats: Beats }> = ({ beats }) => {
  const f = useCurrentFrame();
  const a1 = beats.a1.rel, a2 = beats.a2.rel, a3 = beats.a3.rel, a4 = beats.a4.rel;

  const tChip = a1 + 14;
  const tInput = a1 + 44;
  const tTypeStart = tInput + 8;
  const q = ask.question as string;
  const cps = 1.5; // frames per character
  const typed = Math.max(0, Math.min(q.length, Math.floor((f - tTypeStart) / cps)));
  const tSend = tTypeStart + Math.ceil(q.length * cps) + 14;
  const sent = f >= tSend + 2;

  const statusStep = Math.max(0, Math.min(STATUSES.length - 1, Math.floor((f - (tSend + 6)) / ((a3 - tSend - 6) / STATUSES.length))));
  const answering = f >= a3 + 6;
  const revealed = answering ? Math.min(BLOCKS.length, Math.floor((f - (a3 + 6)) / 8) + 1) : 0;
  const showCtx = f >= a3 + 6 + BLOCKS.length * 8 + 6 || f >= a4;
  const ctxIn = interpolate(f, [a4 - 6, a4 + 8], [0, 1], clampX);
  const busy = sent && !answering;

  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  const path: CursorKey[] = [
    { f: tChip, t: `chip:${REPO}` },
    { f: tInput, t: 'input@0.3,0.5' },
    { f: tSend, t: 'send' },
    { f: a3 + 30, t: [1500, 700] },
    { f: a4 + 30, t: 'ctx0' },
  ];

  const annot = interpolate(f, [a2 + 4, a2 + 20, a3 - 10, a3 + 4], [0, 1, 1, 0], clampX);
  const overlay = (
    <>
      <TrackedCursor path={path} clicks={[tChip, tInput, tSend, a4 + 40]} />
      <div
        style={{
          position: 'absolute',
          left: 300,
          top: 620,
          opacity: annot,
          transform: `translateY(${(1 - annot) * 10}px)`,
          padding: '14px 22px',
          borderRadius: 14,
          background: 'rgba(13,20,32,0.96)',
          border: '1px solid #22d3ee',
          boxShadow: '0 0 30px rgba(34,211,238,0.25)',
          color: '#e2e8f0',
          fontFamily: '-apple-system, "Segoe UI", sans-serif',
          fontSize: 24,
        }}
      >
        <span style={{ color: '#22d3ee', fontWeight: 700 }}>Read-only agent</span> · tools: <code>read</code> <code>grep</code> <code>glob</code> <code>ls</code> · no edit, no shell
      </div>
    </>
  );

  return (
    <Stage overlay={overlay}>
      <Shell title="Ask AI">
        <div className="chat-view">
          <div className="chat-scope ask-scope">
            <span className="muted">Asking about</span>
            <button className="repo-chip">All repos</button>
            {repos.map((r) => (
              <button key={r.id} data-t={`chip:${r.id}`} className={`repo-chip ${(f >= tChip ? REPO : 'all') === r.id ? 'active' : ''}`}>
                {r.name}
              </button>
            ))}
            <span className="ask-scope-spacer" />
          </div>

          <div className="chat-messages" ref={box}>
            {!sent && (
              <div className="chat-welcome">
                <h3>Ask anything about the codebase</h3>
                <p className="muted">
                  Answers come from the knowledge graph plus a read-only look at the actual code.
                  The assistant can read and search files but can never change them.
                </p>
                <div className="ask-suggestions">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} className="repo-chip">{s}</button>
                  ))}
                </div>
              </div>
            )}
            {sent && (
              <div className="chat-msg user">
                <div className="chat-bubble user">{q}</div>
              </div>
            )}
            {busy && (
              <div className="chat-msg ai">
                <div className="chat-bubble ai thinking">
                  <Spinner /> {STATUSES[statusStep]}
                </div>
              </div>
            )}
            {answering && (
              <div className="chat-msg ai">
                <div className="chat-bubble ai">
                  <div className="md">
                    {BLOCKS.slice(0, revealed).map((b, i) => (
                      <div key={i}>{renderRich(b)}</div>
                    ))}
                  </div>
                  {showCtx && (
                    <div className="context-chips" style={{ opacity: ctxIn }}>
                      <div className="context-label">Graph context used — click to inspect:</div>
                      <div className="chip-row">
                        {CTX.map((c, j) => (
                          <button key={c.id} data-t={j === 0 ? 'ctx0' : undefined} className="context-chip">
                            <span className="type-dot" style={{ background: colorForType(c.type) }} />
                            {c.label || c.id}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="chat-input-row">
            <div data-t="input" style={{ flex: 1, display: 'flex' }}>
              <textarea className="chat-input" rows={2} readOnly placeholder="Ask about the codebase…" value={sent ? '' : q.slice(0, typed)} style={{ flex: 1 }} />
            </div>
            <button data-t="send" className="send-btn" disabled={!q.slice(0, typed).trim() || sent}>
              {busy ? '…' : 'Send'}
            </button>
          </div>
        </div>
      </Shell>
    </Stage>
  );
};
