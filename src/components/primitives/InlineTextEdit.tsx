import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';

/**
 * Inline text editor for subtask title / why. Lives inside a React Flow node,
 * so the interactive element wears `nodrag nopan` (and `nowheel` for the
 * multiline textarea) to defeat RF's pointer-event interception. See
 * GraphCanvas pointer-events discussion for why these classes are required.
 *
 * Save/cancel rules:
 * - Single-line: Enter saves, Escape cancels, blur saves.
 * - Multiline (textarea): Cmd/Ctrl+Enter saves (Enter inserts newline),
 *   Escape cancels, blur saves. Textareas auto-grow to content with a
 *   hard max-height of 200px, then scroll — keeps dagre layout predictable.
 *
 * Validation:
 * - `validate(next)` returns a non-null message to reject the save. The field
 *   shakes, keeps edit mode open, and surfaces the message as an `aria-errormessage`.
 * - `onSave` may return a Promise; rejection triggers the same shake path.
 *
 * Soft character limit + counter:
 * - When `softLimit` is provided and current length >= `softLimitWarnAt` (default
 *   `softLimit - 20`), a counter appears. Red at >= softLimit. This is advisory;
 *   the backend enforces its own hard floor independently.
 */
export type InlineTextEditProps = {
  value: string;
  onSave: (next: string) => void | Promise<void>;
  onCancel?: () => void;
  validate?: (next: string) => string | null;
  placeholder?: string;
  ariaLabel: string;
  /** Classes applied in display mode (inherit title styling, etc). */
  textClassName?: string;
  /** Classes applied to the edit-mode input/textarea. */
  inputClassName?: string;
  multiline?: boolean;
  /** Hidden hard floor — browser enforces `maxlength`. */
  maxLength?: number;
  /** Soft limit that triggers the counter UI. Omit to hide the counter. */
  softLimit?: number;
  /** Counter appears at this length. Defaults to `softLimit - 20`. */
  softLimitWarnAt?: number;
  /** Immediately enter edit mode on mount. Used for newly-added subtasks. */
  autoEnterEdit?: boolean;
  /** Display-mode text for an empty value (italic "Add context…" etc). */
  emptyPlaceholder?: string;
  /** Disable click-to-edit entirely (used when subtask is no longer editable). */
  disabled?: boolean;
};

// Design token: 300ms total, 4 oscillations at ±3px. See index.css.
const SHAKE_ANIMATION: CSSProperties['animation'] = 'inline-edit-shake 300ms ease-in-out';

// Cmd on macOS, Ctrl elsewhere — keep the test-friendly version here so we
// don't need to stub navigator platform in jsdom.
function isSaveChord(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
  return e.key === 'Enter' && (e.metaKey || e.ctrlKey);
}

