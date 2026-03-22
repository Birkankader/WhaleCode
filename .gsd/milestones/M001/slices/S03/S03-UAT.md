# S03: Frontend State Synchronization — UAT Script

## Preconditions

- WhaleCode app builds and launches (`cargo tauri dev`)
- At least one CLI agent configured and authenticated (Claude Code, Gemini CLI, or Codex CLI)
- A real git repository open in WhaleCode as the active project
- Auto-approve is **disabled** in settings (to test manual approval flow)

---

## Test Case 1: activePlan Available During Approval Phase (R006)

**Goal:** Confirm TaskApprovalView renders with plan data during awaiting_approval, not blank/null.

### Steps

1. Open WhaleCode with a real project directory
2. Enter a multi-part task in the orchestration input (e.g. "Add a README.md file and create a LICENSE file")
3. Submit the task for orchestration
4. **Observe** the UI during the decomposition → awaiting_approval transition
5. Open browser DevTools console and run: `useTaskStore.getState().activePlan`

### Expected

- TaskApprovalView renders showing the decomposed sub-tasks with agent assignments
- `activePlan` is non-null with `task_id` and `master_agent` fields populated
- activePlan was set **before** the awaiting_approval phase (during decomposing), not after promise resolution
- If you reject and re-submit, activePlan updates to the new plan

### Edge Cases

- **Extremely fast decomposition:** Even if decomposition completes in <1s, activePlan should still be set from the phase_changed event before the approval UI renders
- **Decomposition failure:** If decomposition fails, activePlan may or may not be set (depending on how far the phase_changed event got), but the DecompositionErrorCard should render with the error detail (R002)

---

## Test Case 2: Task Completion Matches Correct Card (R007)

**Goal:** Confirm out-of-order task completions update the correct Kanban task cards.

### Steps

1. Submit a task that decomposes into 3+ sub-tasks
2. Approve the plan
3. **Observe** the Kanban board during worker execution
4. Note which worker finishes first
5. Verify the completed status appears on the **correct** task card (matching the worker that actually finished)

### Expected

- If Worker B (e.g. task "Create LICENSE") finishes before Worker A (e.g. task "Add README"), Worker B's card shows completion status — not Worker A's card
- Each completion updates the task card matching its dag_id, regardless of finish order
- No "Unmatched dag_id" warnings in browser console (DevTools → Console)

### Edge Cases

- **Single sub-task decomposition:** Even with 1 task, dag_id matching should work (no FIFO to fall back to)
- **Custom LLM IDs:** If the LLM returns custom IDs like "setup" or "auth" instead of "t1", "t2", the matching should still work because dag_id uses `def.id` from SubTaskDef

---

## Test Case 3: Per-Worker Streaming Output (R010)

**Goal:** Confirm each worker task card shows its own real-time output, not interleaved output from other workers.

### Steps

1. Submit a multi-task orchestration with 2+ workers
2. Approve the plan
3. During worker execution, observe the Kanban cards for each worker
4. Each card should show a `lastOutputLine` that corresponds to **that specific worker's** agent output

### Expected

- Worker A's card shows output from Worker A's agent (e.g. Claude generating README content)
- Worker B's card shows output from Worker B's agent (e.g. Claude generating LICENSE content)
- Output lines do NOT bleed across workers — each card has independent lastOutputLine updates
- Output updates in real-time (not just on completion)

### Edge Cases

- **Same agent type:** If both workers are Claude, output must still be correctly attributed by dag_id, not by agent name
- **Worker failure:** If a worker errors, its output should stop updating, and the failure event should match the correct card

---

## Test Case 4: Console Diagnostics for Unmatched Events

**Goal:** Verify the diagnostic console.warn fires when dag_id correlation fails (simulated or real).

### Steps

1. Open browser DevTools Console before starting orchestration
2. Run a normal orchestration
3. Filter console for "dag_id" warnings
4. Confirm zero warnings during a normal successful run

### Expected

- Normal orchestration: zero `console.warn` messages about unmatched dag_id
- If backend somehow emits a dag_id not in dagToFrontendId (e.g. due to a bug), a warning like `Unmatched dag_id in task_completed: <id>` appears in console

---

## Test Case 5: Orchestration Log Observability

**Goal:** Verify enriched events are visible in orchestration logs.

### Steps

1. Start an orchestration
2. Open the orchestration logs panel
3. Check that phase_changed entries include plan context (plan_id, master_agent)
4. Check that task_assigned entries include dag_id
5. Check that worker_output entries appear during execution with per-worker attribution

### Expected

- Phase transition logs show which master agent and plan ID are involved
- Task assignment logs show the dag_id for each worker
- During execution, worker output lines appear in logs with dag_id attribution
- All @@orch:: events are traceable in the log panel

---

## Failure Modes to Watch

| Symptom | Likely Cause | Debug |
|---------|-------------|-------|
| TaskApprovalView shows blank/spinner | activePlan still null during approval | Check `useTaskStore.getState().activePlan` in console |
| Wrong task card shows "completed" | FIFO matching still active somewhere | `grep 'subTaskQueue' src/hooks/orchestration/` — should return nothing |
| All workers show same output line | worker_output events not demuxed by dag_id | Check dagToFrontendId map size vs worker count |
| Console warns about unmatched dag_id | dag_id format mismatch between backend and frontend | Compare `grep 'dag_id' orchestrator.rs` emission format vs `handleOrchEvent.ts` extraction |
