/**
 * Phase 3 Step 5 Layer-3 escalation surface.
 *
 * Renders inside `WorkerNode` when the subtask's state is
 * `human_escalation`. Surfaces:
 *   - a short error summary (from `formatAgentError`) with an
 *     expandable "details" pane carrying the verbatim backend text;
 *   - a primary "Open worktree" button that calls
 *     `manualFixSubtask` (backend opens the editor, or copies the
 *     path to the clipboard if no editor tier resolved);
 *   - a primary "I fixed it, continue" button that calls
 *     `markSubtaskFixed` — the backend commits any worktree diff,
 *     flips the subtask to Done, and rejoins the dispatcher;
 *   - a tertiary row of inline-confirm actions:
 *       - "Skip subtask" — previews the cascade count
 *         (self + transitive dependents via `computeSkipCascadeCount`)
 *         before calling `skipSubtask`;
 *       - "Try replan again" — hidden past the Layer-2 replan cap
 *         (`replanCount >= 2`);
 *       - "Abort run" — reuses the existing `cancelRun` action
 *         (no new store plumbing).
 *
 * Layout hand-off: the parent WorkerNode is sized ~280px tall in this
 * state via `layoutGraph`'s `workerHeights` override (see `GraphCanvas`
 * `buildGraph`), and row-mates in the same layout row share that
 * height for visual alignment.
 */

import { useState } from 'react';

import { formatAgentError } from '../../lib/errorDisplay';
import {
  computeSkipCascadeCount,
  useGraphStore,
} from '../../state/graphStore';
import { Button } from '../primitives/Button';

type Props = {
  subtaskId: string;
  replanCount: number;
};

