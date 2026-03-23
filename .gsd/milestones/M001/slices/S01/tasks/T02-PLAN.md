---
estimated_steps: 4
estimated_files: 2
skills_used: []
---

# T02: Wire frontend error propagation so DecompositionErrorCard shows actual backend errors

**Slice:** S01 — Decomposition & Error Pipeline
**Milestone:** M001

## Description

Fix the frontend error propagation chain so that `DecompositionErrorCard` always displays the actual backend error message, not the generic fallback "The master agent failed to decompose the task into sub-tasks."

The error card reads its message from this priority chain (in `DecompositionErrorCard.tsx`, line ~56):
```typescript
const errorMessage =
  masterTask?.resultSummary ||
  orchestrationLogs.filter((l) => l.level === 'error').pop()?.message ||
  'The master agent failed to decompose the task into sub-tasks.';
```

Currently, `masterTask.resultSummary` is only set on success paths (line ~166 of `useOrchestratedDispatch.ts`). On failure paths (the `result.status === 'error'` branch at line ~206 and the `catch` block at line ~210), nobody calls `updateTaskResult`, so the error card falls through to the generic message.

Additionally, the `OrchEvent` TypeScript union in `handleOrchEvent.ts` is missing:
- `dag_id` on `task_completed` / `task_failed` events (backend sends it, frontend type doesn't declare it)
- `decomposition_failed` event type (added by T01 on the backend)

**Note:** The `DecompositionErrorCard.tsx` component itself does NOT need changes — its error reading logic is correct. The fix is upstream: ensure `resultSummary` and/or error-level orchestration logs are always populated when failures occur.

## Steps

1. **Update `OrchEvent` type union** in `src/hooks/orchestration/handleOrchEvent.ts`. Add `dag_id?: string` to `task_completed` and `task_failed` event types. Add a new event type for `decomposition_failed`:
   ```typescript
   | { type: 'task_completed'; dag_id?: string; summary?: string; exit_code?: number }
   | { type: 'task_failed'; dag_id?: string; summary?: string; exit_code?: number }
   | { type: 'decomposition_failed'; error: string }
   ```

2. **Add `decomposition_failed` handler** in the `switch` statement in `handleOrchEvent`:
   ```typescript
   case 'decomposition_failed': {
     log('error', ev.error);
     // Also store on master task so DecompositionErrorCard can read it
     const masterTask = Array.from(store.tasks.values()).find(t => t.role === 'master');
     if (masterTask) {
       const masterId = Array.from(store.tasks.entries()).find(([, t]) => t.role === 'master')?.[0];
       if (masterId) {
         store.updateTaskResult(masterId, ev.error);
       }
     }
     break;
   }
   ```
   This ensures the error flows into both `orchestrationLogs` (via the `log()` call) AND `masterTask.resultSummary` (via `updateTaskResult`), so the `DecompositionErrorCard` will find it through either of its first two priority paths.

3. **Set `resultSummary` on error paths** in `src/hooks/orchestration/useOrchestratedDispatch.ts`:

   **(a)** In the `result.status === 'error'` block (around line 206), before `throw new Error(result.error)`, find the master task and set its resultSummary:
   ```typescript
   } else {
     console.error('Orchestration failed:', result.error);
     useProcessStore.getState()._updateStatus(orchestrationId, 'failed', -1);
     // Set error on master task so DecompositionErrorCard shows it
     const taskState = useTaskStore.getState();
     for (const [id, t] of taskState.tasks) {
       if (t.role === 'master' && t.status === 'running') {
         taskState.updateTaskResult(id, result.error);
         taskState.updateTaskStatus(id, 'failed');
         break;
       }
     }
     taskState.setOrchestrationPhase('failed');
     throw new Error(result.error);
   }
   ```

   **(b)** In the `catch` block (around line 210), before marking running tasks as failed, find the master task and set its resultSummary:
   ```typescript
   } catch (e) {
     console.error('Orchestration error:', e);
     useProcessStore.getState()._updateStatus(orchestrationId, 'failed', -1);
     const taskState = useTaskStore.getState();
     taskState.setOrchestrationPhase('failed');

     // Set error on master task so DecompositionErrorCard shows it
     const errorMsg = e instanceof Error ? e.message : String(e);
     for (const [id, t] of taskState.tasks) {
       if (t.role === 'master') {
         taskState.updateTaskResult(id, errorMsg);
         break;
       }
     }

     // Mark any running tasks as failed
     const currentTasks = new Map(taskState.tasks);
     for (const [id, t] of currentTasks) {
       if (t.status === 'running') {
         currentTasks.set(id, { ...t, status: 'failed' });
       }
     }
     useTaskStore.setState({ tasks: currentTasks });

     throw e;
   }
   ```

4. **Verify** that the changes compile and types are correct:
   ```bash
   npx tsc --noEmit 2>&1 | head -20
   ```

## Must-Haves

- [ ] `OrchEvent` type includes `dag_id?: string` on `task_completed` and `task_failed`
- [ ] `OrchEvent` type includes `decomposition_failed` event with `error: string`
- [ ] `handleOrchEvent` handles `decomposition_failed` by logging error AND setting `resultSummary` on master task
- [ ] `useOrchestratedDispatch.ts` calls `updateTaskResult` on the master task in both the `result.status === 'error'` path and the `catch` block
- [ ] No TypeScript compilation errors

## Verification

- `grep -c 'updateTaskResult' src/hooks/orchestration/useOrchestratedDispatch.ts` — returns >= 3 (1 existing success path + 2 new error paths)
- `grep -q 'decomposition_failed' src/hooks/orchestration/handleOrchEvent.ts` — event type and handler exist
- `grep -q 'dag_id' src/hooks/orchestration/handleOrchEvent.ts` — dag_id declared in event types

## Inputs

- `src/hooks/orchestration/handleOrchEvent.ts` — contains `OrchEvent` type union and event handler switch statement
- `src/hooks/orchestration/useOrchestratedDispatch.ts` — contains the dispatch promise handler with success/error/catch paths

## Expected Output

- `src/hooks/orchestration/handleOrchEvent.ts` — modified: `OrchEvent` types updated, `decomposition_failed` handler added
- `src/hooks/orchestration/useOrchestratedDispatch.ts` — modified: `updateTaskResult` called on both error paths

## Observability Impact

- **New signal:** `decomposition_failed` event is now handled on the frontend — the handler calls `log('error', ev.error)` which populates orchestration logs, AND calls `store.updateTaskResult(masterId, ev.error)` which sets `masterTask.resultSummary`.
- **Error path visibility:** Both the `result.status === 'error'` branch and the `catch` block in `useOrchestratedDispatch.ts` now call `taskState.updateTaskResult()` on the master task, ensuring `DecompositionErrorCard` always shows the actual backend error string instead of the generic fallback.
- **Inspection:** After a failed decomposition, check `masterTask.resultSummary` in the task store — it should contain the specific error message from the backend. The orchestration logs panel will also show the error via the `log('error', ...)` call.
- **Failure state:** When orchestration fails, the master task's `resultSummary` is always populated before the phase transitions to `'failed'`, so the error card's priority chain (`resultSummary` → error logs → generic fallback) resolves at the first tier.
