import { Handle, Position, type NodeProps } from '@xyflow/react';

import { NODE_DIMENSIONS, type LayoutNodeKind } from '../../../lib/layout';

/**
 * Step 5 placeholder — empty shell with correct dimensions so Dagre positions
 * are visually verifiable. Step 6 replaces this with MasterNode / WorkerNode /
 * FinalNode content.
 */
export type PlaceholderNodeData = {
  kind: LayoutNodeKind;
  label?: string;
};

export function PlaceholderNode({ data }: NodeProps) {
  const d = data as PlaceholderNodeData;
  const { width, height } = NODE_DIMENSIONS[d.kind];
  return (
    <div
      className="flex items-center justify-center rounded-md border border-border-subtle bg-bg-elevated text-fg-tertiary"
      style={{ width, height }}
    >
      <Handle type="target" position={Position.Top} className="!bg-border-default !border-0" />
      <span className="text-meta">{d.label ?? d.kind}</span>
      <Handle type="source" position={Position.Bottom} className="!bg-border-default !border-0" />
    </div>
  );
}
