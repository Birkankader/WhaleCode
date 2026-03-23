# S01 — Decomposition & Error Pipeline — Research

**Date:** 2026-03-22
**Depth:** Targeted (known Tauri/Rust/React stack, moderately complex integration across backend and frontend)

## Summary

S01 must fix four concrete gaps that block the decomposition → error display chain end-to-end:

1. **SubTaskDef has no `id` field.** The LLM returns `{"id": "t1", ...}` per the decompose prompt, but `SubTaskDef` in `router/orchestrator.rs` only has `agent`, `prompt`, `description`, `depends_on` — the `id` is silently dropped by serde. Downstream, the orchestrator creates its own `t1, t2...` IDs from array index (line ~1055 of `commands/orchestrator.rs`), which works only if the LLM returns tasks in dependency order. If the LLM returns `{"id": "t3", "depends_on": ["t1"]}` at index 0, the generated ID `t1` won't match the `depends_on` reference. This is the root cause of unreliable DAG scheduling (R005).

2. **`task_assigned` events lack `dag_id`.** The emit at line 931 of `commands/orchestrator.rs` sends agent/description/prompt/depends_on but no ID. The frontend falls back to auto-incrementing a counter (`dagCounter`), which is fragile when events arrive out of order or tasks are retried.

3. **Backend never emits `@@orch::decomposition_failed`.** The frontend handler exists in `handleOrchEvent.ts:259` and the type is declared in the `OrchEvent` union, but no Rust code ever calls `emit_orch(_, "decomposition_failed", _)`. When decomposition fails, errors propagate as `Err(String)` from the IPC command — the frontend catches this in `useOrchestratedDispatch.ts` and sets phase to `'failed'`, but `DecompositionErrorCard` tries to read `masterTask.resultSummary` (which is only set by the `decomposition_failed` handler) or the last error log. The error message shown to the user is often generic because the specific error string from the backend never reaches `resultSummary` (R002).

4. **`humanizeError` is never called in the decomposition path.** The function exists in `lib/humanizeError.ts` with 18 pattern→friendly-message mappings, but `DecompositionErrorCard` displays raw error strings without running them through `humanizeError`. Same gap in `handleOrchEvent.ts` error logging. This means users see internal Rust error strings like "Process xyz not found" instead of friendly messages (R023).

The `phase_changed` event at decomposition start also omits `plan_id` and `master_agent`, which means the frontend can't set `activePlan` early — this is a boundary contract for S03 but must be fixed here.

## Recommendation

Fix in this order: (1) Add `id` to `SubTaskDef` and preserve it through parsing, (2) include `dag_id` in `task_assigned` events, (3) emit `decomposition_failed` event from backend when parsing fails, (4) wire `humanizeError` into the error display chain. These are surgical changes — each touching 1-3 files — that can be verified independently with unit tests before integration testing.

Do NOT refactor the 5-strategy JSON parser or the NDJSON extraction pipeline — they are well-structured and cover the known agent output formats. The parser works; the problem is that parsed data loses the `id` field, and errors don't reach the UI.

## Implementation Landscape

### Key Files

- **`src-tauri/src/router/orchestrator.rs`** (508 lines) — Defines `SubTaskDef`, `DecompositionResult`, `Orchestrator` methods. The `SubTaskDef` struct (line 68) needs an `id: Option<String>` field with `#[serde(default)]`. `build_decompose_prompt` (line 111) already asks the LLM for `"id": "t1"` — the prompt is correct, just the struct drops the field.

- **`src-tauri/src/commands/orchestrator.rs`** (2285 lines) — Main orchestration flow.
  - `parse_decomposition_from_output()` (line ~210) — Extracts JSON from agent output. Calls `parse_decomposition_json()` which deserializes into `DecompositionResult`. Once `SubTaskDef.id` exists, it'll be preserved automatically through the 5-strategy parser — no parser changes needed.
  - `normalize_decomposition_agents()` (line ~314) — Normalizes agent names. Already works, no changes needed.
  - Line ~929: `task_assigned` emit — needs to include `dag_id` from `SubTaskDef.id` or auto-generated index.
  - Line ~1055: DAG node construction — currently uses `format!("t{}", i + 1)` as node ID. Should use `SubTaskDef.id` when present, falling back to index-based ID.
  - Lines ~809-919: Decomposition failure path — when `parse_decomposition_from_output` returns `None` after retry, need to emit `decomposition_failed` event before the fallback single-task path (or when truly failing).
  - Lines ~729, ~754: `phase_changed` emits during decomposing — need to include `plan_id` and `master_agent` for S03 boundary contract.

