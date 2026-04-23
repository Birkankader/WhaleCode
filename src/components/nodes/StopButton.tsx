/**
 * Phase 5 Step 1 — per-worker stop affordance on a worker card.
 *
 * Renders a Stop icon button on cancellable worker cards (running /
 * retrying / waiting). Click cancels exactly this subtask; the rest of
 * the run continues. The backend bypasses the retry ladder entirely —
 * a manually-stopped worker does not trigger Layer 1 retry, Layer 2
 * replan, or Layer 3 escalation.
 *
 * UI states:
 *   - Idle: clickable Stop icon + tooltip "Stop this worker".
 *   - In-flight (the IPC is out but the backend hasn't confirmed the
 *     terminal transition yet): disabled spinner icon + label
 *     "Stopping…". The transient flag clears when
 *     `handleSubtaskStateChanged` observes a terminal state for this
 *     subtask (cancelled happy path, or done/failed/skipped if the
 *     subtask raced the kill signal).
 *
 * Error handling: the backend rejects with a string error when the
 * subtask is not in a cancellable state (done / failed / skipped /
 * cancelled / proposed). That error surfaces via the store's
 * `currentError` + the toast subsystem; the button rolls back to
 * clickable on rejection so users can retry on a re-opened window
 * (e.g., if the state transition they saw was stale).
 */

import { Square } from 'lucide-react';
import { useCallback } from 'react';

import { useGraphStore } from '../../state/graphStore';
import { useToastStore } from '../../state/toastStore';

type Props = {
  /** Subtask id to stop. */
  subtaskId: string;
};

export function StopButton({ subtaskId }: Props) {
  const cancelSubtask = useGraphStore((s) => s.cancelSubtask);
  const inFlight = useGraphStore((s) => s.subtaskCancelInFlight.has(subtaskId));
  const show = useToastStore((s) => s.show);

  const handleClick = useCallback(async () => {
    try {
      await cancelSubtask(subtaskId);
    } catch (err) {
      // Backend rejection. Surface via toast so the card has a durable
      // error signal distinct from the transient "Stopping…" label.
      // `cancelSubtask` already rolled back the in-flight set, so the
      // button is clickable again.
      show({
        kind: 'error',
        message: `Could not stop worker: ${String(err)}`,
        autoDismissMs: null,
      });
    }
  }, [cancelSubtask, subtaskId, show]);

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={inFlight}
      className="flex h-5 w-5 items-center justify-center rounded-sm text-fg-secondary transition-colors hover:bg-bg-elev-1 hover:text-fg-primary disabled:cursor-wait disabled:opacity-60 disabled:hover:bg-transparent"
      aria-label={inFlight ? 'Stopping worker' : 'Stop this worker'}
      title={inFlight ? 'Stopping…' : 'Stop this worker'}
      data-subtask-stop
      data-in-flight={inFlight ? 'true' : 'false'}
    >
      <Square size={12} strokeWidth={2} aria-hidden="true" />
    </button>
  );
}
