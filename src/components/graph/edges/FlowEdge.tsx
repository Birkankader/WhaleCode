import { BaseEdge, getStraightPath, type EdgeProps } from '@xyflow/react';

export type FlowEdgeData = {
  /** True when the downstream node is in a running/retrying state. */
  animated?: boolean;
};

export function FlowEdge({ sourceX, sourceY, targetX, targetY, data, markerEnd }: EdgeProps) {
  const [edgePath] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  const d = data as FlowEdgeData | undefined;
  const animated = d?.animated ?? false;

  return (
    <BaseEdge
      path={edgePath}
      markerEnd={markerEnd}
      style={{
        stroke: 'var(--color-border-default)',
        strokeWidth: 1,
        strokeDasharray: animated ? '4 4' : undefined,
        animation: animated ? 'flow-edge-dash 1.2s linear infinite' : undefined,
      }}
    />
  );
}
