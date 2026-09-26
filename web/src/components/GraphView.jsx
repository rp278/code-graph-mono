import { ReactFlow, Background, Controls, MiniMap } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import KgNode from './KgNode';

const nodeTypes = { kgNode: KgNode };

export default function GraphView({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onNodeClick,
  onInit,
  isEmpty,
  onRebuild,
  rebuildWorking,
}) {
  if (isEmpty) {
    return (
      <div className="empty-state">
        <div className="empty-icon" aria-hidden="true">
          ◇
        </div>
        <h2>No graph data yet</h2>
        <p>
          The knowledge graph hasn&apos;t been built for this repo.
          <br />
          Hit rebuild to scan the codebase and generate nodes and edges.
        </p>
        <button className="rebuild-btn" onClick={onRebuild} disabled={rebuildWorking}>
          {rebuildWorking ? 'Rebuilding…' : 'Build the graph'}
        </button>
      </div>
    );
  }

  return (
    <div className="graph-wrap">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, node) => onNodeClick(node.id)}
        onInit={onInit}
        nodeTypes={nodeTypes}
        colorMode="dark"
        fitView
        minZoom={0.08}
        maxZoom={2.5}
      >
        <Background variant="dots" gap={26} size={1.6} />
        <Controls position="bottom-right" />
        <MiniMap
          position="bottom-left"
          pannable
          zoomable
          nodeColor={(n) => n.data?.color || '#64748b'}
          maskColor="rgba(10, 14, 20, 0.75)"
        />
      </ReactFlow>
    </div>
  );
}
