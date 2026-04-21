import type {
  CSSProperties,
  KeyboardEventHandler,
  MouseEventHandler,
  PropsWithChildren,
} from 'react';

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
  /**
   * Marks the card as "not in the current approval selection" — only set
   * by WorkerNode when a proposed subtask has been unticked. Visually
   * pushes the card to 50% opacity and drops the pending-yellow border
   * to the neutral gray, so the surviving selection reads as the focus
   * at a glance. Ignored when the state is anything other than
   * `proposed` (caller's responsibility).
   */
  dimmed?: boolean;
  /**
   * Phase 4 Step 3 a11y pass-through. Set by WorkerNode when the card
   * is in an expandable state so the whole-card toggle is keyboard-
   * reachable and screen-reader-introspectable. Shape mirrors ARIA so
   * the container stays dumb — WorkerNode owns the semantics and the
   * container just forwards. When `role="button"` is supplied we also
   * smooth over browser defaults: `tabIndex={0}` and Enter/Space
   * activation are the caller's responsibility.
   */
  role?: 'button';
  tabIndex?: number;
  ariaExpanded?: boolean;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  /**
   * Forwarded to the outermost `div` for component-level test queries.
   * WorkerNode sets this so tests can find the expandable card without
   * relying on role — NodeContainer never sets it on its own.
   */
  dataTestId?: string;
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
  dimmed,
  role,
  tabIndex,
  ariaExpanded,
  onKeyDown,
  dataTestId,
  children,
}: PropsWithChildren<Props>) {
  const style = styleForState(variant, state, agentColor);
  // Dimmed takes precedence over the state's own border+opacity so
  // unselected proposed cards all read the same regardless of whether
  // the underlying state style set opacity. 100ms matches the tight
  // feedback loop we want when the user ticks/unticks a subtask —
  // faster than a noticeable animation, slow enough to feel like a
  // transition rather than a jump.
  // Specify border as longhands so only the color actually changes
  // between ticked and unticked — `transition: border-color` below
  // then interpolates the shift instead of snapping. Writing the
  // `border` shorthand here (or in state) lumps width/style/color
  // into one declaration the browser can't animate granularly, and
  // JSDOM drops the shorthand silently when it contains `var(...)`,
  // so the longhand form is the only one that behaves consistently.
  const dimmedStyle = dimmed
    ? {
        borderStyle: 'dashed' as const,
        borderWidth: '1px',
        borderColor: 'var(--color-border-default)',
        opacity: 0.5,
      }
    : undefined;
  const base = 'flex h-full w-full flex-col gap-1 rounded-md bg-bg-elevated px-3 py-2';
  return (
    <div
      className={className ? `${base} ${className}` : base}
      style={{
        width,
        // Smooth the height change so expand/collapse doesn't snap —
        // 150ms ease-out matches the "fast but visible" tier we use
        // for border/opacity and sits under dagre's own position
        // animation so the two reads as one motion. Height always
        // animates; state-tier height flips (e.g. idle→running
        // bumping to 180px) benefit from the same smoothing without
        // adding a per-call gate.
        height,
        cursor: onClick ? 'pointer' : undefined,
        transition:
          'opacity 100ms ease-out, border-color 100ms ease-out, height 150ms ease-out',
        ...style,
        ...dimmedStyle,
      }}
      onClick={onClick}
      onKeyDown={onKeyDown}
      role={role}
      tabIndex={tabIndex}
      aria-expanded={ariaExpanded}
      data-testid={dataTestId}
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
