import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { colorForType } from '../graphUtils';
import { renderRich } from './richText';

const SUGGESTIONS = [
  'What calls the product list endpoint?',
  'How does the storefront load and filter products?',
  'What would break if I change the products table?',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "Ask AI" workflow: codebase Q&A answered by a read-only Cursor agent that is
// handed the knowledge-graph context and can open the real files. One
// conversation == one agent, so follow-ups keep their context.
export default function AskView({ repos = [], initialRepoId = 'all', onJumpToNode }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [repoId, setRepoId] = useState(initialRepoId || 'all');
  const [conversationId, setConversationId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [liveStatus, setLiveStatus] = useState('');
  const [error, setError] = useState(null);
  const bottomRef = useRef(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, busy, liveStatus]);

  const ask = async (text) => {
    const q = (text ?? input).trim();
    if (!q || busy) return;
    setInput('');
    setError(null);
    setMessages((m) => [...m, { role: 'user', text: q }]);
    setBusy(true);
    setLiveStatus('Starting…');
    try {
      const started = await api.ask(q, repoId, conversationId);
      setConversationId(started.conversation_id);
      // Poll until the agent finishes; each poll also refreshes the live
      // "what is it doing" line.
      for (;;) {
        await sleep(1000);
        if (!aliveRef.current) return;
        const s = await api.getAsk(started.conversation_id);
        setLiveStatus(s.live_status?.text || 'Working…');
        if (s.status === 'running') continue;
        if (s.status === 'error') {
          setError(s.error || 'The agent could not answer.');
        } else {
          setMessages((m) => [
            ...m,
            { role: 'ai', text: s.answer, context: Array.isArray(s.context) ? s.context : [] },
          ]);
        }
        break;
      }
    } catch (e) {
      setError(e.message);
    } finally {
      if (aliveRef.current) {
        setBusy(false);
        setLiveStatus('');
      }
    }
  };

  const newConversation = () => {
    if (busy) return;
    setMessages([]);
    setConversationId(null);
    setError(null);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ask();
    }
  };

  return (
    <div className="chat-view">
      <div className="chat-scope ask-scope">
        <span className="muted">Asking about</span>
        <button
          type="button"
          className={`repo-chip ${repoId === 'all' ? 'active' : ''}`}
          onClick={() => setRepoId('all')}
          disabled={busy}
        >
          All repos
        </button>
        {repos.map((r) => (
          <button
            key={r.id}
            type="button"
            className={`repo-chip ${repoId === r.id ? 'active' : ''}`}
            onClick={() => setRepoId(r.id)}
            disabled={busy}
          >
            {r.name || r.id}
          </button>
        ))}
        <span className="ask-scope-spacer" />
        {messages.length > 0 && (
          <button type="button" className="link-btn" onClick={newConversation} disabled={busy}>
            New conversation
          </button>
        )}
      </div>

      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-welcome">
            <h3>Ask anything about the codebase</h3>
            <p className="muted">
              Answers come from the knowledge graph plus a read-only look at the actual code.
              The assistant can read and search files but can never change them.
            </p>
            <div className="ask-suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="repo-chip" onClick={() => ask(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="chat-msg user">
              <div className="chat-bubble user">{m.text}</div>
            </div>
          ) : (
            <div key={i} className="chat-msg ai">
              <div className="chat-bubble ai">
                <div className="md">{renderRich(m.text)}</div>
                {m.context.length > 0 && (
                  <div className="context-chips">
                    <div className="context-label">Graph context used — click to inspect:</div>
                    <div className="chip-row">
                      {m.context.map((c, j) => (
                        <button
                          key={`${c.id || j}`}
                          className="context-chip"
                          onClick={() => c.id && onJumpToNode?.(c.id)}
                          title={c.file || c.id}
                        >
                          <span className="type-dot" style={{ background: colorForType(c.type) }} />
                          {c.label || c.id}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )
        )}
        {busy && (
          <div className="chat-msg ai">
            <div className="chat-bubble ai thinking">
              <span className="spinner" /> {liveStatus || 'Working…'}
            </div>
          </div>
        )}
        {error && (
          <div className="banner error">
            {error}{' '}
            <button className="link-btn" onClick={() => setError(null)}>
              dismiss
            </button>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="chat-input-row">
        <textarea
          className="chat-input"
          rows={2}
          placeholder="Ask about the codebase…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy}
        />
        <button className="send-btn" onClick={() => ask()} disabled={!input.trim() || busy}>
          {busy ? '…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
