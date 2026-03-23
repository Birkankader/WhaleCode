# S01: Decomposition & Error Pipeline

**Goal:** Master agent decomposes a task into sub-tasks with correct JSON parsing, preserved task IDs driving the DAG scheduler, and errors surfacing as user-friendly messages in the UI with expandable technical detail.
**Demo:** Run a real decomposition through the GUI — sub-tasks appear with correct agent assignments and LLM-provided IDs. Force a decomposition failure and see a humanized error in DecompositionErrorCard with raw detail in the expandable "Orchestration Logs" section.

## Must-Haves

- `SubTaskDef` has `pub id: Option<String>` with `#[serde(default)]`, preserved through all 5 parsing strategies without modifying the parser itself
- DAG node IDs use LLM-provided IDs when all tasks have them, fall back to index-based `t1, t2...` when any task is missing an ID
- `task_assigned` events include `dag_id` field so frontend can map events to tasks
- `phase_changed` events during decomposing include `plan_id` and `master_agent` (S03 boundary contract)
- Backend emits `@@orch::decomposition_failed` with `{ error: string }` on all failure paths (timeout, auth error, parse failure) before returning Err or falling back
- `DecompositionErrorCard` pipes error messages through `humanizeError()` for the display text, preserving raw text in expandable logs
- `humanizeError` has 2-3 new decomposition-specific patterns (parse failure, fallback single-task, malformed response)
- All existing 388 Rust tests pass, TypeScript compiles with zero errors, new unit tests cover SubTaskDef.id and humanizeError additions

## Proof Level

- This slice proves: contract + integration (backend emits correct events with correct data, frontend displays humanized errors)
- Real runtime required: yes (Rust compilation, unit test execution, TypeScript type generation)
- Human/UAT required: yes (final verification: trigger real decomposition and forced failure through GUI)

## Verification

- `cd src-tauri && cargo test --lib` — all existing tests pass + new SubTaskDef.id tests pass
- `npx vitest run src/tests/humanizeError.test.ts` — new decomposition patterns pass
- `npx tsc --noEmit` — TypeScript compiles with zero errors
- `rg "emit_orch.*decomposition_failed" src-tauri/src/commands/orchestrator.rs` — at least 2 matches (timeout + parse failure paths)
- `rg "humanizeError" src/components/orchestration/DecompositionErrorCard.tsx` — at least 1 match
- `rg 'pub id: Option<String>' src-tauri/src/router/orchestrator.rs` — 1 match in SubTaskDef

## Observability / Diagnostics

- Runtime signals: `@@orch::decomposition_failed` event with `{ error: string }`, enriched `@@orch::phase_changed` with `plan_id`/`master_agent`, `@@orch::task_assigned` with `dag_id`
- Inspection surfaces: orchestration logs in frontend (DecompositionErrorCard shows last 10 log entries), Rust `debug!()` traces in decomposition parser and DAG construction
- Failure visibility: decomposition errors surface with humanized message + raw detail in expandable section; DAG scheduling failures emit `info` event with fallback notice
- Redaction constraints: none (no secrets in orchestration events)

## Integration Closure

- Upstream surfaces consumed: none (first slice)
- New wiring introduced: `SubTaskDef.id` flows through serde → DAG construction → `task_assigned` events → frontend `dagToFrontendId` map; `decomposition_failed` event flows through IPC → `handleOrchEvent.ts` → `DecompositionErrorCard`; `humanizeError` wired into error display chain
- What remains before milestone is truly usable end-to-end: S02 (worktree isolation), S03 (approval flow + state), S04 (review/merge), S05 (UI cleanup), S06 (full E2E)

## Tasks

