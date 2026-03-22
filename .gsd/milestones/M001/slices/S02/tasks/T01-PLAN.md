---
estimated_steps: 6
estimated_files: 3
skills_used: []
---

# T01: Add internal dispatch function with tool-slot bypass and wire worktree creation into orchestrator

**Slice:** S02 — Worktree Isolation & Parallel Workers
**Milestone:** M001

## Description

This task delivers the two core backend changes for S02: (1) an internal dispatch function that can bypass the tool-slot enforcement for orchestrated workers (R004), and (2) wiring `WorktreeManager` into the orchestrator's Phase 2 dispatch loop so each worker runs in its own git worktree (R003). Both changes converge at the same code path — the orchestrator's wave dispatch loop — so they are implemented together.

The `dispatch_task` function in `router.rs` is a `#[tauri::command]` exported to the frontend. Adding a `skip_tool_slot` parameter would change the Specta-generated TypeScript bindings and break the frontend API. Instead, we extract the function body into a `pub(crate)` internal function and have the Tauri command delegate to it. The orchestrator then calls the internal function directly with `skip_tool_slot: true`.

For worktree isolation, we instantiate `WorktreeManager` before the wave loop in the orchestrator's Phase 2. For each DAG task, we call `create_for_task(dag_id)` to get a `WorktreeEntry`, pass `worktree_entry.path` as the worker's `cwd` (instead of raw `project_dir`), and store the entries in a new `worktree_entries` field on `OrchestrationPlan`. On orchestration completion (both success and failure), we clean up all worktrees.

## Steps

1. **Extract internal dispatch function in `router.rs`.**
   - Create `pub(crate) async fn dispatch_task_internal(prompt, project_dir, tool_name, task_id, on_event, state: &AppState, context_store: &ContextStore, skip_tool_slot: bool) -> Result<String, String>`.
   - Move the full body of `dispatch_task` into this function.
   - The key difference: when `skip_tool_slot` is true, skip the `acquire_tool_slot` call and don't create a `ReservationGuard`. When false, behavior is identical to the original.
   - Have the Tauri command `dispatch_task` delegate to `dispatch_task_internal(..., false)`. Note: `tauri::State<'_, T>` implements `Deref` to `T`, so pass `&*state` and `&*context_store` to the internal function.
   - Important: the internal function takes `state: &AppState` (not `tauri::State`) and `context_store: &ContextStore` (not `tauri::State`) so it can be called from the orchestrator without Tauri's state injection.

2. **Add `worktree_entries` field to `OrchestrationPlan` in `router/orchestrator.rs`.**
   - Add `use std::collections::HashMap;` and `use crate::worktree::models::WorktreeEntry;` imports.
   - Add `#[serde(default)] pub worktree_entries: HashMap<String, WorktreeEntry>` to `OrchestrationPlan`.
   - Since `WorktreeEntry` already derives `Serialize` and `Type`, and `HashMap` has blanket impls, this compiles without changes to Specta.
   - Initialize as `HashMap::new()` in `Orchestrator::create_plan()`.

3. **Wire `WorktreeManager` into orchestrator Phase 2 in `commands/orchestrator.rs`.**
   - Add `use crate::worktree::manager::WorktreeManager;` import.
   - Before the wave loop (after DAG construction, around line ~1095), create the manager: `let worktree_manager = WorktreeManager::new(super::expand_tilde(&project_dir));`
   - Inside the wave loop, for each `dag_id` being dispatched, call `worktree_manager.create_for_task(dag_id)`. On success, store in `plan.worktree_entries.insert(dag_id.clone(), entry.clone())`. Emit `@@orch::worktree_created` event. On failure, emit `@@orch::dispatch_error` and add to `failed_dag_ids`.
   - Pass `entry.path.to_str().unwrap_or(&project_dir)` as the `project_dir` argument.

4. **Replace `super::router::dispatch_task` calls in Phase 2 with `dispatch_task_internal`.**
   - There are 3 call sites in Phase 2: initial dispatch (~line 1127), retry dispatch (~line 1247), and fallback dispatch (~line 1283).
   - Replace each with `super::router::dispatch_task_internal(prompt, cwd, agent, task_id, on_event, state_ref, &*context_store, true)`.
   - For retry/fallback dispatches, use the same worktree path (the worktree is already created for this dag_id — look it up from `plan.worktree_entries.get(dag_id)`).

