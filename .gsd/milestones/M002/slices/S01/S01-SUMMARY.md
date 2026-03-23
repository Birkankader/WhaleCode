# S01 Summary: Decomposition & Error Pipeline

## What This Slice Delivered

The master agent's decomposition output now flows correctly from LLM JSON through Rust deserialization into the DAG scheduler with preserved task IDs, and all decomposition failures surface in the frontend with humanized, actionable error messages. This is the foundation for every downstream slice — S02 (worktree dispatch), S03 (frontend state), and S04 (review/merge) all consume the events and data structures established here.

## Key Changes

### T01: SubTaskDef.id + DAG construction + enriched events
- Added `pub id: Option<String>` with `#[serde(default)]` to `SubTaskDef` — the LLM's `"id": "t1"` field was previously silently dropped by serde
- DAG construction uses all-or-nothing strategy: LLM IDs drive the DAG when every task has one; any missing ID triggers index-based fallback for all tasks
- `task_assigned` events now carry `dag_id` — enables the frontend `dagToFrontendId` map (consumed by S03)
- `phase_changed` events during decomposing now carry `plan_id` and `master_agent` — enables `setActivePlan` to fire during Phase 1 (consumed by S03)
- 4 new unit tests for id deserialization and mixed-ID safety

### T02: decomposition_failed event on all failure paths
- 4 emit sites added: process error, timeout, auth error, parse failure fallback
- Terminal paths (process error, timeout, auth) emit then `return Err`
- Fallback path emits informational event then continues with single-task degraded mode
- Frontend `handleOrchEvent.ts` `decomposition_failed` handler already existed — now it actually receives events

### T03: humanizeError wired into DecompositionErrorCard
- 3 new decomposition-specific patterns in `humanizeError.ts`: parse failure, fallback single-task, timeout
- `DecompositionErrorCard` wraps `rawError` through `humanizeError()` for display, preserves raw text in expandable "Orchestration Logs" section
- Removed stale "Master agent timed out" generic pattern (superseded by decomposition-specific timeout pattern)
- 14 total humanizeError tests pass (3 new + 11 existing)

## Verification Results

| Check | Result |
|-------|--------|
| `cargo test --lib orchestrator_test` | ✅ 21/21 pass |
| `cargo test --lib -- "router::"` | ✅ 50/50 pass |
| `npx vitest run src/tests/humanizeError.test.ts` | ✅ 14/14 pass |
| `npx tsc --noEmit` | ✅ 0 errors |
| `grep "emit_orch.*decomposition_failed"` | ✅ 5 matches (≥2 required) |
| `grep "humanizeError" DecompositionErrorCard.tsx` | ✅ 2 matches (import + usage) |
| `grep 'pub id: Option<String>' router/orchestrator.rs` | ✅ 1 match |

## Boundary Contract — What Downstream Slices Consume

### S02 consumes:
- `SubTaskDef` with `pub id: Option<String>` preserved from LLM output
- Reliable decomposition producing `Vec<SubTaskDef>` with agent assignments and IDs
- `decomposition_failed` event with `{ error: string }` for error visibility

### S03 consumes:
- `task_assigned` events with `dag_id` field → feeds `dagToFrontendId` map for task completion matching
- `phase_changed` events with `plan_id` and `master_agent` → enables `setActivePlan` during decomposing phase
- `decomposition_failed` event → sets `masterTask.resultSummary` for error display
- `humanizeError` coverage for decomposition-specific failures

## Patterns Established

1. **Optional serde fields**: `#[serde(default)]` with `Option<String>` for backward-compatible deserialization of new fields on existing structs
2. **Decomposition-specific humanizeError patterns**: Placed at top of `ERROR_PATTERNS` array so they match before generic patterns
3. **Event semantics**: `decomposition_failed` is informational on fallback path (emit then continue) but terminal on Err paths (emit then return)
4. **All-or-nothing LLM IDs**: Partial IDs are treated as no IDs to keep depends_on references internally consistent

## Decisions Recorded

- D006: All-or-nothing DAG ID assignment from LLM-provided IDs
- D007: decomposition_failed event semantics (informational vs terminal)

## Known Issues

- Full `cargo test --lib` (392 tests) times out at 120s+ — pre-existing condition from integration tests that spawn external processes. All targeted test modules pass cleanly.
- 12 compiler warnings in Rust (pre-existing, unrelated to S01 changes)

## Files Modified

- `src-tauri/src/router/orchestrator.rs` — SubTaskDef.id field
- `src-tauri/src/commands/orchestrator.rs` — DAG construction, enriched events, decomposition_failed emits
- `src-tauri/src/commands/orchestrator_test.rs` — 4 new tests
- `src/lib/humanizeError.ts` — 3 new decomposition-specific patterns
- `src/components/orchestration/DecompositionErrorCard.tsx` — humanizeError wiring
- `src/tests/humanizeError.test.ts` — 3 new test cases
