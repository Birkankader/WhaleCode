---
id: T03
parent: S02
milestone: M002
provides:
  - parallel worker dispatch within DAG waves via tokio::task::JoinSet
  - dispatch_and_await_worker() async helper for self-contained per-worker lifecycle
  - WorkerOutcome struct for structured result collection from spawned workers
  - dispatch_task_inner() in router.rs — tauri::State-free dispatch for spawned Tokio tasks
  - spawn_with_env_core made public for direct use by dispatch_task_inner
key_files:
  - src-tauri/src/commands/orchestrator.rs
  - src-tauri/src/commands/orchestrator_test.rs
  - src-tauri/src/commands/router.rs
  - src-tauri/src/process/manager.rs
  - src-tauri/src/router/retry.rs
key_decisions:
  - Created dispatch_task_inner in router.rs rather than modifying dispatch_task signature, preserving the #[tauri::command] boundary
  - Made spawn_with_env_core public instead of duplicating spawn logic in dispatch_task_inner
  - Worktree creation remains synchronous (before JoinSet spawn) since it's a fast local git operation — workers get their cwd assigned before spawning
  - Rate limit remaining-tasks collection simplified in parallel mode since all wave tasks are already dispatched simultaneously
patterns_established:
  - dispatch_task_inner accepts AppState and ContextStore directly (no tauri::State) — use for any code path that runs inside spawned Tokio tasks
  - WorkerOutcome is the return type for spawned worker tasks — JoinSet collects these for post-wave merging into failed_dag_ids and worker_task_ids
  - Dependency checking and worktree creation happen in the main loop before JoinSet spawn; dispatch+wait+retry+fallback happen inside the spawned async task
observability_surfaces:
  - JoinSet panic/cancellation → dispatch_error event with context "join_set" — new infrastructure failure signal
  - Worker events (worker_started, task_completed, task_failed) now interleave within a wave — consumers must not assume sequential ordering
  - rate_limit_action_needed event simplified — carries dag_id and plan_id but not remaining_tasks in parallel mode
duration: 25m
verification_result: passed
completed_at: 2026-03-23
blocker_discovered: false
---

# T03: Parallelize worker dispatch within DAG waves

**Restructured the orchestrator wave loop to spawn all workers concurrently via tokio::task::JoinSet, with dispatch_and_await_worker() extracting per-worker lifecycle into a self-contained async function and dispatch_task_inner() enabling tauri::State-free dispatch from spawned tasks.**

## What Happened

Extracted the ~350-line per-worker dispatch+wait+retry+fallback body from the sequential `for dag_id in wave_ids` loop into a standalone `async fn dispatch_and_await_worker()`. This function takes all parameters as owned values (cloned from the caller), performs the full worker lifecycle (dispatch → wait with timeout → retry → fallback → emit events), and returns a `WorkerOutcome` struct.

The wave loop now: (1) checks dependencies and creates worktrees synchronously, (2) spawns each worker into a `JoinSet`, (3) collects all `WorkerOutcome`s after the JoinSet drains, and (4) merges results into `failed_dag_ids`, `worker_task_ids`, and `plan.worker_results`.

