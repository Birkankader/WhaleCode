---
id: T02
parent: S02
milestone: M002
provides:
  - worktree creation wired into orchestrator dispatch loop
  - each worker gets isolated worktree cwd via WorktreeManager::create_for_task()
  - retry/fallback reuses same worktree (HashMap lookup by dag_id)
  - worktree_created event emitted per worker with dag_id, branch, path
  - worker_started/task_completed/task_failed enriched with worktree_path and worktree_branch
key_files:
  - src-tauri/src/commands/orchestrator.rs
  - src-tauri/src/commands/orchestrator_test.rs
key_decisions:
  - Worktree creation failure is treated as a dispatch-blocking error — task is added to failed_dag_ids and skipped rather than falling back to project_dir
patterns_established:
  - worktree_entries HashMap keyed by dag_id tracks worktree lifecycle within the dispatch loop — retry/fallback looks up existing entry instead of creating new worktree
  - worker_cwd variable replaces project_dir in all 3 dispatch_task call sites (initial, retry, fallback)
observability_surfaces:
  - worktree_created event with dag_id, task_id, branch, path — emitted once per worker
  - worker_started enriched with worktree_path and worktree_branch
  - task_completed and task_failed enriched with worktree_path and worktree_branch
  - worktree creation failure surfaces as dispatch_error + task_failed events with git2 error text
duration: 15m
verification_result: passed
completed_at: 2026-03-23
blocker_discovered: false
---

# T02: Wire worktree creation into dispatch loop and emit worktree events

**Wired WorktreeManager::create_for_task() into the orchestrator dispatch loop so each worker runs in an isolated git worktree, with retry/fallback reusing the same worktree and all worker events enriched with worktree_path and worktree_branch metadata.**

## What Happened

Added `use crate::worktree::manager::WorktreeManager` and `use crate::worktree::models::WorktreeEntry` imports to the orchestrator. Before the wave loop, a `WorktreeManager` is constructed from `project_dir` and a `HashMap<String, WorktreeEntry>` tracks dag_id → worktree entry.

Inside the per-dag_id dispatch loop, before the first `dispatch_task()` call, the code checks if a worktree already exists for this dag_id (for retry reuse). If not, it calls `worktree_manager.create_for_task(dag_id)`. On success, the entry is stored and a `worktree_created` event is emitted. On failure, a `dispatch_error` + `task_failed` event is emitted and the task is skipped.

All three `dispatch_task()` call sites (initial, retry, fallback) now pass `worker_cwd.clone()` instead of `project_dir.clone()`, ensuring workers run in their isolated worktree directory.

Events `worker_started`, `task_completed`, and `task_failed` are enriched with `worktree_path` and `worktree_branch` fields for downstream consumption by S04 (review/merge).

Added 4 new tests to orchestrator_test.rs: WorktreeEntry field verification, worktree_created event JSON shape, worker event enrichment JSON shape, and WorktreeManager import smoke test.

## Verification

- `cargo test --lib orchestrator_test` — 25 tests pass (21 existing + 4 new)
- `cargo test --lib -- "worktree::"` — 22 existing tests pass
- `cargo test --lib -- "process::manager"` — 7 tests pass
- `cargo test --lib -- "state::"` — 10 tests pass
- `rg "WorktreeManager" src-tauri/src/commands/orchestrator.rs` — returns 2 matches (import + construction)
- `rg "worktree_created" src-tauri/src/commands/orchestrator.rs` — returns 1 match
- `rg 'project_dir\.clone\(\)' src-tauri/src/commands/orchestrator.rs | grep -c "dispatch_task"` — returns 0
- `cargo build --lib` — compiles cleanly (only pre-existing warnings)

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `cargo test --lib orchestrator_test` | 0 | ✅ pass | 4.0s |
| 2 | `cargo test --lib -- "worktree::"` | 0 | ✅ pass | 7.9s |
| 3 | `cargo test --lib -- "process::manager"` | 0 | ✅ pass | 3.2s |
| 4 | `cargo test --lib -- "state::"` | 0 | ✅ pass | 3.2s |
| 5 | `rg "WorktreeManager" src-tauri/src/commands/orchestrator.rs` | 0 | ✅ pass (≥1 match) | <1s |
| 6 | `rg "worktree_created" src-tauri/src/commands/orchestrator.rs` | 0 | ✅ pass (≥1 match) | <1s |
| 7 | `rg 'project_dir\.clone\(\)' orchestrator.rs \| grep dispatch_task` | 1 | ✅ pass (0 matches) | <1s |
| 8 | `cargo build --lib` | 0 | ✅ pass | 4.7s |

## Diagnostics

- `worktree_created` event in the orchestrator event stream — grep for `@@orch::` + `"type":"worktree_created"` to see per-worker worktree info
- `worktree_path` field on `worker_started`, `task_completed`, `task_failed` events — maps dag_id to its filesystem worktree
- Worktree creation failure: `dispatch_error` event includes the git2 error message; `task_failed` includes worktree context
- `worktree_entries` HashMap is local to the dispatch loop — not exposed in global state (worktree lifecycle is per-orchestration)

## Deviations

- The plan mentioned enriching events at specific line numbers (~line 1210 for worker_started, etc.) but the actual line numbers had shifted due to T01 edits. Adapted to actual locations — no semantic deviation.
- The initial dispatch failure path (dispatch_error when dispatch_task itself fails) was also enriched with worktree_path/worktree_branch, beyond what the plan specified — this provides better diagnostics.

## Known Issues

None.

## Files Created/Modified

- `src-tauri/src/commands/orchestrator.rs` — Added WorktreeManager/WorktreeEntry imports; created worktree tracking before wave loop; wired create_for_task before each dispatch; replaced project_dir.clone() with worker_cwd.clone() in all 3 dispatch_task calls; enriched worker_started/task_completed/task_failed with worktree metadata; added worktree_created event emission; graceful handling of worktree creation failure
- `src-tauri/src/commands/orchestrator_test.rs` — Added 4 new tests: worktree_entry_has_expected_fields, worktree_created_event_json_shape, worker_event_enrichment_json_shape, worktree_manager_import_smoke_test
