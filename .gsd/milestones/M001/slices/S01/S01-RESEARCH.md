# S01 — Decomposition & Error Pipeline — Research

**Date:** 2026-03-20
**Status:** Complete
**Requirements:** R001 (Master agent decomposition), R002 (Error surfacing), R005 (Task ID preservation for DAG)

## Summary

S01 has three concrete problems to fix, all traceable to specific lines of code. The good news: the parsing infrastructure is already robust (5 JSON extraction strategies, alternative key handling, agent name normalization), the DAG scheduler is correct and well-tested, and the `DecompositionErrorCard` UI is fully built. What's broken is the plumbing between them.

**Problem 1 (R001/R005):** `SubTaskDef` has no `id` field. The decompose prompt tells the LLM to return `"id": "t1"` with `depends_on: ["t1"]` references, but the struct drops the `id` on deserialization. The DAG builder then synthesizes `t1/t2/t3` IDs from array position (`format!("t{}", i+1)` at `commands/orchestrator.rs:1061`). This works only when the LLM returns tasks in sequential order with `t1/t2/t3` IDs — if it uses different IDs (like `"setup"`, `"auth"`) or reorders tasks, `depends_on` references break and the DAG falls back to a single wave.

**Problem 2 (R002):** The error propagation chain has a dead zone. When decomposition parse fails twice, the backend silently falls back to single-task mode (line ~910) instead of telling the user. Auth errors and spawn failures DO propagate, but the `DecompositionErrorCard` gets its message from `masterTask?.resultSummary` which is only set on success paths (line 190 of `useOrchestratedDispatch.ts`), falling back to the last error log entry. Backend `Err(String)` values reach the orchestration logs via `useOrchestrationLaunch.ts:159` but this path needs hardening.

**Problem 3 (R002):** `dispatch_orchestrated_task` returns `Err(String)` for auth/spawn/timeout failures, but the thrown error on the frontend loses context by the time the `DecompositionErrorCard` renders. The error card should always show the actual backend error string, not the generic fallback.

## Recommendation

Fix in three focused units: (1) Add `id` field to `SubTaskDef` and wire it into DAG construction, (2) replace the silent single-task fallback with an explicit `decomposition_failed` event that carries the actual error, and (3) ensure `DecompositionErrorCard` receives backend error text through `resultSummary` on failure paths. All three are surgical edits to existing code with clear before/after test points.

## Implementation Landscape

### Key Files

- `src-tauri/src/router/orchestrator.rs` — `SubTaskDef` struct (line 68). Needs `id: Option<String>` field with `#[serde(default)]`. Also `DecompositionResult`, `OrchestrationPlan`, prompt builders. Well-tested (17 tests).
- `src-tauri/src/commands/orchestrator.rs` — The 2200-line orchestration command. Three areas to change:
  - **DAG construction** (lines 1059-1065): Change `format!("t{}", i+1)` to use `def.id` when present, falling back to positional IDs.
  - **Decomposition fallback** (lines ~910-935): Replace silent single-task fallback with a `decomposition_failed` orch event that carries the parse error, then optionally fall back.
  - **Error event emission** (throughout): Ensure every `return Err(...)` path first emits an `@@orch::decomposition_failed` event.
- `src/hooks/orchestration/handleOrchEvent.ts` — Event handler. Needs:
  - `task_completed`/`task_failed` type definitions to include `dag_id` field (lines 12-13 — already sent by backend, ignored by frontend type).
  - New `decomposition_failed` event type.
- `src/hooks/orchestration/useOrchestratedDispatch.ts` — Promise resolution handler. The `catch` block (line 209) sets phase to `failed` but doesn't set `resultSummary` on the master task. Need to add `updateTaskResult(masterId, error.message)` before throwing.
- `src/hooks/useOrchestrationLaunch.ts` — Launch entry point. The `.catch` at line 155 already logs the error and sets phase — this is correct but depends on the dispatch hook preserving the error message.
- `src/components/orchestration/DecompositionErrorCard.tsx` — Error UI. Already well-built with retry/switch-agent/edit actions. Error message sourced from `masterTask?.resultSummary || lastErrorLog?.message || genericFallback`. Fix: ensure one of the first two sources is always populated on failure.
- `src-tauri/src/commands/orchestrator_test.rs` — Integration tests (17 tests). Add tests for SubTaskDef with `id` field and error event emission.
- `src-tauri/src/router/dag.rs` — DAG scheduler. No changes needed — it works correctly with any string IDs. 8 tests passing.
- `src-tauri/src/process/manager.rs` — `acquire_tool_slot` / `release_tool_slot`. Current tool slot enforces max 1 per agent name globally. **Not modified in S01** — that's S02's concern (D001). But important context: decomposition acquires and releases the master's slot, so a spawn failure during decomposition properly releases it.

### Build Order

**Unit 1 — SubTaskDef `id` field + DAG wiring (R001, R005):**
This is the foundation. Add `id: Option<String>` to `SubTaskDef` (with `#[serde(default)]`). Update DAG construction in `commands/orchestrator.rs` to use `def.id.clone().unwrap_or_else(|| format!("t{}", i+1))`. This ensures LLM-provided IDs are used when present, with safe fallback. Add unit tests for parsing JSON with `id` field. Verify existing tests still pass (the `id` field is optional so backward-compat is maintained).

