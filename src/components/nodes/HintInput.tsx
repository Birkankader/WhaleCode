/**
 * Phase 6 Step 4 — mid-execution hint input on a running worker.
 *
 * Renders inline single-line input on running cards. Submit on
 * Enter → fires `hintSubtask` action → backend cancels worker,
 * parks hint, restarts with appended prompt. Disabled while in
 * flight; flips to "Restarting with your hint…" copy after
 * backend confirms via `SubtaskHintReceived`.
 *
 * Critical: this is restart, not pause. Worker loses partial
 * progress. Placeholder copy makes that explicit.
 *
 * State coordination:
 *   - Visible only on `running` (not `awaiting_input` — Q&A
 *     QuestionInput already lives there; double-input would
 *     confuse the user).
 *   - WorkerNode parent gates visibility; this component assumes
 *     it's mounted.
 */

import { Send } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useCallback, useState } from 'react';

import { useGraphStore } from '../../state/graphStore';

const MAX_LEN = 500;

type Props = { subtaskId: string };

export function HintInput({ subtaskId }: Props) {
  const inFlight = useGraphStore((s) => s.hintInFlight.has(subtaskId));
  const hintSubtask = useGraphStore((s) => s.hintSubtask);
  const [hint, setHint] = useState('');

  const onSubmit = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      if (inFlight) return;
      const trimmed = hint.trim();
      if (trimmed.length === 0) return;
      try {
        await hintSubtask(subtaskId, trimmed);
        setHint('');
      } catch {
        // Error surfaced via store action's currentError; leave
        // the text in the box so the user can retry without losing
        // it. Banner shows the rejection.
      }
    },
    [hint, hintSubtask, inFlight, subtaskId],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void onSubmit();
      } else if (e.key === 'Escape') {
        setHint('');
      }
    },
    [onSubmit],
  );

  return (
    <form
      onSubmit={onSubmit}
      data-testid={`hint-input-${subtaskId}`}
      className="flex flex-col gap-1"
    >
      <div className="flex items-center gap-1.5 rounded-sm border border-fg-secondary/30 bg-bg-subtle/40 px-2 py-1">
        <input
          type="text"
          value={hint}
          onChange={(e) => setHint(e.target.value.slice(0, MAX_LEN))}
          onKeyDown={onKeyDown}
          disabled={inFlight}
          placeholder="Add hint… (worker restarts; partial progress lost)"
          maxLength={MAX_LEN}
          data-testid={`hint-input-field-${subtaskId}`}
          className="flex-1 bg-transparent text-meta text-fg-primary placeholder:text-fg-tertiary focus:outline-none disabled:opacity-60"
          aria-label="Add hint to running worker"
        />
        <button
          type="submit"
          disabled={inFlight || hint.trim().length === 0}
          data-testid={`hint-input-send-${subtaskId}`}
          aria-label={inFlight ? 'Sending hint' : 'Send hint'}
          title={inFlight ? 'Sending…' : 'Send hint (Enter)'}
          className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-sm text-fg-secondary hover:text-fg-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Send size={12} aria-hidden="true" />
        </button>
      </div>
      {inFlight ? (
        <span
          className="text-hint italic text-fg-tertiary"
          data-testid={`hint-input-status-${subtaskId}`}
        >
          Restarting with your hint…
        </span>
      ) : null}
    </form>
  );
}
