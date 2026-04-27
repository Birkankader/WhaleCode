import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useShallow } from 'zustand/shallow';

import type { DiffStatus, FileDiff } from '../../lib/ipc';
import { computeSidebarOpen, useGraphStore } from '../../state/graphStore';

const DiffBody = lazy(() => import('./DiffBody'));

/**
 * Phase 7 Step 1: right-edge sidebar that absorbs the Phase 4 Step 6
 * `DiffPopover` modal. Same `FileDiff` data, same Shiki + virtual-
 * scroll renderer (`./DiffBody`) — new placement.
 *
 * Open / closed semantics:
 * - Default open during in-flight statuses (running / merging /
 *   planning / awaiting_approval / awaiting_human_fix) — see
 *   `computeSidebarOpen` for the full list.
 * - User toggle via the header collapse button overrides the
 *   default for the rest of the run; cleared on `reset`.
 *
 * Selection:
 * - Worker's "N files" chip click → reset selection to that worker.
 * - Modifier-click → add to selection (multi-worker union view,
 *   per-worker section headers below).
 * - Single-click on a chip already in the selection: re-renders
 *   single-worker view (replaces the multi-select).
 *
 * Width:
 * - 480 px default; resizable 320-720 via the drag handle on the
 *   left edge. Persisted to settings (`inlineDiffSidebarWidth`).
 *
 * Backwards-compat note: this is the new default surface for diff
 * inspection. `DiffPopover.tsx` remains exported and tested through
 * Phase 7 Step 8 — chip click does NOT auto-open the legacy popover
 * any more; tests that exercise the popover directly continue to
 * pass.
 */

const MIN_WIDTH = 320;
const MAX_WIDTH = 720;

export function InlineDiffSidebar() {
  const open = useGraphStore(computeSidebarOpen);
  const width = useGraphStore((s) => s.inlineDiffSidebarWidth);
  const selection = useGraphStore((s) => s.inlineDiffSelection);
  const subtaskDiffs = useGraphStore((s) => s.subtaskDiffs);
  const subtasks = useGraphStore((s) => s.subtasks);
  const { toggleInlineDiffSidebar, setInlineDiffSidebarWidth, clearDiffSelection } = useGraphStore(
    useShallow((s) => ({
      toggleInlineDiffSidebar: s.toggleInlineDiffSidebar,
      setInlineDiffSidebarWidth: s.setInlineDiffSidebarWidth,
      clearDiffSelection: s.clearDiffSelection,
    })),
  );

  // Worker entries for currently-selected ids, in stable plan order.
  const selectedEntries = useMemo(() => {
    const entries: { id: string; title: string; files: readonly FileDiff[] }[] = [];
    for (const sub of subtasks) {
      if (!selection.has(sub.id)) continue;
      const files = subtaskDiffs.get(sub.id);
      if (!files) continue;
      entries.push({ id: sub.id, title: sub.title, files });
    }
    return entries;
  }, [selection, subtaskDiffs, subtasks]);

  if (!open) {
    // Collapsed: render a thin spine with a re-open button. Stays
    // mounted so the "open by default" derivation can re-fire when
    // status flips back to in-flight (e.g. follow-up runs in Step 5).
    return (
      <aside
        className="flex h-full shrink-0 flex-col border-l"
        style={{
          width: 24,
          borderColor: 'var(--color-border-default)',
          backgroundColor: 'var(--color-bg-elevated)',
        }}
        data-testid="inline-diff-sidebar-collapsed"
      >
        <button
          type="button"
          onClick={toggleInlineDiffSidebar}
          aria-label="Open diff sidebar"
          className="h-8 w-full text-meta text-fg-tertiary hover:text-fg-primary"
          data-testid="inline-diff-sidebar-open-button"
        >
          ‹
        </button>
      </aside>
    );
  }

  return (
    <aside
      className="flex h-full shrink-0 flex-col border-l"
      style={{
        width,
        borderColor: 'var(--color-border-default)',
        backgroundColor: 'var(--color-bg-elevated)',
      }}
      data-testid="inline-diff-sidebar"
      data-width={width}
    >
      <ResizeHandle width={width} onWidthChange={setInlineDiffSidebarWidth} />
      <Header
        count={selectedEntries.length}
        onClose={toggleInlineDiffSidebar}
        onClear={clearDiffSelection}
      />
      {selectedEntries.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {selectedEntries.map((entry) => (
            <WorkerSection
              key={entry.id}
              title={entry.title}
              files={entry.files}
              showHeader={selectedEntries.length > 1}
            />
          ))}
        </div>
      )}
    </aside>
  );
}

