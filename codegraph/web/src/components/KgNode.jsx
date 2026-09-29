import { Handle, Position } from '@xyflow/react';

// Explorer node: label on top, "kind · repo · line" underneath.
// The focus node (center of the canvas) is drawn larger.
export default function KgNode({ data }) {
  const { label, kind, color, repo, loc, isCenter, foreignRepo, hint } = data;
  return (
    <div
      className={`kg-node${isCenter ? ' kg-node-center' : ''}`}
      style={{ '--node-color': color }}
      title={`${label}${repo ? `\n${repo}` : ''}${hint ? `\n${hint}` : ''}`}
    >
      <Handle type="target" position={Position.Left} className="kg-handle" />
      <div className="kg-node-label">{label}</div>
      <div className="kg-node-meta">
        <span className="kg-node-kind" style={{ color }}>
          {kind}
        </span>
        {repo && <span className={foreignRepo ? 'kg-node-repo foreign' : 'kg-node-repo'}>{repo}</span>}
        {loc && <span className="kg-node-loc">{loc}</span>}
      </div>
      <Handle type="source" position={Position.Right} className="kg-handle" />
    </div>
  );
}
