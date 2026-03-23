---
estimated_steps: 5
estimated_files: 3
skills_used:
  - review
---

# T02: Wire worktree creation into dispatch loop and emit worktree events

**Slice:** S02 — Worktree Isolation & Parallel Workers
**Milestone:** M002

## Description

The worktree subsystem (`WorktreeManager`, `WorktreeEntry`, 22 passing tests) is fully built but never called from the orchestrator. Workers currently receive `project_dir` as their cwd, so every worker writes to the main repo. This task wires `WorktreeManager::create_for_task()` into the orchestrator dispatch loop so each worker gets an isolated worktree, and enriches events with worktree metadata.

The worktree creation happens per dag_id, before the `dispatch_task()` call. A local `HashMap<String, WorktreeEntry>` tracks dag_id → worktree so retry/fallback reuses the same worktree instead of creating a new one. The worktree path replaces `project_dir` in the `dispatch_task()` call. Events (`worker_started`, `task_completed`, `task_failed`) are enriched with `worktree_path` and `worktree_branch` fields for downstream consumption by S04 (review/merge).

## Steps

1. **Add worktree tracking in dispatch loop**: In `src-tauri/src/commands/orchestrator.rs`, in the `dispatch_orchestrated_task` function, before the wave dispatch loop (~line 1160):
   - Create a `WorktreeManager` from `project_dir`: `let worktree_manager = WorktreeManager::new(std::path::PathBuf::from(&project_dir));`
   - Create a `HashMap<String, WorktreeEntry>` to track dag_id → worktree_entry
   - Add `use crate::worktree::manager::WorktreeManager;` and `use crate::worktree::models::WorktreeEntry;` at the top

2. **Create worktree before each dispatch**: Inside the `for dag_id in wave_ids` loop, before the first `dispatch_task()` call:
   - Check if `worktree_entries` already has an entry for this dag_id (for when retry reuses the loop — shouldn't happen in sequential, but needed for parallel in T03)
   - If not, call `worktree_manager.create_for_task(dag_id)` — use the dag_id (e.g. "t1") as the task_id
   - On success: store entry in `worktree_entries`, emit `worktree_created` event with `{ dag_id, task_id: entry.task_id, branch: entry.branch_name, path: entry.path.display() }`
   - On failure: emit `dispatch_error` with the git2 error, add to `failed_dag_ids`, `continue`
   - Extract the worktree path as a `String`: `let worker_cwd = entry.path.to_string_lossy().to_string();`

3. **Pass worktree path as project_dir**: Replace all 3 `dispatch_task()` call sites within the wave loop (initial dispatch ~line 1200, retry ~line 1314, fallback ~line 1344):
   - Change `project_dir.clone()` to `worker_cwd.clone()` (where `worker_cwd` comes from the worktree entry)
   - The retry and fallback blocks need to look up the worktree_entry for the current dag_id since they're inside the per-dag_id scope

4. **Enrich events with worktree metadata**: For the events emitted in the wave loop:
   - `worker_started` (~line 1210): add `"worktree_path": worker_cwd, "worktree_branch": worktree_entry.branch_name`
   - `task_completed` (end of successful worker wait): add same fields
   - `task_failed` (all failure paths): add same fields
   - This allows S04 to map dag_id → worktree info for review/merge

5. **Add orchestrator tests**: In `src-tauri/src/commands/orchestrator_test.rs`, add tests for:
   - Verify `WorktreeEntry` struct has expected fields (smoke test that the import works)
   - Verify `worktree_created` event JSON shape has required fields
   - Note: Full integration testing of the dispatch loop requires mocking CLI agents, which is out of scope. The real wiring is verified in S06.

## Must-Haves

- [ ] `WorktreeManager::create_for_task()` called before each worker dispatch in the orchestrator loop
- [ ] Worktree path used as `project_dir` for `dispatch_task()` instead of original project dir
- [ ] Retry/fallback reuses the same worktree (lookup from `worktree_entries` HashMap)
- [ ] `worktree_created` event emitted per worker with dag_id, branch, and path
- [ ] `worker_started`, `task_completed`, `task_failed` enriched with `worktree_path` and `worktree_branch`
- [ ] Worktree creation failure handled gracefully (dispatch_error + skip task)
- [ ] Code compiles (`cargo build --lib`)

## Verification

- `cd src-tauri && cargo test --lib orchestrator_test` — all tests pass (existing + new)
- `cd src-tauri && cargo test --lib -- "worktree::"` — 22 existing tests still pass
- `rg "WorktreeManager" src-tauri/src/commands/orchestrator.rs` — returns ≥1 match
- `rg "worktree_created" src-tauri/src/commands/orchestrator.rs` — returns ≥1 match
- `rg 'project_dir\.clone\(\)' src-tauri/src/commands/orchestrator.rs | grep -c "dispatch_task"` — returns 0 (all worker dispatches use worktree path)

## Observability Impact

- Signals added/changed: `worktree_created` event (new); `worker_started`/`task_completed`/`task_failed` enriched with `worktree_path`, `worktree_branch`
- How a future agent inspects this: grep for `worktree_created` in event stream; check `worktree_path` field on any worker event
- Failure state exposed: worktree creation failure surfaces as `dispatch_error` event with git2 error text, dag_id added to failed_dag_ids

## Inputs

- `src-tauri/src/commands/orchestrator.rs` — dispatch loop with 3 `dispatch_task()` call sites passing `project_dir.clone()`
- `src-tauri/src/commands/orchestrator_test.rs` — existing test file (21 tests)
- `src-tauri/src/worktree/manager.rs` — `WorktreeManager` with `create_for_task()` method
- `src-tauri/src/worktree/models.rs` — `WorktreeEntry` struct

## Expected Output

- `src-tauri/src/commands/orchestrator.rs` — worktree creation wired into dispatch loop, events enriched
- `src-tauri/src/commands/orchestrator_test.rs` — new tests for worktree event structure