- **`src/hooks/orchestration/handleOrchEvent.ts`** (270 lines) — Frontend structured event handler. The `decomposition_failed` case (line 259) correctly updates `resultSummary` on the master task — this handler works, it just never fires because the backend doesn't emit the event. The `task_assigned` case (line 87) should log a warning when `dag_id` is missing (it currently falls back silently).

- **`src/components/orchestration/DecompositionErrorCard.tsx`** (310 lines) — Error display UI. The `errorMessage` derivation (line ~71) reads `masterTask?.resultSummary || orchestrationLogs.filter(l => l.level === 'error').pop()?.message || 'The master agent failed to...'`. Needs to pipe the message through `humanizeError()` before display. The expandable "Orchestration Logs" section already shows raw detail — the main error text should be the humanized version with raw text preserved in the expandable section (R023).

- **`src/lib/humanizeError.ts`** (54 lines) — Pattern-based error humanizer. Already has patterns for: process not found, spawn failed, JSON parse failure, auth errors, rate limits, worktree failures, timeout. Needs 1-2 additions for decomposition-specific patterns (e.g., "Decomposition parse failed" → "The AI couldn't structure the task breakdown. Try simplifying your prompt or switching the master agent.").

- **`src/hooks/orchestration/useOrchestratedDispatch.ts`** (168 lines) — Channel handler. Currently catches the backend `Err()` at line ~155 and throws. After the backend emits `decomposition_failed`, the real-time event handler will set `resultSummary` before the promise rejects, so the error card has content. No changes needed here.

- **`src/stores/taskStore.ts`** (210 lines) — Zustand store. Already has `updateTaskResult()` and `addOrchestrationLog()`. No structural changes needed.

### Build Order

**Task 1: Add `id` field to `SubTaskDef` + fix DAG construction** (Rust-only, backend)
- Add `pub id: Option<String>` with `#[serde(default)]` to `SubTaskDef`
- In `commands/orchestrator.rs` DAG construction (~line 1055), use `sub_def.id.clone().unwrap_or_else(|| format!("t{}", i + 1))` as the `DagNode.id`
- In `task_assigned` emit (~line 931), include `"dag_id": sub_def.id.as_deref().unwrap_or("?")`
- Write unit tests: deserialize JSON with `id` field present and absent, verify DAG uses LLM IDs when available
- **Why first:** This is the structural data model fix that R005 depends on. Everything else builds on having correct IDs.

**Task 2: Emit `decomposition_failed` from backend** (Rust, 1 file)
- When decomposition parsing fails (both initial and retry), emit `@@orch::decomposition_failed` with the error detail before falling back to single-task mode or returning Err
- Include `plan_id` and `master_agent` in `phase_changed` events during decomposing phase
- Specifically: after line ~836 when retry also fails, before the fallback: `emit_orch(&on_event, "decomposition_failed", json!({"error": "...detail..."}))`
- Also when the function returns `Err()` for auth errors, timeouts: emit `decomposition_failed` first
- **Why second:** Unblocks error visibility on the frontend (R002). The handler already works.

**Task 3: Wire `humanizeError` into error display** (TypeScript, 2-3 files)
- In `DecompositionErrorCard.tsx`: import and apply `humanizeError(errorMessage)` for the displayed error text. Keep raw message in the expandable logs section.
- In `handleOrchEvent.ts`: wrap error messages in `humanizeError()` when logging at level `'error'`
- Add 2-3 decomposition-specific patterns to `humanizeError.ts` (e.g., parse failure, fallback single-task)
- **Why third:** Makes errors user-friendly (R023). Depends on errors actually reaching the UI (Task 2).

