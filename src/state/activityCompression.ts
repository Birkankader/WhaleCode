/**
 * Phase 6 Step 2 — chip-stack compression rules.
 *
 * Backend emits one `SubtaskActivity` event per parsed `ToolEvent`.
 * Frontend collapses bursts client-side per the Step 0 diagnostic
 * recommendation:
 *
 *   - Same kind + same parent directory within `WINDOW_MS` →
 *     collapse into one chip with a count.
 *   - Different kind, or different parent dir, or outside the
 *     window → separate chip.
 *
 * Pure-data layer; UI applies it on render. Stored events keep
 * their raw shape (50-event cap, FIFO eviction), so a re-derive
 * is cheap.
 */

import type { ToolEvent } from '../lib/ipc';

export const COMPRESSION_WINDOW_MS = 2000;

export type CompressedChip = {
  /** Stable id derived from the underlying event index. */
  id: string;
  event: ToolEvent;
  /** ≥1; >1 means N-of-same-kind compressed into one chip. */
  count: number;
  /** Latest event timestamp in the run (the freshest member). */
  timestampMs: number;
  /** Optional parent-dir hint when the compression keyed on dir. */
  parentDir: string | null;
};

type Stored = { event: ToolEvent; timestampMs: number };

/**
 * Phase 6 Step 2 — collapse a chronological list of stored
 * activities into a chip list. Last-N visible chips live in the
 * caller; this function returns the compressed sequence.
 *
 * Algorithm: walk in reverse (newest first), append into output;
 * when the *current head* of output matches the same kind + same
 * parent dir within `WINDOW_MS`, increment its count instead of
 * adding a new chip.
 */
export function compressActivities(
  stored: ReadonlyArray<Stored>,
): CompressedChip[] {
  if (stored.length === 0) return [];
  const out: CompressedChip[] = [];
  for (let i = stored.length - 1; i >= 0; i--) {
    const entry = stored[i];
    const parentDir = primaryParentDir(entry.event);
    const last = out[out.length - 1];
    const sameKind = last && sameToolKind(last.event, entry.event);
    const sameDir = last && last.parentDir === parentDir;
    const withinWindow =
      last && Math.abs(last.timestampMs - entry.timestampMs) <= COMPRESSION_WINDOW_MS;
    if (sameKind && sameDir && parentDir !== null && withinWindow) {
      last.count += 1;
      // Keep the freshest timestamp as the chip's "as of" marker.
      last.timestampMs = Math.max(last.timestampMs, entry.timestampMs);
      continue;
    }
    out.push({
      id: `chip-${i}`,
      event: entry.event,
      count: 1,
      timestampMs: entry.timestampMs,
      parentDir,
    });
  }
  // Reverse back to chronological order (oldest first → newest
  // last) so the chip stack renders left-to-right with newest on
  // the right (consistent with log scroll direction).
  return out.reverse();
}

function sameToolKind(a: ToolEvent, b: ToolEvent): boolean {
  return a.kind === b.kind;
}

function primaryParentDir(event: ToolEvent): string | null {
  const path = primaryPath(event);
  if (path === null) return null;
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '.' : path.slice(0, idx);
}

function primaryPath(event: ToolEvent): string | null {
  switch (event.kind) {
    case 'file-read':
    case 'file-edit':
      return event.path;
    case 'search':
      return event.paths[0] ?? null;
    default:
      return null;
  }
}

/**
 * Phase 6 Step 2 — middle-ellipsis truncation for long file paths
 * in chip labels. Returns `path` unchanged when within budget.
 */
export function truncatePath(path: string, max: number = 40): string {
  if (path.length <= max) return path;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${path.slice(0, head)}…${path.slice(path.length - tail)}`;
}

/** Single-line human label for a chip. UI wraps with the icon. */
export function chipLabel(chip: CompressedChip): string {
  const { event, count, parentDir } = chip;
  if (count > 1) {
    switch (event.kind) {
      case 'file-read':
        return `Reading ${count} files in ${parentDir ?? '.'}/`;
      case 'file-edit':
        return `Editing ${count} files in ${parentDir ?? '.'}/`;
      case 'bash':
        return `${count} shell commands`;
      case 'search':
        return `${count} searches`;
      case 'other':
        return `${count} ${event.toolName} calls`;
    }
  }
  switch (event.kind) {
    case 'file-read':
      return `Reading ${truncatePath(event.path)}`;
    case 'file-edit':
      return `Editing ${truncatePath(event.path)}`;
    case 'bash':
      return `Running ${truncateInline(event.command, 50)}`;
    case 'search':
      return `Searching '${truncateInline(event.query, 30)}'`;
    case 'other':
      return event.detail.length > 0
        ? `${event.toolName}: ${truncateInline(event.detail, 40)}`
        : event.toolName;
  }
}

function truncateInline(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
