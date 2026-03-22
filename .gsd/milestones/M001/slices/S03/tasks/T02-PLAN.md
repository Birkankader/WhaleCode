---
estimated_steps: 5
estimated_files: 3
skills_used: []
---

# T02: Fix activePlan timing, dag_id matching, and per-worker output attribution in frontend

**Slice:** S03 — Frontend State Synchronization
**Milestone:** M001

## Description

Three frontend state bugs break the orchestration UX. All three fixes are in the same event handler file and depend on the enriched backend events from T01.

**Bug 1 — activePlan null during approval (R006):** `setActivePlan` is called only when the `dispatchOrchestratedTask` promise resolves (line ~193 of `useOrchestratedDispatch.ts`). The promise doesn't resolve until ALL phases complete. During `awaiting_approval`, `activePlan` is null, so `TaskApprovalView` (which guards on `activePlan` at line 34) doesn't render, and auto-approve (which checks `if (activePlan)` at line 53 of `handleOrchEvent.ts`) silently skips.

**Fix:** In the `phase_changed` handler, extract `plan_id` and `master_agent` from the event (added by T01). Call `setActivePlan({ task_id: ev.plan_id, master_agent: ev.master_agent, master_process_id: null })` on the first phase_changed event (decomposing). The `master_process_id` is null at this point — it's already nullable in the store type.

**Bug 2 — FIFO task completion matching (R007):** `task_completed`/`task_failed` handlers use `subTaskQueue.shift()` which returns the oldest queued task regardless of which one actually completed. Backend already sends `dag_id` in these events (from S01). The `dagToFrontendId` map is maintained but not used for completion matching.

**Fix:** Replace `subTaskQueue.shift()` with `dagToFrontendId.get(ev.dag_id)`. If the lookup fails (undefined), emit a `console.warn` with the unmatched `dag_id` for debugging. Also fix `dagToFrontendId` key construction: currently hardcodes `t${dagCounter+1}` but T01 now sends the actual `dag_id` in `task_assigned` events. Use `ev.dag_id` as the key instead.

**Bug 3 — per-worker output unattributed (R010):** All worker output flows through `emitProcessOutput(orchestrationId, msg)`. T01 added `@@orch::worker_output` events with `{dag_id, line}` for each worker stdout line.

**Fix:** Add a `worker_output` case to the `handleOrchEvent` switch. Look up `dagToFrontendId.get(ev.dag_id)` to find the frontend task ID. Call `store.updateTaskOutputLine(frontendId, ev.line)` to set `lastOutputLine` on the task, which the KanbanView already displays.

**Key knowledge:** `OrchEvent` TypeScript types are manually maintained (not auto-generated). The `useTaskStore` `set()` is synchronous (Zustand). `setActivePlan` ordering with auto-approve is safe — decomposing fires before awaiting_approval.

## Steps

1. **Add new event types to `OrchEvent` union in `handleOrchEvent.ts`.** Add `plan_id?: string` and `master_agent?: string` to `phase_changed` type. Add `dag_id?: string` to `task_assigned` type. Add new union member: `{ type: 'worker_output'; dag_id: string; line: string }`. Also add `{ type: 'worker_started'; dag_id: string; process_id: string }` for future use.

2. **Fix activePlan timing in `phase_changed` handler.** In the `decomposing` case, after setting `orchestrationPhase`, call `store.setActivePlan({ task_id: ev.plan_id!, master_agent: ev.master_agent as ToolName ?? masterAgent, master_process_id: null })`. Guard with `if (ev.plan_id)` to gracefully degrade if backend hasn't been updated. This ensures `activePlan` is available before `awaiting_approval` fires, so the auto-approve check at line ~53 sees a non-null `activePlan`.

3. **Fix dagToFrontendId key in `task_assigned` handler.** Replace `dagToFrontendId.set(\`t${dagCounter + 1}\`, subId)` with `dagToFrontendId.set(ev.dag_id ?? \`t${dagCounter + 1}\`, subId)`. This uses the actual DAG ID from the backend (which handles LLM-provided IDs like `"setup"`) while falling back to the old `t{N}` format for backward compatibility.

