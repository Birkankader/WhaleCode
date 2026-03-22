# S02: Worktree Isolation & Parallel Workers

**Goal:** Workers execute in isolated git worktrees and multiple same-type workers run in parallel during orchestrated dispatch.
**Demo:** Dispatching 2+ workers in an orchestration creates separate worktree directories under `.whalecode-worktrees/`, each worker's cwd is its worktree path (not `project_dir`), and two Claude workers can be dispatched simultaneously without "already running" errors.

## Must-Haves

- `dispatch_task` tool slot enforcement is bypassed for orchestrated workers (R004)
- Each orchestrated worker's `cwd` is a worktree path from `WorktreeManager::create_for_task()`, not `project_dir` (R003)
- `OrchestrationPlan` tracks `worktree_entries: HashMap<String, WorktreeEntry>` mapping dag_id → worktree (boundary contract for S04)
- Worktrees are cleaned up on orchestration completion (both success and failure paths)
- Rate limit retry + fallback logic (already implemented) is validated with test coverage (R011)
- All existing orchestrator tests (31+) and worktree tests (6+) continue to pass

## Proof Level

- This slice proves: integration
- Real runtime required: no (unit tests with mocked state verify dispatch paths and worktree wiring)
- Human/UAT required: no (deferred to S05 full pipeline UAT)

## Verification

- `cargo test --lib commands::orchestrator` — all existing tests pass + new worktree integration tests pass
- `cargo test --lib worktree` — all existing 10 tests pass
- `cargo test --lib process::manager` — all existing 6 tests pass
- `grep -q "create_for_task" src-tauri/src/commands/orchestrator.rs` — worktree creation is wired into orchestrator
- `grep -q "worktree_entries" src-tauri/src/router/orchestrator.rs` — tracking field exists on OrchestrationPlan
- `grep -q "dispatch_task_internal\|dispatch_task_for_orchestrator" src-tauri/src/commands/router.rs` — internal dispatch function exists
- `grep -q "cleanup_stale_worktrees\|remove_worktree" src-tauri/src/commands/orchestrator.rs` — cleanup wired into completion paths
- Structural: the `super::router::dispatch_task` call in orchestrator's Phase 2 wave loop passes a worktree-derived path, not raw `project_dir`
- `grep -q "dispatch_error" src-tauri/src/commands/orchestrator.rs` — worktree creation failures emit structured `@@orch::dispatch_error` events with git2 error strings

## Observability / Diagnostics

- Runtime signals: `@@orch::worktree_created` event per worker with `{ dag_id, worktree_path }`, `@@orch::worktrees_cleaned` event on completion with count of cleaned worktrees
- Inspection surfaces: `OrchestrationPlan.worktree_entries` map — inspectable via state lock, serialized in plan returned to frontend
- Failure visibility: worktree creation errors surface via `@@orch::dispatch_error` with specific git2 error strings; cleanup failures are logged but non-fatal
- Redaction constraints: none (worktree paths are local filesystem paths, no secrets)

## Integration Closure

- Upstream surfaces consumed: `SubTaskDef` with `id: Option<String>` from S01, DAG construction with `def.id.clone().unwrap_or_else()` from S01, `WorktreeManager` API from `src-tauri/src/worktree/manager.rs`
- New wiring introduced in this slice: internal `dispatch_task_internal` function in router.rs (bypasses tool slot); `WorktreeManager` instantiation and `create_for_task` calls in orchestrator Phase 2 loop; `worktree_entries` field on `OrchestrationPlan`
- What remains before the milestone is truly usable end-to-end: S03 (frontend state sync — approval flow, dag_id matching), S04 (review + merge pipeline consuming worktree_entries), S05 (full pipeline UAT)

## Tasks

