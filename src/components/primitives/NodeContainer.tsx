import type { CSSProperties, PropsWithChildren } from 'react';

import type { NodeState } from '../../state/nodeMachine';

type Variant = 'master' | 'worker' | 'final';

type Props = {
  variant: Variant;
  state: NodeState;
  agentColor: string;
  width: number;
  height: number;
};

/**
 * Centralises state → border / background mapping per design-system.md
 * "Node (graph element)". Exported for node components; colors are driven
 * by CSS vars so token edits stay in sync.
 */
export function NodeContainer({
  variant,
  state,
  agentColor,
  width,
  height,
  children,
}: PropsWithChildren<Props>) {
  const style = styleForState(variant, state, agentColor);
  return (
    <div
      className="flex h-full w-full flex-col gap-1 rounded-md bg-bg-elevated px-3 py-2"
      style={{ width, height, ...style }}
    >
      {children}
    </div>
  );
}

function styleForState(variant: Variant, state: NodeState, agent: string): CSSProperties {
  const retry = 'var(--color-status-retry)';
  const failed = 'var(--color-status-failed)';
  const pending = 'var(--color-status-pending)';
  const subtle = 'var(--color-border-default)';

  switch (state) {
    case 'thinking':
    case 'running':
      return { border: `1px solid ${agent}`, boxShadow: `0 0 12px -4px ${agent}` };
    case 'proposed':
      return { border: `1px dashed ${pending}` };
    case 'approved':
      return { border: `1px solid ${agent}`, opacity: 0.85 };
    case 'waiting':
      return { border: `1px dashed ${subtle}`, opacity: 0.7 };
    case 'retrying':
      return { border: `1px solid ${retry}`, animation: 'node-pulse 900ms ease-in-out infinite' };
    case 'escalating':
      return { border: `1px solid ${retry}` };
    case 'failed':
      return { border: `1px solid ${failed}` };
    case 'human_escalation':
      return { border: `1px solid ${failed}`, boxShadow: `0 0 12px -4px ${failed}` };
    case 'done':
      return { border: `1px solid ${agent}` };
    case 'skipped':
      return { border: `1px solid ${subtle}`, opacity: 0.4 };
    case 'idle':
    default:
      return variant === 'final'
        ? { border: `1px dashed ${subtle}`, opacity: 0.6 }
        : { border: `1px solid ${subtle}` };
  }
}