4. **Replace FIFO matching in `task_completed`/`task_failed` handler.** Replace `const targetId = subTaskQueue.shift()` with:
   ```typescript
   const targetId = ev.dag_id ? dagToFrontendId.get(ev.dag_id) : subTaskQueue.shift();
   if (!targetId && ev.dag_id) {
     console.warn(`Unmatched dag_id in ${ev.type}: ${ev.dag_id}`);
   }
   ```
   This uses dag_id lookup when available, falls back to FIFO for backward compatibility, and warns on mismatches.

5. **Add `worker_output` handler.** Add case in the switch:
   ```typescript
   case 'worker_output': {
     const frontendId = dagToFrontendId.get(ev.dag_id);
     if (frontendId) {
       store.updateTaskOutputLine(frontendId, ev.line);
     }
     break;
   }
   ```
   The method is `updateTaskOutputLine` in `taskStore.ts` (line ~144). The KanbanView already reads `task.lastOutputLine` and displays it on running task cards.

## Must-Haves

- [ ] `setActivePlan` is called from `phase_changed` handler with `plan_id` and `master_agent` from event payload
- [ ] `dagToFrontendId` uses `ev.dag_id` from `task_assigned` events as key (not hardcoded `t{N}`)
- [ ] `task_completed`/`task_failed` use `dagToFrontendId.get(ev.dag_id)` instead of `subTaskQueue.shift()`
- [ ] `worker_output` event handler updates `lastOutputLine` on the correct task via `dagToFrontendId`
- [ ] `OrchEvent` union type includes all new event fields and types
- [ ] Existing `setActivePlan` call in `useOrchestratedDispatch.ts` kept as fallback (not removed)

## Verification

- `grep -q 'setActivePlan' src/hooks/orchestration/handleOrchEvent.ts` — activePlan set from events
- `! grep -q 'subTaskQueue.shift' src/hooks/orchestration/handleOrchEvent.ts` — FIFO removed (or only used as fallback behind `ev.dag_id` check)
- `grep -q 'dagToFrontendId.get' src/hooks/orchestration/handleOrchEvent.ts` — dag_id lookup used
- `grep -q 'worker_output' src/hooks/orchestration/handleOrchEvent.ts` — worker_output handler exists
- `grep -q "ev.dag_id" src/hooks/orchestration/handleOrchEvent.ts` — dag_id used from events (not computed)
- Copy modified TS files to main project and run `npx tsc --noEmit` to verify compilation (per worktree knowledge)

## Inputs

- `src/hooks/orchestration/handleOrchEvent.ts` — current event handler with OrchEvent union, phase_changed/task_assigned/task_completed handlers
- `src/hooks/orchestration/useOrchestratedDispatch.ts` — current setActivePlan call (to keep as fallback)
- `src/stores/taskStore.ts` — activePlan type, updateTaskLastOutput method, setActivePlan method

## Expected Output

- `src/hooks/orchestration/handleOrchEvent.ts` — enriched OrchEvent types, activePlan set from events, dag_id matching, worker_output handler
- `src/hooks/orchestration/useOrchestratedDispatch.ts` — no changes required (setActivePlan call kept as-is for fallback)
- `src/stores/taskStore.ts` — no changes expected (updateTaskLastOutput already exists at line ~145)

## Observability Impact

- **activePlan timing**: `activePlan` is now set from `phase_changed` events during `decomposing` phase, making it non-null before `awaiting_approval`. Inspect via `useTaskStore.getState().activePlan` in browser console during orchestration.
- **dag_id matching**: `dagToFrontendId` map now uses actual DAG IDs from backend events. If a `dag_id` is unmatched, a `console.warn` is emitted — check browser console for `"Unmatched dag_id"` messages to debug mismatches.
- **worker_output attribution**: Each worker task card's `lastOutputLine` is updated in real-time via `@@orch::worker_output` events. Inspect individual task entries in `useTaskStore.getState().tasks` — each running worker's `lastOutputLine` should show its own latest stdout line.
