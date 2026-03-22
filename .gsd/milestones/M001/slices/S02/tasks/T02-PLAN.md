---
estimated_steps: 4
estimated_files: 3
skills_used:
  - test
---

# T02: Add integration tests for parallel dispatch, worktree wiring, and validate R011 retry coverage

**Slice:** S02 — Worktree Isolation & Parallel Workers
**Milestone:** M001

## Description

T01 wires the worktree and tool-slot bypass infrastructure into the orchestrator, but the existing orchestrator tests use hardcoded JSON parsing and don't exercise the dispatch path with `AppState`. This task adds targeted tests that prove the three requirements this slice owns:

- **R004 (parallel same-type workers):** A test proving two `ProcessEntry` objects with `tool_name = "claude"` can coexist in `AppState.processes` when using the tool-slot bypass path (i.e., `skip_tool_slot: true` doesn't call `acquire_tool_slot`).
- **R003 (worktree isolation):** A test proving `OrchestrationPlan.worktree_entries` is populated and serializable, confirming the tracking field works end-to-end. Also a structural grep test that the orchestrator passes worktree paths (not `project_dir`) to dispatch.
- **R011 (rate limit retry):** Tests validating `should_retry`, `retry_delay_ms`, and `select_fallback_agent` — the existing retry infrastructure functions — produce correct behavior. These functions are already implemented but lack direct unit test coverage, so R011's validation criteria need mapping.

## Steps

1. **Add tool-slot bypass test in `router.rs`.**
   - In the `#[cfg(test)] mod tests` block of `commands/router.rs`, add `test_tool_slot_bypass_allows_concurrent_same_agent`.
   - Create an `AppState` (like existing tests: `Arc::new(Mutex::new(Default::default()))`).
   - Call `acquire_tool_slot(&state, "claude")` — should succeed.
   - Without releasing, verify that `acquire_tool_slot(&state, "claude")` returns `Err`.
   - Then verify that when `skip_tool_slot` is true in `dispatch_task_internal`, the second call would not hit this check (test at the function-level by verifying the guard logic — since we can't easily test the full async dispatch without a Tauri context, test the bypass contract by checking that the reserved_tools set is NOT modified when skip is true).
   - Alternative simpler approach: Manually insert two `ProcessEntry` objects with `tool_name = "claude"` and `status = Running` into `AppState.processes`, confirming they coexist (HashMap keyed by task_id, not tool_name, so this proves the data model supports it). Then verify `acquire_tool_slot` would reject but the bypass path doesn't call it.

2. **Add `OrchestrationPlan` worktree entries serialization test in `orchestrator.rs`.**
   - In the `#[cfg(test)] mod tests` block, add `test_plan_worktree_entries_serializable`.
   - Create an `OrchestrationPlan` via `Orchestrator::create_plan("test", &config)`.
   - Insert a `WorktreeEntry` into `plan.worktree_entries` with realistic values.
   - Call `serde_json::to_value(&plan)` and assert `worktree_entries` key exists in the output.
   - Assert the nested `WorktreeEntry` fields (`task_id`, `path`, `branch_name`) serialize correctly.

3. **Add retry/fallback tests in `orchestrator.rs` (R011 validation).**
   - Add `test_should_retry_respects_max_retries` — verify `should_retry(0, &config)` is true, `should_retry(config.max_retries, &config)` is false.
   - Add `test_retry_delay_exponential_backoff` — verify `retry_delay_ms(0, &config)` is base delay, `retry_delay_ms(1, &config)` is doubled, etc.
   - Add `test_select_fallback_agent_picks_different` — verify `select_fallback_agent("claude", &["claude", "gemini"])` returns `Some("gemini")`, and `select_fallback_agent("claude", &["claude"])` returns `None`.
   - These tests may need the functions to be `pub(crate)` or tested within the module — check current visibility.

4. **Run full module test suites and verify zero regressions.**
   - `cargo test --lib commands::orchestrator` — all tests pass.
   - `cargo test --lib commands::router` — all tests pass.
   - `cargo test --lib process::manager` — all tests pass.
   - `cargo test --lib worktree` — all tests pass.

## Must-Haves

- [ ] Test proving two `ProcessEntry` with same `tool_name` can coexist in `AppState.processes` (R004)
- [ ] Test proving `OrchestrationPlan.worktree_entries` serializes correctly with `WorktreeEntry` values (R003 contract)
- [ ] Tests proving `should_retry`, `retry_delay_ms`, and `select_fallback_agent` behave correctly (R011)
- [ ] All existing tests pass with zero regressions across orchestrator, router, process::manager, and worktree modules

## Verification

- `cargo test --lib commands::orchestrator` — all existing + new tests pass
- `cargo test --lib commands::router` — all existing + new tests pass
- `cargo test --lib process::manager` — all 6 existing tests pass
- `cargo test --lib worktree` — all existing tests pass
- New test count: `grep -c "#\[test\]" src-tauri/src/commands/orchestrator.rs` returns >= 35 (31 existing + 4 new)
- `grep -c "#\[test\]" src-tauri/src/commands/router.rs` returns >= 1 (new bypass test)

## Inputs

- `src-tauri/src/commands/router.rs` — modified by T01, contains `dispatch_task_internal` with `skip_tool_slot`
- `src-tauri/src/commands/orchestrator.rs` — modified by T01, contains worktree wiring + retry functions
- `src-tauri/src/router/orchestrator.rs` — modified by T01, `OrchestrationPlan` has `worktree_entries` field
- `src-tauri/src/process/manager.rs` — existing `acquire_tool_slot` / `release_tool_slot` functions
- `src-tauri/src/worktree/models.rs` — `WorktreeEntry` struct for test construction

## Expected Output

- `src-tauri/src/commands/orchestrator.rs` — 4+ new test functions added in `#[cfg(test)]` module
- `src-tauri/src/commands/router.rs` — 1+ new test function added in `#[cfg(test)]` module

## Observability Impact

- **No new runtime signals**: This task adds test-only code. No new `@@orch::` events, no new state fields.
- **Inspection**: Test output from `cargo test --lib commands::orchestrator` and `cargo test --lib commands::router` shows pass/fail for each requirement (R003, R004, R011).
- **Failure visibility**: Test failures surface as standard Rust test output with assertion messages naming the requirement being validated.
