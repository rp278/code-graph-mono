import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, Controls, MiniMap, Handle, Position } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api } from '../api';
import { buildTree, defaultExpanded, layoutTree, TREE_NODE_W, TREE_NODE_H } from '../treeUtils';

// One row of the tree: chevron + name + (descendant count | source line).
function TreeNode({ data }) {
  const { label, kind, loc, count, childCount, expanded, color, file } = data;
  const hasKids = childCount > 0;
  return (
    <div
      className={`tree-node tree-node-${kind}`}
      style={{ '--node-color': color, width: TREE_NODE_W, height: TREE_NODE_H }}
      title={file || label}
    >
      <Handle type="target" position={Position.Left} className="kg-handle" />
      <span className="tree-chevron">{hasKids ? (expanded ? '▾' : '▸') : '•'}</span>
      <span className="tree-label">{label}</span>
      {hasKids && <span className="tree-count">{count}</span>}
      {!hasKids && loc && <span className="tree-loc">{loc}</span>}
      <Handle type="source" position={Position.Right} className="kg-handle" />
    </div>
  );
}

const nodeTypes = { treeNode: TreeNode };

/**
 * Collapsible folder -> file -> class/function -> method tree.
 * Everything starts collapsed; click a row to expand or collapse it.
 */
export default function TreeView({ repoId, reloadToken }) {
  const [root, setRoot] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const rfRef = useRef(null);
  const focusRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getTree(repoId)
      .then((data) => {
        if (cancelled) return;
        const tree = buildTree(data.nodes || [], data.edges || [], repoId);
        setRoot(tree);
        setExpanded(defaultExpanded(tree));
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [repoId, reloadToken]);

  const { nodes, edges } = useMemo(() => layoutTree(root, expanded), [root, expanded]);

  // After an expand/collapse, keep the clicked row in view.
  useEffect(() => {
    const id = focusRef.current;
    if (!id || !rfRef.current) return;
    const n = nodes.find((x) => x.id === id);
    if (n) {
      rfRef.current.setCenter(n.position.x + TREE_NODE_W / 2, n.position.y + TREE_NODE_H / 2, {
        zoom: rfRef.current.getZoom(),
        duration: 250,
      });
    }
    focusRef.current = null;
  }, [nodes]);

  const onNodeClick = useCallback((_, node) => {
    if (!node.data.childCount) return;
    focusRef.current = node.id;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      return next;
    });
  }, []);

  if (loading) {
    return (
      <div className="veil">
        <span className="spinner large" />
        <span>Loading tree…</span>
      </div>
    );
  }
  if (error) {
    return (
      <div className="empty-state">
        <h2>Couldn&apos;t load the tree</h2>
        <p className="muted">{error}</p>
      </div>
    );
  }
  if (!root || root.count === 0) {
    return (
      <div className="empty-state">
        <div className="empty-icon" aria-hidden="true">
          ◇
        </div>
        <h2>No graph data yet</h2>
        <p>Build the graph first, then the tree will appear here.</p>
      </div>
    );
  }

  return (
    <div className="graph-wrap">
      <ReactFlow
        key={`${repoId}:${reloadToken}`}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onInit={(inst) => {
          rfRef.current = inst;
        }}
        nodesDraggable={false}
        nodesConnectable={false}
        colorMode="dark"
        fitView
        minZoom={0.05}
        maxZoom={2}
      >
        <Background variant="dots" gap={26} size={1.6} />
        <Controls position="bottom-right" showInteractive={false} />
        <MiniMap
          position="bottom-left"
          pannable
          zoomable
          nodeColor={(n) => n.data?.color || '#64748b'}
          maskColor="rgba(10, 14, 20, 0.75)"
        />
      </ReactFlow>
      <div className="tree-toolbar">
        <button className="tab-chip" onClick={() => setExpanded(defaultExpanded(root))}>
          Collapse all
        </button>
        <span className="tree-hint">Click a folder, file or class to expand it</span>
      </div>
    </div>
  );
}
