---
estimated_steps: 5
estimated_files: 2
skills_used: []
---

# T01: Add SubTaskDef ID field, wire DAG construction, and emit decomposition_failed event

**Slice:** S01 — Decomposition & Error Pipeline
**Milestone:** M001

## Description

Fix two backend problems in the orchestration pipeline:

1. **SubTaskDef missing `id` field (R001/R005):** The decompose prompt tells the LLM to return `"id": "t1"` with `depends_on: ["t1"]` references, but the `SubTaskDef` struct drops `id` on deserialization. The DAG builder then synthesizes `t1/t2/t3` IDs from array position (`format!("t{}", i+1)` at line ~1062 of `commands/orchestrator.rs`). This works only when the LLM returns tasks in sequential order with `t1/t2/t3` IDs. If it uses different IDs (like `"setup"`, `"auth"`) or reorders tasks, `depends_on` references break and the DAG falls back to a single wave.

2. **Silent fallback masking errors (R002):** When decomposition parse fails after retry, the backend silently falls back to single-task mode (around line ~910 of `commands/orchestrator.rs`) without emitting an event that tells the frontend what happened. The `DecompositionErrorCard` never learns about the failure.

**Important constraints:**
- `SubTaskDef` has `#[derive(Type)]` from Specta — adding a field will regenerate TypeScript bindings in `src/bindings.ts` on next `cargo tauri dev` build. Using `Option<String>` with `#[serde(default)]` ensures backward compatibility.
- The single-task fallback is intentional for simple/conversational prompts — do NOT remove it. Instead, emit a `decomposition_failed` event carrying the actual error text BEFORE creating the fallback task, so the UI can show what happened while still recovering gracefully.
- The DAG builder should use the LLM-provided `id` for internal DAG scheduling (so `depends_on` references resolve correctly), but continue emitting the same `dag_id` format (`t1/t2/t3` based on position) in `task_completed`/`task_failed` events. This avoids breaking the frontend's `dagToFrontendId` map (S03 will handle dag_id-based matching properly).
- 353 existing Rust tests must continue passing. The `id` field is additive (optional), so no existing test should break.

## Steps

1. **Add `id` field to `SubTaskDef`** in `src-tauri/src/router/orchestrator.rs` (around line 68):
   ```rust
   #[serde(default)]
   pub id: Option<String>,
   ```
   Place it as the first field in the struct for clarity. The `#[derive(Type)]` from Specta will auto-generate the TypeScript binding.

2. **Update DAG construction** in `src-tauri/src/commands/orchestrator.rs` (around line 1061-1065). Change the `DagNode` creation to use the LLM-provided ID when present:
   ```rust
   let dag_nodes: Vec<DagNode> = decomposition.tasks.iter().enumerate().map(|(i, def)| {
       DagNode {
           id: def.id.clone().unwrap_or_else(|| format!("t{}", i + 1)),
           depends_on: def.depends_on.clone(),
       }
   }).collect();
   ```
   This ensures that if the LLM returns `{"id": "setup", "depends_on": []}` and `{"id": "auth", "depends_on": ["setup"]}`, the DAG correctly resolves the dependency.

3. **Emit `decomposition_failed` event** in `src-tauri/src/commands/orchestrator.rs`. Find the retry-also-failed block (around line ~910, the `None => {` match arm after "Decomposition retry also failed"). Before the `let fallback_decomposition = ...` line, add:
   ```rust
   emit_orch(&on_event, "decomposition_failed", serde_json::json!({
       "error": "Failed to parse decomposition JSON after 2 attempts. Running original prompt as single task."
   }));
   ```
   Keep the existing fallback behavior intact — this just adds visibility.

4. **Add unit tests** at the bottom of the `#[cfg(test)]` module in `src-tauri/src/commands/orchestrator.rs`:
   - Test `SubTaskDef` deserializes correctly WITH `id` field present
   - Test `SubTaskDef` deserializes correctly WITHOUT `id` field (backward compat, defaults to `None`)
   - Test `parse_decomposition_json` preserves `id` fields from LLM output
   - Test `try_parse_decomposition` with alternative keys (`sub_tasks`) preserves `id` fields

5. **Run full test suite** to verify all 353+ tests pass:
   ```bash
   cd src-tauri && cargo test 2>&1 | tail -20
   ```

## Must-Haves

- [ ] `SubTaskDef` has `pub id: Option<String>` with `#[serde(default)]`
- [ ] DAG construction uses `def.id.clone().unwrap_or_else(|| format!("t{}", i + 1))`
- [ ] Decomposition retry failure emits `@@orch::decomposition_failed` event with error text
- [ ] Unit tests for SubTaskDef with/without `id` field
- [ ] All 353+ existing tests still pass

## Verification

- `cd src-tauri && cargo test 2>&1 | tail -5` — shows "test result: ok" with 353+ tests passed
- `grep -q 'pub id: Option<String>' src-tauri/src/router/orchestrator.rs` — id field exists
- `grep -q 'decomposition_failed' src-tauri/src/commands/orchestrator.rs` — event emitted
- `grep -q 'def.id.clone()' src-tauri/src/commands/orchestrator.rs` — DAG uses LLM IDs

## Inputs

- `src-tauri/src/router/orchestrator.rs` — contains `SubTaskDef` struct definition (line 68)
- `src-tauri/src/commands/orchestrator.rs` — contains DAG construction (line ~1062), decomposition fallback (line ~910), and test module (line ~1950+)

## Expected Output

- `src-tauri/src/router/orchestrator.rs` — modified: `SubTaskDef` has `id: Option<String>` field
- `src-tauri/src/commands/orchestrator.rs` — modified: DAG uses LLM IDs, `decomposition_failed` event emitted, new unit tests added

## Observability Impact

- **New runtime signal:** `@@orch::decomposition_failed` event with `{ error: string }` payload emitted when decomposition JSON parsing fails after two attempts. A future agent can grep logs for `decomposition_failed` to detect parsing failures.
- **DAG correctness inspection:** DAG node IDs now reflect LLM-provided IDs when present (e.g., `"setup"` instead of positional `"t1"`). This makes orchestration logs more readable and dependency resolution debuggable. Check `dag_nodes` in orchestration debug logs to verify ID mapping.
- **Failure visibility:** The `decomposition_failed` event fires before the single-task fallback, so the UI can show what happened without losing the graceful recovery. The existing `@@orch::info` "Fallback: running original prompt as single task" continues to fire after, preserving backward-compatible log streams.
