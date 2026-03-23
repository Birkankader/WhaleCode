---
id: S01
parent: M001
milestone: M001
provides:
  - SubTaskDef.id: Option<String> field that preserves LLM-provided task IDs through deserialization
  - DAG construction uses def.id when present, positional t{i+1} fallback when absent
  - @@orch::decomposition_failed event emitted before single-task fallback on parse failure
  - Frontend OrchEvent union includes dag_id on task_completed/task_failed and decomposition_failed type
  - masterTask.resultSummary populated on all 3 error paths (result.status==='error', catch block, decomposition_failed handler)
requires:
  - slice: none
    provides: first slice — no upstream dependencies
affects:
  - S02
  - S03
key_files:
  - src-tauri/src/router/orchestrator.rs
  - src-tauri/src/commands/orchestrator.rs
  - src/hooks/orchestration/handleOrchEvent.ts
  - src/hooks/orchestration/useOrchestratedDispatch.ts
key_decisions:
  - SubTaskDef.id is Option<String> with #[serde(default)] for backward-compatible deserialization
  - decomposition_failed event fires before fallback — preserves graceful single-task recovery while adding error visibility
  - masterTask.resultSummary must be set before phase transitions to 'failed' to prevent error card race condition
  - Direct for...of iteration on store.tasks instead of Array.from().find() — fewer allocations, same semantics
patterns_established:
  - Use def.id.clone().unwrap_or_else(|| format!("t{}", i+1)) for DAG node IDs
  - Set resultSummary on every error path before transitioning orchestration phase
  - @@orch:: event types serve as the contract surface between backend and frontend — add to OrchEvent union when introducing new events
observability_surfaces:
  - @@orch::decomposition_failed event with { error: string } payload
  - masterTask.resultSummary always populated on error — DecompositionErrorCard resolves at first priority tier
  - Orchestration logs panel includes error-level entry from decomposition_failed handler
drill_down_paths:
  - .gsd/milestones/M001/slices/S01/tasks/T01-SUMMARY.md
  - .gsd/milestones/M001/slices/S01/tasks/T02-SUMMARY.md
duration: 35m
verification_result: passed
completed_at: 2026-03-20
---

# S01: Decomposition & Error Pipeline

**SubTaskDef preserves LLM-provided task IDs through DAG construction, and all decomposition error paths now propagate specific backend error strings to the DecompositionErrorCard — eliminating generic "Error" text.**

## What Happened

Two focused tasks fixed the decomposition pipeline's two core problems: lost task IDs and swallowed errors.

**T01 (backend)** added `pub id: Option<String>` with `#[serde(default)]` to `SubTaskDef`, changed DAG construction to use `def.id.clone().unwrap_or_else(|| format!("t{}", i+1))` so LLM-provided IDs like `"setup"` and `"auth"` survive into the DAG (making `depends_on: ["setup"]` references actually resolve), and injected a `@@orch::decomposition_failed` event emission in the retry-also-failed code path. The event fires *before* the existing single-task fallback, so recovery behavior is preserved while error visibility is added. Four new unit tests cover ID preservation through deserialization and JSON parsing. All 48 orchestrator tests pass.

**T02 (frontend)** extended the `OrchEvent` TypeScript union with `dag_id?: string` on `task_completed`/`task_failed` events and added the `decomposition_failed` event type. A handler for `decomposition_failed` logs the error at error level and sets `masterTask.resultSummary`. Two additional `updateTaskResult` calls were added in `useOrchestratedDispatch.ts` — one in the `result.status === 'error'` branch, one in the `catch` block — ensuring all 3 error paths populate `resultSummary` before phase transitions to `'failed'`. TypeScript compiles with zero errors.

The net effect: `DecompositionErrorCard` reads `masterTask.resultSummary` as its first display priority, and that field is now guaranteed populated on every error path. The generic fallback message should never appear for backend-originated errors.

## Verification

All 6 slice-level checks pass:

