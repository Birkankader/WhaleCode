/**
 * Phase 7 Step 3 — PlanChecklist alongside the graph.
 *
 * Vertical list of one row per subtask plus a top "Master plan" row.
 * Re-projection of `graphStore` state — no new wire data, no
 * persistence beyond what the graph already carries.
 *
 * Each row shows a state icon (empty circle / spinner / check / X /
 * pause / ! triangle), the subtask title, and a compact secondary
 * line with the agent kind. Click a row to centre the graph on
 * that node (uses the same `setCenter`-with-preserved-zoom path
 * `ApplySummaryOverlay` uses for per-worker pan).
 *
 * Layout: in side-by-side mode (parent renders us at a fixed
 * 280px width) we sit on the right edge of the graph area; in
 * tab mode (parent gates on viewport width) we fill the parent's
 * flex-1 region.
 *
 * Scroll behaviour:
 *   - Auto-scroll to the first subtask that enters Running, but
 *     only on the *first* such transition. Subsequent state
 *     changes leave the scroll position alone so the user's view
 *     of the plan doesn't jitter.
 *   - Manual scroll wins. Once the user has scrolled the
 *     container, auto-scroll opts out for the remainder of the
 *     run.
 *
 * Cancelled run: rows freeze in their last-known state. The
 * cancelled badge variant is rendered (X icon) and the
 * Reverted-via-Step-2 subtitle surfaces as ` · Reverted` next to
 * the state label.
 */

