---
slice: S03
milestone: M001
title: Frontend State Synchronization
status: done
completed_at: 2026-03-20
tasks_completed: [T01, T02]
requirements_addressed: [R006, R007, R010]
proof_level: contract + integration (runtime UAT deferred to S05)
blocker_discovered: false
---

# S03: Frontend State Synchronization — Summary

**What this slice delivered:** Fixed three frontend state synchronization bugs that blocked the orchestration UX — activePlan timing for approval flow (R006), dag_id-based task completion matching replacing FIFO (R007), and per-worker streaming output attribution (R010). Changes span both backend (enriched @@orch:: events) and frontend (event handling rewrites).

## What Changed

### Backend (T01): Enriched orchestration events

Three enrichments to the @@orch:: event protocol:

1. **phase_changed events** now include `plan_id` (plan.task_id) and `master_agent` (config.master_agent) at all 6 emit sites in `orchestrator.rs`. Frontend can call `setActivePlan()` as soon as orchestration starts.

2. **task_assigned events** now include `dag_id` computed as `def.id.clone().unwrap_or_else(|| format!("t{}", i+1))` — matching DAG construction logic. Frontend builds `dagToFrontendId` with actual IDs, not assumed positional format.

3. **Per-worker stdout tagging** via `orch_tag: Option<String>` parameter added to `spawn_with_env_core`, `spawn_with_env_internal`, and `dispatch_task_internal`. When set, the stdout reader emits `@@orch::worker_output` events with `{dag_id, line}` per stdout line. Orchestrator passes `Some(dag_id)` for workers; non-orchestrated dispatch passes `None`.

3 new unit tests verify dag_id computation (custom ID preserved, positional fallback, mixed). Total: 57 orchestrator tests pass.

### Frontend (T02): Event handling rewrites

Three fixes to `handleOrchEvent.ts`:

1. **activePlan timing (R006):** `setActivePlan()` called from `phase_changed` handler when phase is `decomposing`. Extracts `plan_id` and `master_agent` from enriched event. Guarded with `if (ev.plan_id)`. Existing fallback in `useOrchestratedDispatch.ts` preserved.

2. **dag_id matching (R007):** `dagToFrontendId.set()` in `task_assigned` uses `ev.dag_id` instead of `t${dagCounter+1}`. `task_completed`/`task_failed` use `dagToFrontendId.get(ev.dag_id)` instead of `subTaskQueue.shift()`. FIFO removed entirely. `console.warn` for unmatched dag_id values.

3. **Per-worker output (R010):** New `worker_output` case looks up `dagToFrontendId.get(ev.dag_id)` and calls `store.updateTaskOutputLine(frontendId, ev.line)`. KanbanView already reads `lastOutputLine`.

OrchEvent union type extended with: `plan_id?`/`master_agent?` on phase_changed, `dag_id?` on task_assigned, new `worker_output` and `worker_started` members.

## Files Modified

| File | Changes |
|------|---------|
| `src-tauri/src/commands/orchestrator.rs` | plan_id/master_agent on 6 phase_changed events, dag_id on task_assigned, orch_tag on 3 dispatch calls, 3 new tests |
| `src-tauri/src/process/manager.rs` | orch_tag parameter on spawn_with_env_core/internal, worker_output emission in stdout reader |
| `src-tauri/src/commands/router.rs` | orch_tag parameter on dispatch_task_internal, threaded to spawn, None for non-orchestrated |
| `src/hooks/orchestration/handleOrchEvent.ts` | OrchEvent type extension, setActivePlan in phase_changed, dag_id matching, worker_output handler, console.warn |

## Patterns Established

- **dag_id-based event correlation:** Backend emits dag_id → frontend looks up dagToFrontendId → updates correct task card. This replaces FIFO matching everywhere.
- **orch_tag parameter pattern:** Tagging spawned process output with orchestration identity. When `orch_tag` is set, stdout lines are wrapped in `@@orch::worker_output` events. When `None`, no overhead.

## What S04 Should Know

- **Produces for S04:** `activePlan` available immediately during `awaiting_approval` phase. Task completion events matched correctly by `dag_id`. Per-worker streaming output on `lastOutputLine`.
- **dagToFrontendId is the canonical mapping** from backend dag_id → frontend task entry ID. S04 can use this same map for review/merge UI task correlation.
- **OrchEvent types are manually maintained** (not Specta-generated). Any new `@@orch::` events added in S04 need manual TypeScript type additions.
- **orch_tag is threaded through dispatch** — if S04 needs tagged output for review agent, the same mechanism works (pass a tag string, get worker_output events).

## Verification

All 10 slice-level checks pass:

| # | Check | Result |
|---|-------|--------|
| 1 | `cargo test --lib commands::orchestrator` — 57 tests | ✅ pass |
| 2 | `grep -q 'plan_id' orchestrator.rs` | ✅ pass |
| 3 | `grep -q 'dagToFrontendId.get' handleOrchEvent.ts` | ✅ pass |
| 4 | `! grep -q 'subTaskQueue.shift' handleOrchEvent.ts` | ✅ pass |
| 5 | `grep -q 'setActivePlan' handleOrchEvent.ts` | ✅ pass |
| 6 | `grep -q 'worker_output' handleOrchEvent.ts` | ✅ pass |
| 7 | `grep -q 'worker_output' orchestrator.rs` | ✅ pass |
| 8 | `grep -q 'console.warn' handleOrchEvent.ts` | ✅ pass |
| 9 | `grep -q 'orch_tag' manager.rs` | ✅ pass |
| 10 | `grep -q 'orch_tag' router.rs` | ✅ pass |

TypeScript compilation verified via `npx tsc --noEmit` (zero errors, run against main project node_modules).

## Risks / Open Items

- **Runtime UAT deferred to S05:** All three fixes are contract-verified (grep checks, unit tests, TypeScript compilation) but not visually confirmed through the GUI. The approval flow rendering, task card updates, and per-worker output display need runtime UAT in S05.
- **FIFO fallback removed entirely:** If any code path emits task_completed without dag_id, the event will be silently dropped (console.warn only). This is intentional — T01 ensures all paths include dag_id.
