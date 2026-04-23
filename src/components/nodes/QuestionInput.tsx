/**
 * Phase 5 Step 4 — question input for a worker card in `awaiting_input`.
 *
 * Mounted inline in WorkerNode's body when the store's
 * `pendingQuestions` map has an entry for the subtask. Renders:
 *
 *   - The detected question text (verbatim, no truncation so the
 *     user sees exactly what the heuristic picked up);
 *   - A textarea for the user's answer (multiline via Shift+Enter,
 *     submits on Enter);
 *   - "Send answer" + "Skip (mark done)" buttons;
 *   - Transient "Sending…" copy + disabled controls while the
 *     IPC is in flight.
 *
 * Cancel lives on the same card via the Phase 5 Step 1 StopButton —
 * `STOPPABLE_STATES` includes `awaiting_input` so the user can always
 * bail out if the question is genuine but the run needs to stop.
 *
 * False-positive handling: Skip finalizes the subtask as Done with
 * the current output preserved. This is the cheap escape hatch
 * every Step 0 conservative-detection tradeoff leans on.
 */

import { Send, X } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useCallback, useState } from 'react';

import { useGraphStore } from '../../state/graphStore';

type Props = {
  subtaskId: string;
  question: string;
};

export function QuestionInput({ subtaskId, question }: Props) {
  const inFlight = useGraphStore((s) =>
    s.questionAnswerInFlight.has(subtaskId),
  );
  const answerSubtaskQuestion = useGraphStore((s) => s.answerSubtaskQuestion);
  const skipSubtaskQuestion = useGraphStore((s) => s.skipSubtaskQuestion);
  const [answer, setAnswer] = useState('');

  const onSubmit = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      if (inFlight) return;
      const trimmed = answer.trim();
      try {
        await answerSubtaskQuestion(subtaskId, trimmed);
      } catch {
        // Error surfaced via store action's currentError; leave the
        // text in the box so the user can retry without losing it.
      }
    },
    [answer, answerSubtaskQuestion, inFlight, subtaskId],
  );

  const onSkip = useCallback(async () => {
    if (inFlight) return;
    try {
      await skipSubtaskQuestion(subtaskId);
    } catch {
      // Same as above — error shows via currentError.
    }
  }, [inFlight, skipSubtaskQuestion, subtaskId]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void onSubmit();
      }
    },
    [onSubmit],
  );

  return (
    <form
      onSubmit={onSubmit}
      data-testid={`question-input-${subtaskId}`}
      className="flex flex-col gap-1.5 rounded-sm border border-fg-secondary/30 bg-bg-subtle/60 p-2"
    >
      <div
        data-testid={`question-text-${subtaskId}`}
        className="whitespace-pre-wrap text-meta text-fg-primary"
      >
        {question}
      </div>
      <textarea
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={inFlight}
        placeholder="Your answer (Enter to send, Shift+Enter for newline)"
        rows={2}
        data-testid={`question-answer-field-${subtaskId}`}
        className="resize-none rounded-sm border border-fg-secondary/30 bg-bg-primary px-2 py-1 text-meta text-fg-primary placeholder:text-fg-tertiary focus:border-fg-primary focus:outline-none disabled:opacity-60"
        autoFocus
      />
      <div className="flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={onSkip}
          disabled={inFlight}
          data-testid={`question-skip-${subtaskId}`}
          className="inline-flex items-center gap-1 rounded-sm border border-fg-secondary/40 px-1.5 py-0.5 text-meta text-fg-secondary hover:border-fg-primary hover:text-fg-primary disabled:cursor-wait disabled:opacity-60"
        >
          <X size={12} aria-hidden="true" />
          Skip (mark done)
        </button>
        <button
          type="submit"
          disabled={inFlight}
          data-testid={`question-send-${subtaskId}`}
          className="inline-flex items-center gap-1 rounded-sm border border-fg-primary bg-fg-primary/10 px-1.5 py-0.5 text-meta font-medium text-fg-primary hover:bg-fg-primary/20 disabled:cursor-wait disabled:opacity-60"
        >
          <Send size={12} aria-hidden="true" />
          {inFlight ? 'Sending…' : 'Send answer'}
        </button>
      </div>
    </form>
  );
}