function Header({
  count,
  onClose,
  onClear,
}: {
  count: number;
  onClose: () => void;
  onClear: () => void;
}) {
  return (
    <header
      className="flex items-center justify-between border-b px-3 py-2 text-hint uppercase tracking-wide text-fg-secondary"
      style={{ borderColor: 'var(--color-border-default)' }}
    >
      <span>
        {count === 0
          ? 'Diff sidebar'
          : count === 1
            ? '1 worker selected'
            : `${count} workers selected`}
      </span>
      <span className="flex items-center gap-2">
        {count > 0 ? (
          <button
            type="button"
            onClick={onClear}
            className="text-fg-tertiary hover:text-fg-primary"
            aria-label="Clear diff sidebar selection"
            data-testid="inline-diff-sidebar-clear"
          >
            clear
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          className="text-fg-tertiary hover:text-fg-primary"
          aria-label="Close diff sidebar"
          data-testid="inline-diff-sidebar-close"
        >
          <span aria-hidden>×</span>
        </button>
      </span>
    </header>
  );
}

function EmptyState() {
  return (
    <div
      className="flex flex-1 items-center justify-center px-4 text-center text-meta italic text-fg-tertiary"
      data-testid="inline-diff-sidebar-empty"
    >
      Click &ldquo;N files&rdquo; on a worker to view changes.
    </div>
  );
}

function WorkerSection({
  title,
  files,
  showHeader,
}: {
  title: string;
  files: readonly FileDiff[];
  showHeader: boolean;
}) {
  return (
    <section className="border-b last:border-b-0" style={{ borderColor: 'var(--color-border-default)' }}>
      {showHeader ? (
        <h3
          className="flex items-center justify-between px-3 py-1.5 text-hint uppercase tracking-wide text-fg-tertiary"
          style={{ backgroundColor: 'var(--color-bg-subtle)' }}
          data-testid="inline-diff-sidebar-worker-header"
        >
          <span className="truncate" title={title}>
            {title}
          </span>
          <span className="shrink-0 font-mono tabular-nums">
            {files.length} file{files.length === 1 ? '' : 's'}
          </span>
        </h3>
      ) : null}
      {files.length === 0 ? (
        <p className="px-3 py-2 text-meta italic text-fg-tertiary">
          This subtask ran but touched no files.
        </p>
      ) : (
        <ul className="flex flex-col" data-testid="inline-diff-sidebar-file-list">
          {files.map((f) => (
            <DiffFileRow key={f.path} file={f} />
          ))}
        </ul>
      )}
    </section>
  );
}

function DiffFileRow({ file }: { file: FileDiff }) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const label = renderPathLabel(file);
  const variantLabel = renderVariantSuffix(file.status);

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
        data-testid="inline-diff-sidebar-file-header"
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
              data-testid="inline-diff-sidebar-body-loading"
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

function ResizeHandle({
  width,
  onWidthChange,
}: {
  width: number;
  onWidthChange: (width: number) => Promise<void>;
}) {
  const [draggingFrom, setDraggingFrom] = useState<{ x: number; w: number } | null>(null);

  // Track current prop value via layout-effect ref so the mousedown
  // handler reads the latest committed width without re-creating the
  // callback on every prop tick. (Writing refs during render is a
  // react-hooks/refs lint error; layout effect runs post-commit.)
  const widthRef = useRef(width);
  useLayoutEffect(() => {
    widthRef.current = width;
  }, [width]);

  // Optimistic width during drag — committed on mouseup. Held in
  // state so the parent's `inlineDiffSidebarWidth` flips through the
  // store as the user drags.
  const [optimisticWidth, setOptimisticWidth] = useState<number | null>(null);
  const optimisticRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    optimisticRef.current = optimisticWidth;
  }, [optimisticWidth]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDraggingFrom({ x: e.clientX, w: widthRef.current });
    setOptimisticWidth(widthRef.current);
  }, []);

  useEffect(() => {
    if (!draggingFrom) return;
    function onMove(e: MouseEvent) {
      if (!draggingFrom) return;
      // Sidebar lives at the right edge; dragging left = wider.
      const dx = draggingFrom.x - e.clientX;
      const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, draggingFrom.w + dx));
      setOptimisticWidth(next);
    }
    function onUp() {
      const finalWidth = optimisticRef.current ?? widthRef.current;
      setDraggingFrom(null);
      setOptimisticWidth(null);
      void onWidthChange(finalWidth);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [draggingFrom, onWidthChange]);

  // While dragging, mirror the optimistic width into the store so the
  // aside re-renders with the new size on every move tick. Persistence
  // is skipped during drag — mouseup commits via `onWidthChange`.
  useEffect(() => {
    if (optimisticWidth === null) return;
    useGraphStore.setState({ inlineDiffSidebarWidth: optimisticWidth });
  }, [optimisticWidth]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize diff sidebar"
      onMouseDown={onMouseDown}
      className="absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize hover:bg-[var(--color-border-default)]"
      data-testid="inline-diff-sidebar-resize-handle"
      data-dragging={draggingFrom !== null ? 'true' : 'false'}
    />
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
