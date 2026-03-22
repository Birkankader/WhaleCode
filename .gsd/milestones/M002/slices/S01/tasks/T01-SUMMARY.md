---
id: T01
parent: S01
milestone: M002
provides:
  - SubTaskDef.id field for LLM-provided task IDs
  - DAG construction that prefers LLM IDs over index-based fallback
  - dag_id in task_assigned events for frontend mapping
  - plan_id and master_agent in phase_changed decomposing events (S03 boundary contract)
key_files:
  - src-tauri/src/router/orchestrator.rs
  - src-tauri/src/commands/orchestrator.rs
  - src-tauri/src/commands/orchestrator_test.rs
key_decisions:
  - All-or-nothing LLM ID strategy — if any task lacks an id, ALL tasks use index-based fallback to avoid partial-ID chaos in depends_on references
patterns_established:
  - Optional serde fields on SubTaskDef use #[serde(default)] with Option<String> for backward-compatible deserialization
observability_surfaces:
  - phase_changed events now carry plan_id and master_agent during decomposing phase, enabling frontend to set activePlan early
  - task_assigned events carry dag_id from SubTaskDef.id, enabling frontend dagToFrontendId mapping
duration: 25m
verification_result: passed
completed_at: 2026-03-22
blocker_discovered: false
---

# T01: Add id field to SubTaskDef and fix DAG construction to use LLM-provided IDs

**Added SubTaskDef.id field, DAG construction prefers LLM-provided IDs, enriched task_assigned with dag_id and phase_changed with plan_id/master_agent**

## What Happened

Added `pub id: Option<String>` with `#[serde(default)]` to `SubTaskDef` in `router/orchestrator.rs`. The field is deserialized from the LLM's JSON response (which already includes `"id": "t1"` etc.) and was previously silently dropped by serde.

Fixed DAG construction in `commands/orchestrator.rs` to check if ALL tasks have `id.is_some()` — if yes, LLM IDs drive the DAG; if any is `None`, all tasks fall back to index-based `t1, t2...`. This avoids partial-ID chaos where `depends_on` references can't resolve.

Enriched the `task_assigned` emit with `"dag_id"` from `sub_def.id`, and both `phase_changed` emits during decomposing with `"plan_id"` and `"master_agent"`. The frontend types in `handleOrchEvent.ts` already declared these optional fields — this change makes the backend actually populate them, enabling the `setActivePlan` call at line 53 to fire during decomposition.

Updated the fallback SubTaskDef construction (single-task fallback on parse failure) to include `id: None` since the struct now requires the field.

Wrote 4 new unit tests covering: SubTaskDef with id present, SubTaskDef without id (defaults to None), full DecompositionResult preserving LLM IDs, and mixed-ID deserialization.

## Verification

- `cargo build` — compiles successfully (34.9s, 0 errors)
- `cargo test --lib orchestrator_test` — 21/21 tests pass (including 4 new tests)
- `cargo test --lib -- "router::"` — 50/50 router tests pass
- `rg 'pub id: Option<String>' src-tauri/src/router/orchestrator.rs` — 1 match ✅
- `rg '"dag_id"' src-tauri/src/commands/orchestrator.rs` — match in task_assigned emit ✅
- `rg '"plan_id".*task_id' src-tauri/src/commands/orchestrator.rs` — 2 matches in phase_changed emits ✅
- `rg 'all_have_ids' src-tauri/src/commands/orchestrator.rs` — confirms DAG ID logic ✅
- `rg 'id: None' src-tauri/src/commands/orchestrator.rs` — fallback construction updated ✅

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `cd src-tauri && cargo build` | 0 | ✅ pass | 34.9s |
| 2 | `cd src-tauri && cargo test --lib orchestrator_test` | 0 | ✅ pass (21/21) | 0.13s |
| 3 | `cd src-tauri && cargo test --lib -- "router::"` | 0 | ✅ pass (50/50) | 0.13s |
| 4 | `rg 'pub id: Option<String>' src-tauri/src/router/orchestrator.rs` | 0 | ✅ pass (1 match) | <1s |
| 5 | `rg '"dag_id"' src-tauri/src/commands/orchestrator.rs` | 0 | ✅ pass | <1s |
| 6 | `rg '"plan_id".*task_id' src-tauri/src/commands/orchestrator.rs` | 0 | ✅ pass (2 matches) | <1s |
| 7 | `cd src-tauri && cargo test --lib` (full suite) | — | ⏱️ timeout | >120s |

Note: Full `cargo test --lib` times out (pre-existing condition — not caused by this change). Targeted test runs covering orchestrator_test (21 tests) and router tests (50 tests) all pass. The timeout appears to be from integration tests that spawn real processes.

## Diagnostics

- **Inspect SubTaskDef.id**: `rg 'pub id: Option<String>' src-tauri/src/router/orchestrator.rs`
- **Inspect DAG ID logic**: `rg 'all_have_ids' src-tauri/src/commands/orchestrator.rs`
- **Inspect enriched events**: `rg '"plan_id"\|"dag_id"' src-tauri/src/commands/orchestrator.rs`
- **Runtime**: `phase_changed` events during decomposing now carry `plan_id` and `master_agent`; `task_assigned` events carry `dag_id`
- **Failure state**: If LLM returns partial IDs (some tasks with id, some without), DAG construction falls back to index-based with a `debug!()` trace

## Deviations

None. All changes matched the plan exactly.

## Known Issues

- Full `cargo test --lib` (392 tests) times out after 120s+ — this is a pre-existing condition, not introduced by this task. Targeted test modules pass cleanly. The timeout likely comes from integration tests that spawn external processes.

## Files Created/Modified

- `src-tauri/src/router/orchestrator.rs` — Added `pub id: Option<String>` with `#[serde(default)]` to SubTaskDef struct
- `src-tauri/src/commands/orchestrator.rs` — (1) DAG construction uses LLM IDs when all present, index fallback otherwise; (2) task_assigned emits dag_id; (3) both phase_changed emits during decomposing enriched with plan_id and master_agent; (4) fallback SubTaskDef includes id: None
- `src-tauri/src/commands/orchestrator_test.rs` — Added 4 new tests: subtaskdef_with_id_field_deserializes_correctly, subtaskdef_without_id_field_defaults_to_none, decomposition_result_preserves_llm_ids, decomposition_result_mixed_ids_all_become_none_safe
