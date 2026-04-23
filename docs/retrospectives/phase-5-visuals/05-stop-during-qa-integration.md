# Visual obs 05 — Stop × Q&A integration (Step 1 × Step 4)

**Recorded:** 2026-04-23. The only cross-step integration that
needed dedicated wiring — the others (Stash × Merge conflict,
Merge retry × Q&A) compose naturally through existing state gating.

## What to watch

- Worker in `awaiting_input` state. Pending question in store.
  User clicks Stop in WorkerNode footer instead of answering.
- `cancel_subtask` IPC → Orchestrator sets `manual_cancel` +
  fires per-subtask token.
- Worker task in `resolve_qa_loop` is parked on the oneshot
  receiver. `tokio::select!` has three arms: receiver / cancel /
  timeout. Cancel wins → clean up `pending_answers` entry + return
  `Err(EscalateToMaster::UserCancelled)`.
- Dispatcher outcome mapping: `manual_cancel == true` →
  `WorkerOutcome::UserCancelled` → `mark_user_cancelled` →
  `SubtaskState::Cancelled`.

## Observations

1. **Clean oneshot drop.** The worker task's cancel arm removes
   the pending-answer entry before returning. Late IPCs land on a
   missing map entry → return `SubtaskNotFound`. Frontend toasts
   "Could not stop worker: subtask …". No dangling senders, no
   deadlock on the receiver.
2. **STOPPABLE_STATES extension.** Phase 5 Step 1 originally set
   STOPPABLE_STATES = running / retrying / waiting. Step 4 added
   `awaiting_input` — the user should always be able to bail out
   even during Q&A. WorkerNode render test pins both ends.
3. **Storage state trail.** Cancelled-from-awaiting-input subtask
   goes Running → AwaitingInput → Cancelled in storage. Worktree
   preserved (Phase 4 WorktreeActions still renders on Cancelled
   inspectable state).
4. **Post-cancel pending clean.** `cancel_run_during_awaiting_
   input_cleans_up_pending_answer` asserts: (a) pending_answers
   map no longer contains the subtask, (b) a follow-up
   `answer_subtask_question` returns `SubtaskNotFound` error.
   Both guarantees matter — the UI's "Answer failed" toast is
   honest; the worker task's resources are reaped.

## Regressions: none.
