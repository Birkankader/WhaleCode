---
id: T02
parent: S02
milestone: M001
provides:
  - 2 router tests proving R004 (parallel same-type workers via tool-slot bypass)
  - 2 orchestrator tests proving R003 (worktree_entries serialization on OrchestrationPlan)
  - 4 orchestrator tests proving R011 (should_retry, retry_delay_ms, select_fallback_agent, RetryConfig defaults)
key_files:
  - src-tauri/src/commands/orchestrator.rs
  - src-tauri/src/commands/router.rs
key_decisions:
  - Added AgentConfig to orchestrator.rs import list rather than using full path in tests
patterns_established:
  - Test naming convention: test functions named with requirement ID context (e.g., test_tool_slot_bypass_allows_concurrent_same_agent for R004)
observability_surfaces:
  - Test-only: test output from cargo test commands shows pass/fail per requirement
duration: 15m
verification_result: passed
completed_at: 2026-03-20
blocker_discovered: false
---

# T02: Add integration tests for parallel dispatch, worktree wiring, and validate R011 retry coverage

**Added 8 tests validating R004 (parallel same-type workers), R003 (worktree entries serialization), and R011 (retry/fallback logic) with zero regressions across all modules.**

## What Happened

1. **Added 2 router.rs tests for R004 (parallel same-type workers)**: `test_tool_slot_bypass_allows_concurrent_same_agent` inserts two `ProcessEntry` objects with `tool_name = "claude"` into `AppState.processes`, proves they coexist (HashMap keyed by task_id), and verifies `acquire_tool_slot` rejects the second reservation — confirming the `skip_tool_slot` bypass in `dispatch_task_internal` is necessary. `test_reservation_guard_skip_semantics` verifies the guard creation logic.

2. **Added 2 orchestrator.rs tests for R003 (worktree isolation)**: `test_plan_worktree_entries_serializable` creates an `OrchestrationPlan`, inserts two `WorktreeEntry` values, serializes via `serde_json::to_value`, and asserts all fields (`task_id`, `worktree_name`, `branch_name`, `path`, `created_at`) round-trip correctly. `test_plan_worktree_entries_default_empty` verifies new plans start with an empty HashMap that serializes as `{}`.

3. **Added 4 orchestrator.rs tests for R011 (retry/fallback)**: `test_should_retry_respects_max_retries` validates boundary conditions (0, 1, max, beyond-max, zero-max edge case). `test_retry_delay_exponential_backoff` verifies the `base * 2^attempt` formula with both custom and default configs. `test_select_fallback_agent_picks_different` covers claude→gemini, gemini→claude, codex→claude fallback, single-agent no-fallback, and empty-list edge cases. `test_retry_config_default_values` asserts the default config matches orchestrator expectations (max_retries=2, base_delay=5000ms).

4. **Added `AgentConfig` to the orchestrator.rs import list** so the test module can use it via `super::*`.

## Verification

- `cargo test --lib commands::orchestrator` — 54 tests pass (37 in commands::orchestrator + 17 in commands::orchestrator_test), 0 failed
- `cargo test --lib commands::router` — 2 tests pass (both new), 0 failed
- `cargo test --lib process::manager` — 6 tests pass, 0 failed
- `cargo test --lib worktree` — 24 tests pass, 0 failed
- `grep -c "#\[test\]" src-tauri/src/commands/orchestrator.rs` = 37 (≥35 ✅)
- `grep -c "#\[test\]" src-tauri/src/commands/router.rs` = 2 (≥1 ✅)
- All slice-level grep checks pass

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `cargo test --lib commands::orchestrator` | 0 | ✅ pass | 3.2s |
| 2 | `cargo test --lib commands::router` | 0 | ✅ pass | 3.1s |
| 3 | `cargo test --lib process::manager` | 0 | ✅ pass | 3.1s |
| 4 | `cargo test --lib worktree` | 0 | ✅ pass | 3.1s |
| 5 | `grep -c "#\[test\]" src-tauri/src/commands/orchestrator.rs` (=37, ≥35) | 0 | ✅ pass | <1s |
| 6 | `grep -c "#\[test\]" src-tauri/src/commands/router.rs` (=2, ≥1) | 0 | ✅ pass | <1s |
| 7 | `grep -q "create_for_task" src-tauri/src/commands/orchestrator.rs` | 0 | ✅ pass | <1s |
| 8 | `grep -q "worktree_entries" src-tauri/src/router/orchestrator.rs` | 0 | ✅ pass | <1s |
| 9 | `grep -q "dispatch_task_internal" src-tauri/src/commands/router.rs` | 0 | ✅ pass | <1s |
| 10 | `grep -q "remove_worktree" src-tauri/src/commands/orchestrator.rs` | 0 | ✅ pass | <1s |
| 11 | `grep -q "dispatch_error" src-tauri/src/commands/orchestrator.rs` | 0 | ✅ pass | <1s |

## Diagnostics

- Test-only code. No new runtime signals.
- Inspect test results via `cargo test --lib commands::orchestrator -- --nocapture` to see assertion messages referencing requirement IDs.

## Deviations

- **R011 tests co-located with retry.rs coverage**: The task plan asked for retry tests in orchestrator.rs. The retry functions already have 5 comprehensive unit tests in `router/retry.rs`. The new orchestrator tests validate the integration contract (functions are accessible, produce expected values for orchestrator usage) rather than duplicating the existing unit tests. This provides better coverage without redundancy.
- **Added `AgentConfig` to orchestrator.rs imports**: Not mentioned in the task plan, but required because the test module uses `super::*` which only includes items in the parent module's namespace. Adding it to the existing import line was the minimal fix.

## Known Issues

None.

## Files Created/Modified

- `src-tauri/src/commands/router.rs` — added `#[cfg(test)] mod tests` with 2 test functions for R004 validation
- `src-tauri/src/commands/orchestrator.rs` — added 6 test functions for R003 and R011 validation; added `AgentConfig` to import list
- `.gsd/milestones/M001/slices/S02/tasks/T02-PLAN.md` — added Observability Impact section (pre-flight fix)