export function InlineTextEdit({
  value,
  onSave,
  onCancel,
  validate,
  placeholder,
  ariaLabel,
  textClassName = 'text-body text-fg-primary',
  inputClassName = '',
  multiline = false,
  maxLength,
  softLimit,
  softLimitWarnAt,
  autoEnterEdit = false,
  emptyPlaceholder,
  disabled = false,
}: InlineTextEditProps) {
  const [editing, setEditing] = useState(autoEnterEdit);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [shaking, setShaking] = useState(false);
  const [saving, setSaving] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Draft is re-seeded on each enterEdit() call (see below) and on cancel().
  // No passive effect syncs value → draft: in display mode we render `value`
  // directly (draft is invisible + stale); in edit mode the user's typing is
  // the truth until they save or cancel. This avoids react-hooks/set-state-in-
  // effect warnings and correctly handles re-plan-mid-edit (Escape restores
  // the *current* prop, not the prop captured at edit-entry).
  // before the browser paints — no flash of unselected input.
  useLayoutEffect(() => {
    if (!editing) return;
    const el = multiline ? textareaRef.current : inputRef.current;
    if (!el) return;
    el.focus();
    if (el instanceof HTMLInputElement) el.select();
    else el.setSelectionRange(el.value.length, el.value.length);
  }, [editing, multiline]);

  // Auto-grow textarea: reset height to auto, then set to scrollHeight
  // capped at 200px. Matches the "max-height 200px then scroll" decision.
  useLayoutEffect(() => {
    if (!editing || !multiline) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [draft, editing, multiline]);

  const enterEdit = useCallback(() => {
    if (disabled) return;
    setDraft(value);
    setError(null);
    setEditing(true);
  }, [disabled, value]);

  const cancel = useCallback(() => {
    setDraft(value);
    setError(null);
    setEditing(false);
    onCancel?.();
  }, [onCancel, value]);

  const triggerShake = useCallback(() => {
    setShaking(true);
    window.setTimeout(() => setShaking(false), 320);
  }, []);

  const commit = useCallback(async () => {
    const next = draft;
    if (next === value) {
      // No-op save — just exit edit mode, don't round-trip to backend.
      setEditing(false);
      setError(null);
      return;
    }
    const validationError = validate?.(next) ?? null;
    if (validationError !== null) {
      setError(validationError);
      triggerShake();
      return;
    }
    try {
      setSaving(true);
      await onSave(next);
      setEditing(false);
      setError(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Save failed';
      setError(message);
      triggerShake();
    } finally {
      setSaving(false);
    }
  }, [draft, onSave, triggerShake, validate, value]);

  if (!editing) {
    const display = value.trim().length > 0 ? value : emptyPlaceholder ?? placeholder ?? '';
    const isEmpty = value.trim().length === 0;
    return (
      <button
        type="button"
        onClick={enterEdit}
        disabled={disabled}
        aria-label={`Edit ${ariaLabel}`}
        className={`nodrag nopan block w-full cursor-text text-left ${textClassName} ${
          isEmpty ? 'italic text-fg-tertiary' : ''
        } ${disabled ? 'cursor-default' : 'hover:bg-bg-subtle/40'}`}
        style={{
          background: 'transparent',
          border: 'none',
          padding: 0,
          // Allow normal wrapping in display mode; truncation is the caller's job.
          whiteSpace: multiline ? 'pre-wrap' : undefined,
        }}
      >
        {display || '\u00A0'}
      </button>
    );
  }

  const errorId = error ? `${ariaLabel}-error` : undefined;
  const length = draft.length;
  const warnAt = softLimitWarnAt ?? (softLimit !== undefined ? Math.max(0, softLimit - 20) : null);
  const showCounter = softLimit !== undefined && warnAt !== null && length >= warnAt;
  const overSoft = softLimit !== undefined && length >= softLimit;

  const commonStyle: CSSProperties = {
    background: 'var(--color-bg-primary)',
    border: `2px solid var(--color-status-pending)`,
    borderRadius: 4,
    outline: 'none',
    color: 'var(--color-fg-primary)',
    animation: shaking ? SHAKE_ANIMATION : undefined,
    padding: '4px 6px',
  };

  // Save on blur — but only when the blur isn't caused by the save committing
  // itself (e.g., input disables during saving → blur fires). We guard via
  // the `saving` flag.
  const onBlur = () => {
    if (saving) return;
    void commit();
  };

  return (
    <div className="relative w-full">
      {multiline ? (
        <textarea
          ref={textareaRef}
          value={draft}
          disabled={saving}
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-invalid={error ? 'true' : undefined}
          aria-errormessage={errorId}
          maxLength={maxLength}
          rows={1}
          className={`nodrag nopan nowheel block w-full resize-none font-mono ${inputClassName}`}
          style={{ ...commonStyle, minHeight: 28, maxHeight: 200, overflowY: 'auto' }}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
              return;
            }
            if (isSaveChord(e)) {
              e.preventDefault();
              void commit();
            }
          }}
          onBlur={onBlur}
        />
      ) : (
        <input
          ref={inputRef}
          type="text"
          value={draft}
          disabled={saving}
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-invalid={error ? 'true' : undefined}
          aria-errormessage={errorId}
          maxLength={maxLength}
          className={`nodrag nopan block w-full font-mono ${inputClassName}`}
          style={commonStyle}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
              return;
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              void commit();
            }
          }}
          onBlur={onBlur}
        />
      )}
      {showCounter ? (
        <span
          className="pointer-events-none absolute text-hint"
          style={{
            right: 6,
            bottom: multiline ? 4 : '50%',
            transform: multiline ? undefined : 'translateY(50%)',
            color: overSoft ? 'var(--color-status-failed)' : 'var(--color-fg-tertiary)',
          }}
          data-testid="inline-edit-counter"
        >
          {length}
          {softLimit ? `/${softLimit}` : null}
        </span>
      ) : null}
      {error ? (
        <span
          id={errorId}
          role="alert"
          className="mt-1 block text-hint"
          style={{ color: 'var(--color-status-failed)' }}
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}