To support spawning from Tokio tasks (where `tauri::State<'_>` lifetimes can't be satisfied), created `dispatch_task_inner()` in `router.rs` that takes `AppState` and `ContextStore` directly. This mirrors `dispatch_task` exactly but calls `spawn_with_env_core` (made public) instead of going through the per-agent spawn functions that require `tauri::State`.

Added `#[derive(Clone)]` to `RetryConfig` to support cloning into spawned tasks.

Added 4 new tests: WorkerOutcome struct field verification, failed-with-fallback scenario, JoinSet concurrent collection test (spawns 3 async tasks and verifies correct success/failure counts), and WorkerOutcome→WorkerResult merge mapping.

## Verification

- `cargo test --lib orchestrator_test` — 29 tests pass (25 existing + 4 new)
- `cargo test --lib -- "worktree::"` — 22 tests pass
- `cargo test --lib -- "process::manager"` — 7 tests pass
- `cargo test --lib -- "state::"` — 10 tests pass
- `cargo build --lib` — compiles cleanly (only pre-existing warnings)
- `rg "JoinSet" src-tauri/src/commands/orchestrator.rs` — 5 matches (struct comment, function comment, wave comment, spawn, JoinError handling)
- `rg "dispatch_and_await_worker|WorkerOutcome" src-tauri/src/commands/orchestrator.rs` — 8 matches
- `rg "acquire_tool_slot.*tool_name" src-tauri/src/commands/router.rs` — 0 matches (slot keyed by dispatch_id)
- `rg "WorktreeManager" src-tauri/src/commands/orchestrator.rs` — 2 matches
- `rg "worktree_created" src-tauri/src/commands/orchestrator.rs` — 1 match
- `rg 'project_dir\.clone\(\)' src-tauri/src/commands/orchestrator.rs | grep dispatch_task` — 0 matches

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `cargo test --lib orchestrator_test` | 0 | ✅ pass | 4.0s |
| 2 | `cargo test --lib -- "worktree::"` | 0 | ✅ pass | 3.1s |
| 3 | `cargo test --lib -- "process::manager"` | 0 | ✅ pass | 3.1s |
| 4 | `cargo test --lib -- "state::"` | 0 | ✅ pass | 3.1s |
| 5 | `cargo build --lib` | 0 | ✅ pass | 6.6s |
| 6 | `rg "JoinSet\|join_all" orchestrator.rs` | 0 | ✅ pass (≥1 match) | <1s |
| 7 | `rg "dispatch_and_await_worker\|WorkerOutcome" orchestrator.rs` | 0 | ✅ pass (≥2 matches) | <1s |
| 8 | `rg "acquire_tool_slot.*tool_name" router.rs` | 1 | ✅ pass (0 matches) | <1s |
| 9 | `rg "WorktreeManager" orchestrator.rs` | 0 | ✅ pass (≥1 match) | <1s |
| 10 | `rg "worktree_created" orchestrator.rs` | 0 | ✅ pass (≥1 match) | <1s |
| 11 | `rg 'project_dir\.clone\(\)' orchestrator.rs \| grep dispatch_task` | 1 | ✅ pass (0 matches) | <1s |

## Diagnostics

- `WorkerOutcome` struct carries dag_id, exit_code, agent, output_summary, failure_reason, retry_count, original_agent — inspect after JoinSet drain for per-worker post-mortem
- JoinSet panic detection: `dispatch_error` event with `context: "join_set"` and the panic message — grep `@@orch::` events for `join_set` to identify infrastructure failures
- Wave parallelism verification: compare timestamps on `worker_started` events within the same wave — near-simultaneous timestamps confirm parallel dispatch
- `dispatch_task_inner` in router.rs provides the same dispatch semantics as `dispatch_task` but without tauri::State — use for any spawned-task dispatch path

## Deviations

- The plan suggested the rate-limit remaining-tasks collection logic would need adaptation. In the parallel implementation, since all wave tasks are dispatched simultaneously, the "remaining tasks" concept doesn't apply — simplified the rate_limit_action_needed event to carry just dag_id and plan_id instead of a list of undispatched tasks.
- Made `spawn_with_env_core` public rather than creating a separate `spawn_with_env_direct` function — less code duplication and the function was already documented as the core implementation.
- Added `#[derive(Clone)]` to `RetryConfig` — needed for cloning into spawned async tasks. This was not anticipated in the plan.

## Known Issues

None.

## Files Created/Modified

- `src-tauri/src/commands/orchestrator.rs` — Added WorkerOutcome struct, dispatch_and_await_worker() async function, restructured wave loop to use JoinSet for parallel dispatch, moved per-worker result recording and event emission into the async helper
- `src-tauri/src/commands/orchestrator_test.rs` — Added 4 new tests: worker_outcome_struct_fields, worker_outcome_failed_with_fallback, joinset_collects_concurrent_worker_outcomes, worker_outcome_merges_into_worker_results
- `src-tauri/src/commands/router.rs` — Added dispatch_task_inner() accepting AppState and ContextStore directly for use from spawned Tokio tasks
- `src-tauri/src/process/manager.rs` — Made spawn_with_env_core public for direct use by dispatch_task_inner
- `src-tauri/src/router/retry.rs` — Added #[derive(Clone)] to RetryConfig
- `.gsd/milestones/M002/slices/S02/tasks/T03-PLAN.md` — Added Observability Impact section (pre-flight fix)
