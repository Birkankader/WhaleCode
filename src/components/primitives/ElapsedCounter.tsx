/**
 * Phase 7 Step 4 — elapsed-time counter.
 *
 * Pure prop renderer. Backend's per-worker / master tick task
 * pushes 1-second `ElapsedTick` events into the store; consumers
 * read the latest value from `subtaskElapsed` / `masterElapsed`
 * and pass it as `elapsedMs` here. No internal timer — a single
 * tick triggers all three integration points (worker footer,
 * master node, PlanChecklist row) without each component running
 * its own setInterval.
 *
 * Format mirrors the Cursor reference UI:
 *   - <60s        → "Xs"
 *   - <60min      → "Xm Ys"     (e.g. "1m 24s")
 *   - >=60min     → "Xh Ym"     (drops seconds at hour scale —
 *                                 informational, not stopwatch)
 *
 * Render policy: a `null` / `undefined` `elapsedMs` means "not
 * applicable yet" (subtask still in proposed/waiting). Component
 * returns `null` so the parent can stay structurally simple
 * without extra `?` guards.
 */

import { Clock } from 'lucide-react';

type Props = {
  elapsedMs: number | null | undefined;
  /** When `true`, omits the leading icon (compact use in
   *  PlanChecklist secondary line). */
  noIcon?: boolean;
  /** Forwarded onto the root `<span>` for testing surfaces. */
  testId?: string;
};

export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours}h ${remMin}m`;
}

export function ElapsedCounter({ elapsedMs, noIcon, testId }: Props) {
  if (elapsedMs === null || elapsedMs === undefined) return null;
  return (
    <span
      className="inline-flex items-center gap-1 font-mono text-meta text-fg-secondary tabular-nums"
      data-testid={testId ?? 'elapsed-counter'}
      data-elapsed-ms={elapsedMs}
      aria-label={`Elapsed: ${formatElapsed(elapsedMs)}`}
    >
      {noIcon ? null : <Clock size={11} aria-hidden />}
      {formatElapsed(elapsedMs)}
    </span>
  );
}
