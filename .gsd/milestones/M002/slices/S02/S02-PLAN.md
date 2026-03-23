# S02: Worktree Isolation & Parallel Workers

**Goal:** Workers execute in isolated git worktrees with their own cwd, and multiple workers of the same agent type run in parallel within a DAG wave without tool slot blocking.
**Demo:** Dispatch 2+ workers (including same-agent-type) and confirm each runs in a separate `.whalecode-worktrees/` directory with independent changes. Both complete without one blocking the other.

## Must-Haves

- Tool slot mechanism no longer blocks on agent name — two Claude workers can be dispatched concurrently
- Each dispatched worker gets its own worktree via `WorktreeManager::create_for_task()` before dispatch
- `dispatch_task()` receives the worktree path as `project_dir`, not the original project directory
- On retry/fallback, the same worktree is reused (no new worktree per attempt)
- `worktree_created` event emitted per worker with task_id, branch, and path
- `worker_started`, `task_completed`, `task_failed` events enriched with worktree path and branch
- Workers within the same DAG wave execute concurrently (not sequentially)
- All existing worktree tests (22) and orchestrator tests (21) continue to pass

## Proof Level

- This slice proves: integration (worktree infra wired into real dispatch path, parallel execution within waves)
- Real runtime required: no (unit tests + targeted module tests cover the wiring; real CLI agents verified in S06)
- Human/UAT required: no

## Verification

- `cd src-tauri && cargo test --lib -- "worktree::"` — 22+ tests pass (existing + any new)
- `cd src-tauri && cargo test --lib orchestrator_test` — 21+ tests pass (existing + new tests for worktree dispatch and parallel wave logic)
- `cd src-tauri && cargo test --lib -- "process::manager"` — all slot tests pass with updated per-task-id semantics
- `cd src-tauri && cargo test --lib -- "state::"` — state tests pass with renamed field
- `rg "acquire_tool_slot.*tool_name" src-tauri/src/commands/router.rs` — returns 0 matches (slot keyed by dispatch_id, not tool_name)
- `rg "worktree_created" src-tauri/src/commands/orchestrator.rs` — returns ≥1 match
- `rg "WorktreeManager" src-tauri/src/commands/orchestrator.rs` — returns ≥1 match
- `rg "JoinSet\|join_all" src-tauri/src/commands/orchestrator.rs` — returns ≥1 match (parallel dispatch)
- `rg "project_dir\.clone\(\)" src-tauri/src/commands/orchestrator.rs | grep "dispatch_task"` — returns 0 matches in worker dispatch (worktree path used instead)

## Observability / Diagnostics

- Runtime signals: `worktree_created` event per worker (task_id, branch, path); enriched `worker_started`/`task_completed`/`task_failed` with `worktree_path` and `worktree_branch` fields
- Inspection surfaces: `list_worktrees` Tauri command shows active worktrees; `cleanup_worktrees` Tauri command handles stale ones
- Failure visibility: worktree creation errors surface as `dispatch_error` events with the git2 error message; `task_failed` includes worktree path for post-mortem
- Redaction constraints: none (worktree paths are non-sensitive local filesystem paths)

## Integration Closure

- Upstream surfaces consumed: `SubTaskDef` with `id: Option<String>` from S01; `Vec<SubTaskDef>` from reliable decomposition; `dag_id` on events
- New wiring introduced in this slice: `WorktreeManager::create_for_task()` called from orchestrator dispatch loop; worktree path flows through `dispatch_task()` → `build_command()` → `spawn_with_env_core()` as cwd; `JoinSet` for parallel wave execution
- What remains before the milestone is truly usable end-to-end: S03 (frontend state for approval + per-worker streaming), S04 (review/merge using worktree diffs + cleanup), S05 (UI cleanup), S06 (end-to-end verification)

## Tasks

