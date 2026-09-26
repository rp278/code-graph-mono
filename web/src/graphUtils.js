import dagre from 'dagre';

// Color palette per knowledge-graph node type.
export const TYPE_COLORS = {
  endpoint: '#f472b6', // pink   - API route
  component: '#60a5fa', // blue   - React component
  page: '#a78bfa', // violet - routed page
  function: '#34d399', // green  - function
  class: '#fbbf24', // amber  - class
  file: '#94a3b8', // slate  - source file
  table: '#fb923c', // orange - DB table
  repo: '#e879f9', // fuchsia- repository root
};

export const DEFAULT_TYPE_COLOR = '#c084fc';

export const colorForType = (t) => TYPE_COLORS[t] || DEFAULT_TYPE_COLOR;

export const TYPE_DESCRIPTIONS = {
  endpoint: 'API route exposed by the backend',
  component: 'React component',
  page: 'Routed page view',
  function: 'Function or method',
  class: 'Class definition',
  file: 'Source file',
  table: 'Database table',
  repo: 'Repository root',
};

const NODE_W = 210;
const NODE_H = 70;

/**
 * Compute left-to-right dagre positions for a set of API nodes.
 * Returns a map of node id -> {x, y} (top-left corner).
 */
export function layoutNodes(apiNodes) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 55, ranksep: 150, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));
  apiNodes.forEach((n) => g.setNode(n.id, { width: NODE_W, height: NODE_H }));
  dagre.layout(g);
  const positions = {};
  apiNodes.forEach((n) => {
    const p = g.node(n.id);
    positions[n.id] = { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 };
  });
  return positions;
}

export function toFlowNode(apiNode, position) {
  const color = colorForType(apiNode.type);
  return {
    id: apiNode.id,
    type: 'kgNode',
    position: position || { x: 0, y: 0 },
    data: {
      label: apiNode.label || apiNode.id,
      nodeType: apiNode.type || 'unknown',
      file: apiNode.file || '',
      repo: apiNode.repo || '',
      color,
    },
  };
}

/**
 * Convert an API edge to a React Flow edge.
 * INFERRED edges render dashed, AMBIGUOUS render dotted + dimmed.
 */
export function toFlowEdge(apiEdge) {
  const conf = apiEdge.confidence || 'EXTRACTED';
  return {
    id: apiEdge.id,
    source: apiEdge.source,
    target: apiEdge.target,
    label: apiEdge.relation,
    animated: apiEdge.relation === 'fetches' || apiEdge.relation === 'calls',
    style: {
      strokeWidth: 1.6,
      stroke: conf === 'AMBIGUOUS' ? '#64748b' : '#38bdf8',
      strokeDasharray: conf === 'INFERRED' ? '7 5' : conf === 'AMBIGUOUS' ? '2 5' : undefined,
      opacity: conf === 'AMBIGUOUS' ? 0.5 : 0.9,
    },
    labelStyle: { fill: '#94a3b8', fontSize: 10, fontWeight: 600 },
    labelBgStyle: { fill: '#0d1420', fillOpacity: 0.9 },
    labelBgPadding: [3, 5],
    labelBgBorderRadius: 4,
    data: { relation: apiEdge.relation, confidence: conf },
  };
}

/**
 * Build a neighbor list for the details panel:
 * [{ id, label, type, relation, direction: 'out' | 'in', confidence }]
 */
export function neighborsOf(nodeId, apiNodes, apiEdges) {
  const byId = new Map(apiNodes.map((n) => [n.id, n]));
  const out = [];
  for (const e of apiEdges || []) {
    if (e.source === nodeId && byId.has(e.target)) {
      const n = byId.get(e.target);
      out.push({ id: n.id, label: n.label || n.id, type: n.type, relation: e.relation, direction: 'out', confidence: e.confidence });
    } else if (e.target === nodeId && byId.has(e.source)) {
      const n = byId.get(e.source);
      out.push({ id: n.id, label: n.label || n.id, type: n.type, relation: e.relation, direction: 'in', confidence: e.confidence });
    }
  }
  return out;
}
