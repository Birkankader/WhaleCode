# S03: Frontend State Synchronization — Research

**Date:** 2026-03-20
**Depth:** Targeted

## Summary

S03 fixes three frontend state bugs that break the orchestration UX: (1) `activePlan` is null during the `awaiting_approval` phase because `setActivePlan` is called only after the entire `dispatchOrchestratedTask` promise resolves (R006), (2) task completion events use FIFO queue matching (`subTaskQueue.shift()`) instead of the `dag_id` field already present in backend events (R007), and (3) worker streaming output is not attributed per-worker — all output flows through a single `orchestrationId` process in the frontend (R010).

The first two bugs are straightforward fixes in `handleOrchEvent.ts` and `useOrchestratedDispatch.ts`. The third requires either a backend change to tag output events with worker identity or a frontend demuxing strategy — but the existing `MultiAgentOutput` component already handles per-worker display if given the right `taskIds` map.

The highest-risk issue is the `activePlan` timing — it blocks both manual approval (TaskApprovalView guards on `activePlan`) and auto-approve (handleOrchEvent checks `if (activePlan)`). The fix requires the backend to send `plan_id` in a `@@orch::` event so the frontend can set `activePlan` before the promise resolves.

## Recommendation

**Three focused tasks, backend-first:**

1. **Backend: Add `plan_id` and `dag_id` to orchestration events** — Add `plan_id` to every `phase_changed` event (it's available from line 648 of orchestrator.rs before anything streams). Add `dag_id` (or the LLM-provided `def.id`) to `task_assigned` events. This gives the frontend everything it needs to fix the other two bugs without guessing.

2. **Frontend: Fix activePlan + dag_id matching** — In `handleOrchEvent.ts`: (a) extract `plan_id` from the first `phase_changed` event and call `setActivePlan` immediately, and (b) replace `subTaskQueue.shift()` in `task_completed`/`task_failed` with `dagToFrontendId.get(ev.dag_id)`. Also fix `dagToFrontendId` construction — currently hardcodes `t${dagCounter+1}` but backend DAG IDs can be LLM-provided strings (e.g., `"setup"`, `"auth"`). The `task_assigned` event should include the actual `dag_id` so the frontend maps correctly.

3. **Frontend: Per-worker output attribution** — The backend already creates a separate process entry per worker (each `dispatch_task_internal` call returns a unique `task_id`). The problem is the frontend routes ALL output through `emitProcessOutput(orchestrationId, msg)` on the single orchestration channel. Fix: have the backend emit `@@orch::worker_output` events tagged with `dag_id`, and have the frontend demux these to per-worker process entries. The `MultiAgentOutput` component already supports split/tabbed per-worker views — it just needs the correct `taskIds` map.

## Implementation Landscape

### Key Files

- `src-tauri/src/commands/orchestrator.rs` — Backend orchestration. `emit_orch` calls need `plan_id` added to `phase_changed` events (lines 664, 698, 973, 989). `task_assigned` event (line 962) needs `dag_id` added. Lines 1376 already sends `dag_id` in `task_completed`/`task_failed` — no change needed there.
- `src/hooks/orchestration/handleOrchEvent.ts` — Frontend event handler. Three changes: (1) extract `plan_id` from `phase_changed` and call `setActivePlan`, (2) use `dag_id` from `task_assigned` to build `dagToFrontendId` map correctly, (3) replace `subTaskQueue.shift()` with `dagToFrontendId.get(ev.dag_id)` in `task_completed`/`task_failed`.
- `src/hooks/orchestration/useOrchestratedDispatch.ts` — The `setActivePlan` call at line 193 can remain as a fallback (for when the promise resolves), but the primary activation should come from handleOrchEvent. The `emitProcessOutput(orchestrationId, msg)` routing is the root cause of per-worker attribution failure.
- `src/components/views/TaskApprovalView.tsx` — Guards on `activePlan` at lines 34, 185, 205. No change needed here once activePlan is set correctly from events.
- `src/stores/taskStore.ts` — `activePlan` shape may need `master_process_id` to be optional/nullable since we won't have it at the `phase_changed` point (it's set later during master spawn). Already nullable (`string | null`).
- `src/components/orchestration/MultiAgentOutput.tsx` — Already supports per-worker display with `taskIds: Map<ToolName, string>`. Not used anywhere currently. Needs to be wired into the orchestration view with real worker process IDs.

### Build Order

