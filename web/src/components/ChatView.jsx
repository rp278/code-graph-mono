import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { colorForType } from '../graphUtils';

// --- tiny markdown-ish renderer: code fences, inline code, **bold**, bullets, headings ---
function inline(text) {
  const tokens = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return tokens.map((t, i) => {
    if (t.length > 4 && t.startsWith('**') && t.endsWith('**')) {
      return <strong key={i}>{t.slice(2, -2)}</strong>;
    }
    if (t.length > 2 && t.startsWith('`') && t.endsWith('`')) {
      return (
        <code key={i} className="md-inline-code">
          {t.slice(1, -1)}
        </code>
      );
    }
    return <span key={i}>{t}</span>;
  });
}

function renderLine(line, key) {
  const trimmed = line.trim();
  if (/^#{1,4}\s/.test(trimmed)) {
    return <h4 key={key} className="md-h">{inline(trimmed.replace(/^#{1,4}\s/, ''))}</h4>;
  }
  if (/^[-*]\s+/.test(trimmed)) {
    return (
      <div key={key} className="md-bullet">
        <span className="md-bullet-mark">•</span>
        <span>{inline(trimmed.replace(/^[-*]\s+/, ''))}</span>
      </div>
    );
  }
  if (/^\d+[.)]\s+/.test(trimmed)) {
    return (
      <div key={key} className="md-bullet">
        <span className="md-bullet-mark">{trimmed.match(/^\d+[.)]/)[0]}</span>
        <span>{inline(trimmed.replace(/^\d+[.)]\s+/, ''))}</span>
      </div>
    );
  }
  if (trimmed === '') return <div key={key} className="md-gap" />;
  return <p key={key} className="md-p">{inline(line)}</p>;
}

function renderRich(text) {
  const parts = String(text || '').split(/(```[\s\S]*?```)/g);
  return parts.map((part, i) => {
    if (part.startsWith('```')) {
      const code = part.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '');
      return (
        <pre key={i} className="md-code">
          <code>{code}</code>
        </pre>
      );
    }
    return <div key={i}>{part.split('\n').map((line, j) => renderLine(line, `${i}-${j}`))}</div>;
  });
}

export default function ChatView({ repoId, repos, onJumpToNode }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, sending]);

  const send = async () => {
    const q = input.trim();
    if (!q || sending || !repoId) return;
    setInput('');
    setError(null);
    setMessages((m) => [...m, { role: 'user', text: q }]);
    setSending(true);
    try {
      const r = await api.chat(q, repoId);
      setMessages((m) => [
        ...m,
        {
          role: 'ai',
          text: r.answer || r.message || 'No response from the agent.',
          context: Array.isArray(r.context) ? r.context : [],
          grounded: !r.answer,
        },
      ]);
    } catch (e) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="chat-view">
      <div className="chat-scope">
        <span className="muted">Asking about</span>
        <strong>
          {repoId === 'all'
            ? 'All repos'
            : repos.find((r) => r.id === repoId)?.name || repoId || '—'}
        </strong>
      </div>

      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-welcome">
            <h3>Ask anything about the codebase</h3>
            <p className="muted">
              Try “What calls the product list endpoint?” or “What breaks if I change the
              products table?” Answers are grounded in the knowledge graph.
            </p>
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
                {m.grounded && (
                  <div className="grounded-note">
                    AI answers are offline — showing graph context instead.
                  </div>
                )}
                <div className="md">{renderRich(m.text)}</div>
                {m.context.length > 0 && (
                  <div className="context-chips">
                    <div className="context-label">Graph context — click to inspect:</div>
                    <div className="chip-row">
                      {m.context.map((c, j) => (
                        <button
                          key={`${c.id || j}`}
                          className="context-chip"
                          onClick={() => c.id && onJumpToNode(c.id)}
                          title={c.file || c.id}
                        >
                          <span
                            className="type-dot"
                            style={{ background: colorForType(c.type) }}
                          />
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
        {sending && (
          <div className="chat-msg ai">
            <div className="chat-bubble ai thinking">
              <span className="spinner" /> Consulting the graph…
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
          placeholder={repoId ? 'Ask about the codebase…' : 'Select a repo first…'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={!repoId || sending}
        />
        <button
          className="send-btn"
          onClick={send}
          disabled={!input.trim() || sending || !repoId}
        >
          {sending ? '…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
