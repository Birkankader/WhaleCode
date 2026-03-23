---
id: T01
parent: S02
milestone: M001
provides:
  - pub(crate) dispatch_task_internal with skip_tool_slot bypass for orchestrated workers
  - worktree_entries field on OrchestrationPlan for dag_id→WorktreeEntry tracking
  - WorktreeManager wired into orchestrator Phase 2 dispatch loop
  - Worktree cleanup on both success and failure completion paths
  - spawn_with_env_internal for non-Tauri callers
key_files:
  - src-tauri/src/commands/router.rs
  - src-tauri/src/commands/orchestrator.rs
  - src-tauri/src/router/orchestrator.rs
  - src-tauri/src/process/manager.rs
  - src-tauri/src/worktree/models.rs
key_decisions:
  - Used adapter pattern + spawn_with_env_internal in dispatch_task_internal rather than creating internal variants of each spawn_*_task function
  - Added Deserialize derive to WorktreeEntry to support serde(default) on OrchestrationPlan's new HashMap field
patterns_established:
  - Internal dispatch bypass pattern: pub(crate) function with skip_tool_slot param, Tauri command delegates with false
  - spawn_with_env_internal for &AppState callers (avoids tauri::State dependency)
observability_surfaces:
  - @@orch::worktree_created event per worker with { dag_id, worktree_path, branch_name }
  - @@orch::worktrees_cleaned event on completion with { count }
  - Worktree creation failures surface via @@orch::dispatch_error with git2 error string
  - OrchestrationPlan.worktree_entries map inspectable in state
duration: 25m
verification_result: passed
completed_at: 2026-03-20
blocker_discovered: false
---

# T01: Add internal dispatch function with tool-slot bypass and wire worktree creation into orchestrator

**Extracted dispatch_task_internal with skip_tool_slot bypass, wired WorktreeManager into orchestrator Phase 2 so each worker runs in its own git worktree, and added cleanup on both success/failure paths.**

## What Happened

1. **Created `dispatch_task_internal` in `router.rs`** — a `pub(crate)` async function that accepts `&AppState` and `&ContextStore` directly (not `tauri::State`), plus a `skip_tool_slot: bool` parameter. When `true`, the tool-slot reservation is bypassed, allowing multiple workers of the same type to run in parallel. The existing `dispatch_task` Tauri command delegates to it with `skip_tool_slot: false`, preserving the API contract.

2. **Added `spawn_with_env_internal` to `process/manager.rs`** — the spawn functions (`spawn_claude_task`, etc.) all require `tauri::State<'_, AppState>` which can't be constructed from `&AppState`. Rather than modifying all three spawn functions, I added a `pub(crate)` internal variant of `spawn_with_env` that accepts `&AppState` directly. The internal dispatch function uses the adapter pattern (same keychain + command building logic) and calls `spawn_with_env_internal`.

3. **Added `worktree_entries` to `OrchestrationPlan`** — `HashMap<String, WorktreeEntry>` with `#[serde(default)]` for backward compatibility. Required adding `Deserialize` derive to `WorktreeEntry` in `worktree/models.rs`. Initialized as empty in `create_plan()`.

4. **Wired `WorktreeManager` into orchestrator Phase 2** — instantiated before the wave loop, calls `create_for_task(dag_id)` for each task, stores entry in `plan.worktree_entries`, and passes the worktree path to `dispatch_task_internal` instead of raw `project_dir`. All 3 dispatch call sites (initial, retry, fallback) use `dispatch_task_internal` with `skip_tool_slot: true`.

5. **Added worktree cleanup on both paths** — on success (before `OrchestrationPhase::Completed`) and on failure (all-tasks-failed early return), iterates `plan.worktree_entries` and calls `remove_worktree()`. Cleanup errors are logged but non-fatal. Emits `@@orch::worktrees_cleaned` with count.

## Verification

