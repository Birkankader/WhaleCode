# Visual obs 01 — InlineDiffSidebar (Step 1 + polish round)

## What to watch

- Submit a multi-worker task; watch the right-edge sidebar
  during running / done states.
- Click "N files" chip on different workers (single + modifier).
- Drag the resize handle, toggle collapse, watch graph viewport
  reflow.
- Verify Apply transitions sidebar to default-collapsed.

## Observations

- **Default-open derivation.** Sidebar opens automatically the
  moment the run enters `planning` and stays open through
  `awaiting_approval` / `running` / `merging` /
  `awaiting_human_fix`. Collapses to a 24px spine on `idle` /
  `done` / `applied` / `rejected` / `failed` / `cancelled`. The
  user toggle (the `‹` / `›` button on the spine and the X on the
  open header) overrides for the rest of the run. Cursor parity
  achieved — diffs are visible by default while you'd want to
  watch them.
- **Auto-fill on no-selection.** When the user hasn't picked a
  worker manually (`inlineDiffSelection.size === 0`), the sidebar
  shows every subtask that has a diff entry. As workers finish
  and emit `subtask_diff`, their files appear in plan order with
  per-worker section headers. First chip click switches to manual
  mode (single-worker view); modifier-click adds.
- **Multi-worker union.** Cmd-click two workers' "N files" chips
  → sidebar splits into per-worker sections, each with its own
  header and file list. A third modifier-click adds a third
  section. A plain click on any single chip resets to that
  worker's view. The visual hierarchy reads correctly: section
  header is heavier than file row, file row is heavier than diff
  body line.
- **Width persistence.** Drag-resized to 560 px, ran a follow-up,
  width stayed at 560. Settings round-trip is silent — no spinner,
  no flicker. Out-of-range hydration (5000) clamps to 720.
- **DiffPopover removal verified.** Chip click no longer mounts
  the modal; sidebar selects the worker. Searched the bundle for
  any DiffPopover string after the Step 8 deletion — only history-
  comment hits in WorkerNode + sidebar self-reference. Modal is
  gone from the running app entirely.
- **Mid-ellipsis on long file paths.** Files like
  `src/components/very/deeply/nested/sub/Component.tsx` truncate
  with mid-path ellipsis around the sidebar's 40-char width
  threshold. Hovering would reveal the full path (browser
  default). Same Cursor pattern.

Regressions: none. Phase 4 Step 6 Shiki + virtual-scroll renderer
intact under the new placement.
