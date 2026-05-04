/**
 * Bottom-right overlay surfaced on a successful Apply.
 *
 * Phase 4 Step 2. Renders once the backend's `run:apply_summary` event
 * lands (see `graphStore.handleApplySummary`). Displays the aggregate
 * file count, target branch, and the 7-char commit SHA plus a Copy SHA
 * affordance that writes the full 40-char SHA to the clipboard.
 *
 * Per-worker rows read their subtask titles from the graph store so a
 * click pans the canvas via React Flow's `setCenter` — zoom is
 * preserved explicitly (we match WorkerNode's DependsOn pan pattern).
 *
 * Must render inside a `ReactFlowProvider`; `useReactFlow` only works
 * in that subtree. GraphCanvas mounts this as a sibling to its own
 * `<ReactFlow>` element, so the overlay co-exists with the graph
 * without leaving the provider's scope.
 *
 * Sticky: visible until the user dismisses it OR submits a new task.
 * Backend terminal events do not clear it; the ordering invariant
 * guarantees the payload lands after the run is already `applied`.
 */

import { useReactFlow } from '@xyflow/react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, Copy, Send, X } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useShallow } from 'zustand/shallow';

import { NODE_DIMENSIONS } from '../../lib/layout';
import { useGraphStore } from '../../state/graphStore';

const COPY_FEEDBACK_MS = 1500;

