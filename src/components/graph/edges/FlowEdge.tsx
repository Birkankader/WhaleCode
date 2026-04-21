import { BaseEdge, getStraightPath, type EdgeProps } from '@xyflow/react';

export type FlowEdgeData = {
  /** True when the downstream node is in a running/retrying state. */
  animated?: boolean;
  /**
   * True when one of this edge's endpoints is a proposed subtask the
   * user has unticked. Pairs with the node-level dim in `NodeContainer`
   * so the graph reads as a single focus group rather than a grid with
   * half-faded nodes floating on full-strength connectors. 100ms fade
   * matches the checkbox tick response.
   */
  dimmed?: boolean;
};

export function FlowEdge({ sourceX, sourceY, targetX, targetY, data, markerEnd }: EdgeProps) {
  const [edgePath] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  const d = data as FlowEdgeData | undefined;
  const animated = d?.animated ?? false;
  const dimmed = d?.dimmed ?? false;

  return (
    <BaseEdge
      path={edgePath}
      markerEnd={markerEnd}
      style={{
        stroke: 'var(--color-border-default)',
        strokeWidth: 1,
        strokeDasharray: animated ? '4 4' : undefined,
        animation: animated ? 'flow-edge-dash 1.2s linear infinite' : undefined,
        opacity: dimmed ? 0.5 : 1,
        transition: 'opacity 100ms ease-out',
      }}
    />
  );
}
