# Visual obs 01 — per-worker stop (Step 1)

**Recorded:** 2026-04-23 using the Step 0 `ScriptedAgent` +
`ExecuteScript::Block` fixtures.

## What to watch

- Footer Stop button on worker cards in `running` / `retrying` /
  `waiting` / `awaiting_input`. Square icon, 12px, portals via the
  existing WorkerNode footer layout — not a new stacking context,
  so no `createPortal` needed (unlike Phase 4 Step 4's
  WorktreeActions menu).
- Click → IPC in flight → button disabled with `Stopping…` aria-
  label (sits next to existing footer chips without reflow).
- Backend transitions the subtask to `Cancelled` (new terminal,
  Phase 5 Step 1). Card renders with the `cancelled` state label.

## Observations

1. **Disjoint state sets.** `STOPPABLE_STATES` = `running` /
   `retrying` / `waiting` / `awaiting_input` (the Phase 5 Step 4
   addition). `INSPECTABLE_STATES` = `done` / `failed` /
   `human_escalation` / `cancelled`. No overlap — Stop and
   WorktreeActions never render on the same card.
2. **Sibling workers unaffected.** Stopping one running worker in a
   3-subtask plan leaves the other two workers' cards untouched;
   the dispatcher main loop's new `UserCancelled` arm re-enters
   `pick_ready` rather than `drain_as_skipped`. Integration test
   `cancel_subtask_marks_cancelled_and_run_continues` pins this.
3. **Replan-race graceful.** Clicking Stop on a subtask whose Layer
   2 replan is in flight rejects with `WrongSubtaskState`; the
   StopButton's `catch` surfaces a pinned error toast ("Could not
   stop worker: subtask is in state Failed, expected running |
   retrying | waiting"). UI rolls back the in-flight flag.
4. **Cascade preserved.** A dependent subtask whose parent was
   user-cancelled transitions to `Skipped` (orchestrator-intent)
   rather than `Cancelled` — distinction between user-initiated
   vs cascade is preserved visually (two different state labels +
   different wire states). `cancel_subtask_cascades_dependents_to_skipped`
   pins this.

## Regressions: none.
