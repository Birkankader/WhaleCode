---
id: T01
parent: S03
milestone: M002
provides:
  - Green handleOrchEvent test baseline (22/22)
  - subTaskQueue fully removed from frontend codebase
  - setActivePlan promise-path guarded as fallback
key_files:
  - src/tests/handleOrchEvent.test.ts
  - src/hooks/orchestration/handleOrchEvent.ts
  - src/hooks/orchestration/useOrchestratedDispatch.ts
key_decisions:
  - setActivePlan guard uses `if (!taskState.activePlan)` — promise path is fallback only
  - Replaced subTaskQueue assertion with store.tasks.has() check (verifies same invariant via real state)
patterns_established:
  - dagToFrontendId is the sole task-matching mechanism — no secondary queue
observability_surfaces:
  - console.warn on unmatched dag_id in task_completed/task_failed
  - orchestrationLogs captures all phase transitions for post-hoc inspection
duration: 15m
verification_result: passed
completed_at: 2026-03-23
blocker_discovered: false
---

# T01: Fix stale test, remove subTaskQueue, guard redundant setActivePlan

**Fixed stale executing-phase test expectation, removed all subTaskQueue residue from handler/dispatch/tests, and guarded promise-path setActivePlan as event-path fallback.**

## What Happened

1. Changed test expectation at line 88 from `'running'` to `'waiting'` — the executing-phase handler correctly sets workers to `'waiting'` (they transition to `'running'` on `worker_started`).
2. Removed `subTaskQueue: string[]` parameter from `handleOrchEvent` function signature (5 params → 4). Stripped all `subTaskQueue.push()`, `.findIndex()`, `.indexOf()`, and `.splice()` calls from `task_assigned`, `task_completed/task_failed`, `task_skipped`, and `task_retrying` handlers. The `dagToFrontendId` map is the only matching mechanism needed.
3. Removed `const subTaskQueue: string[] = []` declaration and the argument from the `handleOrchEvent(...)` call in `useOrchestratedDispatch.ts`.
4. Updated test helper: removed `subTaskQueue` from `freshContext()` and `dispatch()`. Replaced the `ctx.subTaskQueue` assertion with `useTaskStore.getState().tasks.has('test-uuid-1')` — verifies the task was registered via real store state.
5. Wrapped the promise-path `setActivePlan` call with `if (!taskState.activePlan)` so it only fires when the event-based path (Phase 1 decomposing) didn't already set it.

## Verification

- `npx vitest run src/tests/handleOrchEvent.test.ts` — 22/22 pass ✅
- `grep -r "subTaskQueue" src/` — zero matches ✅
- `npx tsc --noEmit` — zero errors ✅
- `npx vitest run` — full suite 94/94 pass ✅

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx vitest run src/tests/handleOrchEvent.test.ts` | 0 | ✅ pass | 0.3s |
| 2 | `grep -r "subTaskQueue" src/` | 1 (no matches) | ✅ pass | 0.1s |
| 3 | `npx tsc --noEmit` | 0 | ✅ pass | 3.4s |
| 4 | `npx vitest run` | 0 | ✅ pass | 0.8s |

## Diagnostics

- Run `npx vitest run src/tests/handleOrchEvent.test.ts` to verify all 22 event handler tests.
- If `activePlan` is unexpectedly null after orchestration completes, the event-based path failed during Phase 1 — check `orchestrationLogs` for `phase_changed` → `decomposing` entries.
- `console.warn` fires in browser devtools when `task_completed` or `task_failed` arrives with an unmatched `dag_id`.

## Deviations

None — all five steps executed as planned.

## Known Issues

None.

## Files Created/Modified

- `src/tests/handleOrchEvent.test.ts` — Fixed stale `'running'` → `'waiting'` expectation, removed subTaskQueue from helper, replaced queue assertion with store check
- `src/hooks/orchestration/handleOrchEvent.ts` — Removed subTaskQueue parameter and all queue operations (push/splice/indexOf/findIndex)
- `src/hooks/orchestration/useOrchestratedDispatch.ts` — Removed subTaskQueue declaration, removed it from handleOrchEvent call, guarded promise-path setActivePlan
