import { useEffect, useId, useRef } from 'react';

import type { FileDiff } from '../../lib/ipc';

/**
 * Per-subtask diff popover — hangs off the "N files" chip on a done
 * WorkerNode (the chip itself only renders once the subtask's diff has
 * landed, so we're always in a post-run state here) and shows each file
 * this worker changed with +/- counts. Dismissed by clicking outside,
 * pressing Escape, or clicking the chip again.
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
  const headerId = useId();

  // Escape closes; outside-click closes. Effect depends on `onClose`
  // so a re-render with a fresh handler swaps the listeners atomically.
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
    // Bubble-phase `click` — the chip's own onClick (which toggles the
    // popover closed) runs first and we see the already-settled native
    // event on the way up. A capture-phase `mousedown` would close the
    // popover before the chip's click fires, and the chip's subsequent
    // click would then re-open it, defeating chip-click-to-close in
    // real interactions (`fireEvent.click` tests don't surface this
    // because they never dispatch mousedown).
    document.addEventListener('click', onDocClick);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('click', onDocClick);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-labelledby={headerId}
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
        id={headerId}
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
