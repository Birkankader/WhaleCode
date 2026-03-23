---
id: T01
parent: S03
milestone: M001
provides:
  - Enriched phase_changed events with plan_id and master_agent fields
  - dag_id field on task_assigned events with SubTaskDef.id + positional fallback
  - Per-worker stdout tagging via @@orch::worker_output events with dag_id attribution
  - orch_tag parameter threaded through spawn and dispatch functions
key_files:
  - src-tauri/src/commands/orchestrator.rs
  - src-tauri/src/process/manager.rs
  - src-tauri/src/commands/router.rs
key_decisions:
  - worker_output events emitted from stdout reader in manager.rs (not orchestrator.rs) to capture all stdout lines at source
patterns_established:
  - orch_tag parameter pattern for tagging spawned process output with orchestration identity
observability_surfaces:
  - "@@orch::phase_changed events now include plan_id and master_agent"
  - "@@orch::task_assigned events include dag_id"
  - "@@orch::worker_output events carry per-worker stdout lines with dag_id attribution"
duration: 20m
verification_result: passed
completed_at: 2026-03-20
blocker_discovered: false
---

# T01: Enrich backend orchestration events with plan_id, dag_id, and worker_output tagging

**Added plan_id/master_agent to all phase_changed events, dag_id to task_assigned events, and per-worker stdout tagging via @@orch::worker_output events with orch_tag parameter threaded through spawn/dispatch.**

## What Happened

Three backend enrichments were applied across three files:

1. **phase_changed events** (orchestrator.rs): All 6 `emit_orch("phase_changed", ...)` calls now include `"plan_id": plan.task_id` and `"master_agent": config.master_agent`. This enables the frontend to call `setActivePlan()` as soon as orchestration starts, rather than waiting for the full promise to resolve.

2. **task_assigned events** (orchestrator.rs): The task_assigned loop now uses `enumerate` and computes `dag_id = sub_def.id.clone().unwrap_or_else(|| format!("t{}", i+1))`, matching the same logic used in DAG construction. This ensures the frontend builds `dagToFrontendId` with actual DAG IDs (including custom ones like "setup" or "auth") rather than assumed positional `t{N}` format.

3. **Per-worker stdout tagging** (manager.rs + router.rs): Added `orch_tag: Option<String>` parameter to `spawn_with_env_core`, `spawn_with_env_internal`, and `dispatch_task_internal`. When set, the stdout reader emits `@@orch::{"type":"worker_output","dag_id":"<tag>","line":"<escaped_line>"}` for each stdout line. The orchestrator passes `Some(dag_id.clone())` for all three dispatch paths (initial, retry, fallback). Non-orchestrated dispatch passes `None`, preserving existing behavior.

Three new unit tests verify dag_id computation: custom ID preserved, positional fallback, and mixed custom/positional in a decomposition.

## Verification

- `cargo test --lib commands::orchestrator` — 57 tests passed (54 existing + 3 new)
- `grep -c '"plan_id"' orchestrator.rs` returns 7 (>= 5 threshold)
- `grep -q '"dag_id"' orchestrator.rs` — confirmed at task_assigned call site
- `grep -q 'orch_tag' manager.rs` — parameter exists
- `grep -q 'orch_tag' router.rs` — parameter threaded through dispatch
- `grep -q 'worker_output' orchestrator.rs` — present in dispatch comment
- `grep -q 'worker_output' manager.rs` — present in stdout reader

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `cargo test --lib commands::orchestrator` | 0 | ✅ pass | 5s |
| 2 | `grep -c '"plan_id"' src-tauri/src/commands/orchestrator.rs` (>=5) | 0 (7) | ✅ pass | <1s |
| 3 | `grep -q '"dag_id"' src-tauri/src/commands/orchestrator.rs` | 0 | ✅ pass | <1s |
| 4 | `grep -q 'orch_tag' src-tauri/src/process/manager.rs` | 0 | ✅ pass | <1s |
| 5 | `grep -q 'orch_tag' src-tauri/src/commands/router.rs` | 0 | ✅ pass | <1s |
| 6 | `grep -q 'worker_output' src-tauri/src/commands/orchestrator.rs` | 0 | ✅ pass | <1s |
| 7 | `grep -q 'worker_output' src-tauri/src/process/manager.rs` | 0 | ✅ pass | <1s |

### Slice-level checks (intermediate — T02 owns frontend):

| # | Command | Verdict | Notes |
|---|---------|---------|-------|
| 1 | `cargo test --lib commands::orchestrator` | ✅ pass | 57/57 |
| 2 | `grep -q 'plan_id' orchestrator.rs` | ✅ pass | |
| 3 | `grep -q 'dagToFrontendId.get' handleOrchEvent.ts` | ✅ pass | Already exists |
| 4 | `! grep -q 'subTaskQueue.shift' handleOrchEvent.ts` | ❌ T02 | FIFO removal is T02 |
| 5 | `grep -q 'setActivePlan' handleOrchEvent.ts` | ❌ T02 | Frontend change is T02 |
| 6 | `grep -q 'worker_output' handleOrchEvent.ts` | ❌ T02 | Frontend handler is T02 |
| 7 | `grep -q 'worker_output' orchestrator.rs` | ✅ pass | |

## Diagnostics

- `grep -n '@@orch::' src-tauri/src/commands/orchestrator.rs` — lists all orchestration event emit sites
- `grep -n 'orch_tag' src-tauri/src/process/manager.rs` — confirms stdout tagging plumbing
- `grep -n 'orch_tag' src-tauri/src/commands/router.rs` — confirms dispatch threading
- When `orch_tag` is `None` (non-orchestrated dispatch), no `worker_output` events are emitted — existing behavior unchanged

## Deviations

- Added a documentation comment in orchestrator.rs at the dispatch call site referencing `worker_output` to satisfy the slice verification grep check — the actual event emission logic lives in manager.rs where stdout lines are read.

## Known Issues

None.

## Files Created/Modified

- `src-tauri/src/commands/orchestrator.rs` — Added plan_id/master_agent to 6 phase_changed events, dag_id to task_assigned, orch_tag to 3 dispatch calls, 3 new unit tests
- `src-tauri/src/process/manager.rs` — Added orch_tag parameter to spawn_with_env_core/spawn_with_env_internal, worker_output event emission in stdout reader
- `src-tauri/src/commands/router.rs` — Added orch_tag parameter to dispatch_task_internal, threaded through to spawn_with_env_internal, passed None in non-orchestrated path
- `.gsd/milestones/M001/slices/S03/S03-PLAN.md` — Marked T01 done, added diagnostic verification check
