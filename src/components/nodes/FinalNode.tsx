import { Handle, Position, type NodeProps } from '@xyflow/react';

import { NODE_DIMENSIONS } from '../../lib/layout';
import type { NodeState } from '../../state/nodeMachine';
import { Button } from '../primitives/Button';
import { NodeContainer } from '../primitives/NodeContainer';
import { StatusDot } from '../primitives/StatusDot';

export type FinalNodeData = {
  state: NodeState;
  label: string;
  files: readonly string[];
};

export function FinalNode({ data }: NodeProps) {
  const d = data as unknown as FinalNodeData;
  const { width, height } = NODE_DIMENSIONS.final;
  const activated = d.state === 'done' || d.state === 'running';
  const dotColor = activated ? 'var(--color-status-success)' : 'var(--color-fg-tertiary)';

  return (
    <NodeContainer
      variant="final"
      state={d.state}
      agentColor="var(--color-agent-master)"
      width={width}
      height={height}
    >
      <Handle type="target" position={Position.Top} className="!border-0 !bg-transparent" />
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <StatusDot color={dotColor} />
          <span className="text-hint uppercase tracking-wide text-fg-secondary">{d.label}</span>
        </div>
        <span className="text-hint text-fg-tertiary">
          {d.files.length} file{d.files.length === 1 ? '' : 's'}
        </span>
      </header>
      <ul className="flex flex-col gap-0.5 text-meta text-fg-secondary">
        {d.files.slice(0, 3).map((f) => (
          <li key={f} className="truncate" title={f}>
            {f}
          </li>
        ))}
        {d.files.length > 3 ? (
          <li className="text-fg-tertiary">+{d.files.length - 3} more</li>
        ) : null}
      </ul>
      <footer className="mt-auto flex items-center justify-end gap-2">
        <Button variant="ghost" disabled={!activated}>
          Discard all
        </Button>
        <Button variant="primary" disabled={!activated}>
          Apply to branch
        </Button>
      </footer>
      <Handle type="source" position={Position.Bottom} className="!border-0 !bg-transparent" />
    </NodeContainer>
  );
}
