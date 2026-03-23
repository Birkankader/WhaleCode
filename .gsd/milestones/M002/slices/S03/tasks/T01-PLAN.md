---
estimated_steps: 5
estimated_files: 3
skills_used:
  - test
---

# T01: Fix stale test, remove subTaskQueue, guard redundant setActivePlan

**Slice:** S03 — Frontend State & Approval Flow
**Milestone:** M002

## Description

The handleOrchEvent test suite has 1 stale failure (expects `'running'` but handler correctly sets `'waiting'` — workers wait for `worker_started` to transition to running). The `subTaskQueue` array is residual from the old FIFO matching approach — all task completion matching already uses `dagToFrontendId`. The promise-path `setActivePlan` at `useOrchestratedDispatch.ts:193` is redundant with the event-based path that fires during Phase 1. This task fixes the test, removes the dead code, and guards the redundant call.

## Steps

1. **Fix stale test** — In `src/tests/handleOrchEvent.test.ts` line 88, change `toBe('running')` to `toBe('waiting')`. The `phase_changed` → `executing` handler sets workers to `'waiting'` status, not `'running'` — workers transition to `'running'` only when `worker_started` event arrives. Run `npx vitest run src/tests/handleOrchEvent.test.ts` to confirm all 22 pass.

2. **Remove subTaskQueue from handleOrchEvent.ts** — Remove the `subTaskQueue: string[]` parameter (3rd param) from the `handleOrchEvent` function signature. Remove all `subTaskQueue.push(...)`, `subTaskQueue.findIndex(...)`, `subTaskQueue.splice(...)`, and `subTaskQueue.indexOf(...)` calls inside the handlers for `task_assigned`, `task_completed`, `task_skipped`, and `task_retrying` events. The matching logic via `dagToFrontendId.get(ev.dag_id!)` is what actually works — the queue operations are cleanup that serves no purpose.

3. **Remove subTaskQueue from useOrchestratedDispatch.ts** — Remove the `const subTaskQueue: string[] = []` declaration (~line 32). Update the `handleOrchEvent(...)` call (~line 58) to remove the `subTaskQueue` argument.

4. **Update test helper** — In `src/tests/handleOrchEvent.test.ts`, remove `subTaskQueue: [] as string[]` from `freshContext()` and remove `ctx.subTaskQueue` from the `dispatch` helper function call. Verify the test for `task_assigned` that checks `ctx.subTaskQueue` (line 143) — either remove that assertion or replace it with a check on the task store state instead.

5. **Guard redundant setActivePlan** — In `useOrchestratedDispatch.ts` at line 193, wrap the `taskState.setActivePlan({...})` call with `if (!taskState.activePlan)` so it only fires if the event-based path (which fires during Phase 1 decomposing) didn't already set it. This makes the promise-resolution path a fallback rather than an overwrite. Run `npx tsc --noEmit` and full test suite.

## Must-Haves

- [ ] Test at line 88 expects `'waiting'` not `'running'`
- [ ] `subTaskQueue` removed from `handleOrchEvent` signature and body
- [ ] `subTaskQueue` removed from `useOrchestratedDispatch.ts`
- [ ] Test helper updated — no `subTaskQueue` in `freshContext` or `dispatch`
- [ ] `setActivePlan` in promise path guarded with `if (!taskState.activePlan)`
- [ ] All 22 handleOrchEvent tests pass
- [ ] `npx tsc --noEmit` — zero errors

## Verification

- `npx vitest run src/tests/handleOrchEvent.test.ts` — 22/22 pass (zero failures)
- `rg "subTaskQueue" src/` — zero matches
- `npx tsc --noEmit` — zero errors

## Inputs

- `src/tests/handleOrchEvent.test.ts` — stale test to fix + test helper to update
- `src/hooks/orchestration/handleOrchEvent.ts` — event handler with residual subTaskQueue parameter
- `src/hooks/orchestration/useOrchestratedDispatch.ts` — owns subTaskQueue declaration and redundant setActivePlan

## Expected Output

- `src/tests/handleOrchEvent.test.ts` — fixed test expectation, removed subTaskQueue from helper
- `src/hooks/orchestration/handleOrchEvent.ts` — subTaskQueue parameter removed, splice operations removed
- `src/hooks/orchestration/useOrchestratedDispatch.ts` — subTaskQueue removed, setActivePlan guarded

## Observability Impact

- **Signals changed:** `handleOrchEvent` function signature drops from 5 to 4 params — any out-of-tree caller passing 5 args will get a TS error at compile time.
- **Inspection:** `npx vitest run src/tests/handleOrchEvent.test.ts` — 22 tests cover all event types; the executing-phase test now correctly expects `'waiting'` status.
- **Failure visibility:** `console.warn` remains for unmatched `dag_id` in task_completed/task_failed — observable in browser devtools. The `setActivePlan` guard means the promise-path only fires as fallback, so if `activePlan` is unexpectedly null after orchestration, the event-based path failed to set it during Phase 1 — diagnosable via checking `orchestrationPhase` transitions in `orchestrationLogs`.
