---
id: T02
parent: S01
milestone: M001
provides:
  - Frontend decomposition_failed event handling with error propagation to masterTask.resultSummary
  - Error path coverage in useOrchestratedDispatch ensuring DecompositionErrorCard always shows actual backend errors
key_files:
  - src/hooks/orchestration/handleOrchEvent.ts
  - src/hooks/orchestration/useOrchestratedDispatch.ts
key_decisions:
  - Used direct for...of iteration on store.tasks instead of Array.from().find() — same result, fewer allocations
patterns_established:
  - Set masterTask.resultSummary on every error path before transitioning orchestration phase to 'failed'
observability_surfaces:
  - masterTask.resultSummary always populated on error — DecompositionErrorCard resolves at first priority tier
  - orchestration logs include error-level entry from decomposition_failed handler
duration: 10m
verification_result: passed
completed_at: 2026-03-20
blocker_discovered: false
---

# T02: Wire frontend error propagation so DecompositionErrorCard shows actual backend errors

**Wired decomposition_failed event handler and error-path resultSummary propagation so DecompositionErrorCard displays actual backend errors instead of generic fallback text.**

## What Happened

Three changes across two files to close the frontend error propagation gap:

1. **OrchEvent type union** (`handleOrchEvent.ts`) — Added `dag_id?: string` to `task_completed` and `task_failed` event types (backend already sends this field). Added `decomposition_failed` event type with `error: string` payload.

2. **decomposition_failed handler** (`handleOrchEvent.ts`) — Added switch case that calls `log('error', ev.error)` to populate orchestration logs AND iterates `store.tasks` to find the master task and call `store.updateTaskResult(id, ev.error)` to set `resultSummary`. This ensures the DecompositionErrorCard finds the error through both its first two priority paths (resultSummary and error-level logs).

3. **Error path coverage** (`useOrchestratedDispatch.ts`) — In the `result.status === 'error'` branch: find the running master task, call `updateTaskResult(id, result.error)` and `updateTaskStatus(id, 'failed')` before setting phase to failed. In the `catch` block: extract error message via `e instanceof Error ? e.message : String(e)`, find the master task, and call `updateTaskResult(id, errorMsg)` before marking running tasks as failed. Both paths now populate resultSummary before the phase transitions to 'failed'.

## Verification

All task-level and slice-level checks pass:
- `updateTaskResult` count in `useOrchestratedDispatch.ts` = 3 (1 existing success + 2 new error paths) ✅
- `decomposition_failed` present in `handleOrchEvent.ts` ✅
- `dag_id` declared in `handleOrchEvent.ts` event types ✅
- TypeScript compilation: zero errors (validated against main project's compiler with node_modules) ✅
- All 5 slice-level grep checks pass ✅

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `grep -c 'updateTaskResult' src/hooks/orchestration/useOrchestratedDispatch.ts` (returns 3) | 0 | ✅ pass | <1s |
| 2 | `grep -q 'decomposition_failed' src/hooks/orchestration/handleOrchEvent.ts` | 0 | ✅ pass | <1s |
| 3 | `grep -q 'dag_id' src/hooks/orchestration/handleOrchEvent.ts` | 0 | ✅ pass | <1s |
| 4 | `npx tsc --noEmit` (main project with modified files) | 0 | ✅ pass | ~15s |
| 5 | `grep -q 'pub id: Option<String>' src-tauri/src/router/orchestrator.rs` (slice check) | 0 | ✅ pass | <1s |
| 6 | `grep -q 'decomposition_failed' src-tauri/src/commands/orchestrator.rs` (slice check) | 0 | ✅ pass | <1s |

## Diagnostics

- **Runtime inspection:** After a failed decomposition, check `masterTask.resultSummary` in the task store — it should contain the specific backend error. The orchestration logs panel also shows the error via `log('error', ...)`.
- **Error card behavior:** `DecompositionErrorCard` reads `masterTask?.resultSummary` first. Since all error paths now populate this field before transitioning to `'failed'`, the generic fallback message should never appear for backend-originated errors.
- **decomposition_failed event:** When the backend emits `@@orch::decomposition_failed`, the frontend handler logs it at error level and sets resultSummary on the master task — both visible in the Orchestration Logs panel.

## Deviations

- Used direct `for...of` iteration on `store.tasks` entries instead of the plan's `Array.from(store.tasks.values()).find()` two-pass pattern — functionally identical but avoids unnecessary array allocation.

## Known Issues

- TypeScript verification required copying files to the main project directory (worktree lacks `node_modules`). The main project's `tsc --noEmit` confirmed zero errors.

## Files Created/Modified

- `src/hooks/orchestration/handleOrchEvent.ts` — Added `dag_id` to task_completed/task_failed types, added `decomposition_failed` event type and handler
- `src/hooks/orchestration/useOrchestratedDispatch.ts` — Added `updateTaskResult` calls on both error paths (result.status==='error' and catch block)
