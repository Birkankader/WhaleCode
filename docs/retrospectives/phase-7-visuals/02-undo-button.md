# Visual obs 02 — UndoButton 2s countdown (Step 2)

## What to watch

- Worker reaches `done` with diff entries. Click Undo.
- Watch the 3-phase countdown affordance.
- Confirm the worker transitions to `cancelled` with "Reverted"
  subtitle, sidebar drops the diff entry, sibling workers
  unaffected.

## Observations

- **3-phase confirm pattern.** First click flips the button to a
  filled "Undo in 2s" countdown. Second click during the window
  fires the IPC. Click outside (or wait > 2s) resets to idle.
  Pattern guards against muscle-memory clicks on a destructive
  action without modal-prompting.
- **Countdown rendering.** The 2-second window is rendered as a
  filled-progress style on the button background (left-to-right
  fill). Tween is a CSS `transform: scaleX()` not a JS interval,
  so it's smooth at 60fps and doesn't burn frames.
- **"Reverting…" caption** appears on the cancelled card while
  the IPC is in flight. Cleared the moment `WorktreeReverted`
  lands.
- **"Reverted" vs "Stopped" subtitle.** Manual Stop on a running
  worker shows "Stopped". Undo on a done worker (which goes
  through cancel + revert) shows "Reverted". Reading
  `subtaskRevertIntent.has(id)` drives the swap. Visual difference
  is meaningful — user knows whether worktree was wiped.
- **Sidebar drops the worker's diff** the moment
  `WorktreeReverted` lands. If the sidebar was showing only that
  worker's diff (single-select), the sidebar's "no diffs to show"
  empty state renders. If multi-select, the other workers'
  sections stay; the reverted worker's section disappears.
- **`git status` confirms clean.** Ran on the worktree path after
  Undo: working tree clean, HEAD unchanged. `revert_worktree`'s
  `git reset --hard HEAD` + `git clean -fd` did its job.

Regressions: none. Phase 5 Step 1 per-subtask cancel still works
(Stop button on running cards), distinct from Undo (revert flag
distinguishes).
