# S03: Frontend State Synchronization

**Goal:** Approval flow works reliably (activePlan available during approval), task completion events match the correct frontend task card by dag_id, and streaming output is attributed per-worker.
**Demo:** Run an orchestration and confirm: (1) TaskApprovalView renders during awaiting_approval phase (activePlan is non-null), (2) out-of-order task completions update the correct Kanban cards, (3) each worker task card shows its own lastOutputLine from real-time streaming.

## Must-Haves

- `activePlan` is set from `@@orch::phase_changed` events before the orchestration promise resolves (R006)
- `task_completed`/`task_failed` events use `dagToFrontendId.get(ev.dag_id)` instead of `subTaskQueue.shift()` (R007)
- `task_assigned` events include `dag_id` so the frontend builds `dagToFrontendId` with actual DAG IDs, not assumed `t{N}` format
- Per-worker streaming output is visible on each task card's `lastOutputLine` via `@@orch::worker_output` events (R010)

## Proof Level

- This slice proves: contract + integration
- Real runtime required: yes (UAT through GUI for full confirmation, but contract verified by code inspection + Rust tests)
- Human/UAT required: yes (visual confirmation of approval flow and task cards deferred to S05 end-to-end)

## Verification

- `cargo test --lib commands::orchestrator` — all existing tests pass + new tests for enriched events
- `grep -q 'plan_id' src-tauri/src/commands/orchestrator.rs` — backend emits plan_id in phase_changed events
- `grep -q 'dagToFrontendId.get' src/hooks/orchestration/handleOrchEvent.ts` — dag_id matching replaces FIFO
- `! grep -q 'subTaskQueue.shift' src/hooks/orchestration/handleOrchEvent.ts` — FIFO queue removed from task_completed/task_failed
- `grep -q 'setActivePlan' src/hooks/orchestration/handleOrchEvent.ts` — activePlan set from events
- `grep -q 'worker_output' src/hooks/orchestration/handleOrchEvent.ts` — per-worker output handler exists
- `grep -q 'worker_output' src-tauri/src/commands/orchestrator.rs` — backend emits worker_output events
- `grep -q 'console.warn' src/hooks/orchestration/handleOrchEvent.ts` — unmatched dag_id emits diagnostic warning for debugging

## Observability / Diagnostics

- Runtime signals: `@@orch::phase_changed` events now include `plan_id` and `master_agent`; `@@orch::task_assigned` includes `dag_id`; new `@@orch::worker_output` events carry per-worker stdout lines with `dag_id` attribution
- Inspection surfaces: Orchestration logs panel shows per-worker output lines attributed by agent; KanbanView task cards display `lastOutputLine` per worker
- Failure visibility: If `dagToFrontendId.get(ev.dag_id)` returns undefined, a console.warn is emitted with the unmatched dag_id — enables debugging mismatches
- Redaction constraints: none

## Integration Closure

- Upstream surfaces consumed: `@@orch::task_completed`/`task_failed` events with `dag_id` field (from S01), `SubTaskDef.id: Option<String>` (from S01), DAG construction using `def.id` (from S01)
- New wiring introduced in this slice: `setActivePlan` called from event handler (not just promise resolution), `dagToFrontendId` used for task matching (replacing FIFO), per-worker output tagging via `@@orch::worker_output` events, optional `orch_tag` parameter on `spawn_with_env_core` for stdout line tagging
- What remains before the milestone is truly usable end-to-end: S04 (review & merge pipeline), S05 (end-to-end integration)

## Tasks

