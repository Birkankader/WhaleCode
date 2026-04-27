# Visual obs 03 — mid-execution hint injection (Step 4)

## What to watch

- Submit a task, type a hint into the inline `HintInput` while a
  worker is running, observe the cancel + restart-with-appended-
  prompt flow.
- Verify Layer-1 retry budget is unchanged (no Retrying state),
  the post-submit copy, awaiting-input precedence, Stop
  precedence over hint, concurrent-hint rejection, and terminal-
  state rejection.

## Observations

- **Inline placement.** `HintInput` renders inline on the
  running worker card, single-line, placeholder "Add hint…",
  consistent with Phase 5's QuestionInput slot reuse. Visually
  unobtrusive when empty, focus ring matches the design-system
  token on click-in.
- **Submit flow.** Type hint → Enter → input disables, "Restart-
  ing with your hint…" caption appears below in muted color.
  Worker card transitions Running → Cancelled (briefly,
  ~1-2s — Phase 5 Step 1 latency budget) → Running. The caption
  dismisses the moment the worker re-enters Running. Clean.
- **Layer 1 budget unchanged.** Confirmed via integration test
  (`hint_subtask_does_not_consume_retry_budget`) and visually:
  the worker's retry attempt counter does not increment, no
  "Retrying" badge flashes during the cancel arm. The new
  `CancelDecision` priority path bypasses the retry ladder
  entirely as designed.
- **Q&A precedence.** While the worker is in `AwaitingInput`,
  the `HintInput` is replaced by `QuestionInput` (same slot).
  No double-input collision. Once the question is answered or
  skipped and the worker returns to Running, `HintInput`
  reappears.
- **Stop-during-hint.** Submitted a hint, then clicked Stop
  before the cancel-restart cycle completed. Manual cancel
  takes priority — worker terminates as `Cancelled` (not
  Restarting), the in-flight hint dispatch is dropped, no
  double-state. UI shows Cancelled label, not "Restarting…".
  Matches the cancel-priority decision tree.
- **Concurrent hint rejection.** Submitted a second hint while
  the first restart was still in flight. Returned
  `WrongSubtaskState` toast, input value preserved so user can
  retry once the first cycle completes. No silent drop.
- **Terminal state rejection.** Tried to submit a hint on a Done
  worker (input is hidden in terminal states, but invoked the
  IPC directly via dev tools to confirm backend guard). Returns
  `WrongSubtaskState`. Defense-in-depth holds.
- **Hint counter affordance.** Per spec, no per-worker hint log
  surface in this phase. Considered showing "3 hints applied"
  per the spec risk flag — left for Phase 7 if user reports
  hint-loop pain in real usage.

Regressions: none. Q&A flow, per-worker stop, conflict resolver
retry path all exercised in cross-step integration tests and
manually re-verified post-Step-4.
