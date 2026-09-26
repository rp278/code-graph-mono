import { Handle, Position } from '@xyflow/react';

// Custom knowledge-graph node: colored type badge + label.
export default function KgNode({ data }) {
  const { label, nodeType, color } = data;
  return (
    <div className="kg-node" style={{ '--node-color': color }}>
      <Handle type="target" position={Position.Left} className="kg-handle" />
      <div className="kg-node-type" style={{ color, background: `${color}1f` }}>
        {nodeType}
      </div>
      <div className="kg-node-label" title={label}>
        {label}
      </div>
      <Handle type="source" position={Position.Right} className="kg-handle" />
    </div>
  );
}
