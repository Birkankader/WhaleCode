---
estimated_steps: 5
estimated_files: 3
skills_used:
  - review
---

# T03: Parallelize worker dispatch within DAG waves

**Slice:** S02 — Worktree Isolation & Parallel Workers
**Milestone:** M002

## Description

After T01 (tool slots no longer block same-agent-type) and T02 (each worker gets its own worktree cwd), the dispatch loop still processes workers sequentially — dispatch one, wait for completion, then dispatch next. This task restructures the inner wave loop to spawn all workers in a wave concurrently using `tokio::task::JoinSet`, then collect results after all complete. This delivers on R004's requirement that multiple workers of the same agent type run simultaneously.

The key challenge is extracting the current per-worker body (~150 lines including dispatch, wait, retry, fallback) into a self-contained async function that can be spawned as a Tokio task. The function receives cloned/Arc'd state and returns a structured result. After the JoinSet drains, the main loop merges results into `failed_dag_ids` and `worker_task_ids`.

**Important context for the executor:**
- The inner wave dispatch loop is in `dispatch_orchestrated_task()` in `src-tauri/src/commands/orchestrator.rs`, starting around line 1170 after T02's changes
- The loop body spans from `for dag_id in wave_ids {` through the final task completion handling (including retry/fallback logic) — roughly 200+ lines
- `state: tauri::State<'_, AppState>` is an `Arc<Mutex<AppStateInner>>` — cloneable
- `on_event: Channel<OutputEvent>` is cloneable (`.clone()`)
- `context_store: tauri::State<'_, ContextStore>` wraps an Arc — `.inner().clone()` gives the inner value
- `app_handle: AppHandle` is cloneable
- The existing `wave_task_ids` local variable already suggests the original author intended parallel dispatch

## Steps

1. **Define the worker result struct**: At the top of `orchestrator.rs` (or in a nearby section), define:
   ```rust
   struct WorkerOutcome {
       dag_id: String,
       success: bool,
       process_task_id: Option<String>,
       agent: String,
       output_summary: String,
       failure_reason: Option<String>,
   }
   ```

2. **Extract the per-worker body into an async function**: Create `async fn dispatch_and_await_worker(...)` that contains the current body of the `for dag_id in wave_ids` inner loop. Parameters:
   - `dag_id: String`
   - `sub_id: String, agent: String, sub_prompt: String` (from `task_channels`)
   - `dag_node_depends_on: Vec<String>` (just the dependency list)
   - `worker_cwd: String` (worktree path from T02)
   - `worktree_entry: WorktreeEntry` (for event metadata from T02)
   - `state: AppState` (the `Arc<Mutex<_>>` — cloned from `state_ref`)
   - `on_event: Channel<OutputEvent>` (cloned)
   - `app_handle: AppHandle` (cloned)
   - `context_store: Arc<ContextStore>` (or whatever the inner type is — check the actual type)
   - `retry_config: RetryConfig`
   - `available_agents: Vec<String>`
   - `worker_timeout: Duration`
   - `plan_task_id: String` (for messenger events)
   - Returns: `WorkerOutcome`
   - **Note**: The function cannot take `tauri::State<'_>` as a parameter — it must take the inner `AppState` (which is `Arc<Mutex<AppStateInner>>`). For `context_store`, clone the inner Arc. The `dispatch_task` call in `router.rs` takes `tauri::State<'_, AppState>` — you'll need to use the same approach the code currently uses for `state_ref` (which dereferences `tauri::State` to the inner Arc). If `dispatch_task` requires `tauri::State`, you may need to wrap the Arc back or refactor `dispatch_task` to accept `&AppState`. Check the actual types carefully.

3. **Restructure the wave loop to use JoinSet**: Replace the sequential `for dag_id in wave_ids` with:
   ```rust
   let mut join_set = tokio::task::JoinSet::new();
   for dag_id in wave_ids {
       // ... dependency check (skip if failed dep) ...
       // ... worktree lookup (from T02's HashMap) ...
       let worker_fut = dispatch_and_await_worker(/* cloned params */);
       join_set.spawn(worker_fut);
   }
   // Collect results
   let mut wave_outcomes: Vec<WorkerOutcome> = Vec::new();
   while let Some(result) = join_set.join_next().await {
       match result {
           Ok(outcome) => wave_outcomes.push(outcome),
           Err(e) => { /* JoinError — log and treat as failure */ }
       }
   }
   // Merge outcomes into failed_dag_ids and worker_task_ids
   for outcome in wave_outcomes {
       if outcome.success {
           if let Some(tid) = outcome.process_task_id {
               worker_task_ids.push((tid, outcome.agent));
           }
       } else {
           failed_dag_ids.insert(outcome.dag_id);
       }
   }
   ```