**Task 4: Integration verification** (Testing)
- Rust unit tests for `SubTaskDef` with `id` field (deserialization, DAG construction with LLM IDs vs fallback)
- Verify existing 50+ orchestrator tests still pass
- TypeScript compilation check (`npx tsc --noEmit`)
- Manual or automated test: trigger a decomposition failure (e.g., invalid agent name) and verify the error card shows a humanized message with expandable raw detail

### Verification Approach

**Contract verification (automated):**
- `cargo test -p whalecode-app` — All existing tests pass + new tests for SubTaskDef.id parsing
- New test: deserialize `{"tasks":[{"id":"t1","agent":"claude","prompt":"...","description":"...","depends_on":[]}]}` and verify `result.tasks[0].id == Some("t1")`
- New test: deserialize without `id` field and verify `result.tasks[0].id == None`
- New test: DAG construction with LLM-provided IDs respects `depends_on` references
- `npx tsc --noEmit` — TypeScript compiles with zero errors
- `rg "emit_orch.*decomposition_failed" src-tauri/src/` returns at least one match (wiring check)
- `rg "humanizeError" src/components/orchestration/DecompositionErrorCard.tsx` returns a match (wiring check)

**Integration verification (manual):**
- Launch WhaleCode with at least one agent CLI installed
- Submit a task that requires decomposition (e.g., "Refactor the auth module and add rate limiting")
- Verify: sub-tasks appear with correct agent assignments
- Force a decomposition failure (e.g., disconnect network, use invalid API key) and verify:
  - DecompositionErrorCard appears
  - Error message is user-friendly (not raw Rust string)
  - Expandable "Orchestration Logs" section shows technical detail
  - Retry/Switch Agent buttons work

## Constraints

- `SubTaskDef` derives `specta::Type` for Tauri IPC type generation — adding `id: Option<String>` is safe since `Option` maps to TypeScript `string | null` and specta handles it
- The 5-strategy decomposition parser (`parse_decomposition_json`) must NOT be modified — it works correctly for all agent types. Only the struct it deserializes into changes.
- `acquire_tool_slot` per-agent-name blocking is S02 scope — do NOT change it in S01
- The `task_assigned` event format change must be backward-compatible: frontend already handles missing `dag_id` via fallback

## Common Pitfalls

- **Breaking specta/IPC type generation** — After adding `id: Option<String>` to `SubTaskDef`, run `cargo build` to regenerate TypeScript bindings. The frontend `approve_orchestration` call sends `modified_tasks: SubTaskDef[]` — the generated type must include the new `id` field (optional, so no breaking change).
- **DAG ID mismatch** — If the LLM returns IDs like `"task_1"` instead of `"t1"`, the `depends_on: ["t1"]` references won't match. The normalize step should either use LLM IDs as-is (they'll match if the LLM is consistent) or strip them entirely and use index-based IDs. Recommendation: use LLM IDs when ALL tasks have IDs, fall back to index-based when any task is missing an ID. This avoids partial-ID chaos.
- **Double error display** — If backend emits `decomposition_failed` AND returns `Err()`, the frontend could show the error twice (once via event handler, once via promise rejection). Ensure the `Err()` path sets phase to `'failed'` only if the event handler hasn't already done so.

## Open Risks

- The `decompose_prompt` instructs the LLM to return `"id": "t1"` but real agents may return other ID formats (`"task-1"`, `"step_a"`, etc.) or omit IDs entirely. The fallback to index-based IDs handles this, but `depends_on` references using non-matching IDs will cause `DagError::MissingDependency`. The mitigation is: validate that all `depends_on` references exist in the ID set before building the DAG, and fall back to single-wave execution if validation fails (already handled by the `topological_waves` error path at line ~1065).
- Whether `approve_decomposition` (line ~1930) and `approve_orchestration` (line ~1691) are both used or if one is dead code — they have overlapping signatures and both modify plan phase to `Executing`. The approval flow in `TaskApprovalView` calls `commands.approveOrchestration`, while `approve_decomposition` appears to be an older path. Need to verify during implementation that only one approval path is active.