- `cargo test --lib commands::orchestrator` — 48 tests passed, 0 failed
- `cargo test --lib worktree` — 22 tests passed, 0 failed
- `cargo test --lib process::manager` — 6 tests passed, 0 failed
- `cargo test --lib commands::router` — 0 tests (no existing router tests), 0 failed
- All 7 grep checks pass (dispatch_task_internal, create_for_task, worktree_entries, skip_tool_slot, 3+ dispatch_task_internal calls in orchestrator, remove_worktree, dispatch_error)

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `cargo check --lib` | 0 | ✅ pass | 7.5s |
| 2 | `cargo test --lib commands::orchestrator` | 0 | ✅ pass | 23.9s |
| 3 | `cargo test --lib commands::router` | 0 | ✅ pass | 20.9s |
| 4 | `cargo test --lib worktree` | 0 | ✅ pass | 17.5s |
| 5 | `cargo test --lib process::manager` | 0 | ✅ pass | 4.4s |
| 6 | `grep -q "dispatch_task_internal" src-tauri/src/commands/router.rs` | 0 | ✅ pass | <1s |
| 7 | `grep -q "create_for_task" src-tauri/src/commands/orchestrator.rs` | 0 | ✅ pass | <1s |
| 8 | `grep -q "worktree_entries" src-tauri/src/router/orchestrator.rs` | 0 | ✅ pass | <1s |
| 9 | `grep -q "skip_tool_slot" src-tauri/src/commands/router.rs` | 0 | ✅ pass | <1s |
| 10 | `grep -c "dispatch_task_internal" src-tauri/src/commands/orchestrator.rs` (=3) | 0 | ✅ pass | <1s |
| 11 | `grep -q "remove_worktree" src-tauri/src/commands/orchestrator.rs` | 0 | ✅ pass | <1s |
| 12 | `grep -q "dispatch_error" src-tauri/src/commands/orchestrator.rs` | 0 | ✅ pass | <1s |

## Diagnostics

- **Worktree creation events**: Look for `@@orch::worktree_created` in process output — contains `dag_id`, `worktree_path`, `branch_name`
- **Cleanup events**: `@@orch::worktrees_cleaned` with `count` of successfully cleaned worktrees
- **Failure state**: Worktree creation failures appear as `@@orch::dispatch_error` with the git2 error string; the failed `dag_id` is added to `failed_dag_ids`
- **State inspection**: `OrchestrationPlan.worktree_entries` is a `HashMap<String, WorktreeEntry>` serialized in the plan returned to frontend

## Deviations

- **spawn_with_env_internal added**: The plan assumed `dispatch_task_internal` could directly call the spawn functions (`spawn_claude_task`, etc.) with `state.clone()`. Those functions take `tauri::State<'_, AppState>` which can't be constructed from `&AppState`. Instead of modifying 3 spawn functions, I added a `pub(crate) spawn_with_env_internal` in `process/manager.rs` that mirrors `spawn_with_env` but accepts `&AppState`. The internal dispatch function replicates the adapter pattern (keychain + command building) and calls this directly.
- **Deserialize added to WorktreeEntry**: The plan didn't mention this, but it's required because `OrchestrationPlan` derives `Deserialize` and the new `HashMap<String, WorktreeEntry>` field with `#[serde(default)]` requires `WorktreeEntry` to also be deserializable.

## Known Issues

None.

## Files Created/Modified

- `src-tauri/src/commands/router.rs` — extracted `dispatch_task_internal` with `skip_tool_slot` param; `dispatch_task` delegates to it
- `src-tauri/src/commands/orchestrator.rs` — wired `WorktreeManager` into Phase 2 dispatch loop, replaced 3 dispatch calls, added cleanup on both paths, added observability events
- `src-tauri/src/router/orchestrator.rs` — added `worktree_entries: HashMap<String, WorktreeEntry>` to `OrchestrationPlan`, initialized in `create_plan()`
- `src-tauri/src/process/manager.rs` — added `pub(crate) spawn_with_env_internal` that takes `&AppState`
- `src-tauri/src/worktree/models.rs` — added `Deserialize` derive to `WorktreeEntry`
