# Visual obs 05 — Inline FollowupInput in ApplySummaryOverlay (Step 5)

## What to watch

- Apply a parent run.
- Watch ApplySummaryOverlay render the follow-up input below the
  per-worker rows.
- Type a follow-up prompt, press Enter (or click Send).
- Observe subscription swap — parent UI detaches, child UI
  attaches, no overlay flash.
- Verify schema: `parent_run_id` populated on the child run row
  in SQLite.

## Observations

- **Inline placement.** The follow-up input lives at the bottom of
  ApplySummaryOverlay below the per-worker file-count rows.
  Single-line text input + Send icon button to the right.
  Placeholder: "Ask for follow-up changes…". 500-char maxLength
  enforced via `maxLength={500}` on the `<input>`.
- **No new modal / overlay.** The follow-up input is part of an
  existing surface. Spec design philosophy honoured: zero new
  panels.
- **In-flight state.** While `start_followup_run` IPC is pending,
  the input + Send button both disable + the bottom of the
  overlay shows a small "Starting follow-up…" caption in muted
  text. Disable visually distinct from default state (40% opacity).
- **Subscription swap is invisible.** From the user's perspective,
  the moment Send fires: overlay dismisses, graph clears, master
  thinking chip reappears, plan loads. No flash, no double-render.
  `detachActiveSubscription` + `reset()` + new `RunSubscription` +
  `attach()` all complete inside the IPC's await window before any
  re-render.
- **Sidebar default-open re-derives** for the child run. If the
  parent had user-collapsed the sidebar, the override clears on
  reset; child status `planning` triggers default-open. Width
  persists (settings-backed).
- **Schema check.** Inspecting the SQLite `runs` table after the
  swap: child row has `parent_run_id = '<parent run id>'`,
  populated on insert. Parent row's `parent_run_id` stays NULL
  (it's the root of the lineage). Migration `M003_ADD_PARENT_RUN_ID`
  applied cleanly on a Phase-6-era DB without a re-run; existing
  Phase 6 rows load with `parent_run_id = NULL`.
- **Empty / whitespace prompt rejected.** Send button disabled
  until prompt has non-whitespace content. Submitting `   ` no-ops
  with a transient error caption.

Regressions: none. ApplySummaryOverlay's per-worker row click →
graph pan still works (ReactFlow `setCenter` integration intact).
