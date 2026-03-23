# S02: Worktree Isolation & Parallel Workers — Summary

## What This Slice Delivered

Workers now execute in isolated git worktrees with parallel dispatch within DAG waves. Three coordinated changes make this work:

1. **Tool slot refactor (T01):** `reserved_tools` → `reserved_dispatches`. Slot key changed from agent name to unique dispatch_id. The running-process check that blocked same-agent concurrency is removed entirely. Two Claude workers (or any same-agent-type pair) can dispatch simultaneously.

2. **Worktree wiring (T02):** `WorktreeManager::create_for_task()` called in the dispatch loop before each worker starts. A `worktree_entries` HashMap keyed by dag_id tracks worktrees for the lifecycle of the orchestration. Retry and fallback reuse the existing worktree (no new worktree per attempt). `dispatch_task` receives the worktree path as cwd, not project_dir. Worktree creation failure is a dispatch-blocking error — the task goes to failed_dag_ids rather than falling back to project_dir.

3. **Parallel wave dispatch (T03):** The sequential `for dag_id in wave_ids` loop replaced with `tokio::task::JoinSet`. `dispatch_and_await_worker()` async helper encapsulates per-worker lifecycle (dispatch → wait → retry → fallback → emit events). Returns `WorkerOutcome` struct. A new `dispatch_task_inner()` in router.rs accepts `AppState`/`ContextStore` directly (no `tauri::State<'_>`) for use from spawned Tokio tasks.

## Key Files Changed

| File | What Changed |
|------|-------------|
| `src-tauri/src/state.rs` | `reserved_tools` → `reserved_dispatches`; 4 tests updated |
| `src-tauri/src/process/manager.rs` | `acquire_tool_slot` → `acquire_dispatch_slot`; running-process check removed; `spawn_with_env_core` made public; 5 updated + 1 new test |
| `src-tauri/src/commands/router.rs` | `ReservationGuard` holds dispatch_id; `dispatch_task` generates dispatch_id from task_id; new `dispatch_task_inner()` for spawned tasks |
| `src-tauri/src/commands/orchestrator.rs` | WorktreeManager wired into dispatch loop; `worktree_entries` HashMap; `WorkerOutcome` struct; `dispatch_and_await_worker()` async fn; JoinSet wave loop; worktree_created event; enriched worker events |
| `src-tauri/src/commands/orchestrator_test.rs` | 8 new tests (worktree creation, event shapes, WorkerOutcome, JoinSet concurrency) |
| `src-tauri/src/router/retry.rs` | `#[derive(Clone)]` on `RetryConfig` |

## Patterns Established

- **dispatch_id is the universal slot key** — router generates from task_id/UUID, orchestrator uses plan.task_id variants (`{plan.task_id}-review` for review phase)
- **dispatch_task_inner for spawned tasks** — any code running inside a `JoinSet` or `tokio::spawn` that needs dispatch should use this instead of `dispatch_task` (tauri::State lifetime constraint)
- **worktree_entries HashMap tracks worktree lifecycle** — keyed by dag_id, retry/fallback looks up existing entry instead of creating new worktree
- **WorkerOutcome as the JoinSet return type** — carries dag_id, exit_code, agent, output_summary, failure_reason, retry_count, original_agent for post-wave merging
- **Worker events interleave within a wave** — consumers must correlate by dag_id, not arrival order

## Events & Observability

New/enriched events:
- `worktree_created` — emitted once per worker with `{ dag_id, task_id, branch, path }`
- `worker_started` — enriched with `worktree_path` and `worktree_branch`
- `task_completed` — enriched with `worktree_path` and `worktree_branch`
- `task_failed` — enriched with `worktree_path` and `worktree_branch`
- `dispatch_error` with context `"join_set"` — new signal for JoinSet panic/cancellation

Diagnostic surfaces:
- `AppStateInner.reserved_dispatches` — active dispatch reservations at runtime
- `WorkerOutcome` fields — per-worker post-mortem after JoinSet drain

## Verification Results

| Test Suite | Count | Status |
|-----------|-------|--------|
| `worktree::` | 22 | ✅ all pass |
| `orchestrator_test` | 29 | ✅ all pass (21 existing + 8 new) |
| `process::manager` | 7 | ✅ all pass (5 updated + 1 new + 1 existing) |
| `state::` | 10 | ✅ all pass (4 renamed + 6 existing) |

Ripgrep checks:
- `acquire_tool_slot.*tool_name` in router.rs → 0 matches ✅
- `worktree_created` in orchestrator.rs → ≥1 match ✅
- `WorktreeManager` in orchestrator.rs → ≥1 match ✅
- `JoinSet|join_all` in orchestrator.rs → ≥1 match ✅
- `project_dir.clone()` near dispatch_task in orchestrator.rs → 0 matches ✅

## Requirements Validated

- **R003** (worktree isolation): Each worker gets its own worktree via WorktreeManager. project_dir no longer used as worker cwd.
- **R004** (parallel same-agent workers): Per-dispatch-id slots + JoinSet wave dispatch enable concurrent same-agent execution.
- **R011** (rate limit retry/fallback): Preserved in dispatch_and_await_worker() with RetryConfig cloned into spawned tasks.

## What the Next Slices Need to Know

**S03 (Frontend State):** Worker events now interleave within a wave — the frontend must correlate by dag_id, not arrival order. Events carry new `worktree_path` and `worktree_branch` fields. The `worktree_created` event is new and should be handled.

**S04 (Review & Merge):** The `worktree_entries` HashMap in the orchestrator tracks worktrees by dag_id with branch names and paths. Auto-commit + diff generation should use these entries. Worktree cleanup should iterate this map. The `dispatch_task_inner` pattern is available if S04 needs to spawn additional async operations.

## Known Issues

None.
