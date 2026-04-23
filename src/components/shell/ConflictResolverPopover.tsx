/**
 * Phase 5 Step 3 — merge conflict resolver popover.
 *
 * Opens from the ErrorBanner "Open resolver" action when the run is
 * in Merging with an unresolved conflict (store `mergeConflict !==
 * null`). Surfaces:
 *
 *   - The conflicted file list;
 *   - Per-file worker attribution — which workers touched this path,
 *     joined client-side against `subtaskDiffs`;
 *   - Per-worker "Open worktree" button that reuses Phase 4 Step 4's
 *     `revealWorktree` IPC so the user can inspect each worker's
 *     version of the file in their file manager;
 *   - A "Retry apply" button that fires the `retry_apply` IPC;
 *   - Retry-attempt counter on subsequent failures.
 *
 * Ships the workflow, not an in-app merge editor. Users resolve in
 * their own tool on the base branch; "Retry apply" re-enters the
 * merge oneshot. If the retry conflicts again, the popover stays
 * open (via the store's persistent `mergeConflict` state) with the
 * attempt counter bumped.
 *
 * Rendered as a modal-style overlay anchored to the viewport center
 * — a React Flow node's transform context doesn't reach here so no
 * portal is needed (the component is mounted outside the canvas in
 * App.tsx). The Escape key / backdrop click dismiss it; the
 * conflict state remains so the "Open resolver" action is available
 * to reopen.
 */