4. **Handle the tauri::State → Arc conversion**: The `dispatch_task` in `router.rs` takes `tauri::State<'_, AppState>`. Since we're in an async spawned task, we can't pass `tauri::State`. Two approaches:
   - **Preferred**: Check if `dispatch_task` can accept `AppState` directly (it already dereferences to `&AppState` internally). If so, create a parallel version or modify the function signature.
   - **Alternative**: Since `router::dispatch_task` is only called from the orchestrator's dispatch loop, refactor it to accept `AppState` and `Arc<ContextStore>` directly instead of `tauri::State` wrappers. The Tauri command boundary in `router.rs` is `dispatch_task` which is `#[tauri::command]` — but the orchestrator calls `super::router::dispatch_task()` directly. You may need a non-Tauri wrapper function like `dispatch_task_inner(prompt, project_dir, tool_name, task_id, on_event, state: AppState, context_store: Arc<ContextStore>)`.

5. **Add tests and verify**: Add a test that validates the `WorkerOutcome` struct shape. Verify compilation and all existing orchestrator tests pass. Run `cargo test --lib orchestrator_test`.

## Must-Haves

- [ ] Per-worker dispatch+wait+retry logic extracted into `dispatch_and_await_worker()` async function
- [ ] Wave loop uses `tokio::task::JoinSet` to spawn workers concurrently
- [ ] Results collected and merged into `failed_dag_ids` / `worker_task_ids` after JoinSet drains
- [ ] Retry/fallback logic preserved inside the per-worker async function
- [ ] `dispatch_task` callable from spawned Tokio task (not dependent on `tauri::State` lifetime)
- [ ] All existing orchestrator tests pass

## Verification

- `cd src-tauri && cargo test --lib orchestrator_test` — all tests pass
- `cd src-tauri && cargo build --lib` — compiles without errors
- `rg "JoinSet" src-tauri/src/commands/orchestrator.rs` — returns ≥1 match
- `rg "dispatch_and_await_worker\|WorkerOutcome" src-tauri/src/commands/orchestrator.rs` — returns ≥2 matches (definition + usage)
- `rg "for dag_id in wave_ids" src-tauri/src/commands/orchestrator.rs` — the loop body is now JoinSet spawns, not sequential dispatch+wait

## Inputs

- `src-tauri/src/commands/orchestrator.rs` — dispatch loop with worktree wiring from T02, sequential per-worker processing
- `src-tauri/src/commands/orchestrator_test.rs` — existing tests
- `src-tauri/src/commands/router.rs` — `dispatch_task()` taking `tauri::State<'_, AppState>` and `tauri::State<'_, ContextStore>`

## Expected Output

- `src-tauri/src/commands/orchestrator.rs` — parallel wave dispatch via JoinSet, `dispatch_and_await_worker()` helper, `WorkerOutcome` struct
- `src-tauri/src/commands/orchestrator_test.rs` — test for WorkerOutcome struct
- `src-tauri/src/commands/router.rs` — possibly refactored `dispatch_task_inner()` accepting non-Tauri-State types for spawned task compatibility

## Observability Impact

- **New signal: JoinSet panic/cancellation** — `dispatch_error` event with `context: "join_set"` emitted when a spawned worker task panics or is cancelled. Grep `join_set` in orchestrator event stream to detect infrastructure-level failures.
- **Changed signal: Worker events now arrive concurrently** — `worker_started`, `task_completed`, `task_failed` events for workers within the same wave may interleave instead of arriving sequentially. Downstream consumers must not assume ordering within a wave.
- **New signal: Rate limit without remaining tasks** — In parallel mode, `rate_limit_action_needed` no longer includes `remaining_tasks` (all tasks in the wave are already dispatched). The event carries `dag_id` and `plan_id` for identification.
- **Inspection: Wave parallelism** — To verify parallel execution, check timestamps on `worker_started` events for the same wave — they should be near-simultaneous rather than sequential.
- **Failure visibility:** JoinSet errors (panics) surface as `dispatch_error` events and are logged to stderr. Worker-level failures still flow through the same `task_failed` event path as before.
