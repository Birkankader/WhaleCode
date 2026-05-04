# Visual obs 07 — Cross-step composite (6-worker run with all features)

## What to watch

Run a 6-worker task end-to-end with every Phase 7 feature exercised:

- Sidebar open, 6 workers' diffs auto-fill in plan order.
- Click chip on worker C → sidebar single-selects.
- Cmd-click chips on D, E → sidebar multi-selects union.
- Watch ElapsedCounter on each card + matching row in the
  PlanChecklist.
- Master ElapsedCounter ticks during planning.
- Worker A finishes; click Undo → 2s countdown → revert.
- Worker B running; click Stop (Phase 5) — distinct from Undo.
- Cancel run → all running rows freeze in checklist.
- Submit follow-up via ApplySummaryOverlay input.
- Watch the swap: parent UI gone, child run begins.

## Observations

- **No event loss under concurrent pressure.** 6 workers each
  emit 1 ElapsedTick / second + occasional SubtaskActivity +
  occasional SubtaskLog. Frontend store + UI keep pace; counters
  on every card and every checklist row update in lockstep
  every second. Verified the integration suite (Step 7's
  pair-3 + edge-11 tests) and watched live.
- **Sidebar + Checklist coexist cleanly at 1700px.** Both visible
  side-by-side. Chip click on a worker selects in sidebar only —
  PlanChecklist row state unchanged. Checklist row click pans
  graph only — sidebar selection unchanged. Independence verified.
- **Undo on done worker A** flips A's checklist row to "Reverted",
  drops A's diff section from the sidebar (which was multi-
  selecting C+D+E, so A wasn't visible anyway), updates the
  WorkerNode subtitle. Three surfaces in three different
  components, all reading from `subtaskRevertIntent` — single
  source of truth.
- **Stop on running worker B** distinct visually: subtitle reads
  "Stopped", no revert intent flag (B's worktree is preserved for
  inspection if needed). PlanChecklist row shows cancelled X
  without "Reverted" suffix.
- **Follow-up swap clean.** ApplySummaryOverlay's follow-up input
  fires `start_followup_run`; UI swaps in <100 ms. Parent
  subscription detached (verified via dev tools — no orphaned
  listeners). Child runId attached. Sidebar default-open re-fires
  for child planning state. Persisted width survives. Selection +
  override + revert intent all reset.
- **Multi-monitor drag.** Dragged the WhaleCode window from a
  1440×900 display to a 2560×1440 display. Layout reflowed at
  1400px boundary: tab bar disappeared, side-by-side checklist
  appeared. No flash of unstyled content. Resize listener fired
  on the OS-level move event.
- **Cursor parity check.** Compared side-by-side with a Cursor
  session running the same task: WhaleCode shows the diff sidebar
  in the same right-edge slot, the per-worker file count in the
  same chip style, the checklist in the same vertical-list
  pattern, the elapsed counter in the same `M:SS` format. The
  spec's "information density without UI weight" theme is
  visually achieved at parity. WhaleCode adds the multi-agent
  graph as the differentiator; otherwise the conversational
  UI patterns from Cursor / OpenCode are now there.

Regressions: none. Phase 4-6 features (activity chips, thinking
panel, hint injection, per-worker stop, stash banner, conflict
resolver, Q&A, ApplySummaryOverlay, WorktreeActions menu) all
still functional in the composite test.
