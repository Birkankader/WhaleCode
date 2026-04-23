import {
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';

import { useGraphStore } from '../../state/graphStore';

const TITLE = 'WhaleCode';
const TAGLINE = 'Your AI team, orchestrated visually';
const PLACEHOLDER = 'What should the team build?';

/**
 * Max textarea height in rows. Contents that exceed this cap scroll
 * internally rather than pushing the submit-hint row off-screen. 8
 * rows ≈ 200px at 24px line-height — generous enough for a real
 * multi-paragraph task without swallowing the viewport.
 */
const MAX_ROWS = 8;

export function EmptyState() {
  const submitTask = useGraphStore((s) => s.submitTask);
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow 1 → MAX_ROWS rows as the user types. Uses the
  // "reset to auto → read scrollHeight → clamp" pattern so the
  // measurement is independent of the textarea's current height.
  // `useLayoutEffect` fires before paint, so the user never sees a
  // single-frame resize flicker.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const style = window.getComputedStyle(el);
    const lineHeight = parseFloat(style.lineHeight) || 24;
    const paddingY =
      parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const borderY =
      parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    const maxHeight = lineHeight * MAX_ROWS + paddingY + borderY;
    const next = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${next}px`;
  }, [value]);

  async function launch(trimmed: string) {
    if (submitting) return;
    setSubmitting(true);
    try {
      await submitTask(trimmed);
    } catch (err) {
      // `submitTask` has already surfaced the error via `currentError`; the
      // banner (Commit 3) renders it. Swallow to avoid an unhandled rejection.
      console.error('[EmptyState] submitTask failed', err);
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    void launch(trimmed);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter submits; Shift+Enter inserts a newline (default behavior
    // of the textarea when we don't preventDefault).
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const trimmed = value.trim();
      if (!trimmed) return;
      void launch(trimmed);
    }
  }

  return (
    <div className="flex h-full w-full items-center justify-center px-6">
      <form onSubmit={handleSubmit} className="flex w-full max-w-[560px] flex-col items-center">
        <h1 className="text-title font-medium text-fg-primary" style={{ letterSpacing: '0.5px' }}>
          {TITLE}
        </h1>
        <p className="mt-2 text-meta text-fg-tertiary">{TAGLINE}</p>

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={PLACEHOLDER}
          autoFocus
          disabled={submitting}
          rows={1}
          className="mt-12 w-full resize-none overflow-y-auto rounded-lg border border-border-default bg-bg-elevated px-5 py-[18px] text-[20px] leading-[1.4] text-fg-primary placeholder:text-fg-secondary focus:border-[var(--color-agent-master)] focus:outline-none disabled:opacity-60"
          aria-label={PLACEHOLDER}
        />

        <div className="mt-3 flex w-full items-center gap-1.5 text-hint text-fg-tertiary">
          <KeyChip>Enter</KeyChip>
          <span>to start</span>
          <span>·</span>
          <KeyChip>Shift</KeyChip>
          <span>+</span>
          <KeyChip>Enter</KeyChip>
          <span>for newline</span>
        </div>
      </form>
    </div>
  );
}

function KeyChip({ children }: { children: string }) {
  return (
    <span className="inline-flex items-center rounded-sm border border-border-default bg-bg-elevated px-1.5 py-0.5 text-hint text-fg-secondary">
      {children}
    </span>
  );
}
