import { BaseEdge, EdgeLabelRenderer } from '@xyflow/react';

// Smooth curve through the waypoints dagre computed for this edge, so it
// routes around other repos instead of cutting straight across them.
function pathThrough(pts) {
  if (pts.length < 2) return '';
  if (pts.length === 2) return `M ${pts[0].x} ${pts[0].y} L ${pts[1].x} ${pts[1].y}`;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const last = i === pts.length - 2;
    const to = last
      ? pts[i + 1]
      : { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 };
    d += ` Q ${pts[i].x} ${pts[i].y} ${to.x} ${to.y}`;
  }
  return d;
}

/** Edge between two repositories with a stacked "relation ×count" label. */
export default function RepoLinkEdge({ id, data, markerEnd, style }) {
  const pts = data?.points || [];
  const mid = pts.length
    ? pts.length % 2
      ? pts[(pts.length - 1) / 2]
      : {
          x: (pts[pts.length / 2 - 1].x + pts[pts.length / 2].x) / 2,
          y: (pts[pts.length / 2 - 1].y + pts[pts.length / 2].y) / 2,
        }
    : { x: 0, y: 0 };

  return (
    <>
      <BaseEdge id={id} path={pathThrough(pts)} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        <div
          className="repo-link-label"
          style={{ transform: `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px)` }}
        >
          {(data?.lines || []).map((l) => (
            <div className="repo-link-line" key={`${l.reverse ? 'r' : 'f'}:${l.relation}`}>
              <span className="repo-link-dot" style={{ background: l.color }} />
              <span>
                {l.reverse ? '← ' : ''}
                {l.label}
              </span>
              <b>×{l.count}</b>
            </div>
          ))}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
