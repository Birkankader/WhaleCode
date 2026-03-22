---
estimated_steps: 4
estimated_files: 1
skills_used: []
---

# T02: Emit decomposition_failed event from backend on all failure paths

**Slice:** S01 — Decomposition & Error Pipeline
**Milestone:** M002

## Description

The frontend handler for `@@orch::decomposition_failed` exists in `handleOrchEvent.ts` (line 259) and correctly updates `masterTask.resultSummary` — but the backend never emits this event. When decomposition fails, users see a generic "The master agent failed to decompose the task" message because the specific error string from the backend never reaches `resultSummary`. This task adds `emit_orch` calls for `decomposition_failed` at every failure path: timeout, auth error, and parse failure (before fallback).

## Steps

1. **Emit on auth error** (~line 810 of `src-tauri/src/commands/orchestrator.rs`):
   - After `detect_auth_error()` returns `Some(auth_error)`, before `return Err(auth_error)`:
   ```rust
   emit_orch(&on_event, "decomposition_failed", serde_json::json!({
       "error": auth_error.clone()
   }));
   ```

2. **Emit on master agent timeout** (~line 803):
   - Before `return Err("Master agent timed out".to_string())`:
   ```rust
   emit_orch(&on_event, "decomposition_failed", serde_json::json!({
       "error": "Master agent timed out during task decomposition"
   }));
   ```

3. **Emit on parse failure fallback** (~line 898, in the `None => { ... }` arm after retry also fails):
   - Before the fallback decomposition creation, emit the event. The fallback still proceeds, but the event lets the frontend know the parse failed:
   ```rust
   emit_orch(&on_event, "decomposition_failed", serde_json::json!({
       "error": "Could not parse decomposition from agent output. Falling back to running the original prompt as a single task."
   }));
   ```
   - IMPORTANT: The fallback path should still proceed (it creates a single-task decomposition). The `decomposition_failed` event informs the frontend but does not block execution. The frontend `decomposition_failed` handler sets `resultSummary` on the master task — this is informational when fallback proceeds.

4. **Guard against double error display**:
   - In the auth/timeout paths that `return Err(...)`, the frontend also catches the promise rejection in `useOrchestratedDispatch.ts`. The event handler will fire first (sets `resultSummary`), then the promise rejection sets phase to `'failed'`. This is the correct order — no code change needed, but verify by reading the useOrchestratedDispatch error handling path.
   - If any additional `Err(...)` return paths exist between the decomposing phase and the approval phase, add `decomposition_failed` emit there too. Use `rg "return Err" src-tauri/src/commands/orchestrator.rs` and check lines 700-950 range.

## Must-Haves

- [ ] `decomposition_failed` emitted on master agent timeout (before Err return)
- [ ] `decomposition_failed` emitted on auth error detection (before Err return)
- [ ] `decomposition_failed` emitted when parse fails after retry (before fallback)
- [ ] Fallback single-task path still works (emit is informational, doesn't block fallback)
- [ ] All existing tests still pass
- [ ] No other `return Err(...)` in the decomposition phase range (lines 700-950) is missing the event

## Verification

- `rg "emit_orch.*decomposition_failed" src-tauri/src/commands/orchestrator.rs` — at least 3 matches (timeout, auth, parse failure)
- `cd src-tauri && cargo test --lib` — all tests pass
- `cd src-tauri && cargo build` — compiles

## Observability Impact

- Signals added: `@@orch::decomposition_failed` event with `{ error: string }` payload emitted on all decomposition failure paths
- How a future agent inspects this: check orchestration logs in frontend for `decomposition_failed` entries; `rg "decomposition_failed" src-tauri/src/commands/orchestrator.rs` to see all emit sites
- Failure state exposed: specific error string (timeout, auth, parse) surfaces via event → handleOrchEvent → masterTask.resultSummary → DecompositionErrorCard

## Inputs

- `src-tauri/src/commands/orchestrator.rs` — decomposition flow lines 700-950, specifically: timeout return (~803), auth error return (~810), parse failure fallback (~898)

## Expected Output

- `src-tauri/src/commands/orchestrator.rs` — `emit_orch` calls for `decomposition_failed` at timeout, auth error, and parse failure paths
