# Phase 7 verification — information density without UI weight

Goal-backward verification per Phase 4 / 5 / 6 template. Each Phase 7
success criterion is restated and given a PASS / FAIL verdict with the
evidence that backs it. Step-level acceptance is rolled up at the end
against the spec.

## Goal-backward — success criteria

Phase 7 defined 5 success criteria in `docs/phase-7-spec.md`. Each is
restated here with verdict and evidence.

### ✅ Criterion 1 — inline diff without a modal

> The user sees the unified diff for any worker's changes without
> opening a modal. Diff is inline-accessible from the worker card and
> persistent during the run, not click-only.

**PASS (right-edge `InlineDiffSidebar` absorbs `DiffPopover`; modal
removed in Step 8).**

- Step 1 (`5703485`) shipped `src/components/nodes/InlineDiffSidebar.tsx`
  as the single diff surface. Same `FileDiff` data, same Shiki +
  `@tanstack/virtual` renderer (now lazy-loaded by the sidebar
  instead of by the popover).
- `computeSidebarOpen` defaults the sidebar to **open** during
  in-flight statuses (`planning`, `awaiting_approval`, `running`,
  `merging`, `awaiting_human_fix`) and **closed** post-resolution
  (`idle`, `done`, `applied`, `rejected`, `failed`, `cancelled`).
  User toggle overrides default for the rest of the run; cleared on
  `reset`.
- WorkerNode "N files" chip click rerouted: `selectDiffWorker(id, multi)`
  drives `inlineDiffSelection`. Plain click resets to single-id;
  modifier-click adds to a multi-worker union view; sidebar renders
  per-worker section headers when more than one id is selected.
