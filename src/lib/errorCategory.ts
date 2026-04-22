// Phase 4 Step 5: user-facing copy derivation for wire-level
// `ErrorCategoryWire` payloads. Single source of truth for the five
// locked strings — ErrorBanner and WorkerNode both pull through this
// helper so a copy tweak stays one edit.

import type { ErrorCategoryWire } from './ipc';

/**
 * Stable short label for a crash category. Used as the inline chip
 * on a Failed WorkerNode and as the prominent banner headline when a
 * single failed subtask carries a category.
 *
 * Timeout formats `afterSecs` as minutes, rounded to the nearest
 * whole minute, bottoming out at "<1m" so the UI never says "Timed
 * out after 0m". The backend's production deadlines are 10 min
 * (plan) / 30 min (execute); sub-minute timeouts only occur in
 * tests, where "<1m" is accurate.
 */
export function describeErrorCategory(cat: ErrorCategoryWire): string {
  switch (cat.kind) {
    case 'process-crashed':
      return 'Subprocess crashed';
    case 'task-failed':
      return 'Task failed';
    case 'parse-failed':
      return 'Invalid agent output';
    case 'timeout': {
      const secs = cat.afterSecs;
      if (secs < 60) return 'Timed out after <1m';
      const mins = Math.round(secs / 60);
      return `Timed out after ${mins}m`;
    }
    case 'spawn-failed':
      return "Agent couldn't start";
  }
}

/**
 * True when two wire categories should render as the "same" chip /
 * banner variant. `Timeout` variants compare structurally because
 * two subtasks that both timed out at different deadlines should
 * still collapse into a single banner; downstream consumers can
 * inspect the representative category's `afterSecs` directly if
 * they want the exact number.
 */
export function sameErrorCategoryKind(
  a: ErrorCategoryWire,
  b: ErrorCategoryWire,
): boolean {
  return a.kind === b.kind;
}