import { AnimatePresence, motion } from 'framer-motion';
import { Folder, RefreshCcw, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { revealWorktree } from '../../lib/ipc';
import { useGraphStore } from '../../state/graphStore';
import { useToastStore } from '../../state/toastStore';

type WorkerTouch = {
  subtaskId: string;
  title: string;
};

type ConflictRow = {
  path: string;
  touches: WorkerTouch[];
};

export function ConflictResolverPopover() {
  const runId = useGraphStore((s) => s.runId);
  const mergeConflict = useGraphStore((s) => s.mergeConflict);
  const subtaskDiffs = useGraphStore((s) => s.subtaskDiffs);
  const subtasks = useGraphStore((s) => s.subtasks);
  const retryApplyInFlight = useGraphStore((s) => s.retryApplyInFlight);
  const retryApply = useGraphStore((s) => s.retryApply);
  const open = useGraphStore((s) => s.conflictResolverOpen);
  const setOpen = useGraphStore((s) => s.setConflictResolverOpen);
  const show = useToastStore((s) => s.show);

  const [revealingSubtaskId, setRevealingSubtaskId] = useState<string | null>(
    null,
  );

  // Escape dismisses (consistent with Phase 4 popovers).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  // Cross-reference `mergeConflict.files` with `subtaskDiffs` to build
  // per-file worker attribution. Freeze result to stabilize identity
  // across renders.
  const rows: ConflictRow[] = useMemo(() => {
    if (!mergeConflict) return [];
    // Build { path -> subtaskId[] } from subtaskDiffs.
    const byPath = new Map<string, Set<string>>();
    subtaskDiffs.forEach((files, sid) => {
      for (const fd of files) {
        let bucket = byPath.get(fd.path);
        if (!bucket) {
          bucket = new Set();
          byPath.set(fd.path, bucket);
        }
        bucket.add(sid);
      }
    });
    const subtaskTitle = new Map(subtasks.map((s) => [s.id, s.title]));
    return mergeConflict.files.map((path) => {
      const touched = byPath.get(path) ?? new Set<string>();
      const touches: WorkerTouch[] = [];
      for (const sid of touched) {
        const title = subtaskTitle.get(sid) ?? sid;
        touches.push({ subtaskId: sid, title });
      }
      return { path, touches };
    });
  }, [mergeConflict, subtaskDiffs, subtasks]);

  const onReveal = useCallback(
    async (subtaskId: string) => {
      if (!runId) return;
      setRevealingSubtaskId(subtaskId);
      try {
        await revealWorktree(runId, subtaskId);
        show({ kind: 'success', message: 'Opened in file manager.' });
      } catch (err) {
        show({
          kind: 'error',
          message: `Could not reveal worktree: ${String(err)}`,
          autoDismissMs: null,
        });
      } finally {
        setRevealingSubtaskId(null);
      }
    },
    [runId, show],
  );

  const onRetry = useCallback(async () => {
    try {
      await retryApply();
      // On success, handleMergeConflict / handleMergeRetryFailed /
      // handleCompleted will clear or refresh the state. We keep the
      // popover open so the user sees the new attempt counter.
    } catch {
      // Error already routed into `currentError` by the store action.
    }
  }, [retryApply]);

  const onDismiss = useCallback(() => {
    setOpen(false);
  }, [setOpen]);

  return (
    <AnimatePresence>
      {open && mergeConflict ? (
        <motion.div
          key="conflict-resolver-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
          onClick={(e) => {
            if (e.target === e.currentTarget) onDismiss();
          }}
          data-testid="conflict-resolver-backdrop"
        >
          <motion.div
            key="conflict-resolver-popover"
            initial={{ y: 8, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 8, opacity: 0 }}
            transition={{ duration: 0.15 }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="conflict-resolver-title"
            data-testid="conflict-resolver-popover"
            className="relative flex max-h-[80vh] w-[560px] flex-col overflow-hidden rounded-md border border-fg-secondary/30 bg-bg-primary shadow-xl"
          >
            <header className="flex items-start justify-between gap-2 border-b border-fg-secondary/20 px-4 py-3">
              <div className="flex flex-col gap-0.5">
                <span
                  id="conflict-resolver-title"
                  className="text-body font-medium text-fg-primary"
                >
                  {mergeConflict.retryAttempt > 0
                    ? `Still conflicted (attempt ${mergeConflict.retryAttempt})`
                    : 'Merge conflict'}
                </span>
                <span className="text-meta text-fg-secondary">
                  Resolve the {mergeConflict.files.length} conflicted file
                  {mergeConflict.files.length === 1 ? '' : 's'} in your editor
                  on the base branch, then click Retry apply.
                </span>
              </div>
              <button
                type="button"
                onClick={onDismiss}
                aria-label="Close resolver"
                data-testid="conflict-resolver-close"
                className="inline-flex size-6 flex-shrink-0 items-center justify-center rounded-sm text-fg-secondary hover:bg-bg-subtle hover:text-fg-primary"
              >
                <X size={14} />
              </button>
            </header>
            <ul
              className="flex flex-1 flex-col gap-3 overflow-auto px-4 py-3"
              data-testid="conflict-resolver-file-list"
            >
              {rows.map((row) => (
                <li
                  key={row.path}
                  className="flex flex-col gap-1.5 rounded-sm border border-fg-secondary/20 px-3 py-2"
                  data-testid="conflict-resolver-file-row"
                >
                  <code
                    className="truncate text-meta text-fg-primary"
                    style={{ fontFamily: 'var(--font-mono)' }}
                    title={row.path}
                  >
                    {row.path}
                  </code>
                  {row.touches.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-1.5 text-meta text-fg-secondary">
                      <span>Touched by</span>
                      {row.touches.map((t) => (
                        <button
                          key={t.subtaskId}
                          type="button"
                          onClick={() => void onReveal(t.subtaskId)}
                          disabled={revealingSubtaskId === t.subtaskId}
                          className="inline-flex items-center gap-1 rounded-sm border border-fg-secondary/40 px-1.5 py-0.5 text-meta text-fg-primary hover:border-fg-primary disabled:cursor-wait disabled:opacity-60"
                          data-testid={`conflict-resolver-reveal-${t.subtaskId}`}
                          title={`Open this worker's worktree in file manager`}
                        >
                          <Folder size={12} aria-hidden="true" />
                          {t.title}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <span className="text-meta text-fg-tertiary">
                      No worker touch recorded.
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <footer className="flex items-center justify-end gap-2 border-t border-fg-secondary/20 px-4 py-3">
              <button
                type="button"
                onClick={onDismiss}
                className="inline-flex items-center rounded-sm border border-fg-secondary/40 px-2.5 py-1 text-meta text-fg-primary hover:border-fg-primary"
                data-testid="conflict-resolver-dismiss"
              >
                Close
              </button>
              <button
                type="button"
                onClick={onRetry}
                disabled={retryApplyInFlight}
                className="inline-flex items-center gap-1 rounded-sm border border-fg-primary bg-fg-primary/10 px-2.5 py-1 text-meta font-medium text-fg-primary hover:bg-fg-primary/20 disabled:cursor-wait disabled:opacity-60"
                data-testid="conflict-resolver-retry"
              >
                <RefreshCcw size={12} aria-hidden="true" />
                {retryApplyInFlight ? 'Retrying…' : 'Retry apply'}
              </button>
            </footer>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
