import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';

import { useToastStore, type ToastKind } from '../../state/toastStore';

/**
 * Transient toast stack — bottom-right overlay, mounted once in App
 * parallel to ErrorBanner / AutoApproveSuspendedBanner. Reads the
 * queue from `useToastStore` and renders each toast with an
 * icon-accent stripe and a dismiss button. Auto-dismiss lives in the
 * store (not here) so a toast cycling out of view doesn't leave
 * dangling timers.
 *
 * Stacking order: newest on top. Max visible = the whole queue — we
 * don't cap because the only producer today is WorktreeActions, which
 * can only emit a handful at a time. If Phase 5's settings flows start
 * spamming, swap in a cap + "N more" affordance.
 */
type Accent = { fg: string; bg: string; Icon: typeof AlertCircle };

const ACCENT: Record<ToastKind, Accent> = {
  success: {
    fg: 'var(--color-status-success)',
    // ~10% alpha of --color-status-success (#10b981)
    bg: 'rgba(16, 185, 129, 0.12)',
    Icon: CheckCircle2,
  },
  error: {
    fg: 'var(--color-status-failed)',
    bg: 'rgba(239, 68, 68, 0.12)',
    Icon: AlertCircle,
  },
  info: {
    fg: 'var(--color-fg-primary)',
    bg: 'rgba(232, 232, 232, 0.08)',
    Icon: Info,
  },
};

export function ToastStack() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[320px] flex-col-reverse gap-2"
      aria-live="polite"
      aria-atomic="false"
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => {
          const accent = ACCENT[t.kind];
          const Icon = accent.Icon;
          return (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              role={t.kind === 'error' ? 'alert' : 'status'}
              className="pointer-events-auto flex items-start gap-2 rounded-md px-3 py-2 text-body shadow-lg"
              style={{
                background: accent.bg,
                border: `1px solid ${accent.fg}`,
                color: 'var(--color-fg-primary)',
              }}
            >
              <Icon size={14} style={{ color: accent.fg, flexShrink: 0, marginTop: 2 }} />
              <span className="flex-1 text-meta">{t.message}</span>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss notification"
                className="inline-flex size-5 flex-shrink-0 items-center justify-center rounded-sm text-fg-secondary hover:bg-bg-subtle hover:text-fg-primary"
              >
                <X size={12} />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
