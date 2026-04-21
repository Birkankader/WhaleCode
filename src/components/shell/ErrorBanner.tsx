import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, ChevronDown, ChevronRight, X } from 'lucide-react';
import { useState } from 'react';

import { useGraphStore } from '../../state/graphStore';

type Variant = 'error' | 'warning';

type Props = {
  /**
   * Visual accent. Phase 2 always renders 'error'; 'warning' is wired now so
   * Phase 3 can surface non-fatal signals without refactoring this component.
   */
  variant?: Variant;
};

const ACCENT: Record<Variant, { fg: string; bg: string }> = {
  error: {
    fg: 'var(--color-status-failed)',
    // ~10% alpha of --color-status-failed (#ef4444)
    bg: 'rgba(239, 68, 68, 0.1)',
  },
  warning: {
    fg: 'var(--color-status-pending)',
    // ~10% alpha of --color-status-pending (#fbbf24)
    bg: 'rgba(251, 191, 36, 0.1)',
  },
};

export function ErrorBanner({ variant = 'error' }: Props) {
  const currentError = useGraphStore((s) => s.currentError);
  const dismissError = useGraphStore((s) => s.dismissError);
  const [expanded, setExpanded] = useState(false);

  const { summary, details } = splitError(currentError);
  const accent = ACCENT[variant];
  const visible = currentError !== null;

  return (
    <AnimatePresence>
      {visible ? (
        <motion.div
          key="error-banner"
          initial={{ y: '-100%' }}
          animate={{ y: 0 }}
          exit={{ y: '-100%' }}
          transition={{ duration: 0.2, ease: visible ? 'easeOut' : 'easeIn' }}
          role="alert"
          aria-live="assertive"
          data-variant={variant}
          className="relative z-10 flex w-full flex-col gap-2 px-4 py-3 text-fg-primary"
          style={{
            background: accent.bg,
            borderBottom: `1px solid ${accent.fg}`,
          }}
        >
          <div className="flex items-start gap-2">
            <AlertCircle size={16} style={{ color: accent.fg, flexShrink: 0, marginTop: 2 }} />
            <div className="flex flex-1 flex-col gap-1">
              <span className="text-body">{summary}</span>
              {details ? (
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  className="inline-flex w-fit items-center gap-1 text-meta text-fg-secondary hover:text-fg-primary"
                  aria-expanded={expanded}
                >
                  {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <span>{expanded ? 'Hide details' : 'Show details'}</span>
                </button>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => {
                setExpanded(false);
                dismissError();
              }}
              aria-label="Dismiss error"
              className="inline-flex size-6 flex-shrink-0 items-center justify-center rounded-sm text-fg-secondary hover:bg-bg-subtle hover:text-fg-primary"
            >
              <X size={14} />
            </button>
          </div>
          {details && expanded ? (
            <pre
              className="ml-6 max-h-[200px] overflow-auto whitespace-pre-wrap break-words rounded-sm bg-bg-subtle px-2 py-1.5 text-meta text-fg-secondary"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              {details}
            </pre>
          ) : null}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/**
 * Split a raw error string into the first line (summary) and the rest (details).
 * Single-line errors have no details; multi-line errors keep the tail in a
 * collapsed mono block. Keeping this as pure text avoids needing a structured
 * error type before Phase 3 defines one.
 */
function splitError(err: string | null): { summary: string; details: string | null } {
  if (err === null) return { summary: '', details: null };
  const idx = err.indexOf('\n');
  if (idx === -1) return { summary: err, details: null };
  return {
    summary: err.slice(0, idx).trimEnd(),
    details: err.slice(idx + 1).trimEnd() || null,
  };
}
