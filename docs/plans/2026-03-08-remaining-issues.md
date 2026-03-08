# Remaining Issues from Orchestration Code Review

**Date**: 2026-03-08
**Context**: Orchestration redesign implemented (Tasks 1-10). Code review found 20 issues, 6 already fixed. This doc covers the 14 remaining issues for a future session.

**For Claude**: Read this doc, then fix each issue in order (CRITICAL first). Each issue has the file, current code, and exact fix needed.

---

## CRITICAL Issues

### Issue 1: Backend process entries and orchestration plans never cleaned up

**Files**: `src-tauri/src/state.rs`, `src-tauri/src/process/manager.rs`

**Problem**: `AppStateInner.processes` and `AppStateInner.orchestration_plans` HashMaps grow forever. Every spawned process inserts a `ProcessEntry` (with `output_lines: Vec<String>`) and every orchestration inserts an `OrchestrationPlan`. Nothing ever removes them.

**Fix**: In `src-tauri/src/process/manager.rs`, in the waiter task (the block that runs after `child.wait().await`), after setting the terminal status and dropping `stdin_tx`, also clear `output_lines` since they're no longer needed:

```rust
entry.output_lines.clear();
entry.output_lines.shrink_to_fit();
```

Then add a cleanup command. Create `src-tauri/src/commands/cleanup.rs`:

```rust
use crate::state::{AppState, ProcessStatus};

/// Remove completed/failed processes older than 5 minutes from state.
#[tauri::command]
#[specta::specta]
pub async fn cleanup_completed_processes(
    state: tauri::State<'_, AppState>,
) -> Result<u32, String> {
    let mut inner = state.lock().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().timestamp_millis();
    let five_min_ms = 5 * 60 * 1000;

    let stale_ids: Vec<String> = inner.processes.iter()
        .filter(|(_, entry)| {
            matches!(entry.status, ProcessStatus::Completed(_) | ProcessStatus::Failed(_))
                && (now - entry.started_at) > five_min_ms
        })
        .map(|(id, _)| id.clone())
        .collect();

    let count = stale_ids.len() as u32;
    for id in &stale_ids {
        inner.processes.remove(id);
    }

    // Also clean up completed orchestration plans
    let stale_plan_ids: Vec<String> = inner.orchestration_plans.iter()
        .filter(|(_, plan)| {
            matches!(plan.phase, crate::router::orchestrator::OrchestrationPhase::Completed | crate::router::orchestrator::OrchestrationPhase::Failed)
        })
        .map(|(id, _)| id.clone())
        .collect();
    for id in &stale_plan_ids {
        inner.orchestration_plans.remove(id);
    }

    Ok(count)
}
```

Register in `commands/mod.rs` (`pub mod cleanup; pub use cleanup::cleanup_completed_processes;`) and in `lib.rs` (add to imports and `collect_commands!`).

Call this from frontend periodically (e.g., every 5 minutes via `setInterval` in `routes/index.tsx`).

---

### Issue 2: Frontend outputLogs grows unbounded forever

**File**: `src/hooks/useProcess.ts`

**Problem**: Module-level `outputLogs` Map (line 19) stores every `OutputEvent` for every process forever. No eviction.

**Current code** (around line 39):
```typescript
export function emitProcessOutput(taskId: string, event: OutputEvent) {
  const log = outputLogs.get(taskId) ?? [];
  log.push(event);
  outputLogs.set(taskId, log);
  // ...
```

**Fix**: Cap at 5000 events per process:
```typescript
export function emitProcessOutput(taskId: string, event: OutputEvent) {
  const log = outputLogs.get(taskId) ?? [];
  log.push(event);
  if (log.length > 5000) {
    log.splice(0, log.length - 5000);
  }
  outputLogs.set(taskId, log);
  // ...
```

Also add cleanup when process is removed. Find `_removeProcess` in useProcess.ts and add:
```typescript
outputLogs.delete(taskId);
outputCallbacks.delete(taskId);
```

---

### Issue 3: Frontend processes and tasks Maps never cleaned up

**File**: `src/hooks/useProcess.ts`, `src/stores/taskStore.ts`

**Problem**: `_removeProcess` exists in useProcess.ts but is never called. `removeTask` exists in taskStore.ts but is never called. Processes and tasks accumulate forever.

**Fix**: In `src/components/terminal/ProcessPanel.tsx`, add a close button to process tabs for completed/failed processes. When clicked, call `_removeProcess(taskId)` from the process store and `removeTask(taskId)` from the task store.

Add to the process tab button JSX (inside the `processList.map` block), after the exit code span:
```tsx
{(proc.status === 'completed' || proc.status === 'failed') && (
  <span
    className="ml-1 text-zinc-600 hover:text-zinc-300 cursor-pointer"
    onClick={(e) => {
      e.stopPropagation();
      useProcessStore.getState()._removeProcess(proc.taskId);
    }}
  >
    x
  </span>
)}
```

---

## MEDIUM Issues

### Issue 6: Sub-tasks dispatched sequentially, not parallel

**File**: `src-tauri/src/commands/orchestrator.rs`

**Problem**: Phase 2 dispatches sub-tasks in a sequential `for` loop with `await`. Should be parallel.

**Current code** (around line 151-176):
```rust
for (sub_id, agent, sub_prompt) in &task_channels {
    let dispatch_result = super::router::dispatch_task(
        sub_prompt.clone(),
        ...
    ).await;
```

