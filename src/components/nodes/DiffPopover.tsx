import { useEffect, useRef } from 'react';

import type { FileDiff } from '../../lib/ipc';

/**
 * Per-subtask diff popover — hangs off the "N files" chip on a
 * done/running WorkerNode and shows each file this worker changed
 * with +/- counts. Dismissed by clicking outside, pressing Escape,
 * or clicking the chip again.
 *
 * Positioned as an absolute child of the chip so React Flow's node
 * transforms apply automatically. Uses `nodrag`/`nopan` so clicks
 * inside don't start dragging the node or panning the canvas.
 */
export function DiffPopover({
  files,
  onClose,
}: {
  files: readonly FileDiff[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  // Escape closes; outside-click closes. Attach once, tear down on
  // unmount — no deps so handlers always see the latest `onClose`.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    function onDocClick(e: MouseEvent) {
      const root = ref.current;
      if (!root) return;
      if (e.target instanceof Node && root.contains(e.target)) return;
      onClose();
    }
    window.addEventListener('keydown', onKey, true);
    // `capture: true` so we fire before any nested stopPropagation on
    // the WorkerNode's card-click handler — otherwise closing from an
    // outside click on another worker card would race.
    document.addEventListener('mousedown', onDocClick, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDocClick, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      // Position: anchor above the chip (chip is footer-bottom-right).
      // Right-aligned so long paths don't overflow the card's right edge.
      // z-50 to sit above sibling cards. nodrag/nopan kills React Flow
      // gestures inside. onClick stops bubble so the chip's own toggle
      // (which closes the popover) doesn't re-fire.
      className="nodrag nopan absolute bottom-full right-0 z-50 mb-1 flex max-h-64 w-80 flex-col overflow-hidden rounded-md border bg-[var(--color-bg-elevated)] shadow-lg"
      style={{ borderColor: 'var(--color-border-default)' }}
      onClick={(e) => e.stopPropagation()}
      data-testid="diff-popover"
    >
      <header
        className="flex items-center justify-between border-b px-3 py-2 text-hint uppercase tracking-wide text-fg-secondary"
        style={{ borderColor: 'var(--color-border-default)' }}
      >
        <span>
          {files.length} file{files.length === 1 ? '' : 's'} changed
        </span>
        <button
          type="button"
          onClick={onClose}
          className="text-fg-tertiary hover:text-fg-primary"
          aria-label="Close diff preview"
        >
          <span aria-hidden>×</span>
        </button>
      </header>
      {files.length === 0 ? (
        <p className="px-3 py-4 text-meta italic text-fg-tertiary">
          This subtask ran but touched no files.
        </p>
      ) : (
        <ul
          className="flex min-h-0 flex-col overflow-y-auto font-mono text-meta"
          data-testid="diff-popover-list"
        >
          {files.map((f) => (
            <li
              key={f.path}
              className="flex items-center justify-between gap-3 px-3 py-1 hover:bg-[var(--color-bg-subtle)]/40"
            >
              <span className="truncate text-fg-primary" title={f.path}>
                {f.path}
              </span>
              <span className="shrink-0 tabular-nums">
                <span style={{ color: 'var(--color-status-success)' }}>+{f.additions}</span>
                <span className="mx-1 text-fg-tertiary">/</span>
                <span style={{ color: 'var(--color-status-failed)' }}>−{f.deletions}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