- [x] **T01: Add id field to SubTaskDef and fix DAG construction to use LLM-provided IDs** `est:45m`
  - Why: R001/R005 — SubTaskDef drops the LLM's `id` field, so `depends_on` references don't match generated DAG IDs. Also `task_assigned` events lack `dag_id` and `phase_changed` events lack `plan_id`/`master_agent` (S03 boundary contract).
  - Files: `src-tauri/src/router/orchestrator.rs`, `src-tauri/src/commands/orchestrator.rs`, `src-tauri/src/commands/orchestrator_test.rs`
  - Do: (1) Add `pub id: Option<String>` with `#[serde(default)]` to `SubTaskDef`. (2) In DAG construction (~line 1052), use LLM IDs when ALL tasks have them, fall back to index-based when any is missing. (3) Add `dag_id` to `task_assigned` emit (~line 931). (4) Add `plan_id` and `master_agent` to `phase_changed` emits during decomposing (~lines 715, 749). (5) Write unit tests for SubTaskDef.id deserialization and DAG ID logic. Do NOT modify `parse_decomposition_json` or the 5-strategy parser.
  - Verify: `cd src-tauri && cargo test --lib` passes (all 388+ existing + new tests)
  - Done when: `SubTaskDef` has `id: Option<String>`, DAG uses LLM IDs when available, `task_assigned` includes `dag_id`, `phase_changed` includes `plan_id`/`master_agent`, all tests green

- [x] **T02: Emit decomposition_failed event from backend on all failure paths** `est:30m`
  - Why: R002 — The frontend handler for `decomposition_failed` exists but the backend never emits this event, so DecompositionErrorCard shows generic "The master agent failed..." text instead of the actual error.
  - Files: `src-tauri/src/commands/orchestrator.rs`
  - Do: (1) After retry parse failure (~line 898, before fallback), emit `decomposition_failed` with the parse error detail. (2) In auth error path (~line 810), emit `decomposition_failed` before returning Err. (3) In timeout path (~line 803), emit `decomposition_failed` before returning Err. (4) Ensure fallback single-task path still works (emit event but proceed with fallback, don't block). Guard against double error display: only emit if phase hasn't already been set to failed.
  - Verify: `rg "emit_orch.*decomposition_failed" src-tauri/src/commands/orchestrator.rs` shows at least 2 matches; `cd src-tauri && cargo test --lib` passes
  - Done when: Every decomposition failure path emits `@@orch::decomposition_failed` with an actionable error string before returning Err or falling back

- [x] **T03: Wire humanizeError into DecompositionErrorCard and add decomposition-specific patterns** `est:30m`
  - Why: R023 — Error messages in DecompositionErrorCard are raw Rust strings. Users see "Process xyz not found" instead of friendly guidance.
  - Files: `src/components/orchestration/DecompositionErrorCard.tsx`, `src/lib/humanizeError.ts`, `src/tests/humanizeError.test.ts`
  - Do: (1) Add 2-3 decomposition-specific patterns to `humanizeError.ts` (e.g., "Decomposition parse failed" → friendly message, "Fallback: running original prompt" → friendly message, "not valid JSON" → friendly message). (2) In `DecompositionErrorCard.tsx`, import `humanizeError` and wrap the `errorMessage` display through it — keep raw text available in expandable logs section. (3) Add new test cases to `humanizeError.test.ts` for the new patterns. (4) Verify TypeScript compiles.
  - Verify: `npx vitest run src/tests/humanizeError.test.ts` passes; `npx tsc --noEmit` succeeds; `rg "humanizeError" src/components/orchestration/DecompositionErrorCard.tsx` shows import
  - Done when: DecompositionErrorCard shows humanized error messages, raw text preserved in expandable section, all new tests pass, TypeScript compiles clean

## Files Likely Touched

- `src-tauri/src/router/orchestrator.rs`
- `src-tauri/src/commands/orchestrator.rs`
- `src-tauri/src/commands/orchestrator_test.rs`
- `src/components/orchestration/DecompositionErrorCard.tsx`
- `src/lib/humanizeError.ts`
- `src/tests/humanizeError.test.ts`
