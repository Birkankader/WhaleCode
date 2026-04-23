# Visual obs 04 — interactive agent Q&A (Step 4)

**Recorded:** 2026-04-23 using the Step 0 fake-agent fixtures
(`fake_asks_question_then_exits.sh`, `fake_asks_question_then_
waits.sh`) alongside `ScriptedAgent` exec sequences.

## What to watch

- Worker's `ExecutionResult.summary` ending in `?` →
  `detect_question` returns `Some(question)` →
  `resolve_qa_loop` transitions subtask to `AwaitingInput`
  (new Phase 5 Step 4 state) → emits `SubtaskQuestionAsked` with
  the detected line.
- WorkerNode renders `QuestionInput` inline: question text
  verbatim + textarea (Enter submit, Shift+Enter newline) + Send
  / Skip buttons.
- Answer IPC → re-execute adapter with `extra_context = "User's
  answer: …"` → loop re-detects. Skip → finalize with current
  output as Done. Timeout (10 min default) → synthesized Skip.

## Observations

1. **Heuristic-only detection.** Step 0 diagnostic matrix was 3-
   for-3 negative on structured signals across Claude / Codex /
   Gemini. `detect_question` keys on the last non-empty summary
   line ending in `?`. Unit tests pin trigger / no-trigger /
   empty / blank-line-trail cases.
2. **Retry budget bypass.** Answer restart calls `worker.execute`
   directly, not `execute_subtask_with_retry`. No Retrying event
   fires on the Q&A path. Explicitly asserted by
   `answer_subtask_question_re_executes_with_appended_prompt`
   (`retrying_count == 0` post-answer).
3. **MAX_QA_ROUNDS=6.** Pathological adapter that keeps ending in
   `?` after every answer is bounded. After 6 rounds the loop
   finalizes with the most recent output as Done — false-positive
   escape inside the loop itself.
4. **Multi-worker independence.** `pending_answers` map is keyed
   by `SubtaskId` (ulid, globally unique). Two workers paused on
   questions simultaneously each have their own oneshot; answers
   to one don't affect the other. `two_workers_in_awaiting_input_
   handled_independently` pins.
5. **Stop integration.** STOPPABLE_STATES was extended in Step 4
   to include `awaiting_input` — a worker with a pending question
   the user no longer wants to answer can be cancelled outright.
   `cancel_run_during_awaiting_input_cleans_up_pending_answer`
   asserts the pending sender is dropped + late IPCs return
   SubtaskNotFound.

## Calibration debt

Detection false-positive rate is unknown until users run real
tasks. A worker ending "Done? Yes." would currently trigger
AwaitingInput on "Yes." (last line is a statement — no trigger).
But "Done. Anything else?" (last line ending in `?`) does trigger.
The Skip button is the one-click escape; if the false-positive
rate proves high, Phase 6 tightens to require a question-word
start (`which` / `should` / `does` / `can` / `do` / `is`).

## Regressions: none.