- [x] **T01: Refactor tool slots from per-agent-name to per-task-id tracking** `est:45m`
  - Why: `acquire_tool_slot(state, "claude")` blocks any second Claude dispatch. This is the parallelism blocker for R004. Changing the key from tool_name to a unique dispatch_id allows concurrent same-agent workers.
  - Files: `src-tauri/src/process/manager.rs`, `src-tauri/src/commands/router.rs`, `src-tauri/src/commands/orchestrator.rs`, `src-tauri/src/state.rs`
  - Do: Rename `reserved_tools` → `reserved_dispatches` in AppStateInner. Change `acquire_tool_slot` / `release_tool_slot` to accept a `dispatch_id: &str` instead of `tool_name`. In `dispatch_task()`, generate or use the passed task_id as the dispatch_id. In orchestrator decompose/review, use plan_task_id. Update all 6 existing tests in process/manager.rs. Add test verifying two "claude" dispatches succeed with different dispatch_ids.
  - Verify: `cd src-tauri && cargo test --lib -- "process::manager"` passes; `rg "acquire_tool_slot.*tool_name" src-tauri/src/commands/router.rs` returns 0 matches
  - Done when: Tool slot functions accept dispatch_id, existing tests updated and passing, two same-agent-type dispatches no longer conflict

- [x] **T02: Wire worktree creation into dispatch loop and emit worktree events** `est:1h`
  - Why: Workers currently receive `project_dir` as cwd, writing to the main repo. This wires the existing `WorktreeManager` into the orchestrator so each worker gets an isolated worktree. Covers R003.
  - Files: `src-tauri/src/commands/orchestrator.rs`, `src-tauri/src/commands/orchestrator_test.rs`
  - Do: In the dispatch loop, before each `dispatch_task()` call, create a worktree via `WorktreeManager::create_for_task(dag_id)`. Store entries in a local `HashMap<String, WorktreeEntry>`. Pass `worktree_entry.path.to_string_lossy().to_string()` instead of `project_dir.clone()` to `dispatch_task()`. On retry/fallback, look up the existing worktree for that dag_id (don't create a new one). Emit `worktree_created` event. Enrich `worker_started`, `task_completed`, `task_failed` events with `worktree_path` and `worktree_branch`. Add unit tests for the wiring.
  - Verify: `cd src-tauri && cargo test --lib orchestrator_test` passes; `rg "WorktreeManager" src-tauri/src/commands/orchestrator.rs` returns ≥1; `rg "worktree_created" src-tauri/src/commands/orchestrator.rs` returns ≥1
  - Done when: Each worker dispatch creates a worktree and uses it as cwd; retry/fallback reuses the same worktree; events carry worktree metadata

- [x] **T03: Parallelize worker dispatch within DAG waves** `est:1h30m`
  - Why: The dispatch loop is sequential — it dispatches one worker, awaits completion, then starts the next. For R004 (simultaneous execution), workers within a wave must run concurrently. This is the final piece enabling true parallel execution.
  - Files: `src-tauri/src/commands/orchestrator.rs`, `src-tauri/src/commands/orchestrator_test.rs`
  - Do: Extract the per-worker dispatch+wait+retry body (the inner `for dag_id in wave_ids` block) into a standalone `async fn dispatch_and_await_worker(...)` helper. Use `tokio::task::JoinSet` to spawn all workers in a wave concurrently. After the JoinSet drains, merge results — populate `failed_dag_ids` and `worker_task_ids` from each worker's return value. Pass shared context (state, on_event, app_handle, context_store) as cloned Arcs. The helper returns a struct with dag_id, success/failure, task_id, output_summary. Add a test verifying the dispatch loop structure supports concurrent execution.
  - Verify: `cd src-tauri && cargo test --lib orchestrator_test` passes; `rg "JoinSet" src-tauri/src/commands/orchestrator.rs` returns ≥1; no sequential `dispatch_task → wait` pattern remains in the wave loop
  - Done when: Workers within a DAG wave are spawned concurrently via JoinSet, results collected after all complete, retry/fallback logic preserved per worker

## Files Likely Touched

- `src-tauri/src/process/manager.rs` — tool slot refactor
- `src-tauri/src/commands/router.rs` — dispatch_task slot acquisition
- `src-tauri/src/commands/orchestrator.rs` — worktree creation, parallel dispatch, event enrichment
- `src-tauri/src/commands/orchestrator_test.rs` — new tests
- `src-tauri/src/state.rs` — reserved_tools → reserved_dispatches rename