**Unit 2 — Error propagation chain (R002):**
Three sub-changes:
- (a) In `commands/orchestrator.rs`, when decomposition parse fails after retry and falls back to single-task, emit `@@orch::decomposition_failed` event with the actual error ("Failed to parse decomposition JSON after 2 attempts") before creating the fallback task.
- (b) In `useOrchestratedDispatch.ts`, on the error path (`result.status === 'error'`), find the master task and call `updateTaskResult(masterId, result.error)` before throwing. This ensures `DecompositionErrorCard` can read `masterTask.resultSummary`.
- (c) In `handleOrchEvent.ts`, add handler for `decomposition_failed` event that logs the error and optionally stores it where the error card can find it.

**Unit 3 — Frontend type alignment (R002):**
Update the `OrchEvent` type union in `handleOrchEvent.ts` to include `dag_id` on `task_completed`/`task_failed` events. Add `decomposition_failed` event type. Note: the actual FIFO→dag_id matching fix is S03 (D003), but the type should be correct now.

**Unit 4 — Tests:**
- Rust: Add tests for `SubTaskDef` deserialization with `id` field present and absent, `parse_decomposition_json` with LLM-style IDs, DAG construction using preserved IDs.
- Verify 353+ existing Rust tests still pass.
- Frontend: verify error card displays actual error text (manual verification via GUI).

### Verification Approach

**Contract verification (automated):**
```bash
cd src-tauri && cargo test
```
Must pass 353+ tests including new ones for `SubTaskDef.id` parsing. Key new tests:
- `SubTaskDef` with `id` field present deserializes correctly
- `SubTaskDef` with `id` field absent defaults to `None` (backward compat)
- `parse_decomposition_json` preserves task IDs from LLM output
- DAG construction uses LLM IDs when present, falls back to positional

**Integration verification (manual):**
Run `cargo tauri dev`, submit a task that triggers orchestration. Verify:
1. Decomposition produces sub-tasks with IDs visible in orchestration logs
2. Intentionally malformed input shows actual error in DecompositionErrorCard (not generic "The master agent failed...")
3. Auth errors (e.g., invalid API key) show specific message in the error card

**Observable behaviors:**
- Before fix: DecompositionErrorCard shows "The master agent failed to decompose the task into sub-tasks" for all failures
- After fix: Error card shows specific backend error (e.g., "claude is not logged in. Please run 'claude /login' in your terminal first." or "Failed to parse decomposition JSON after 2 attempts")

## Constraints

- `SubTaskDef` has `#[derive(Type)]` from Specta — adding a field regenerates TypeScript bindings. Must run `cargo tauri dev` or the binding generation step after changing the struct to update `src/bindings.ts`.
- The `DecompositionResult` struct is returned from `dispatch_orchestrated_task` as part of `OrchestrationPlan` — changing `SubTaskDef` changes the IPC contract. Using `Option<String>` with `#[serde(default)]` ensures backward compatibility.
- 353 existing Rust tests must continue passing. The `id` field is additive (optional), so no existing test should break.

## Common Pitfalls

- **Specta binding regeneration** — After adding `id: Option<String>` to `SubTaskDef`, the TypeScript bindings in `src/bindings.ts` auto-regenerate. If the planner forgets this, the frontend will see a type mismatch. The build step handles this automatically via `cargo tauri dev`.
- **DAG ID mismatch with frontend** — The frontend's `dagToFrontendId` map uses the same `t1/t2/t3` synthetic IDs (assigned in `handleOrchEvent.ts` at `dagToFrontendId.set(\`t${dagCounter + 1}\`, subId)`). If we change the backend to emit LLM-provided IDs in events like `task_completed`, the frontend map must key on those same IDs. The simplest approach: always emit both `dag_id` (for backend use) and the positional `dag_index` in events, OR ensure the backend normalizes IDs to `t1/t2/t3` format even when preserving LLM IDs for `depends_on` resolution. The safest path is to build the DAG from LLM IDs internally but continue emitting `t1/t2/t3` in events to frontend.
- **Silent fallback masking errors** — The current single-task fallback (line ~910) is intentional for simple/conversational prompts. Removing it entirely would break casual use. The fix should emit a warning event but still fall back, so the user sees "Decomposition failed, running as single task" rather than a hard error.

## Open Risks

- **LLM ID format variability** — LLMs may return IDs as `"t1"`, `"task_1"`, `"1"`, `"setup"`, or even omit them entirely. The `Option<String>` with fallback-to-positional handles all cases, but `depends_on` references like `["setup"]` will only work if the corresponding task also has `id: "setup"`. If one task has an ID and its dependency doesn't, the DAG will error with `MissingDependency`. The fallback to single-wave execution (already present at line 1078) handles this gracefully.
- **Frontend `activePlan` race condition** — D004 notes that `activePlan` is set after the promise resolves but needed during `awaiting_approval`. This is S03's responsibility but affects S01's error card: if decomposition fails during auto-approve because `activePlan` is null, the error won't show the plan context. S01 should not try to fix this — it's explicitly scoped to S03.
