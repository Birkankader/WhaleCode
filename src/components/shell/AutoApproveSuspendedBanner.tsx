/**
 * Warning banner shown when the backend emits
 * `run:auto_approve_suspended` — the run hit its configured ceiling
 * and the approval path reverted to manual for the remainder of the
 * run. The backend latches this per-run, so the banner shows at most
 * once per run regardless of how many further passes fall back to
 * manual.
 *
 * Distinct from `ErrorBanner`: not an error, and it reads from a
 * different piece of store state (`autoApproveSuspended`) so the two
 * can coexist vertically if they both fire in the same frame.
 */

import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, X } from 'lucide-react';

import { useGraphStore } from '../../state/graphStore';

const REASON_COPY: Record<string, string> = {
  subtask_limit:
    'Auto-approve suspended: this run hit the configured subtask ceiling. Remaining plan passes need manual approval.',
};

export function AutoApproveSuspendedBanner() {
  const suspended = useGraphStore((s) => s.autoApproveSuspended);
  const dismiss = useGraphStore((s) => s.dismissAutoApproveSuspended);

  const visible = suspended !== null;
  const message = suspended
    ? REASON_COPY[suspended.reason] ??
      'Auto-approve suspended: remaining plan passes need manual approval.'
    : '';

  const fg = 'var(--color-status-pending)';
  const bg = 'rgba(251, 191, 36, 0.1)';

  return (
    <AnimatePresence>
      {visible ? (
        <motion.div
          key="auto-approve-suspended"
          initial={{ y: '-100%' }}
          animate={{ y: 0 }}
          exit={{ y: '-100%' }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          role="status"
          aria-live="polite"
          data-testid="auto-approve-suspended-banner"
          className="relative z-10 flex w-full items-start gap-2 px-4 py-3 text-fg-primary"
          style={{
            background: bg,
            borderBottom: `1px solid ${fg}`,
          }}
        >
          <AlertCircle size={16} style={{ color: fg, flexShrink: 0, marginTop: 2 }} />
          <span className="flex-1 text-body">{message}</span>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss auto-approve suspended notice"
            className="inline-flex size-6 flex-shrink-0 items-center justify-center rounded-sm text-fg-secondary hover:bg-bg-subtle hover:text-fg-primary"
          >
            <X size={14} />
          </button>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
