---
id: T01
parent: S02
milestone: M002
provides:
  - dispatch_id-based slot reservation (replaces per-agent-name blocking)
  - acquire_dispatch_slot / release_dispatch_slot public API
  - concurrent same-agent-type dispatch capability
key_files:
  - src-tauri/src/state.rs
  - src-tauri/src/process/manager.rs
  - src-tauri/src/commands/router.rs
  - src-tauri/src/commands/orchestrator.rs
key_decisions:
  - Orchestrator review phase uses "{plan.task_id}-review" as dispatch_id to avoid collision with decompose phase's "{plan.task_id}"
patterns_established:
  - dispatch_id is the slot key everywhere — router generates from task_id/UUID, orchestrator uses plan.task_id variants
observability_surfaces:
  - AppStateInner.reserved_dispatches shows active dispatch reservations keyed by dispatch_id
  - Error messages include dispatch_id for traceability
duration: 20m
verification_result: passed
completed_at: 2026-03-23
blocker_discovered: false
---

# T01: Refactor tool slots from per-agent-name to per-task-id tracking

**Renamed reserved_tools → reserved_dispatches and refactored acquire/release slot functions from per-agent-name to per-dispatch-id semantics, removing the running-process check that blocked same-agent concurrency.**

## What Happened

Changed the tool slot mechanism across 4 files to key on unique dispatch_id instead of agent name (tool_name). The running-process for-loop in `acquire_tool_slot` that checked `proc.tool_name == tool_name && Running` was the direct blocker for parallel same-agent workers — it's now removed entirely. The `reserved_dispatches` HashSet only guards against TOCTOU races on the same dispatch_id, not against concurrent agents of the same type.

In `router.rs`, `dispatch_task()` generates a dispatch_id from the provided `task_id` or a fresh UUID. In `orchestrator.rs`, decompose uses `plan.task_id` and review uses `{plan.task_id}-review` as dispatch_ids. The `ReservationGuard` RAII struct was updated to hold `dispatch_id` instead of `tool_name`.

Added a new test `test_acquire_dispatch_slot_two_same_agent_different_ids` that proves the core behavior change: two dispatches with different dispatch_ids both succeed regardless of agent name. Updated the running-process test to verify it no longer blocks.

## Verification

- `cargo test --lib -- "process::manager"` — 7 tests pass (5 updated + 1 new concurrency test + 1 existing spawn test)
- `cargo test --lib -- "state::"` — 10 tests pass (4 renamed dispatch tests + 6 existing)
- `cargo test --lib orchestrator_test` — 21 tests pass (unaffected)
- `rg "reserved_tools" src-tauri/src/` — 0 matches (fully renamed)
- `rg "acquire_tool_slot.*tool_name" src-tauri/src/commands/router.rs` — 0 matches (slot keyed by dispatch_id)
- `cargo build --lib` — compiles cleanly (only pre-existing warnings)

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `cargo test --lib -- "process::manager"` | 0 | ✅ pass | 7.7s |
| 2 | `cargo test --lib -- "state::"` | 0 | ✅ pass | 4.3s |
| 3 | `cargo test --lib orchestrator_test` | 0 | ✅ pass | 4.0s |
| 4 | `rg "reserved_tools" src-tauri/src/` | 1 | ✅ pass (0 matches) | <1s |
| 5 | `rg "acquire_tool_slot.*tool_name" src-tauri/src/commands/router.rs` | 1 | ✅ pass (0 matches) | <1s |
| 6 | `cargo build --lib` | 0 | ✅ pass | 6.6s |

## Diagnostics

- `AppStateInner.reserved_dispatches` — inspect active dispatch reservations at runtime
- Error format: `"{dispatch_id} is already being dispatched"` — appears when duplicate dispatch_id is attempted
- The old `"{tool_name} is already running a task"` error is gone — its absence confirms same-agent concurrency is unlocked

## Deviations

- Orchestrator review phase needed a distinct dispatch_id from decompose phase since both use the same plan. Used `format!("{}-review", plan.task_id)` convention instead of the planner's assumption that `plan.task_id` alone would suffice for both phases.
- The planner expected 6 existing tests in manager.rs but there were actually 4 slot tests + 1 spawn test + 1 send test (6 total, but only 4 needed slot-related updates). The test count in verification (7) includes the new concurrency test.

## Known Issues

None.

## Files Created/Modified

- `src-tauri/src/state.rs` — Renamed `reserved_tools` → `reserved_dispatches` in AppStateInner; updated 4 tests to use dispatch_id semantics
- `src-tauri/src/process/manager.rs` — Renamed `acquire_tool_slot` → `acquire_dispatch_slot`, `release_tool_slot` → `release_dispatch_slot`; removed running-process check loop; updated 4 tests + added new concurrency test
- `src-tauri/src/commands/router.rs` — Updated `ReservationGuard` to hold `dispatch_id`; `dispatch_task` generates dispatch_id from task_id/UUID for slot acquisition
- `src-tauri/src/commands/orchestrator.rs` — Changed 6 acquire/release call sites from `config.master_agent` to `plan.task_id` / `{plan.task_id}-review`
- `.gsd/milestones/M002/slices/S02/tasks/T01-PLAN.md` — Added Observability Impact section (pre-flight fix)