**Task 1 (backend):** Add `plan_id` to all `phase_changed` events and `dag_id` to `task_assigned` events. This is the enabler for both frontend fixes. Verify with existing orchestrator tests — they cover emit_orch calls.

**Task 2 (frontend — activePlan + dag_id matching):** Fix the two state bugs. This is the highest-value change — unblocks approval flow entirely. Can be verified by checking that `activePlan` is set when `orchestrationPhase === 'awaiting_approval'`, and that task completion updates the correct card.

**Task 3 (frontend — per-worker output):** Wire per-worker output attribution. This is the most complex change but also the lowest-risk (streaming output is a nice-to-have vs. approval flow which is blocking). Options: (a) create separate `Channel<OutputEvent>` per worker in the backend (invasive), or (b) demux `@@orch::` tagged output in the frontend (simpler). Recommend option (b): the backend already has the `dag_id` context when dispatching — add an `@@orch::worker_stdout` event wrapper, and have the frontend create per-worker process entries in the process store, routing output to them.

### Verification Approach

- **activePlan timing:** `grep -n 'setActivePlan' src/hooks/orchestration/handleOrchEvent.ts` — must show a call in the `phase_changed` handler (decomposing or awaiting_approval case). Check `TaskApprovalView` renders when `orchestrationPhase === 'awaiting_approval'` by confirming `activePlan` is non-null at that point.
- **dag_id matching:** `grep -n 'subTaskQueue.shift' src/hooks/orchestration/handleOrchEvent.ts` — must return 0 results (replaced with dagToFrontendId lookup). Check that `dagToFrontendId.get(ev.dag_id)` is used in task_completed/task_failed handlers.
- **Per-worker output:** Check that `MultiAgentOutput` is rendered somewhere in the orchestration view with real worker process IDs, or that the KanbanView task cards show `lastOutputLine` from per-worker output.
- **Backend events:** `cargo test --lib commands::orchestrator` — 48+ tests, <1s. Verify new fields in emit_orch calls.
- **TypeScript:** Copy modified TS files to main project, run `npx tsc --noEmit` to verify compilation.

## Constraints

- `OutputEvent` enum is part of the Specta-generated TypeScript bindings. Adding a field (like `task_id`) would change the IPC contract and require frontend binding updates. The `@@orch::` prefix approach (embedding metadata in `Stdout` string payloads) avoids this — it's the existing pattern.
- `activePlan` shape includes `master_process_id: string | null`. At the `phase_changed` (decomposing) point, the master hasn't spawned yet so `master_process_id` is null. The field is already nullable, so this works.
- `dagToFrontendId` uses `t{N}` keys but S01 changed DAG construction to use `def.id.clone().unwrap_or_else(|| format!("t{}", i+1))`. If an LLM provides IDs like `"setup"`, the backend's `dag_id` in `task_completed` will be `"setup"`, not `"t1"`. The frontend map must use the actual DAG ID, not assume `t{N}` format.

## Common Pitfalls

- **dagToFrontendId key mismatch** — The frontend currently constructs keys as `t${dagCounter+1}` but backend DAG IDs can be LLM-provided strings. If the backend sends `dag_id: "setup"` in `task_completed` but the frontend mapped it as `t1`, the lookup fails and no task card is updated. Fix: have `task_assigned` include the actual `dag_id` so the frontend uses the correct key.
- **setActivePlan ordering with auto-approve** — If `setActivePlan` is called in the `decomposing` phase_changed handler but auto-approve checks it in the `awaiting_approval` handler, timing is fine (decomposing fires first). But if both happen in the same event loop tick, ensure the store update is synchronous (Zustand `set` is synchronous, so this is safe).
- **Per-worker process store pollution** — Creating per-worker entries in the frontend `processStore` means `processes.size` grows. The existing `orchestrationId` entry represents the entire orchestration. Worker entries should be distinguishable (e.g., via a `parentOrchestrationId` field or convention) so the UI doesn't show them as separate top-level processes.

## Open Risks

- **Per-worker output complexity** — The simplest approach (demux `@@orch::` events) may miss raw stdout/stderr that doesn't go through `emit_orch`. Worker processes send raw NDJSON output through the shared channel. Full attribution may require the backend to prefix all worker stdout lines with a `dag_id` tag, which is more invasive. A pragmatic first step is to attribute `@@orch::` events per-worker and show raw output in the unified orchestration console.