**Fix**: Use `tokio::task::JoinSet`:
```rust
let mut join_set = tokio::task::JoinSet::new();
for (sub_id, agent, sub_prompt) in task_channels {
    let project_dir = project_dir.clone();
    let on_event = on_event.clone();
    let state = state.clone();
    let context_store = context_store.clone();
    join_set.spawn(async move {
        let result = super::router::dispatch_task(
            sub_prompt,
            project_dir,
            agent.clone(),
            Some(sub_id.clone()),
            on_event,
            state,
            context_store,
        ).await;
        (sub_id, agent, result)
    });
}

while let Some(join_result) = join_set.join_next().await {
    match join_result {
        Ok((sub_id, agent, Ok(task_id))) => {
            worker_task_ids.push((task_id, agent));
        }
        Ok((sub_id, agent, Err(e))) => {
            emit_messenger(&app_handle, MessengerMessage::system(
                &plan.task_id,
                format!("Failed to dispatch to {}: {}", agent, e),
                MessageType::TaskFailed,
            ));
        }
        Err(e) => {
            // JoinError - task panicked
        }
    }
}
```

**NOTE**: `dispatch_task` enforces "max 1 running process per tool". If decomposition assigns multiple sub-tasks to the same agent, the second will fail. This is expected — the decomposition prompt tells the master not to assign multiple tasks to the same agent. But consider relaxing the 1-per-tool limit for orchestrated sub-tasks in the future.

**BLOCKER**: `tauri::State` is not `Send`, so it can't be moved into `tokio::spawn`. You'll need to extract the inner `Arc<Mutex<AppStateInner>>` and pass that instead. Alternatively, keep sequential dispatch but document the limitation.

---

### Issue 8: Polling loop for process completion is wasteful

**File**: `src-tauri/src/commands/orchestrator.rs`

**Problem**: `wait_for_process_completion` polls every 500ms. Adds latency and wastes CPU.

**Better approach**: Add a `tokio::sync::watch` or `Arc<tokio::sync::Notify>` to `ProcessEntry`. The waiter task signals it when the process exits. `wait_for_process_completion` awaits the signal instead of polling.

**This is a larger refactor** — the `ProcessEntry` struct needs a new field, and `manager.rs` waiter task needs to signal it. Defer if time-constrained.

---

### Issue 10: Tauri event listener unlisten function ignored

**File**: `src/stores/messengerStore.ts`

**Problem**: `listen()` returns `Promise<UnlistenFn>` but it's never captured. During HMR, stale listeners can accumulate.

**Fix**:
```typescript
let unlistenFn: (() => void) | null = null;

export async function initMessengerListener() {
  if (listenerInitialized) return;
  listenerInitialized = true;
  unlistenFn = await listen<Record<string, unknown>>('messenger-event', (event) => {
    // ... existing handler
  });
}

export function cleanupMessengerListener() {
  unlistenFn?.();
  unlistenFn = null;
  listenerInitialized = false;
}
```

---

### Issue 11: TOCTOU race on "one process per tool" check

**File**: `src-tauri/src/commands/router.rs`

**Problem**: `dispatch_task` checks if a tool is busy (locks state, checks, drops lock), then spawns (which re-locks state). Between the check and spawn, another call could pass the same check.

**Fix**: Use a reservation pattern. After the busy check passes, insert a placeholder `ProcessEntry` with status `Running` before dropping the lock. Then spawn the actual process. If spawn fails, remove the placeholder.

**This is a larger refactor** — defer if time-constrained. The current sequential dispatch in orchestrator partially mitigates this.

---

### Issue 14: Dependency wait hangs forever (no timeout)

**File**: `src/hooks/useTaskDispatch.ts`

**Problem**: When `dependsOn` is set, the code subscribes and waits forever for the dependency to complete. No timeout, no cancellation.

**Fix**: Add `Promise.race` with a 5-minute timeout:
```typescript
const completed = await Promise.race([
  new Promise<boolean>((resolve) => {
    const unsub = useProcessStore.subscribe((state) => {
      const dep = state.processes.get(dependsOn);
      if (!dep || dep.status === 'completed') { unsub(); resolve(true); }
      else if (dep.status === 'failed') { unsub(); resolve(false); }
    });
  }),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300_000)),
]);
```

---

## LOW Issues (Fix if convenient)

### Issue 15: tool_name hardcoded to "test" in process manager
**File**: `src-tauri/src/process/manager.rs` line ~101
**Fix**: Change `tool_name: "test".to_string()` to `tool_name: String::new()` or pass tool_name as a parameter.

### Issue 16: create_plan generates sub-tasks that are immediately discarded
**File**: `src-tauri/src/router/orchestrator.rs`
**Fix**: Simplify `create_plan` to not generate sub-tasks since `dispatch_orchestrated_task` clears them and rebuilds from decomposition.

### Issue 17: unsafe block lacks SAFETY comment
**File**: `src-tauri/src/process/manager.rs` lines 57-62
**Fix**: Add `// SAFETY: setpgid is async-signal-safe, safe to call in pre_exec context`

### Issue 18: Auto-answer stdin hack sent to all agents
**File**: `src-tauri/src/process/manager.rs` lines 71-72
**Fix**: Make auto-answer configurable per adapter or detect prompt first. Low priority.

### Issue 19: Redundant double state update in dispatchTask
**File**: `src/hooks/useTaskDispatch.ts` lines 165-174
**Fix**: Remove the `updateTaskStatus(tempId, 'running')` call on line 166 since lines 170-173 overwrite it anyway.

### Issue 20: Inconsistent exit event ordering
**File**: `src/hooks/useProcess.ts` vs `src/hooks/useTaskDispatch.ts`
**Fix**: Standardize: always update status first, then emit exit event. Match useTaskDispatch pattern.
