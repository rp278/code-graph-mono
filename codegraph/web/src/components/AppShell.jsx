import Brand from './Brand';

export default function AppShell({ title, onHome, children, actions }) {
  return (
    <div className="app-shell">
      <header className="shell-header">
        <Brand size="sm" subtitle={false} onClick={onHome} />
        <div className="shell-rule" aria-hidden="true" />
        <h2 className="shell-title">{title}</h2>
        <div className="shell-actions">{actions}</div>
      </header>
      <div className="shell-body">{children}</div>
    </div>
  );
}
