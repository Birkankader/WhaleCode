---
estimated_steps: 5
estimated_files: 3
skills_used: []
---

# T01: Add id field to SubTaskDef and fix DAG construction to use LLM-provided IDs

**Slice:** S01 — Decomposition & Error Pipeline
**Milestone:** M002

## Description

The LLM's decomposition prompt asks for `"id": "t1"` per task, but `SubTaskDef` in `router/orchestrator.rs` has no `id` field — serde silently drops it. Downstream, the orchestrator generates its own `t1, t2...` from array index, which breaks when `depends_on` references use the LLM's IDs in a different order. This task adds the `id` field, fixes DAG construction to prefer LLM-provided IDs, includes `dag_id` in `task_assigned` events, and enriches `phase_changed` events with `plan_id`/`master_agent` (S03 boundary contract).

## Steps

1. **Add `id` field to `SubTaskDef`** in `src-tauri/src/router/orchestrator.rs` (line 68):
   - Add `#[serde(default)] pub id: Option<String>` to the struct
   - The struct derives `specta::Type`, `Serialize`, `Deserialize` — `Option<String>` is safe for all
   - Do NOT touch `DecompositionResult`, `parse_decomposition_json`, or any parsing code

2. **Fix DAG construction** in `src-tauri/src/commands/orchestrator.rs` (~line 1052):
   - Check if ALL tasks in `decomposition.tasks` have `id.is_some()`. If yes, use LLM IDs. If any is `None`, fall back to index-based `format!("t{}", i + 1)` for ALL tasks (avoids partial-ID chaos).
   - Replace:
     ```rust
     let dag_nodes: Vec<DagNode> = decomposition.tasks.iter().enumerate().map(|(i, def)| {
         DagNode {
             id: format!("t{}", i + 1),
             depends_on: def.depends_on.clone(),
         }
     }).collect();
     ```
   - With logic that checks `all_have_ids` first, then maps accordingly.

3. **Add `dag_id` to `task_assigned` emit** (~line 931):
   - The emit currently sends `agent`, `description`, `prompt`, `depends_on`
   - Add `"dag_id": sub_def.id.as_deref().unwrap_or("")` to the JSON payload
   - The frontend `handleOrchEvent.ts` type already declares `dag_id?: string` on `task_assigned` events (line 8 area), so no frontend type change needed

4. **Enrich `phase_changed` events during decomposing** (~lines 715 and 749):
   - Add `"plan_id": plan.task_id` and `"master_agent": config.master_agent` to both `phase_changed` emits in the decomposing phase
   - The frontend type already has `plan_id?: string` and `master_agent?: string` on `phase_changed` (line 8 of handleOrchEvent.ts)
   - The handler at line 49-53 of handleOrchEvent.ts already reads `ev.plan_id` to set `activePlan` — this just makes it fire

5. **Write unit tests** in `src-tauri/src/commands/orchestrator_test.rs`:
   - Test: deserialize SubTaskDef JSON with `id` field present → `id == Some("t1")`
   - Test: deserialize SubTaskDef JSON without `id` field → `id == None` (serde default)
   - Test: deserialize full DecompositionResult with `id` fields → all IDs preserved
   - Also update the existing fallback SubTaskDef construction (~line 900) to include `id: None` since the struct now has the field

## Must-Haves

- [ ] `SubTaskDef` has `pub id: Option<String>` with `#[serde(default)]`
- [ ] DAG uses LLM IDs when all tasks have them, index-based fallback when any is missing
- [ ] `task_assigned` events include `dag_id` from SubTaskDef.id
- [ ] `phase_changed` events during decomposing include `plan_id` and `master_agent`
- [ ] Fallback SubTaskDef construction (~line 900) includes `id: None`
- [ ] All existing 388+ tests still pass + new tests for id field
- [ ] `cargo build` succeeds (specta type regeneration)

## Verification

- `cd src-tauri && cargo test --lib` — all tests pass (existing + new)
- `cd src-tauri && cargo build` — compiles successfully (specta generates updated TS types)
- `rg 'pub id: Option<String>' src-tauri/src/router/orchestrator.rs` — shows 1 match
- `rg '"dag_id"' src-tauri/src/commands/orchestrator.rs` — shows match in task_assigned emit
- `rg '"plan_id".*plan.task_id' src-tauri/src/commands/orchestrator.rs` — shows matches in phase_changed emits

## Inputs

- `src-tauri/src/router/orchestrator.rs` — SubTaskDef struct definition (line 68)
- `src-tauri/src/commands/orchestrator.rs` — DAG construction (~line 1052), task_assigned emit (~line 931), phase_changed emits (~lines 715, 749), fallback SubTaskDef (~line 900)
- `src-tauri/src/commands/orchestrator_test.rs` — existing test patterns for DecompositionResult parsing

## Expected Output

- `src-tauri/src/router/orchestrator.rs` — SubTaskDef with `id: Option<String>` field added
- `src-tauri/src/commands/orchestrator.rs` — DAG construction uses LLM IDs, task_assigned includes dag_id, phase_changed enriched
- `src-tauri/src/commands/orchestrator_test.rs` — new unit tests for SubTaskDef.id deserialization and all-have-ids logic

## Observability Impact

- **Signals changed**: `@@orch::phase_changed` during decomposing now carries `plan_id` (string) and `master_agent` (string); `@@orch::task_assigned` now carries `dag_id` (string, empty if no LLM id)
- **How to inspect**: `rg '"plan_id"\|"dag_id"' src-tauri/src/commands/orchestrator.rs` to verify enriched event payloads; frontend `handleOrchEvent.ts` reads `ev.plan_id` to call `setActivePlan` early
- **Failure visibility**: When LLM provides partial IDs (some tasks with id, some without), DAG falls back to index-based IDs silently — `debug!()` trace in DAG construction logs the fallback decision
- **What a future agent checks**: Run `cargo test --lib subtaskdef` to verify SubTaskDef.id deserialization; grep for `all_have_ids` to inspect the fallback logic
