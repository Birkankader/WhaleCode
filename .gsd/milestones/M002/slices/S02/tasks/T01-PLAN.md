---
estimated_steps: 5
estimated_files: 4
skills_used:
  - review
---

# T01: Refactor tool slots from per-agent-name to per-task-id tracking

**Slice:** S02 — Worktree Isolation & Parallel Workers
**Milestone:** M002

## Description

The current `acquire_tool_slot(state, tool_name)` / `release_tool_slot(state, tool_name)` mechanism uses the agent name (e.g. "claude") as the lock key. This means two Claude workers can never run concurrently — `acquire_tool_slot` will return `Err("claude is already running a task")` or `Err("claude is already being dispatched")`. This task changes the key from `tool_name` to a unique `dispatch_id` so that multiple workers of the same agent type can coexist.

The `reserved_tools: HashSet<String>` in `AppStateInner` becomes `reserved_dispatches: HashSet<String>`. The functions accept `dispatch_id` instead of `tool_name`. The running-process check is removed (it checked `proc.tool_name == tool_name` to block same-agent concurrent processes — exactly what we want to allow now). The reservation guard in `router.rs` passes the dispatch_id. The orchestrator's calls to `acquire_tool_slot` / `release_tool_slot` for master decompose/review also change to use the plan task_id as dispatch_id.

## Steps

1. **Rename the state field**: In `src-tauri/src/state.rs`, rename `reserved_tools: HashSet<String>` to `reserved_dispatches: HashSet<String>`. Update the 4 state.rs tests that reference `reserved_tools`.

2. **Refactor acquire/release functions**: In `src-tauri/src/process/manager.rs`:
   - Rename `acquire_tool_slot` → `acquire_dispatch_slot` (or keep the name and change the param from `tool_name: &str` to `dispatch_id: &str`)
   - Remove the for-loop that checks `proc.tool_name == tool_name && Running` — this was the per-agent-name blocking check
   - Change `inner.reserved_tools` → `inner.reserved_dispatches` throughout
   - Rename `release_tool_slot` → `release_dispatch_slot` similarly
   - Update all 6 existing tests: change the test names and assertions to use dispatch_id semantics
   - Add a new test `test_acquire_dispatch_slot_two_same_agent_different_ids` that proves two "claude" dispatches with different dispatch_ids both succeed

3. **Update router.rs dispatch_task**: In `src-tauri/src/commands/router.rs`, the `dispatch_task()` function:
   - Generate or use the `task_id` param as `dispatch_id`: `let dispatch_id = task_id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());`
   - Call `acquire_dispatch_slot(&*state, &dispatch_id)` instead of `acquire_tool_slot(&*state, &tool_name)`
   - Update `ReservationGuard::new` to take `dispatch_id` instead of `tool_name`
   - The ReservationGuard struct changes `tool_name: String` to `dispatch_id: String`

4. **Update orchestrator.rs master calls**: In `src-tauri/src/commands/orchestrator.rs`, the 6 call sites (3 acquire, 3 release) for the master decomposition and review phases:
   - Use the plan's `task_id` as `dispatch_id` instead of `config.master_agent`
   - These are at ~line 756, 779, 786, 1535, 1552, 1556

5. **Compile and test**: `cargo build --lib` to verify no compile errors, then run targeted tests to confirm all pass.

## Must-Haves

- [ ] `reserved_tools` renamed to `reserved_dispatches` in `AppStateInner`
- [ ] `acquire_tool_slot` / `release_tool_slot` accept dispatch_id, not tool_name
- [ ] Running-process check loop removed from `acquire_tool_slot` (was blocking same-agent concurrency)
- [ ] New test proves two dispatches with same agent name but different dispatch_ids succeed
- [ ] All existing tests in process/manager.rs, state.rs updated and passing
- [ ] Orchestrator master decompose/review uses plan task_id as dispatch_id

## Verification

- `cd src-tauri && cargo test --lib -- "process::manager"` — all slot tests pass (6 updated + 1 new)
- `cd src-tauri && cargo test --lib -- "state::"` — state tests pass with renamed field
- `cd src-tauri && cargo test --lib orchestrator_test` — existing orchestrator tests unaffected
- `rg "reserved_tools" src-tauri/src/` — returns 0 matches (fully renamed)
- `rg "acquire_tool_slot\b" src-tauri/src/` — returns 0 matches if renamed, or all call sites use dispatch_id

## Inputs

- `src-tauri/src/process/manager.rs` — contains `acquire_tool_slot`, `release_tool_slot`, and 6 tests
- `src-tauri/src/commands/router.rs` — contains `dispatch_task` with slot acquisition and `ReservationGuard`
- `src-tauri/src/commands/orchestrator.rs` — 6 acquire/release call sites for master agent
- `src-tauri/src/state.rs` — `AppStateInner` with `reserved_tools: HashSet<String>` field and 4 tests

## Expected Output

- `src-tauri/src/process/manager.rs` — refactored slot functions with dispatch_id semantics, 7+ tests
- `src-tauri/src/commands/router.rs` — dispatch_task uses dispatch_id for slot acquisition
- `src-tauri/src/commands/orchestrator.rs` — master agent calls use plan task_id as dispatch_id
- `src-tauri/src/state.rs` — `reserved_dispatches` field, updated tests

## Observability Impact

- **Signals changed:** `acquire_dispatch_slot` / `release_dispatch_slot` error messages now include a `dispatch_id` instead of an agent name. Error format: `"{dispatch_id} is already being dispatched"` (was `"{tool_name} is already running a task"` or `"{tool_name} is already being dispatched"`).
- **Removed signal:** The running-process check (`"{tool_name} is already running a task"`) is gone — this was the per-agent-name concurrency blocker. Its absence is the observable proof that same-agent parallel dispatch is unlocked.
- **Inspection:** `AppStateInner.reserved_dispatches` shows active dispatch reservations keyed by dispatch_id. Orchestrator decompose uses `plan.task_id` and review uses `{plan.task_id}-review` as dispatch_ids.
- **Failure visibility:** TOCTOU guard still active — duplicate dispatch_id attempts return `Err`, surfaced as dispatch errors upstream.
