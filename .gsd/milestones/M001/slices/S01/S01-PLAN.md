# S01: Decomposition & Error Pipeline

**Goal:** Master agent decomposes a task into sub-tasks with correct JSON parsing (preserving LLM-provided IDs), and errors at any phase surface with actionable detail in the UI error card — not generic fallback text.
**Demo:** Submit a task through the GUI → decomposition produces sub-tasks with IDs visible in orchestration logs. Intentionally trigger a failure (e.g., invalid API key) → the DecompositionErrorCard shows the specific backend error string, not "The master agent failed to decompose the task into sub-tasks."

## Must-Haves

- `SubTaskDef` struct has `id: Option<String>` field (with `#[serde(default)]`) that preserves LLM-provided task IDs
- DAG construction uses `def.id` when present, falls back to positional `t{i+1}` IDs
- When decomposition parse fails after retry, backend emits `@@orch::decomposition_failed` event carrying the actual error text before falling back to single-task mode
- Frontend `DecompositionErrorCard` always shows the actual backend error — `resultSummary` is populated on all failure paths
- `OrchEvent` TypeScript union includes `dag_id` field on `task_completed`/`task_failed` events and a new `decomposition_failed` event type
- All 353+ existing Rust tests still pass
- New unit tests for `SubTaskDef` deserialization with and without `id` field

## Proof Level

- This slice proves: contract + operational (parsing correctness + error visibility)
- Real runtime required: yes (manual GUI verification of error card)
- Human/UAT required: yes (visual confirmation that error card shows specific error text)

## Verification

- `cd src-tauri && cargo test 2>&1 | tail -5` — all 353+ tests pass including new `SubTaskDef` ID tests
- `grep -q 'pub id: Option<String>' src-tauri/src/router/orchestrator.rs` — SubTaskDef has id field
- `grep -q 'decomposition_failed' src-tauri/src/commands/orchestrator.rs` — backend emits decomposition_failed event
- `grep -q 'decomposition_failed' src/hooks/orchestration/handleOrchEvent.ts` — frontend handles the event
- `grep -q 'updateTaskResult' src/hooks/orchestration/useOrchestratedDispatch.ts | wc -l` returns >= 3 — resultSummary set on error paths
- `grep -q "dag_id" src/hooks/orchestration/handleOrchEvent.ts` — task_completed/task_failed types include dag_id

## Observability / Diagnostics

- Runtime signals: `@@orch::decomposition_failed` event with `{ error: string }` payload; existing `@@orch::info` "Fallback: running original prompt as single task" preserved
- Inspection surfaces: Orchestration Logs panel in DecompositionErrorCard (collapsible details section shows last 10 logs including the error)
- Failure visibility: `masterTask.resultSummary` now always populated on error paths — the error card reads this first, so specific backend errors are displayed
- Redaction constraints: none (error strings may contain CLI names but no secrets)

## Integration Closure

- Upstream surfaces consumed: none (first slice)
- New wiring introduced in this slice: `SubTaskDef.id` field propagates through Specta TypeScript bindings (auto-regenerated on build); `decomposition_failed` event type added to frontend OrchEvent union
- What remains before the milestone is truly usable end-to-end: S02 (worktree isolation), S03 (frontend state sync — `dag_id`-based matching instead of FIFO queue, `activePlan` timing fix), S04 (review/merge), S05 (integration)

## Tasks

- [x] **T01: Add SubTaskDef ID field, wire DAG construction, and emit decomposition_failed event** `est:1h`
  - Why: Fixes R001/R005 (ID preservation for DAG) and the backend half of R002 (error event emission). SubTaskDef currently drops the LLM's `id` field on deserialization, so `depends_on` references break. The fallback path silently creates a single task without telling the frontend what went wrong.
  - Files: `src-tauri/src/router/orchestrator.rs`, `src-tauri/src/commands/orchestrator.rs`
  - Do: (1) Add `id: Option<String>` with `#[serde(default)]` to `SubTaskDef`. (2) Update DAG construction at line ~1062 to use `def.id.clone().unwrap_or_else(|| format!("t{}", i+1))`. (3) After the retry-also-failed fallback block (~line 910), emit `@@orch::decomposition_failed` event with the actual error before creating the fallback task. (4) Add unit tests for `SubTaskDef` with/without `id`, and for `parse_decomposition_json` preserving IDs. (5) Verify all 353+ existing tests pass.
  - Verify: `cd src-tauri && cargo test 2>&1 | tail -5` passes with 353+ tests
  - Done when: `SubTaskDef` has `id: Option<String>`, DAG uses it when present, decomposition failures emit a `decomposition_failed` event, and all tests pass

- [x] **T02: Wire frontend error propagation so DecompositionErrorCard shows actual backend errors** `est:45m`
  - Why: Closes R002 on the frontend side. Currently the error card shows generic fallback text because `resultSummary` is never set on failure paths, and the `OrchEvent` types don't include `dag_id` or `decomposition_failed`.
  - Files: `src/hooks/orchestration/handleOrchEvent.ts`, `src/hooks/orchestration/useOrchestratedDispatch.ts`
  - Do: (1) In `handleOrchEvent.ts`: add `dag_id?: string` to `task_completed` and `task_failed` event types; add `decomposition_failed` event type `{ type: 'decomposition_failed'; error: string }`; add handler that logs the error and stores it via `addOrchestrationLog` at `error` level. (2) In `useOrchestratedDispatch.ts`: in the `result.status === 'error'` block (line ~206), find the master task and call `updateTaskResult(masterId, result.error)` before throwing; in the `catch` block (line ~210), find the master task and call `updateTaskResult(masterId, String(e))` before marking running tasks as failed.
  - Verify: `grep -c 'updateTaskResult' src/hooks/orchestration/useOrchestratedDispatch.ts` returns >= 3; `grep -q 'decomposition_failed' src/hooks/orchestration/handleOrchEvent.ts` succeeds
  - Done when: Every error path in `useOrchestratedDispatch.ts` calls `updateTaskResult` on the master task, `OrchEvent` includes `dag_id` and `decomposition_failed`, and the handler processes `decomposition_failed` events

## Files Likely Touched

- `src-tauri/src/router/orchestrator.rs`
- `src-tauri/src/commands/orchestrator.rs`
- `src/hooks/orchestration/handleOrchEvent.ts`
- `src/hooks/orchestration/useOrchestratedDispatch.ts`