- [x] **T01: Enrich backend orchestration events with plan_id, dag_id, and worker_output tagging** `est:45m`
  - Why: Frontend needs `plan_id` + `master_agent` in `phase_changed` events to set `activePlan` early, `dag_id` in `task_assigned` to build correct frontend map, and per-worker stdout tagging via `@@orch::worker_output` for output attribution. All three frontend fixes depend on these backend enrichments.
  - Files: `src-tauri/src/commands/orchestrator.rs`, `src-tauri/src/process/manager.rs`, `src-tauri/src/commands/router.rs`
  - Do: (1) Add `plan_id` and `master_agent` fields to all `phase_changed` emit_orch calls (plan.task_id and config.master_agent are in scope at every call site). (2) Add `dag_id` to `task_assigned` events — construct DAG IDs using `def.id.clone().unwrap_or_else(|| format!("t{}", i+1))` in the task_assigned loop (mirrors DAG construction). (3) Add optional `orch_tag: Option<String>` parameter to `spawn_with_env_core` and `spawn_with_env_internal` — when set, the stdout reader also emits `@@orch::worker_output::{json}` with `{dag_id, line}` for each stdout line. (4) In `dispatch_task_internal`, thread the `orch_tag` through. (5) In the orchestrator dispatch loop, pass `Some(dag_id.clone())` as `orch_tag` when dispatching workers. (6) Add unit test verifying `task_assigned` events include `dag_id`.
  - Verify: `cargo test --lib commands::orchestrator` passes; `grep -q '"plan_id"' src-tauri/src/commands/orchestrator.rs && grep -q '"dag_id".*task_assigned' src-tauri/src/commands/orchestrator.rs && grep -q 'orch_tag' src-tauri/src/process/manager.rs`
  - Done when: All phase_changed events include plan_id + master_agent, task_assigned includes dag_id, worker stdout lines are wrapped in @@orch::worker_output events with dag_id when dispatched from orchestrator

- [x] **T02: Fix activePlan timing, dag_id matching, and per-worker output attribution in frontend** `est:45m`
  - Why: Three frontend state bugs block the orchestration UX: activePlan is null during approval (R006), task completions match wrong cards via FIFO (R007), and worker output is unattributed (R010). All three depend on the enriched backend events from T01.
  - Files: `src/hooks/orchestration/handleOrchEvent.ts`, `src/hooks/orchestration/useOrchestratedDispatch.ts`, `src/stores/taskStore.ts`
  - Do: (1) In `handleOrchEvent.ts` `phase_changed` handler: extract `plan_id` and `master_agent` from the event, call `setActivePlan({task_id: ev.plan_id, master_agent: ev.master_agent, master_process_id: null})` when phase is `decomposing` or `awaiting_approval`. (2) In `task_assigned` handler: use `ev.dag_id` instead of `t${dagCounter+1}` for `dagToFrontendId` key. (3) In `task_completed`/`task_failed` handler: replace `subTaskQueue.shift()` with `dagToFrontendId.get(ev.dag_id)`, add `console.warn` if lookup fails. (4) Add `worker_output` case to the switch: extract `dag_id` and `line`, look up `dagToFrontendId.get(ev.dag_id)`, call `store.updateTaskOutputLine(frontendId, line)` to update `lastOutputLine`. (5) Add `worker_output` to the `OrchEvent` union type. (6) Keep `setActivePlan` call in `useOrchestratedDispatch.ts` as fallback (when promise resolves) — don't remove it, just ensure it's not the only path.
  - Verify: `grep -q 'setActivePlan' src/hooks/orchestration/handleOrchEvent.ts && ! grep -q 'subTaskQueue.shift' src/hooks/orchestration/handleOrchEvent.ts && grep -q 'dagToFrontendId.get' src/hooks/orchestration/handleOrchEvent.ts && grep -q 'worker_output' src/hooks/orchestration/handleOrchEvent.ts`
  - Done when: activePlan is set from phase_changed events (not just promise resolution), task completion uses dag_id lookup, worker_output events update lastOutputLine per worker

## Files Likely Touched

- `src-tauri/src/commands/orchestrator.rs`
- `src-tauri/src/process/manager.rs`
- `src-tauri/src/commands/router.rs`
- `src/hooks/orchestration/handleOrchEvent.ts`
- `src/hooks/orchestration/useOrchestratedDispatch.ts`
- `src/stores/taskStore.ts`
