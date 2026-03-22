# Decisions Register

<!-- Append-only. Never edit or remove existing rows.
     To reverse a decision, add a new row that supersedes it.
     Read this file at the start of any planning or research phase. -->

| # | When | Scope | Decision | Choice | Rationale | Revisable? |
|---|------|-------|----------|--------|-----------|------------|
| D001 | M001/S02 | arch | Tool slot concurrency model | Per-task-id tracking instead of per-agent-name max-1 slot | Current acquire_tool_slot enforces max 1 per agent name globally, contradicting parallel execution. Multiple Claude workers need to run simultaneously. Track by task_id with optional per-agent-type concurrency limit | Yes — if rate limits make unbounded parallelism impractical |
| D002 | M001/S02 | arch | Worker execution directory | Each worker runs in its own git worktree via WorktreeManager.create_for_task() | WorktreeManager exists with full API and tests. Wire into orchestrator dispatch so each worker's cwd is the worktree path. Core safety promise for parallel execution | No |
| D003 | M001/S03 | pattern | Task completion event matching | Use dag_id from backend event payload + dagToFrontendId map, not FIFO queue | Backend already sends dag_id in task_completed/task_failed events. Frontend ignores it and uses subTaskQueue.shift(). dagToFrontendId map is maintained — just needs to be used | No |
| D004 | M001/S03 | pattern | activePlan availability timing | Set activePlan from @@orch:: events during Phase 1, not after promise resolves | Promise resolves after ALL phases. activePlan needed during awaiting_approval. Plan info available from @@orch:: events at Phase 1 start | No |
| D005 | M002 | arch | M001 code recovery vs fresh start | Fresh start on gsd-main — M002 re-implements all M001 scope from actual codebase state | M001 worktree was cleaned up without squash-merging code changes. Planning artifacts say "complete" but codebase is pre-M001 state. Recovering stale worktree changes is risky and potentially conflicting. Cleaner to fix from what actually exists. | No |