5. **Add worktree cleanup on orchestration completion.**
   - After the Phase 3 review section, before `plan.phase = OrchestrationPhase::Completed`, iterate `plan.worktree_entries` and call `worktree_manager.remove_worktree(&entry.worktree_name)` for each. Log but don't fail on cleanup errors.
   - On early-return error paths, do the same cleanup. The `worktree_manager` variable needs to be available at these points — if it's created inside the Phase 2 block, move it to a broader scope or call `cleanup_stale_worktrees()` as a fallback.
   - Emit `@@orch::worktrees_cleaned` event with count.

6. **Verify compilation and existing tests.**
   - Run `cargo test --lib commands::orchestrator` — all 31+ existing tests must pass.
   - Run `cargo test --lib commands::router` — existing tests must pass.
   - The `ReservationGuard` struct in `router.rs` should remain (used by the non-orchestrated path).

## Must-Haves

- [ ] `dispatch_task_internal` exists as `pub(crate)` in `commands/router.rs` with `skip_tool_slot` parameter
- [ ] `dispatch_task` Tauri command delegates to `dispatch_task_internal` with `skip_tool_slot: false` — no API change
- [ ] `OrchestrationPlan` has `worktree_entries: HashMap<String, WorktreeEntry>` field
- [ ] Orchestrator Phase 2 calls `WorktreeManager::create_for_task(dag_id)` for each worker
- [ ] Orchestrator Phase 2 passes worktree path (not raw `project_dir`) to dispatch
- [ ] All 3 dispatch calls in Phase 2 use `dispatch_task_internal` with `skip_tool_slot: true`
- [ ] Worktree cleanup runs on both success and failure completion paths
- [ ] All existing orchestrator tests pass (31+)

## Verification

- `cargo test --lib commands::orchestrator` — all existing tests pass (0 failures)
- `cargo test --lib commands::router` — existing tests pass
- `grep -q "dispatch_task_internal" src-tauri/src/commands/router.rs` — internal function exists
- `grep -q "create_for_task" src-tauri/src/commands/orchestrator.rs` — worktree creation wired in
- `grep -q "worktree_entries" src-tauri/src/router/orchestrator.rs` — tracking field exists
- `grep -q "skip_tool_slot" src-tauri/src/commands/router.rs` — bypass parameter exists
- `grep -c "dispatch_task_internal" src-tauri/src/commands/orchestrator.rs` returns >= 3 (all dispatch calls replaced)
- `grep -q "remove_worktree\|cleanup_stale" src-tauri/src/commands/orchestrator.rs` — cleanup wired

## Observability Impact

- Signals added: `@@orch::worktree_created` event per worker with `{ dag_id, worktree_path, branch_name }`, `@@orch::worktrees_cleaned` event on completion with `{ count }`
- How a future agent inspects this: `OrchestrationPlan.worktree_entries` map in state, serialized in plan returned to frontend
- Failure state exposed: worktree creation failures surface via `@@orch::dispatch_error` with git2 error string; cleanup failures logged but non-fatal

## Inputs

- `src-tauri/src/commands/router.rs` — current `dispatch_task` Tauri command with `acquire_tool_slot` enforcement
- `src-tauri/src/commands/orchestrator.rs` — Phase 2 dispatch loop calling `super::router::dispatch_task()` with `project_dir`
- `src-tauri/src/router/orchestrator.rs` — `OrchestrationPlan` struct without worktree tracking
- `src-tauri/src/worktree/manager.rs` — `WorktreeManager` API (consumed as-is, no changes needed)
- `src-tauri/src/worktree/models.rs` — `WorktreeEntry` struct (consumed as-is, already serializable)
- `src-tauri/src/commands/mod.rs` — `expand_tilde` utility function

## Expected Output

- `src-tauri/src/commands/router.rs` — contains `pub(crate) async fn dispatch_task_internal` with `skip_tool_slot` param; `dispatch_task` delegates to it
- `src-tauri/src/commands/orchestrator.rs` — Phase 2 creates worktrees via `WorktreeManager`, passes worktree paths to `dispatch_task_internal`, stores entries in plan, cleans up on completion
- `src-tauri/src/router/orchestrator.rs` — `OrchestrationPlan` has `worktree_entries: HashMap<String, WorktreeEntry>` field
