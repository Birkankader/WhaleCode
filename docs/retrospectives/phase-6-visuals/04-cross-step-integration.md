# Visual obs 04 — cross-step integration (Steps 2 × 3 × 4)

## What to watch

- Hint mid-flight while activity chips are streaming and the
  thinking panel is open. Stop during hint while thinking on.
  Q&A mid-flow with hint queued. Phase 5 surfaces (per-worker
  stop, base-branch stash, conflict resolver) still working
  alongside Phase 6 surfaces.

## Observations

- **Hint × ActivityChipStack.** Hint submitted while chips were
  mid-stream. On restart, chip stack resets to empty (correct —
  chips track current execution, not historical), and a fresh
  stream begins as the worker re-runs with the appended prompt.
  No stale-chip leakage from the cancelled attempt.
- **Hint × ThinkingPanel.** Toggle thinking on, then submit a
  hint. Thinking chunks from the cancelled attempt remain in the
  store; new chunks from the restarted attempt append. Toggle
  state preserved across the Running → Cancelled → Running
  transition. Matches "store still accumulates" spec line.
- **Stop × Hint precedence.** Submitted a hint, then clicked
  Stop before the restart fired. Worker landed in Cancelled,
  hint dispatch was dropped. The `CancelDecision` priority logic
  (manual cancel beats hint-restart) holds in the visual flow,
  not just the unit test.
- **Q&A × Hint shared restart helper.** Triggered a Q&A on one
  worker (synthetic question, restart with appended answer) and
  a hint on another worker concurrently. Both workers used the
  same `restart_with_extra` Rust helper extracted in Step 4.
  Both restarted cleanly with the right `extra_context` (answer
  prefix vs hint prefix). No cross-talk in the pending-channels
  map.
- **Phase 5 features still working.**
  - **Per-worker stop.** Independent of hint affordance. Stop
    button still aborts the worker without cascading the run.
  - **Base-branch dirty stash.** Triggered a dirty base-branch
    state during a hint restart — the stash + retry-apply path
    from Phase 5 Step 2 fired correctly. Hint restart did not
    bypass the stash hook.
  - **Conflict resolver popover.** Triggered a merge conflict
    after a hinted worker completed. The Phase 5 Step 3 popover
    appeared with the same retry-apply IPC, conflict file list
    rendered correctly.
- **Visual hierarchy on a busy card.** A running Claude worker
  with chips streaming, thinking panel expanded, and HintInput
  visible all fit within the existing content-fit `[200, 340]`
  card height (Phase 4 Step 7 final geometry). No clip, no
  overflow, no horizontal scroll. Margins read clean per the
  4/8/16/24/48 spacing scale.

Regressions: none. The cross-cutting concern was always going
to be CancelDecision priority + extra_context routing; both
held under live exercise.
