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

const LOG_VISIBLE_STATES: ReadonlySet<NodeState> = new Set([
  'running',
  'retrying',
  'done',
  'failed',
]);

export function WorkerNode({ id, data }: NodeProps) {
  const d = data as unknown as WorkerNodeData;
  const { width, height } = NODE_DIMENSIONS.worker;
  const color = AGENT_COLOR_VAR[d.agent];
  const isProposed = d.state === 'proposed';
  const strikeTitle = d.state === 'escalating' || d.state === 'skipped';
  const showLogs = LOG_VISIBLE_STATES.has(d.state);

  const isSelected = useGraphStore((s) => s.selectedSubtaskIds.has(id));
  const toggle = useGraphStore((s) => s.toggleSubtaskSelection);
  // Subscribe only to this node's logs — identity-stable when other nodes
  // append so this worker doesn't rerender on every graph-wide log write.
  const logs = useGraphStore((s) => s.nodeLogs.get(id));

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
      {showLogs ? <LogBlock lines={logs ?? []} animateCursor={isStreaming(d.state)} /> : null}
      <footer className="mt-auto flex items-center justify-end">
        <Chip variant="agent" color={color}>
          {AGENT_LABEL[d.agent]}
        </Chip>
      </footer>
      <Handle type="source" position={Position.Bottom} className="!border-0 !bg-transparent" />
    </NodeContainer>
  );
}

function LogBlock({ lines, animateCursor }: { lines: readonly string[]; animateCursor: boolean }) {
  const tail = lines.slice(-3);
  return (
    <div
      className="font-mono text-fg-tertiary"
      style={{
        background: 'var(--color-bg-primary)',
        borderRadius: 4,
        padding: '6px 8px',
        fontSize: 10,
        lineHeight: 1.5,
        height: 54,
        overflow: 'hidden',
      }}
      data-testid="worker-log-block"
    >
      {tail.map((line, i) => {
        const isLast = i === tail.length - 1;
        return (
          <div key={`${i}-${line}`} className="truncate">
            <LogLine line={line} />
            {isLast && animateCursor ? <BlinkingCursor /> : null}
          </div>
        );
      })}
    </div>
  );
}

function LogLine({ line }: { line: string }) {
  const first = line.charAt(0);
  const color = PREFIX_COLOR[first];
  if (!color) return <>{line}</>;
  return (
    <>
      <span style={{ color }}>{first}</span>
      {line.slice(1)}
    </>
  );
}

function BlinkingCursor() {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        marginLeft: 2,
        width: 6,
        height: '1em',
        verticalAlign: '-0.15em',
        background: 'currentColor',
        animation: 'log-cursor-blink 1s step-end infinite',
      }}
    />
  );
}

const PREFIX_COLOR: Record<string, string> = {
  '✓': 'var(--color-status-success)',
  '→': 'var(--color-fg-tertiary)',
  '⚠': 'var(--color-status-retry)',
  '✗': 'var(--color-status-failed)',
};

function isStreaming(state: NodeState): boolean {
  return state === 'running' || state === 'retrying';
}

function statusColor(state: NodeState, agent: string): string {
  if (state === 'done') return 'var(--color-status-success)';
  if (state === 'failed' || state === 'human_escalation') return 'var(--color-status-failed)';
  if (state === 'retrying' || state === 'escalating') return 'var(--color-status-retry)';
  if (state === 'waiting' || state === 'skipped') return 'var(--color-fg-tertiary)';
  return agent;
}
