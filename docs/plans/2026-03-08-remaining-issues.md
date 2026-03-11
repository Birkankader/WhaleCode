# Remaining Issues from Orchestration Code Review

**Date**: 2026-03-08
**Context**: Orchestration redesign implemented (Tasks 1-10). Code review found 20 issues, 6 already fixed. This doc covered the 14 remaining issues.

**Status**: All feasible issues fixed. Only 2 deferred (architectural refactors).

---

## CRITICAL Issues — ALL FIXED

### Issue 1: Backend process entries and orchestration plans never cleaned up ✅
- `output_lines.clear()` + `shrink_to_fit()` in waiter task
- `cleanup_completed_processes` command registered
- Frontend calls cleanup every 5 minutes

### Issue 2: Frontend outputLogs grows unbounded forever ✅
- Capped at 5000 events per process
- Cleanup on process removal

### Issue 3: Frontend processes and tasks Maps never cleaned up ✅
- Close button on completed/failed process tabs
- Calls both `_removeProcess` and `removeTask`

---

## MEDIUM Issues — 3 FIXED, 2 DEFERRED

### Issue 6: Sub-tasks dispatched sequentially, not parallel — DEFERRED
Sequential dispatch with documented limitation. `tauri::State` is not `Send`, so `tokio::spawn` parallelization requires deeper refactoring. Each agent gets at most one sub-task, so sequential dispatch has minimal impact.

### Issue 8: Polling loop for process completion is wasteful ✅
- Added `tokio::sync::watch` channel to `ProcessEntry`
- Waiter task signals completion via watch sender
- `wait_for_process_completion` awaits the watch instead of 500ms polling

### Issue 10: Tauri event listener unlisten function ignored ✅
- `unlistenFn` captured and cleaned up
- `cleanupMessengerListener()` exported and called on unmount

### Issue 11: TOCTOU race on "one process per tool" check — DEFERRED
Sequential dispatch in orchestrator partially mitigates. Full fix requires reservation pattern — larger refactor.

### Issue 14: Dependency wait hangs forever (no timeout) ✅
- `Promise.race` with 5-minute timeout

---

## LOW Issues — ALL FIXED

### Issue 15: tool_name hardcoded to "test" in process manager ✅
Changed to `String::new()`.

### Issue 16: create_plan generates sub-tasks that are immediately discarded ✅
`create_plan` now returns empty `sub_tasks` vec (shell only).

### Issue 17: unsafe block lacks SAFETY comment ✅
Added `// SAFETY: setpgid is async-signal-safe, safe to call in pre_exec context`.

### Issue 18: Auto-answer stdin hack sent to all agents ✅
`spawn_with_env` now takes `initial_stdin: Option<&[u8]>`. Only Claude gets `Some(b"1\ny\n")`, Gemini/Codex get `None`.

### Issue 19: Redundant double state update in dispatchTask ✅
Removed redundant `updateTaskStatus(tempId, 'running')` call.

### Issue 20: Inconsistent exit event ordering ✅
Both `useProcess.ts` and `useTaskDispatch.ts` now update status first, then emit exit event.
