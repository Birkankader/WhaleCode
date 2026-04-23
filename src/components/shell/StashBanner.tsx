/**
 * Phase 5 Step 2 — stash status banner.
 *
 * Renders when the backend has captured a stash via
 * `stash_and_retry_apply`. Three states:
 *
 *   - **Held (happy path)** — info banner with "Pop stash" (primary),
 *     "Copy ref" (secondary), "Dismiss" (hide in-session). Visible
 *     post-apply while the stash sits in `git stash` awaiting the
 *     user's decision.
 *   - **Popping** — the pop IPC is in flight. The primary button
 *     flips to "Popping…" disabled.
 *   - **Pop failed (conflict)** — error banner instructing the user
 *     to resolve in their editor + `git stash drop` when done. The
 *     stash ref remains held until the user resolves; we don't
 *     auto-retry pop.
 *
 * Missing-ref pop failures clear `stash` server-side and we don't
 * render anything (the held state is gone). That path is accompanied
 * by a toast in `StashToastBridge` so the user sees the outcome.
 *
 * Lives in the main element alongside ErrorBanner so it layers above
 * the graph canvas without disturbing layout.
 */

import { AnimatePresence, motion } from 'framer-motion';
import { Check, Copy, X } from 'lucide-react';
import { useCallback, useState } from 'react';

import { useGraphStore } from '../../state/graphStore';

const ACCENT = {
  info: {
    fg: 'var(--color-status-running)',
    bg: 'rgba(34, 211, 238, 0.1)',
  },
  error: {
    fg: 'var(--color-status-failed)',
    bg: 'rgba(239, 68, 68, 0.1)',
  },
} as const;

export function StashBanner() {
  const stash = useGraphStore((s) => s.stash);
  const stashInFlight = useGraphStore((s) => s.stashInFlight);
  const popStash = useGraphStore((s) => s.popStash);
  const [dismissed, setDismissed] = useState(false);
  const [copied, setCopied] = useState(false);

  const onCopyRef = useCallback(async () => {
    if (!stash) return;
    try {
      await navigator.clipboard.writeText(stash.ref);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard refused (iframed / HTTP). Fall through silently;
      // the ref is still visible inline for manual selection.
    }
  }, [stash]);

  const onPop = useCallback(() => {
    void popStash();
  }, [popStash]);

  // Dismiss resets on new stash ref — we key the local dismissed flag
  // on the ref string so switching runs (new stash) re-shows the
  // banner without session state leaking.
  const visible = stash !== null && !dismissed;
  const popFailed = stash?.popFailed ?? null;
  const isError = popFailed?.kind === 'conflict';
  const accent = isError ? ACCENT.error : ACCENT.info;
  const shortRef = stash?.ref.slice(0, 10) ?? '';

  return (
    <AnimatePresence>
      {visible ? (
        <motion.div
          key={`stash-banner-${stash?.ref ?? 'none'}`}
          initial={{ y: '-100%' }}
          animate={{ y: 0 }}
          exit={{ y: '-100%' }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          role="status"
          data-testid="stash-banner"
          data-kind={popFailed?.kind ?? 'held'}
          className="relative z-10 flex w-full items-center gap-3 px-4 py-2 text-fg-primary"
          style={{
            background: accent.bg,
            borderBottom: `1px solid ${accent.fg}`,
          }}
        >
          <span className="text-meta text-fg-secondary">
            {isError
              ? 'Stash pop conflicted.'
              : 'WhaleCode is holding your stash.'}
          </span>
          <code
            className="rounded-sm bg-bg-subtle px-1.5 py-0.5 text-meta text-fg-secondary"
            data-testid="stash-banner-ref"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            {shortRef}
          </code>
          {isError ? (
            <span className="flex-1 text-meta text-fg-secondary">
              Resolve in your editor, then run
              <code
                className="mx-1 rounded-sm bg-bg-subtle px-1 text-meta"
                style={{ fontFamily: 'var(--font-mono)' }}
              >
                git stash drop
              </code>
              when done.
            </span>
          ) : (
            <span className="flex-1" />
          )}
          {!isError ? (
            <button
              type="button"
              onClick={onPop}
              disabled={stashInFlight === 'pop'}
              data-testid="stash-banner-pop"
              className="inline-flex items-center rounded-sm border border-fg-secondary/40 px-2 py-0.5 text-meta font-medium text-fg-primary hover:border-fg-primary disabled:cursor-wait disabled:opacity-60"
              style={{ color: accent.fg }}
            >
              {stashInFlight === 'pop' ? 'Popping…' : 'Pop stash'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onCopyRef}
            aria-label={copied ? 'Ref copied' : 'Copy stash ref'}
            data-testid="stash-banner-copy"
            className="inline-flex size-6 flex-shrink-0 items-center justify-center rounded-sm text-fg-secondary hover:bg-bg-subtle hover:text-fg-primary"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label="Dismiss stash banner"
            data-testid="stash-banner-dismiss"
            className="inline-flex size-6 flex-shrink-0 items-center justify-center rounded-sm text-fg-secondary hover:bg-bg-subtle hover:text-fg-primary"
          >
            <X size={14} />
          </button>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
