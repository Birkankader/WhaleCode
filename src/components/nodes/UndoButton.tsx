/**
 * Phase 7 Step 2 — per-worker Undo (revert worktree changes).
 *
 * Renders next to {@link StopButton} on workers that have produced
 * changes (`subtaskDiffs[id]?.length > 0`) AND are not in
 * `awaiting_input` (where the QuestionInput already owns the
 * footer slot). Click flow:
 *
 *   default → click → confirming (2s countdown) → reverting → done
 *
 *   - default: lucide RotateCcw icon, plain ghost-y button.
 *   - confirming: button widens to "Undo? 2s · Cancel" with a
 *     2-second countdown. Clicking the button OR clicking elsewhere
 *     on the card aborts. After 2s with no abort, the IPC fires.
 *   - reverting: store's `revertInFlight` flag is true; button
 *     disabled, label "Reverting…". The flag clears on the
 *     backend's `WorktreeReverted` event handler in graphStore.
 *
 * Backend semantics (see `Orchestrator::revert_subtask_changes`):
 * fires the cancel for active states + runs `git reset --hard HEAD`
 * + `git clean -fd` in the subtask's worktree + tags the row with
 * `revert_intent` so the cancelled card gets a "Reverted" subtitle
 * instead of "Stopped". Cascades waiting/proposed dependents to
 * `Skipped`.
 */

import { RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useGraphStore } from '../../state/graphStore';

const COUNTDOWN_MS = 2000;
const TICK_MS = 100;

type Phase = 'idle' | 'confirming' | 'reverting';

type Props = { subtaskId: string };

export function UndoButton({ subtaskId }: Props) {
  const inFlight = useGraphStore((s) => s.revertInFlight.has(subtaskId));
  const revertSubtaskChanges = useGraphStore((s) => s.revertSubtaskChanges);

  const [phase, setPhase] = useState<Phase>('idle');
  const [remainingMs, setRemainingMs] = useState<number>(COUNTDOWN_MS);
  const fireTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimers = useCallback(() => {
    if (fireTimerRef.current !== null) {
      clearTimeout(fireTimerRef.current);
      fireTimerRef.current = null;
    }
    if (tickTimerRef.current !== null) {
      clearInterval(tickTimerRef.current);
      tickTimerRef.current = null;
    }
  }, []);

  // Cleanup on unmount + when transitioning out of `confirming`.
  useEffect(() => {
    return () => clearTimers();
  }, [clearTimers]);

  // Reflect `inFlight` back into local phase: when the backend's
  // `WorktreeReverted` event fires, `inFlight` flips to false and
  // the card transitions to Cancelled — drop back to idle so a
  // re-mount on a sibling re-running worker starts fresh.
  useEffect(() => {
    if (!inFlight && phase === 'reverting') {
      setPhase('idle');
    }
  }, [inFlight, phase]);

  const startConfirm = useCallback(() => {
    setPhase('confirming');
    setRemainingMs(COUNTDOWN_MS);
    const startedAt = Date.now();
    tickTimerRef.current = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const remaining = Math.max(0, COUNTDOWN_MS - elapsed);
      setRemainingMs(remaining);
    }, TICK_MS);
    fireTimerRef.current = setTimeout(() => {
      clearTimers();
      setPhase('reverting');
      void revertSubtaskChanges(subtaskId).catch(() => {
        // graphStore action populates currentError + rolls the
        // in-flight flag. Local state drops back to idle so the
        // user can retry.
        setPhase('idle');
      });
    }, COUNTDOWN_MS);
  }, [clearTimers, revertSubtaskChanges, subtaskId]);

  const cancelConfirm = useCallback(() => {
    clearTimers();
    setPhase('idle');
  }, [clearTimers]);

  if (inFlight || phase === 'reverting') {
    return (
      <button
        type="button"
        className="nodrag nopan inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-meta text-fg-tertiary"
        disabled
        data-testid="worker-undo-button"
        data-phase="reverting"
        aria-label="Reverting worker changes"
      >
        <RotateCcw size={12} aria-hidden />
        Reverting…
      </button>
    );
  }

  if (phase === 'confirming') {
    const seconds = Math.ceil(remainingMs / 1000);
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          cancelConfirm();
        }}
        className="nodrag nopan inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-meta hover:bg-bg-subtle/40"
        style={{
          borderColor: 'var(--color-status-failed)',
          color: 'var(--color-status-failed)',
        }}
        data-testid="worker-undo-button"
        data-phase="confirming"
        data-remaining-ms={remainingMs}
        aria-label={`Cancel revert (${seconds}s)`}
      >
        <RotateCcw size={12} aria-hidden />
        Undo? {seconds}s · Cancel
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        startConfirm();
      }}
      className="nodrag nopan inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-meta text-fg-tertiary hover:bg-bg-subtle/40 hover:text-fg-primary"
      data-testid="worker-undo-button"
      data-phase="idle"
      aria-label="Undo this worker's changes"
      title="Revert worktree (cancels worker if running, wipes changes)"
    >
      <RotateCcw size={12} aria-hidden />
      Undo
    </button>
  );
}