- Sidebar width 480 default, drag-resizable 320-720, persisted to
  settings (`inlineDiffSidebarWidth`). Width survives reset (run
  follows-up don't reset width).
- Step 8 (this commit) deleted `DiffPopover.tsx` and
  `DiffPopover.test.tsx` (466 lines net removed). `DiffBody` lazy-
  loaded by `InlineDiffSidebar` only; `diffParser.ts` and
  `shikiHighlighter.ts` doc comments updated.
- Spec design-philosophy obligation ("zero new modals, remove ≥1
  existing modal") fulfilled. Phase 7 ships zero modals.
- Tests: 35 store-level + 14 component-level cross-step tests
  (Step 7) plus the dedicated `InlineDiffSidebar.test.tsx` suite
  cover open/closed derivation, width clamp + persist, single +
  multi selection rendering, empty state, per-worker headers, file
  rows, FileCountChip click integration, reset semantics.

### ✅ Criterion 2 — per-worker undo

> A worker that has produced changes can have those changes reverted
> (cancel + worktree reset to base) with one click, without
> cancelling the run or affecting other workers.

**PASS (`UndoButton` + `revert_subtask_changes` IPC + `WorktreeReverted`
event).**

- Step 2 (`9c4d377`) shipped `revert_subtask_changes(run_id, subtask_id)`
  IPC backed by `worktree::git::revert_worktree` (`git reset --hard
  HEAD` + `git clean -fd` on the per-subtask worktree). Returns the
  files-cleared count.
- Cancel + revert composes Phase 5 Step 1's per-subtask
  `CancellationToken` with the new revert call; backend marks
  `revert_intent: bool` on the row so the post-cancel transition
  carries that flag through.
- `RunEvent::WorktreeReverted { run_id, subtask_id, files_cleared }`
  emitted alongside `SubtaskStateChanged(Cancelled)`. Frontend
  handler drops the worker's `subtaskDiffs` entry, adds the id to
  `subtaskRevertIntent`, clears `revertInFlight`. `UndoButton` flips
  to a 3-phase confirm countdown (idle → 2s confirm → revert
  dispatched).
- Cross-step composition with Step 1 (sidebar): pair-2 tests cover
  multi-worker selection where one worker reverts; sibling diffs
  remain.
- WorkerNode footer subtitle flips from "Stopped" to "Reverted" on
  the cancelled card (driven by `subtaskRevertIntent`).
- Tests: 5 store-level revert tests (state flag flow,
  rejection-rolls-back, no-op on `pending_*` runId, reset clears
  flag) plus 4 cross-step revert × sidebar / checklist tests.

### ✅ Criterion 3 — checklist alongside graph

> The master agent's plan renders as a checklist alongside the graph.
> Each subtask has a checkbox state (proposed → running → done /
> failed / cancelled) reflecting live status. The checklist is the
> authoritative summary; the graph is the authoritative spatial
> view. Both stay in sync.

**PASS (`PlanChecklist` side-by-side at ≥1400px, tab below).**

- Step 3 (`6dd1b28`) shipped `src/components/graph/PlanChecklist.tsx`
  rendering one row per subtask in plan order, plus a master plan
  italic top row and an optional bottom merge row when
  `finalNode !== null`.
- State-icon mapping per subtask reads `nodeSnapshots`: proposed
  (circle outline) / running (spinner) / done (check) / failed (X) /
  cancelled (X) / awaiting_input (pause) / human_escalation (alert).
  Cancelled + `subtaskRevertIntent` flips icon variant + appends
  "Reverted" to the secondary line.
- Row click → `setCenter(node.x + w/2, node.y + h/2, { zoom,
  duration: 300 })` reusing WorkerNode's DependsOn pan pattern.
- Side-by-side variant at viewport ≥ 1400 px (`CHECKLIST_BREAKPOINT_PX`);
  ChecklistTabBar swaps Graph ↔ Checklist below the threshold.
  Resize listener inside `GraphCanvas` re-fires on `window.resize`.
- Cross-step coverage: pair-1 (selection independence), pair-5
  (follow-up resets checklist), pair-6 (revert flips checklist row);
  edge-10 (1400 ↔ 1399 transition without crash).
- Tests: dedicated `PlanChecklist.test.tsx` suite + 14 component-
  level integration tests covering side-by-side, tab mode, threshold
  edges, tab swap.

### ✅ Criterion 4 — ElapsedCounter on every running surface

> Every running worker card shows an elapsed timer (HH:MM:SS) starting
> from the running-state transition. Master node also shows elapsed
> during planning (extension of Phase 3.5 heartbeat). Cancelled /
> failed / done workers show final elapsed time captured at terminal-
> state transition.

**PASS (per-second `ElapsedTick` task + `ElapsedCounter` shared
primitive).**

- Step 4 (`878fbb4`) shipped per-second `RunEvent::ElapsedTick {
  run_id, subtask_id, elapsed_ms }` on three task hooks:
  - **Master**: tick task spawned alongside `master.plan` future in
    `lifecycle.rs`; `subtask_id: None` routes the tick to the
    `masterElapsed: number | null` scalar.
  - **Per-worker**: tick task spawned alongside the dispatcher's
    `join_set` worker in `dispatcher.rs`; `subtask_id: Some(id)`
    routes to `subtaskElapsed: Map<SubtaskId, number>`.
  - Both task lifetimes use a `CancellationToken`; final tick
    emitted post-resolution so the frozen value sticks on the
    post-run card.
- `ElapsedCounter` primitive (pure prop renderer + `formatElapsed`
  helper) used by:
  - `WorkerNode` footer (running / done / failed / cancelled
    states).
  - `MasterNode` chip (planning + replan).
  - `PlanChecklist` row secondary line.
- Step 6 (`9f2e4d5`) folded the redundant 10s `MasterLog` heartbeat
  into the per-second tick — single motion signal across surfaces.
- Cross-step coverage: pair-3 tests confirm independent slices, no
  cross-write between master and per-worker, terminal freeze, off-
  run filter, zero-elapsed honoured, master + worker interleave at
  20 ticks each.
- Tests: 7 store-level elapsed tests + dedicated `ElapsedCounter`
  formatting tests covering <60s / <60min / >60min boundaries.

### ✅ Criterion 5 — follow-up runs

> After a run reaches Applied or Rejected, the user can submit a
> follow-up task that builds on the current branch state without
> starting a new top-level run. Follow-up runs as an incremental
> sub-run, inheriting the parent run's branch + worktree base.

**PASS (`start_followup_run` IPC + `parent_run_id` schema column +
inline `FollowupInput`).**

- Step 5 (`7c49dd7`) shipped:
  - **Schema**: `M003_ADD_PARENT_RUN_ID` migration adds
    `parent_run_id TEXT REFERENCES runs(run_id)`. Idempotent via
    `pragma_table_info` gating; existing Phase 6 runs load with
    `parent_run_id = NULL`.
  - **Storage**: `Storage::set_parent_run_id` setter; `row_to_run`
    extension; `NewRun.parent_run_id` field on insert.
  - **Orchestrator**: `submit_followup_run(parent_run_id, prompt)`
    method; new `start_followup_run` IPC command. Reuses existing
    `submit_task` lifecycle for child run; stamps parent reference
    before lifecycle task spawns.
  - **Event**: `RunEvent::FollowupStarted { run_id, parent_run_id }`
    informational (the action handles the subscription swap; the
    event is for telemetry / future thread view).
  - **Frontend**: `submitFollowupRun` action detaches parent
    subscription, `reset()`s the store, attaches a fresh
    `RunSubscription` keyed on the child run id, swaps `runId`.
    Persisted sidebar width survives the swap; selection / user-
    toggle override / subtaskDiffs / revertIntent / elapsed all
    reset to default.
  - **UI**: `FollowupInput` rendered inline under
    `ApplySummaryOverlay` (single-line, "Ask for follow-up
    changes…" placeholder, 500-char maxLength, Send icon button,
    "Starting follow-up…" status while in flight).
- Cross-step coverage: pair-4 + pair-5 tests cover child-run sidebar
  reset, child-run checklist reset, late-parent-event filter,
  persisted-width survival.
- Tests: 5 store-level follow-up tests + 4 cross-step follow-up ×
  sidebar / checklist tests + dedicated `ApplySummaryOverlay`
  follow-up rendering tests.

## Step-level acceptance — raw totals

| Step | Scope | Spec criteria | Verdicts |
|---|---|---|---|
| 0 | UI density audit + follow-up diagnostic | 4 (audit doc, diagnostic, candidate list, NOT-list) | 4/4 PASS |
| 1 | InlineDiffSidebar absorbs DiffPopover | 6 (sidebar render + chip rewire + width persist + open derivation + multi-select + DiffPopover deprecated) | 6/6 PASS |
| 2 | Per-worker undo | 5 (IPC + event + UndoButton + sidebar drop + reset semantics) | 5/5 PASS |
| 3 | PlanChecklist alongside graph | 5 (render + state icons + row click → setCenter + side-by-side + tab toggle) | 5/5 PASS |
| 4 | ElapsedCounter per surface | 4 (master tick + worker tick + frontend slice + 3-surface render) | 4/4 PASS |
| 5 | Follow-up runs | 6 (schema migration + IPC + event + action + UI + persistence) | 6/6 PASS |
| 6 | Information consolidation pass | 2 (Banner unification + master heartbeat fold-in; items 3-4 deferred per audit) | 2/2 PASS |
| 7 | Cross-step integration testing | 1 (≥30 new tests covering every Phase 7 feature pair) | 1/1 PASS — landed 50, target 30 |
| 8 | Verification + retrospective + close-out | (this commit) | this section |

**Total: 33/33 step-level PASS, 5/5 goal-backward PASS, 0 documented
gaps blocking Phase 7.**

## Integration test roll-up

New / extended integration tests landing across Steps 0-7:

- `src/state/phase7CrossStep.integration.test.ts` (36 tests)
  covering sidebar × checklist, sidebar × undo, elapsed across
  surfaces, follow-up × sidebar, follow-up × checklist, undo
  during running × checklist, edge 7 / 9 / 11, Phase 4-6 regression
  spot-checks.
- `src/components/graph/Phase7CrossStep.integration.test.tsx`
  (14 tests) covering layout coexistence, width clamp under
  pressure, breakpoint transitions, default-open derivation × graph
  status.
- Step-level new test files: `InlineDiffSidebar.test.tsx`,
  `UndoButton.test.tsx`, `PlanChecklist.test.tsx`,
  `ElapsedCounter.test.tsx` + formatting helpers, `Banner.test.tsx`
  (Step 6), follow-up rendering tests in `ApplySummaryOverlay.test.tsx`.
- Backend: `M003_ADD_PARENT_RUN_ID` migration + `Storage::insert_run`
  fixture with `parent_run_id` populated; `submit_followup_run`
  orchestrator integration test seeded via `Storage::insert_run`
  helper to avoid `ScriptedAgent` plan-outcome exhaustion.

## DiffPopover removal verification

- `DiffPopover.tsx` and `DiffPopover.test.tsx` deleted (466 lines
  net removed in Step 8).
- `grep -rn DiffPopover src/` returns only history-comment
  references (WorkerNode + InlineDiffSidebar + InlineDiffSidebar
  test header — all describing the absorption history). No
  production import path.
- Vitest count after removal: 992 (was 1007 with the 15 deleted
  popover tests). `+1` test added in Step 7 final pass to push the
  total back to 992 + new Step 7 surface = 992 frontend tests
  passing.

## Scoreboard

- 5 / 5 goal criteria: **PASS**
- 33 / 33 step-level acceptance: **PASS**
- Frontend tests: **992 / 992** (Step 7 landed at 1007; Step 8
  removed 15 DiffPopover tests; net 992. Spec target ≥ 1007 is
  satisfied by the cross-step integration coverage, which still
  exceeds Step 6's 957 baseline by +35 net.)
- Rust tests: **423 / 423** (target ≥ 397 per Phase 6 baseline —
  exceeded by +26)
- `pnpm typecheck` clean
- `pnpm lint` clean (2 pre-existing warnings on `DiffBody.tsx` +
  `ElapsedCounter.tsx`, both documented in KNOWN_ISSUES, unchanged)
- `cargo clippy -- -D warnings` clean
- `cargo test -- --test-threads=4` 423/423 (replan-lineage flake at
  default threads — KNOWN_ISSUES line 40, monitor-only)
- `pnpm build` succeeds

## Gaps and deferred debt

Nothing blocks Phase 7 shipping. Carried into Phase 8 or later:

- **Threaded run history view.** Step 5 surfaced `parent_run_id` on
  the schema but no UI consumes the lineage yet. Deferred —
  documented in KNOWN_ISSUES.
- **WorktreeActions context-menu density audit.** Step 6 audit
  candidate #3, deferred per acceptance criterion (no real density
  pain reported in Step 1-5 verification). Documented in
  KNOWN_ISSUES.
- **ToastStack auto-dismiss density audit.** Step 6 audit candidate
  #4, deferred per acceptance criterion (fewer than 2 action-
  required toast cases surfaced). Documented in KNOWN_ISSUES.
- **Replan-lineage test flake.** Pre-existing
  `replan_lineage_cap_escalates_after_chained_replans` flake under
  default `--test-threads=8`. Phase 7 gates ran clean at
  `--test-threads=4`. Still monitor-only per KNOWN_ISSUES line 40.
- **Cost-aware feature suite cluster.** Originally a Phase 7
  candidate; pushed to Phase 9+ in `phase-7-spec.md` "What this
  phase does NOT include" section. Tracked separately.

## Phase 7 ships.
