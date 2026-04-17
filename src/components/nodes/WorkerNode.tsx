import { Handle, Position, type NodeProps } from '@xyflow/react';

import { NODE_DIMENSIONS } from '../../lib/layout';
import { useGraphStore, type AgentKind } from '../../state/graphStore';
import type { NodeState } from '../../state/nodeMachine';
import { Chip } from '../primitives/Chip';
import { NodeContainer } from '../primitives/NodeContainer';
import { StatusDot } from '../primitives/StatusDot';
import { AGENT_COLOR_VAR, AGENT_LABEL } from '../primitives/agentColor';

export type WorkerNodeData = {
  state: NodeState;
  agent: AgentKind;
  title: string;
  retries: number;
};

const STATE_LABEL: Record<NodeState, string> = {
  idle: 'Queued',
  thinking: 'Thinking',
  proposed: 'Proposed',
  approved: 'Approved',
  waiting: 'Waiting',
  running: 'Running',
  retrying: 'Retrying',
  failed: 'Failed',
  escalating: 'Escalating',
  human_escalation: 'Needs you',
  done: 'Done',
  skipped: 'Skipped',
};

export function WorkerNode({ id, data }: NodeProps) {
  const d = data as unknown as WorkerNodeData;
  const { width, height } = NODE_DIMENSIONS.worker;
  const color = AGENT_COLOR_VAR[d.agent];
  const isProposed = d.state === 'proposed';
  const strikeTitle = d.state === 'escalating' || d.state === 'skipped';

  const isSelected = useGraphStore((s) => s.selectedSubtaskIds.has(id));
  const toggle = useGraphStore((s) => s.toggleSubtaskSelection);

  return (
    <NodeContainer
      variant="worker"
      state={d.state}
      agentColor={color}
      width={width}
      height={height}
    >
      <Handle type="target" position={Position.Top} className="!border-0 !bg-transparent" />
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isProposed ? (
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => toggle(id)}
              aria-label={`Select ${d.title}`}
              className="size-3 cursor-pointer accent-[var(--color-agent-master)]"
            />
          ) : (
            <StatusDot color={statusColor(d.state, color)} />
          )}
          <span className="text-hint uppercase tracking-wide text-fg-secondary">
            {STATE_LABEL[d.state]}
          </span>
        </div>
        {d.retries > 0 ? (
          <span className="text-hint text-fg-tertiary">retry {d.retries}</span>
        ) : null}
      </header>
      <p
        className="truncate text-body text-fg-primary"
        style={strikeTitle ? { textDecoration: 'line-through' } : undefined}
        title={d.title}
      >
        {d.title}
      </p>
      <footer className="mt-auto flex items-center justify-end">
        <Chip variant="agent" color={color}>
          {AGENT_LABEL[d.agent]}
        </Chip>
      </footer>
      <Handle type="source" position={Position.Bottom} className="!border-0 !bg-transparent" />
    </NodeContainer>
  );
}

function statusColor(state: NodeState, agent: string): string {
  if (state === 'done') return 'var(--color-status-success)';
  if (state === 'failed' || state === 'human_escalation') return 'var(--color-status-failed)';
  if (state === 'retrying' || state === 'escalating') return 'var(--color-status-retry)';
  if (state === 'waiting' || state === 'skipped') return 'var(--color-fg-tertiary)';
  return agent;
}
