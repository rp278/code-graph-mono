// Tiny markdown-ish renderer: code fences, inline code, **bold**, bullets, headings.

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

export function renderRich(text) {
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
