import type { CSSProperties, MouseEventHandler, PropsWithChildren } from 'react';

import type { NodeState } from '../../state/nodeMachine';

type Variant = 'master' | 'worker' | 'final';

type Props = {
  variant: Variant;
  state: NodeState;
  agentColor: string;
  width: number;
  height: number;
  /**
   * Optional click handler. Used by WorkerNode in `proposed` state to make
   * the whole card a selection toggle — the checkbox alone is too small a
   * click target. Keyboard + screen-reader semantics live on the inner
   * checkbox; this is a mouse affordance only.
   */
  onClick?: MouseEventHandler<HTMLDivElement>;
  /**
   * Extra Tailwind classes merged onto the container. Used by WorkerNode
   * to opt into Tailwind's `group` pattern for hover-reveal affordances
   * (the remove button fades in via `group-hover:opacity-100`).
   */
  className?: string;
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
  onClick,
  className,
  children,
}: PropsWithChildren<Props>) {
  const style = styleForState(variant, state, agentColor);
  const base = 'flex h-full w-full flex-col gap-1 rounded-md bg-bg-elevated px-3 py-2';
  return (
    <div
      className={className ? `${base} ${className}` : base}
      style={{ width, height, cursor: onClick ? 'pointer' : undefined, ...style }}
      onClick={onClick}
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
      return {
        border: `1px solid ${agent}`,
        animation: 'node-think 1.5s ease-in-out infinite',
      };
    case 'running':
      return {
        border: `1px solid ${agent}`,
        animation: 'node-running-glow 2s ease-in-out infinite',
        // Consumed by the keyframe via var() so the glow matches the agent.
        ['--node-glow-color' as string]: agent,
      };
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
    case 'cancelled':
      // Distinct from `skipped` (which is bypassed-on-purpose during a live
      // run): `cancelled` is the whole-run stop. Slightly stronger opacity
      // + dashed border signals "frozen tombstone" rather than "skipped
      // this one". Matches the design-system tombstone intent.
      return { border: `1px dashed ${subtle}`, opacity: 0.5 };
    case 'idle':
    default:
      return variant === 'final'
        ? { border: `1px dashed ${subtle}`, opacity: 0.6 }
        : { border: `1px solid ${subtle}` };
  }
}
