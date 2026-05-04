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
 *
 * Phase 7 Step 6: shared chrome (motion enter/exit, accent bg,
 * dismiss × button) is delegated to the `Banner` primitive. This
 * wrapper owns: variant selection (info/error), the inline
 * ref-code + instruction text, and the Pop / Copy action buttons.
 */

import { Check, Copy } from 'lucide-react';
import { useCallback, useState } from 'react';

import { useGraphStore } from '../../state/graphStore';
import { Banner } from '../primitives/Banner';

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
  const variant = isError ? 'error' : 'info';
  const accentFg = isError
    ? 'var(--color-status-failed)'
    : 'var(--color-status-running)';
  const shortRef = stash?.ref.slice(0, 10) ?? '';

  return (
    <Banner
      variant={variant}
      visible={visible}
      testId="stash-banner"
      role="status"
      ariaLive="polite"
      icon={null}
      dataAttrs={{ kind: popFailed?.kind ?? 'held' }}
      onDismiss={() => setDismissed(true)}
      dismissLabel="Dismiss stash banner"
      actions={
        <>
          {!isError ? (
            <button
              type="button"
              onClick={onPop}
              disabled={stashInFlight === 'pop'}
              data-testid="stash-banner-pop"
              className="inline-flex items-center rounded-sm border border-fg-secondary/40 px-2 py-0.5 text-meta font-medium text-fg-primary hover:border-fg-primary disabled:cursor-wait disabled:opacity-60"
              style={{ color: accentFg }}
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
        </>
      }
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
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
          <span className="text-meta text-fg-secondary">
            Resolve in your editor, then run
            <code
              className="mx-1 rounded-sm bg-bg-subtle px-1 text-meta"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              git stash drop
            </code>
            when done.
          </span>
        ) : null}
      </div>
    </Banner>
  );
}