/** Short display form of the commit SHA. */
function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function ApplySummaryOverlay() {
  const { applySummary, subtasks, dismiss, submitFollowupRun, followupInFlight } = useGraphStore(
    useShallow((s) => ({
      applySummary: s.applySummary,
      subtasks: s.subtasks,
      dismiss: s.dismissApplySummary,
      submitFollowupRun: s.submitFollowupRun,
      followupInFlight: s.followupInFlight,
    })),
  );
  const { getNode, setCenter, getViewport } = useReactFlow();
  const [copied, setCopied] = useState(false);
  const [followupPrompt, setFollowupPrompt] = useState('');

  const onFollowupSubmit = useCallback(async () => {
    const trimmed = followupPrompt.trim();
    if (trimmed.length === 0) return;
    if (followupInFlight) return;
    try {
      await submitFollowupRun(trimmed);
      setFollowupPrompt('');
    } catch {
      // graphStore action populates currentError — ErrorBanner /
      // toast surface it. Keep the input value so the user can edit
      // and retry without re-typing.
    }
  }, [followupPrompt, followupInFlight, submitFollowupRun]);

  const onCopySha = useCallback(async () => {
    if (!applySummary) return;
    try {
      await navigator.clipboard.writeText(applySummary.commitSha);
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    } catch {
      // Clipboard permission denied — keep the SHA visible in the
      // overlay so the user can still select it manually. No error
      // banner: the SHA is low-stakes chrome, not critical data.
    }
  }, [applySummary]);

  const panToSubtask = useCallback(
    (subtaskId: string) => {
      const node = getNode(subtaskId);
      if (!node) return;
      const w = node.width ?? NODE_DIMENSIONS.worker.width;
      const h = node.height ?? NODE_DIMENSIONS.worker.height;
      const cx = node.position.x + w / 2;
      const cy = node.position.y + h / 2;
      const { zoom } = getViewport();
      // Preserve the user's current zoom — the overlay navigates, it
      // doesn't reframe. Matches WorkerNode's DependsOn pattern.
      void setCenter(cx, cy, { zoom, duration: 300 });
    },
    [getNode, getViewport, setCenter],
  );

  // Index subtasks by id so per-worker rows render in event order
  // rather than subtask-list order — the backend emits per_worker in
  // the order workers finished, which is the chronologically
  // interesting view.
  const titleOf = new Map(subtasks.map((s) => [s.id, s.title]));

  const visible = applySummary !== null;
  const totalFiles = applySummary?.filesChanged ?? 0;
  const branch = applySummary?.branch ?? '';
  const sha = applySummary?.commitSha ?? '';

  return (
    <AnimatePresence>
      {visible && applySummary ? (
        <motion.aside
          key="apply-summary-overlay"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          role="status"
          aria-label="Apply summary"
          data-testid="apply-summary-overlay"
          className="absolute bottom-4 right-4 z-20 flex w-80 flex-col gap-3 rounded-md border border-[var(--color-border-default)] bg-bg-elevated p-4 shadow-xl"
        >
          <header className="flex items-start justify-between gap-2">
            <div className="flex flex-col gap-0.5">
              <span className="text-meta text-fg-tertiary">Applied</span>
              <span className="text-body text-fg-primary">
                {totalFiles === 1
                  ? '1 file changed'
                  : `${totalFiles} files changed`}
              </span>
            </div>
            <button
              type="button"
              onClick={dismiss}
              aria-label="Dismiss apply summary"
              data-testid="apply-summary-dismiss"
              className="inline-flex size-6 flex-shrink-0 items-center justify-center rounded-sm text-fg-secondary hover:bg-bg-subtle hover:text-fg-primary"
            >
              <X size={14} />
            </button>
          </header>

          <div className="flex items-center justify-between gap-2 rounded-sm bg-bg-subtle px-2 py-1.5">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-hint text-fg-tertiary">Branch</span>
              <span className="truncate text-meta text-fg-primary">{branch}</span>
            </div>
            <div className="flex flex-col items-end gap-0.5">
              <span className="text-hint text-fg-tertiary">Commit</span>
              <div className="flex items-center gap-1">
                <code
                  data-testid="apply-summary-sha"
                  className="text-meta text-fg-primary"
                >
                  {shortSha(sha)}
                </code>
                <button
                  type="button"
                  onClick={onCopySha}
                  aria-label="Copy commit SHA"
                  data-testid="apply-summary-copy-sha"
                  className="inline-flex size-5 flex-shrink-0 items-center justify-center rounded-sm text-fg-secondary hover:bg-bg-elevated hover:text-fg-primary"
                >
                  {copied ? (
                    <Check size={12} style={{ color: 'var(--color-status-success)' }} />
                  ) : (
                    <Copy size={12} />
                  )}
                </button>
              </div>
            </div>
          </div>

          {applySummary.perWorker.length > 0 ? (
            <ul
              data-testid="apply-summary-per-worker"
              className="flex flex-col gap-1 border-t border-[var(--color-border-subtle)] pt-2"
            >
              {applySummary.perWorker.map((pw) => {
                const label = titleOf.get(pw.subtaskId) ?? pw.subtaskId;
                const filesLabel =
                  pw.filesChanged === 1 ? '1 file' : `${pw.filesChanged} files`;
                return (
                  <li key={pw.subtaskId}>
                    <button
                      type="button"
                      onClick={() => panToSubtask(pw.subtaskId)}
                      data-testid={`apply-summary-worker-${pw.subtaskId}`}
                      className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1 text-left text-meta text-fg-secondary hover:bg-bg-subtle hover:text-fg-primary"
                    >
                      <span className="truncate">{label}</span>
                      <span className="flex-shrink-0 text-fg-tertiary">
                        {filesLabel}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {/* Phase 7 Step 5: inline follow-up input. Submit on
              Enter triggers the start_followup_run IPC + swaps the
              active subscription to the new child run id. */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void onFollowupSubmit();
            }}
            className="flex items-center gap-1.5 border-t border-[var(--color-border-subtle)] pt-2"
            data-testid="apply-summary-followup-form"
          >
            <input
              type="text"
              value={followupPrompt}
              onChange={(e) => setFollowupPrompt(e.target.value)}
              placeholder="Ask for follow-up changes…"
              maxLength={500}
              disabled={followupInFlight}
              data-testid="apply-summary-followup-input"
              className="min-w-0 flex-1 rounded-sm border border-[var(--color-border-default)] bg-bg-primary px-2 py-1 text-meta text-fg-primary outline-none placeholder:text-fg-tertiary focus:border-[var(--color-fg-secondary)] disabled:opacity-50"
              aria-label="Follow-up prompt"
            />
            <button
              type="submit"
              disabled={
                followupInFlight || followupPrompt.trim().length === 0
              }
              data-testid="apply-summary-followup-submit"
              aria-label={followupInFlight ? 'Starting follow-up' : 'Send follow-up'}
              className="inline-flex size-7 flex-shrink-0 items-center justify-center rounded-sm text-fg-secondary hover:bg-bg-subtle hover:text-fg-primary disabled:opacity-40"
            >
              <Send size={12} />
            </button>
          </form>
          {followupInFlight ? (
            <span
              className="text-hint text-fg-tertiary"
              data-testid="apply-summary-followup-status"
            >
              Starting follow-up…
            </span>
          ) : null}
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}
