import { Handle, Position, type NodeProps } from '@xyflow/react';

import { NODE_DIMENSIONS } from '../../lib/layout';
import type { AgentKind } from '../../state/graphStore';
import type { NodeState } from '../../state/nodeMachine';
import { NodeContainer } from '../primitives/NodeContainer';
import { StatusDot } from '../primitives/StatusDot';
import { AGENT_COLOR_VAR, AGENT_LABEL } from '../primitives/agentColor';

export type MasterNodeData = {
  state: NodeState;
  agent: AgentKind;
  title: string;
  subtitle?: string;
};

export function MasterNode({ data }: NodeProps) {
  const d = data as unknown as MasterNodeData;
  const { width, height } = NODE_DIMENSIONS.master;
  const color = AGENT_COLOR_VAR[d.agent];

  return (
    <NodeContainer
      variant="master"
      state={d.state}
      agentColor={color}
      width={width}
      height={height}
    >
      <Handle type="target" position={Position.Top} className="!border-0 !bg-transparent" />
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <StatusDot color={color} />
          <span className="text-hint uppercase tracking-wide text-fg-secondary">Master</span>
        </div>
        <span className="text-hint text-fg-tertiary">{AGENT_LABEL[d.agent]}</span>
      </header>
      <p className="truncate text-body text-fg-primary" title={d.title}>
        {d.title}
      </p>
      {d.subtitle ? <p className="truncate text-hint text-fg-tertiary">{d.subtitle}</p> : null}
      <Handle type="source" position={Position.Bottom} className="!border-0 !bg-transparent" />
    </NodeContainer>
  );
}
