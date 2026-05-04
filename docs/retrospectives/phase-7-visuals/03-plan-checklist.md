# Visual obs 03 — PlanChecklist responsive layout (Step 3)

## What to watch

- Submit task at >1400 px viewport: side-by-side layout.
- Resize browser below 1400 px: tab toggle appears.
- Click checklist row → graph centers on subtask.
- Revert a worker → checklist row shows "Reverted" subtitle.
- Cancel run mid-flight → checklist freezes at last-known states.

## Observations

- **Side-by-side at ≥1400 px.** Checklist sits in a fixed 280 px
  column on the right of the graph. Each row reads as: state icon
  + subtask title + (secondary line: agent + elapsed + subtitle).
  Master plan italic top row, optional merge bottom row when
  `finalNode !== null`. Hierarchy reads cleanly — single-column
  vertical list, easy to scan with 6 workers.
- **Tab swap at <1400 px.** Below the threshold, a tab bar with
  "Graph" + "Checklist" appears. Default tab is Graph. Clicking
  Checklist swaps content (mutually exclusive in narrow mode). Tab
  state is per-session — no cross-session memory, intentionally.
- **Threshold transition is clean.** Crossing 1400 px via window
  resize: side-by-side ↔ tab swap fires on the next resize event.
  No flash of unstyled content; the `useLayoutEffect` resize
  listener picks up `window.innerWidth` and re-renders before
  paint.
- **State icons.** Proposed (circle outline), running (spinning
  loader), done (check), failed (X with red accent), cancelled (X
  with grey accent), awaiting_input (pause), human_escalation
  (alert). Distinct enough at 16px to read without hovering.
- **Row click pans graph.** `setCenter(node.x + w/2, node.y + h/2,
  { zoom: <current>, duration: 300 })` — preserves zoom, animates
  300ms. Same pattern as ApplySummaryOverlay's per-worker rows.
  Verified: clicking row F pans to worker F card without changing
  zoom level.
- **Revert flag flip.** Reverting a worker from the WorkerNode
  changes the row's secondary line on the checklist within the
  same render — `subtaskRevertIntent` is a shared store slice, no
  prop drilling. Subtitle shows "Reverted" with the same red
  accent as the cancelled X icon.
- **Cancelled run freezes the checklist.** After clicking Stop on
  the run-wide cancel, all rows lock at their last-known state.
  Running rows flip to cancelled, waiting rows flip to skipped.
  No further state changes render — the dispatcher's terminal
  drain finishes and the checklist matches.

Regressions: none. Graph rendering at >=1400 px shrinks by 280 px
column-width but the layout reflows cleanly via flex parent.