| # | Check | Result |
|---|-------|--------|
| 1 | `SubTaskDef` has `id: Option<String>` | ✅ pass |
| 2 | Backend emits `decomposition_failed` event | ✅ pass |
| 3 | Frontend handles `decomposition_failed` | ✅ pass |
| 4 | `updateTaskResult` count >= 3 in `useOrchestratedDispatch.ts` | ✅ pass (3) |
| 5 | `dag_id` in `handleOrchEvent.ts` event types | ✅ pass |
| 6 | DAG uses `def.id.clone()` | ✅ pass |

Additional verification:
- 48 orchestrator Rust tests pass (including 4 new ID-preservation tests)
- TypeScript compilation: zero errors via `npx tsc --noEmit`

## New Requirements Surfaced

- none

## Deviations

- T01 added `id: None` to the inline `SubTaskDef` construction in the fallback block — not in the plan but required for compilation since the struct gained a new field.
- T02 used direct `for...of` iteration on `store.tasks` entries instead of `Array.from().find()` — functionally identical, fewer allocations.

## Known Limitations

- Full `cargo test` suite (all 357+ tests) could not complete within the worktree timeout. The 48 orchestrator-scoped tests cover all changed code paths. A full suite run should be validated in CI or a clean build before merge.
- Error propagation is verified at the contract level (event types, field population). Runtime visual confirmation that DecompositionErrorCard actually renders the error string requires a manual GUI test (covered in UAT).
- `dag_id`-based task completion *matching* (replacing FIFO queue) is wired in the type system but the actual matching logic change is S03 scope — S01 only added the `dag_id` field to the event types.

## Follow-ups

- S02 needs Specta TypeScript bindings regenerated (happens on `cargo build`) to pick up `SubTaskDef.id` in the frontend types.
- S03 should implement `dag_id`-based task completion matching now that the field exists on the event types.

## Files Created/Modified

- `src-tauri/src/router/orchestrator.rs` — Added `id: Option<String>` field with `#[serde(default)]` to `SubTaskDef` struct
- `src-tauri/src/commands/orchestrator.rs` — Updated DAG construction to use LLM IDs, emitted `decomposition_failed` event on retry failure, added `id: None` to fallback SubTaskDef, added 4 unit tests
- `src/hooks/orchestration/handleOrchEvent.ts` — Added `dag_id` to task_completed/task_failed types, added `decomposition_failed` event type and handler
- `src/hooks/orchestration/useOrchestratedDispatch.ts` — Added `updateTaskResult` calls on both error paths (result.status==='error' and catch block)

## Forward Intelligence

### What the next slice should know
- `SubTaskDef.id` propagates through Specta to TypeScript bindings on next `cargo build`. If S02/S03 work references `SubTaskDef` from the frontend, run a build first to get the updated bindings.
- The `@@orch::decomposition_failed` event is a new addition to the IPC contract. Any frontend code that switches on `OrchEvent` types should handle it — `handleOrchEvent.ts` already does.
- `dag_id` is now declared on `task_completed` and `task_failed` event types but the actual *matching* logic in `handleOrchEvent.ts` still uses the FIFO `subTaskQueue`. S03 needs to replace that with `dagToFrontendId` map lookup.

### What's fragile
- The `updateTaskResult` → phase transition ordering in `useOrchestratedDispatch.ts` — if anyone reorders these calls so phase becomes `'failed'` before resultSummary is set, the error card will flash generic text before the real error appears. The pattern is: **always set resultSummary first, then transition phase**.
- TypeScript types for `OrchEvent` are manually maintained (not auto-generated from Rust). If the backend adds new event fields, the TypeScript union must be updated manually to match.

### Authoritative diagnostics
- `cargo test --lib commands::orchestrator` — 48 tests in <1s, covers all parsing, DAG construction, and decomposition logic. This is the fastest way to verify orchestrator changes.
- `grep -c 'updateTaskResult' src/hooks/orchestration/useOrchestratedDispatch.ts` — must return >= 3. If it drops below 3, an error path lost its resultSummary propagation.

### What assumptions changed
- Original assumption: "SubTaskDef drops the id field silently" — confirmed true, now fixed. The id field deserializes correctly with both present and absent JSON.
- Original assumption: "DAG falls back to single wave without ID preservation" — confirmed. With the fix, LLM-provided IDs flow through to DAG node IDs, so `depends_on` references resolve and multi-wave scheduling works.