export function EscalationActions({ subtaskId, replanCount }: Props) {
  const escalation = useGraphStore((s) => s.humanEscalation);
  const subtasks = useGraphStore((s) => s.subtasks);
  const manualFix = useGraphStore((s) => s.manualFixSubtask);
  const markFixed = useGraphStore((s) => s.markSubtaskFixed);
  const skip = useGraphStore((s) => s.skipSubtask);
  const replan = useGraphStore((s) => s.tryReplanAgain);
  const cancel = useGraphStore((s) => s.cancelRun);

  const [detailsOpen, setDetailsOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | 'skip' | 'abort'>(null);
  const [busy, setBusy] = useState<
    null | 'open' | 'fixed' | 'skip' | 'replan' | 'abort'
  >(null);

  // The store's `humanEscalation` is the authoritative summary carrier.
  // Guarding here means the component is safe to mount momentarily out
  // of sync with the snapshot (e.g. the final store event fires a tick
  // after the actor transition). Without this guard we'd lose the
  // reason line when the run races the DOM.
  const isMine = escalation !== null && escalation.subtaskId === subtaskId;
  const reasonText = isMine ? escalation.reason : '';
  const display = formatAgentError(reasonText);

  const cascade = computeSkipCascadeCount(subtasks, subtaskId);

  // Backend gates replan at a cap of 2. We hide the action past the
  // cap to avoid an always-failing click; the backend still rejects
  // a concurrent click (defence in depth via mapEditError).
  const canReplan = replanCount < 2;

  const run = async (
    kind: Exclude<typeof busy, null>,
    fn: () => Promise<unknown>,
  ) => {
    setBusy(kind);
    try {
      await fn();
    } catch {
      // `currentError` is already populated by the store action — the
      // ErrorBanner surfaces it. Swallow here so the click-handler
      // doesn't bubble as an unhandled promise rejection.
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="nodrag nopan flex min-h-0 flex-col gap-2"
      // Stop event propagation so clicks on buttons / details don't
      // bubble up to any parent click handler the node might attach
      // later.
      onClick={(e) => e.stopPropagation()}
      data-testid={`escalation-actions-${subtaskId}`}
    >
      <div className="flex flex-col gap-1">
        <span className="text-meta text-fg-primary">{display.summary}</span>
        {display.details ? (
          <button
            type="button"
            onClick={() => setDetailsOpen((v) => !v)}
            className="self-start text-hint text-fg-tertiary hover:text-fg-secondary"
            aria-expanded={detailsOpen}
            data-testid="escalation-details-toggle"
          >
            {detailsOpen ? 'Hide details' : 'Show details'}
          </button>
        ) : null}
        {display.details && detailsOpen ? (
          <pre
            className="max-h-[72px] overflow-auto whitespace-pre-wrap break-words rounded-sm bg-bg-subtle px-2 py-1 text-hint text-fg-secondary"
            style={{ fontFamily: 'var(--font-mono)' }}
            data-testid="escalation-details-body"
          >
            {display.details}
          </pre>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={busy !== null}
          onClick={() => void run('open', () => manualFix(subtaskId))}
          data-testid="escalation-open-worktree"
        >
          {busy === 'open' ? 'Opening…' : 'Open worktree'}
        </Button>
        <Button
          variant="primary"
          disabled={busy !== null}
          onClick={() => void run('fixed', () => markFixed(subtaskId))}
          data-testid="escalation-mark-fixed"
        >
          {busy === 'fixed' ? 'Continuing…' : 'I fixed it, continue'}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-hint">
        {confirm === 'skip' ? (
          <InlineConfirm
            label={
              cascade > 0
                ? `Skip this and ${cascade} dependent subtask${cascade === 1 ? '' : 's'}?`
                : 'Skip this subtask?'
            }
            onYes={() =>
              void run('skip', async () => {
                await skip(subtaskId);
                setConfirm(null);
              })
            }
            onNo={() => setConfirm(null)}
            testIdPrefix="escalation-confirm-skip"
            disabled={busy !== null}
          />
        ) : (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => setConfirm('skip')}
            className="text-fg-tertiary hover:text-fg-secondary disabled:opacity-50"
            data-testid="escalation-skip-trigger"
          >
            Skip subtask
          </button>
        )}

        {canReplan ? (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void run('replan', () => replan(subtaskId))}
            className="text-fg-tertiary hover:text-fg-secondary disabled:opacity-50"
            data-testid="escalation-try-replan"
          >
            {busy === 'replan' ? 'Asking master…' : 'Try replan again'}
          </button>
        ) : null}

        {confirm === 'abort' ? (
          <InlineConfirm
            label="Abort the run?"
            onYes={() =>
              void run('abort', async () => {
                await cancel();
                setConfirm(null);
              })
            }
            onNo={() => setConfirm(null)}
            testIdPrefix="escalation-confirm-abort"
            disabled={busy !== null}
          />
        ) : (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => setConfirm('abort')}
            className="text-fg-tertiary hover:text-fg-secondary disabled:opacity-50"
            data-testid="escalation-abort-trigger"
          >
            Abort run
          </button>
        )}
      </div>
    </div>
  );
}

function InlineConfirm({
  label,
  onYes,
  onNo,
  testIdPrefix,
  disabled,
}: {
  label: string;
  onYes: () => void;
  onNo: () => void;
  testIdPrefix: string;
  disabled: boolean;
}) {
  return (
    <span className="flex items-center gap-1 text-hint">
      <span style={{ color: 'var(--color-status-failed)' }}>{label}</span>
      <button
        type="button"
        onClick={onYes}
        disabled={disabled}
        className="rounded-sm border px-1 py-0.5 disabled:opacity-50"
        style={{
          borderColor: 'var(--color-status-failed)',
          color: 'var(--color-status-failed)',
        }}
        data-testid={`${testIdPrefix}-yes`}
      >
        Yes
      </button>
      <button
        type="button"
        onClick={onNo}
        disabled={disabled}
        className="rounded-sm border px-1 py-0.5 text-fg-tertiary disabled:opacity-50"
        style={{ borderColor: 'var(--color-border-default)' }}
        data-testid={`${testIdPrefix}-no`}
      >
        No
      </button>
    </span>
  );
}