- [x] **T01: Add internal dispatch function with tool-slot bypass and wire worktree creation into orchestrator** `est:1h`
  - Why: The core changes for both R003 (worktree isolation) and R004 (parallel same-type workers) center on the same code path — the orchestrator's Phase 2 wave dispatch loop. `dispatch_task` is a `#[tauri::command]` so we can't change its signature without breaking the frontend API. We create an internal-only function that both the Tauri command and the orchestrator can call with different tool-slot behavior. Then we wire `WorktreeManager::create_for_task()` into the orchestrator so each worker gets its own worktree directory as cwd.
  - Files: `src-tauri/src/commands/router.rs`, `src-tauri/src/commands/orchestrator.rs`, `src-tauri/src/router/orchestrator.rs`
  - Do: (1) Extract `dispatch_task` body into `pub(crate) async fn dispatch_task_internal(...)` with an added `skip_tool_slot: bool` param. `dispatch_task` delegates to it with `skip_tool_slot: false`. (2) Add `worktree_entries: HashMap<String, WorktreeEntry>` to `OrchestrationPlan` (with `#[serde(default)]` for backward compat). (3) In orchestrator Phase 2, create `WorktreeManager::new(expand_tilde(&project_dir))` before the wave loop. For each dag task, call `create_for_task(dag_id)`, store entry in `plan.worktree_entries`, and pass `worktree_entry.path.to_str()` as the `project_dir` arg to `dispatch_task_internal(..., skip_tool_slot: true)`. (4) Replace all 3 `super::router::dispatch_task(...)` calls in Phase 2 with `dispatch_task_internal(..., skip_tool_slot: true)`. (5) Add worktree cleanup at orchestration completion (success path) and failure paths using `manager.remove_worktree()` for each entry. (6) Emit `@@orch::worktree_created` event after each worktree creation.
  - Verify: `cargo test --lib commands::orchestrator` passes all existing tests + `grep -q "create_for_task" src-tauri/src/commands/orchestrator.rs` + `grep -q "dispatch_task_internal" src-tauri/src/commands/router.rs` + `grep -q "worktree_entries" src-tauri/src/router/orchestrator.rs`
  - Done when: orchestrator Phase 2 creates worktrees for each worker, passes worktree paths as cwd to internal dispatch (bypassing tool slot), tracks entries in plan, and cleans up on completion

- [x] **T02: Add integration tests for parallel dispatch, worktree wiring, and validate R011 retry coverage** `est:45m`
  - Why: T01 wires the infrastructure but the orchestrator's unit tests use mocked adapters and don't exercise the actual dispatch path with state. We need tests that prove: (a) two processes with the same `tool_name` can coexist in `AppState.processes` when using the internal dispatch bypass, (b) the `worktree_entries` field on `OrchestrationPlan` is populated and serializable, (c) retry/fallback logic in the dispatch loop handles rate limits (R011 validation). These tests form the contract that S04 depends on.
  - Files: `src-tauri/src/commands/orchestrator.rs`, `src-tauri/src/commands/router.rs`, `src-tauri/src/process/manager.rs`
  - Do: (1) In `router.rs` test module, add test `test_dispatch_task_internal_skip_tool_slot` that calls `dispatch_task_internal` with `skip_tool_slot: true` twice for the same tool_name and asserts both succeed (no "already running" error). (2) In `orchestrator.rs` test module, add test `test_orchestration_plan_worktree_entries_serializable` that creates an `OrchestrationPlan` with populated `worktree_entries` and verifies `serde_json::to_value` produces the expected shape. (3) In `orchestrator.rs` test module, add test `test_retry_config_and_fallback_selection` that validates `should_retry`, `retry_delay_ms`, and `select_fallback_agent` produce correct behavior (maps to R011). (4) Run full `cargo test --lib` to confirm no regressions across all modules.
  - Verify: `cargo test --lib commands::orchestrator` passes all tests (existing + new) + `cargo test --lib commands::router` passes + `cargo test --lib process::manager` passes
  - Done when: 3+ new tests pass covering parallel dispatch bypass, worktree tracking serialization, and retry/fallback logic; all existing tests pass with zero regressions

## Files Likely Touched

- `src-tauri/src/commands/router.rs` — extract internal dispatch function with tool-slot bypass
- `src-tauri/src/commands/orchestrator.rs` — wire WorktreeManager, pass worktree paths, add cleanup, add tests
- `src-tauri/src/router/orchestrator.rs` — add `worktree_entries` field to `OrchestrationPlan`
- `src-tauri/src/process/manager.rs` — no changes, but tests verify concurrent process entries
- `src-tauri/src/worktree/manager.rs` — no changes, consumed as-is
- `src-tauri/src/worktree/models.rs` — no changes, `WorktreeEntry` already serializable
