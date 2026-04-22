import { Suspense, lazy, useEffect, useId, useRef, useState } from 'react';

import type { DiffStatus, FileDiff } from '../../lib/ipc';

/**
 * Per-subtask diff popover — hangs off the "N files" chip on a done
 * WorkerNode. Each file starts collapsed (filename + status + `+N/-M`
 * stats only); clicking the header expands the unified-diff body.
 *
 * Expand state is local to this popover instance: closing and re-opening
 * the popover resets all files back to collapsed, by design — we don't
 * want to surprise the user with "the same file I expanded ten minutes
 * ago is still expanded."
 *
 * The expanded body ships in a dynamically-imported chunk (`./DiffBody`)
 * so Shiki's grammar loader glue and `@tanstack/react-virtual` stay out
 * of the main bundle until the user actually opens a diff preview.
 */

const DiffBody = lazy(() => import('./DiffBody'));

export function DiffPopover({
  files,
  onClose,
}: {
  files: readonly FileDiff[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const headerId = useId();

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
    // Bubble-phase click so the chip's own toggle fires first — see the
    // long-form rationale in the Phase 3.5 implementation.
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
      className="nodrag nopan nowheel absolute bottom-full right-0 z-50 mb-1 flex max-h-[70vh] w-[28rem] flex-col overflow-hidden rounded-md border bg-[var(--color-bg-elevated)] shadow-lg"
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
        <ul className="flex min-h-0 flex-col overflow-y-auto" data-testid="diff-popover-list">
          {files.map((f) => (
            <DiffFileRow key={f.path} file={f} />
          ))}
        </ul>
      )}
    </div>
  );
}

function DiffFileRow({ file }: { file: FileDiff }) {
  const [expanded, setExpanded] = useState(false);
  const label = renderPathLabel(file);
  const variantLabel = renderVariantSuffix(file.status);
  const rowId = useId();
  const bodyId = `${rowId}-body`;

  return (
    <li
      className="border-b last:border-b-0"
      style={{ borderColor: 'var(--color-border-default)' }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={bodyId}
        className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left font-mono text-meta hover:bg-[var(--color-bg-subtle)]/40"
        data-testid="diff-file-header"
        data-path={file.path}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span aria-hidden className="text-fg-tertiary">
            {expanded ? '▾' : '▸'}
          </span>
          <span className="truncate text-fg-primary" title={file.path}>
            {label}
          </span>
          {variantLabel ? (
            <span
              className="shrink-0 rounded px-1 text-hint uppercase tracking-wide text-fg-tertiary"
              style={{ backgroundColor: 'var(--color-bg-subtle)' }}
            >
              {variantLabel}
            </span>
          ) : null}
        </span>
        <span className="shrink-0 font-mono tabular-nums">
          <span style={{ color: 'var(--color-status-success)' }}>+{file.additions}</span>
          <span className="mx-1 text-fg-tertiary">/</span>
          <span style={{ color: 'var(--color-status-failed)' }}>−{file.deletions}</span>
        </span>
      </button>
      {expanded ? (
        <Suspense
          fallback={
            <div
              id={bodyId}
              className="px-3 py-2 font-mono text-meta italic text-fg-tertiary"
              data-testid="diff-body-loading"
            >
              loading preview…
            </div>
          }
        >
          <DiffBody file={file} id={bodyId} />
        </Suspense>
      ) : null}
    </li>
  );
}

function renderPathLabel(file: FileDiff): string {
  if (file.status?.kind === 'renamed') {
    return `${file.status.from} → ${file.path}`;
  }
  return file.path;
}

function renderVariantSuffix(status: DiffStatus | undefined): string | null {
  if (!status) return null;
  switch (status.kind) {
    case 'added':
      return 'new';
    case 'deleted':
      return 'removed';
    case 'renamed':
      return 'renamed';
    case 'binary':
      return 'binary';
    case 'modified':
      return null;
  }
}