import { useReactFlow } from '@xyflow/react';
import {
  AlertTriangle,
  Check,
  Circle,
  Loader2,
  MoreHorizontal,
  Pause,
  Sparkles,
  X as XIcon,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { useShallow } from 'zustand/shallow';

import { NODE_DIMENSIONS } from '../../lib/layout';
import {
  FINAL_ID,
  MASTER_ID,
  useGraphStore,
} from '../../state/graphStore';
import type { NodeState } from '../../state/nodeMachine';
import { AGENT_LABEL } from '../primitives/agentColor';

type Props = {
  className?: string;
  /**
   * Forwarded onto the root `<aside>` for testid suffixing when
   * the parent renders both the side-by-side and the tabbed
   * variant in adjacent test cases. Optional.
   */
  'data-testid-suffix'?: string;
};

/** Phase 7 Step 3: 280 px is the spec width for the side-by-side
 *  variant. Tab-mode usage applies its own flex-1 sizing via
 *  `className` instead. */
const SIDE_BY_SIDE_WIDTH_PX = 280;

export function PlanChecklist({ className, ...rest }: Props) {
  const { masterNode, subtasks, status, finalNode } = useGraphStore(
    useShallow((s) => ({
      masterNode: s.masterNode,
      subtasks: s.subtasks,
      status: s.status,
      finalNode: s.finalNode,
    })),
  );
  const nodeSnapshots = useGraphStore((s) => s.nodeSnapshots);
  const subtaskRevertIntent = useGraphStore((s) => s.subtaskRevertIntent);

  const { getNode, setCenter, getViewport } = useReactFlow();

  // Pan to a node id, preserving zoom (matches the
  // ApplySummaryOverlay + WorkerNode dependency-link pattern).
  const panTo = useCallback(
    (nodeId: string) => {
      const node = getNode(nodeId);
      if (!node) return;
      const dim =
        nodeId === MASTER_ID
          ? NODE_DIMENSIONS.master
          : nodeId === FINAL_ID
            ? NODE_DIMENSIONS.final
            : NODE_DIMENSIONS.worker;
      const w = node.width ?? dim.width;
      const h = node.height ?? dim.height;
      const cx = node.position.x + w / 2;
      const cy = node.position.y + h / 2;
      const { zoom } = getViewport();
      void setCenter(cx, cy, { zoom, duration: 300 });
    },
    [getNode, getViewport, setCenter],
  );

  // Auto-scroll guard. Both refs survive the run; the user-scroll
  // detection sets `userScrolledRef` true on first manual scroll
  // and we never reset it (a fresh run remounts via React keying
  // on `runId` from the parent).
  const containerRef = useRef<HTMLDivElement | null>(null);
  const userScrolledRef = useRef(false);
  const firstRunningHandledRef = useRef(false);

  const onScroll = useCallback(() => {
    userScrolledRef.current = true;
  }, []);

  // Detect the first subtask that enters Running and bring its
  // row into view. Subsequent state churn leaves the scroll alone.
  const firstRunningId = useMemo(() => {
    for (const sub of subtasks) {
      const snap = nodeSnapshots.get(sub.id);
      if (
        snap?.value === 'running' || snap?.value === 'retrying'
      ) {
        return sub.id;
      }
    }
    return null;
  }, [subtasks, nodeSnapshots]);

  useEffect(() => {
    if (!firstRunningId) return;
    if (firstRunningHandledRef.current) return;
    if (userScrolledRef.current) return;
    const container = containerRef.current;
    if (!container) return;
    const row = container.querySelector(
      `[data-checklist-row-id="${firstRunningId}"]`,
    ) as HTMLElement | null;
    if (!row) return;
    // jsdom lacks `scrollIntoView`; the auto-scroll is a UX nicety,
    // not a correctness invariant, so guard the call rather than
    // forcing every test to stub the prototype.
    row.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    firstRunningHandledRef.current = true;
  }, [firstRunningId]);

  // Master plan label flips during PlanningInProgress + ReplanInProgress.
  const masterIsThinking =
    status === 'planning' || status === 'awaiting_approval';

  const showFinalRow = finalNode !== null && status !== 'idle';

  const sideBySideStyle =
    rest['data-testid-suffix'] === 'side-by-side'
      ? { width: SIDE_BY_SIDE_WIDTH_PX }
      : {};

  return (
    <aside
      className={
        'flex h-full min-h-0 flex-col border-l ' + (className ?? '')
      }
      style={{
        borderColor: 'var(--color-border-default)',
        backgroundColor: 'var(--color-bg-elevated)',
        ...sideBySideStyle,
      }}
      data-testid="plan-checklist"
      data-variant={rest['data-testid-suffix'] ?? 'tab'}
      aria-label="Plan checklist"
    >
      <header
        className="shrink-0 border-b px-3 py-2 text-hint uppercase tracking-wide text-fg-secondary"
        style={{ borderColor: 'var(--color-border-default)' }}
      >
        Plan
      </header>
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto"
        data-testid="plan-checklist-list"
      >
        {masterNode ? (
          <ChecklistRow
            id={MASTER_ID}
            kind="master"
            title="Master plan"
            secondary={AGENT_LABEL[masterNode.agent]}
            state={masterIsThinking ? 'running' : 'done'}
            isReverted={false}
            onClick={() => panTo(MASTER_ID)}
          />
        ) : null}
        {subtasks.map((sub) => {
          const snap = nodeSnapshots.get(sub.id);
          const state: NodeState = snap?.value ?? 'idle';
          const reverted = subtaskRevertIntent.has(sub.id);
          return (
            <ChecklistRow
              key={sub.id}
              id={sub.id}
              kind="worker"
              title={sub.title}
              secondary={AGENT_LABEL[sub.agent]}
              state={state}
              isReverted={reverted}
              onClick={() => panTo(sub.id)}
            />
          );
        })}
        {showFinalRow ? (
          <ChecklistRow
            id={FINAL_ID}
            kind="final"
            title="Merge"
            secondary={status === 'applied' ? 'Applied' : null}
            state={
              status === 'applied'
                ? 'done'
                : status === 'merging'
                  ? 'running'
                  : 'idle'
            }
            isReverted={false}
            onClick={() => panTo(FINAL_ID)}
          />
        ) : null}
      </div>
    </aside>
  );
}

function ChecklistRow({
  id,
  kind,
  title,
  secondary,
  state,
  isReverted,
  onClick,
}: {
  id: string;
  kind: 'master' | 'worker' | 'final';
  title: string;
  secondary: string | null;
  state: NodeState;
  isReverted: boolean;
  onClick: () => void;
}) {
  const stateText = stateLabel(state, isReverted);
  return (
    <button
      type="button"
      onClick={onClick}
      data-checklist-row-id={id}
      data-state={state}
      data-kind={kind}
      data-testid={`plan-checklist-row-${id}`}
      className="flex w-full items-start gap-2 border-b px-3 py-2 text-left hover:bg-bg-subtle/40"
      style={{ borderColor: 'var(--color-border-subtle)' }}
      aria-label={`${title} — ${stateText}`}
    >
      <StateIcon state={state} isReverted={isReverted} />
      <div className="min-w-0 flex-1">
        <span
          className={
            'block truncate text-meta text-fg-primary '
            + (kind === 'master' ? 'italic ' : '')
          }
          title={title}
        >
          {title}
        </span>
        <span className="block truncate text-hint text-fg-tertiary">
          {secondary ?? ''}
          {secondary ? ' · ' : ''}
          {stateText}
        </span>
      </div>
    </button>
  );
}

function StateIcon({
  state,
  isReverted,
}: {
  state: NodeState;
  isReverted: boolean;
}) {
  const props = { size: 14, 'aria-hidden': true } as const;
  if (state === 'done') {
    return (
      <Check
        {...props}
        style={{ color: 'var(--color-status-success)' }}
        data-testid="plan-checklist-icon-done"
      />
    );
  }
  if (state === 'failed') {
    return (
      <XIcon
        {...props}
        style={{ color: 'var(--color-status-failed)' }}
        data-testid="plan-checklist-icon-failed"
      />
    );
  }
  if (state === 'cancelled') {
    return (
      <XIcon
        {...props}
        style={{ color: 'var(--color-fg-tertiary)' }}
        data-testid={
          isReverted
            ? 'plan-checklist-icon-reverted'
            : 'plan-checklist-icon-cancelled'
        }
      />
    );
  }
  if (state === 'skipped') {
    return (
      <Sparkles
        {...props}
        style={{ color: 'var(--color-fg-tertiary)' }}
        data-testid="plan-checklist-icon-skipped"
      />
    );
  }
  if (state === 'running' || state === 'retrying') {
    return (
      <Loader2
        {...props}
        className="animate-spin"
        style={{ color: 'var(--color-status-success)' }}
        data-testid="plan-checklist-icon-running"
      />
    );
  }
  if (state === 'awaiting_input') {
    return (
      <Pause
        {...props}
        style={{ color: 'var(--color-fg-secondary)' }}
        data-testid="plan-checklist-icon-awaiting-input"
      />
    );
  }
  if (state === 'human_escalation' || state === 'escalating') {
    return (
      <AlertTriangle
        {...props}
        style={{ color: 'var(--color-status-failed)' }}
        data-testid="plan-checklist-icon-escalation"
      />
    );
  }
  if (state === 'thinking') {
    return (
      <MoreHorizontal
        {...props}
        style={{ color: 'var(--color-fg-tertiary)' }}
        data-testid="plan-checklist-icon-thinking"
      />
    );
  }
  // proposed / waiting / idle
  return (
    <Circle
      {...props}
      style={{ color: 'var(--color-fg-tertiary)' }}
      data-testid="plan-checklist-icon-empty"
    />
  );
}

function stateLabel(state: NodeState, isReverted: boolean): string {
  switch (state) {
    case 'idle':
      return '—';
    case 'thinking':
      return 'Thinking';
    case 'proposed':
      return 'Proposed';
    case 'approved':
      return 'Approved';
    case 'waiting':
      return 'Waiting';
    case 'running':
      return 'Running';
    case 'retrying':
      return 'Retrying';
    case 'awaiting_input':
      return 'Has a question';
    case 'done':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'skipped':
      return 'Skipped';
    case 'escalating':
      return 'Escalating';
    case 'human_escalation':
      return 'Needs you';
    case 'cancelled':
      return isReverted ? 'Cancelled · Reverted' : 'Cancelled';
  }
}
