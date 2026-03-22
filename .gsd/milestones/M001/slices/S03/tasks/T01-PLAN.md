---
estimated_steps: 5
estimated_files: 3
skills_used: []
---

# T01: Enrich backend orchestration events with plan_id, dag_id, and worker_output tagging

**Slice:** S03 — Frontend State Synchronization
**Milestone:** M001

## Description

The frontend needs three pieces of information from backend events that are currently missing:

1. **`plan_id` + `master_agent` in `phase_changed` events** — The frontend needs these to call `setActivePlan()` as soon as orchestration starts, not after the entire promise resolves. Both values are available in scope at every `emit_orch("phase_changed", ...)` call site: `plan.task_id` and `config.master_agent`.

2. **`dag_id` in `task_assigned` events** — Currently `task_assigned` only sends `{agent, description, prompt}`. The frontend builds `dagToFrontendId` using `t${dagCounter+1}` which breaks when LLMs provide custom IDs like `"setup"` or `"auth"`. The DAG ID should be computed the same way as DAG construction: `def.id.clone().unwrap_or_else(|| format!("t{}", i+1))`.

3. **Per-worker stdout tagging via `@@orch::worker_output` events** — Workers share the orchestration channel. Their stdout lines are interleaved with no identity. Add an optional `orch_tag` parameter to `spawn_with_env_core`/`spawn_with_env_internal`. When set, the stdout reader also emits `@@orch::{"type":"worker_output","dag_id":"<tag>","line":"<line>"}` for each line. The orchestrator passes `dag_id` as the tag when dispatching workers.

**Key reference:** The `emit_orch` function is at line ~31 of `orchestrator.rs`. It sends `@@orch::{json}` as a `Stdout` event. The pattern is established — we're just adding fields and a new event type.

**Knowledge from S01:** OrchEvent types are manually maintained in `handleOrchEvent.ts` — T02 will add the corresponding TypeScript types. `SubTaskDef.id` is `Option<String>` with `#[serde(default)]`. DAG construction already uses `def.id.clone().unwrap_or_else(|| format!("t{}", i+1))`.

## Steps

1. **Add `plan_id` and `master_agent` to all `phase_changed` emit_orch calls.** There are ~8 `phase_changed` calls (lines ~664, 698, 973, 989, 1090, 1435, and the single-task-fallback at ~976). Add `"plan_id": plan.task_id` and `"master_agent": config.master_agent` (or `plan.master_agent`) to each JSON payload. The variable names vary slightly by call site — `config.master_agent` is available in the main function, and `plan.master_agent` is always available.

2. **Add `dag_id` to `task_assigned` events.** In the loop at line ~961 (`for sub_def in &decomposition.tasks`), add a counter or use `enumerate` to compute the DAG ID: `let dag_id = sub_def.id.clone().unwrap_or_else(|| format!("t{}", i+1))`. Add `"dag_id": dag_id` to the `task_assigned` JSON payload.

3. **Add optional `orch_tag` parameter to `spawn_with_env_core` and `spawn_with_env_internal`.** In `src-tauri/src/process/manager.rs`: add `orch_tag: Option<String>` parameter to both functions. In `spawn_with_env_core`'s stdout reader task (the `tauri::async_runtime::spawn` block that reads stdout lines), if `orch_tag` is `Some(tag)`, also emit an `@@orch::` worker_output event: `channel.send(OutputEvent::Stdout(format!("@@orch::{{\"type\":\"worker_output\",\"dag_id\":\"{}\",\"line\":{}}}", tag, serde_json::to_string(&line).unwrap_or_default())))`.

4. **Thread `orch_tag` through `dispatch_task_internal`.** In `src-tauri/src/commands/router.rs`: add `orch_tag: Option<String>` parameter to `dispatch_task_internal`. Pass it through to `spawn_with_env_internal`. Update all call sites of `dispatch_task_internal` — in `orchestrator.rs` worker dispatch calls (~line 1152, 1273, 1310), pass `Some(dag_id.clone())`. In the non-orchestrated dispatch path (router.rs `dispatch_task` command), pass `None`.

5. **Add unit test verifying enriched event payloads.** In the orchestrator test module, add a test that constructs a `SubTaskDef` with `id: Some("setup".to_string())` and verifies the expected `dag_id` would be `"setup"`. This complements the existing ID preservation tests from S01.

## Must-Haves

- [ ] All `phase_changed` emit_orch calls include `"plan_id"` and `"master_agent"` fields
- [ ] `task_assigned` emit_orch call includes `"dag_id"` computed from `sub_def.id` with positional fallback
- [ ] `spawn_with_env_core` accepts optional `orch_tag` and emits `@@orch::worker_output` events when set
- [ ] `dispatch_task_internal` passes `orch_tag` through; orchestrator dispatch passes `dag_id`
- [ ] `cargo test --lib commands::orchestrator` passes (all existing + new tests)

## Verification

- `cargo test --lib commands::orchestrator` — all tests pass
- `grep -c '"plan_id"' src-tauri/src/commands/orchestrator.rs` returns >= 5 (at least 5 phase_changed calls include plan_id)
- `grep -q '"dag_id"' src-tauri/src/commands/orchestrator.rs` at the task_assigned call site
- `grep -q 'orch_tag' src-tauri/src/process/manager.rs` — parameter exists
- `grep -q 'orch_tag' src-tauri/src/commands/router.rs` — parameter threaded through dispatch

## Observability Impact

- Signals added: `plan_id` and `master_agent` fields on all `@@orch::phase_changed` events; `dag_id` field on `@@orch::task_assigned` events; new `@@orch::worker_output` event type with `{dag_id, line}` payload
- How a future agent inspects this: `grep -n '@@orch::' src-tauri/src/commands/orchestrator.rs` lists all event sites; `grep 'orch_tag' src-tauri/src/process/manager.rs` confirms stdout tagging
- Failure state exposed: If `orch_tag` is None (non-orchestrated dispatch), no worker_output events are emitted — existing behavior unchanged

## Inputs

- `src-tauri/src/commands/orchestrator.rs` — current emit_orch calls for phase_changed and task_assigned
- `src-tauri/src/process/manager.rs` — spawn_with_env_core and spawn_with_env_internal function signatures
- `src-tauri/src/commands/router.rs` — dispatch_task_internal function signature and call sites

## Expected Output

- `src-tauri/src/commands/orchestrator.rs` — enriched phase_changed and task_assigned events, orch_tag passed in worker dispatch calls
- `src-tauri/src/process/manager.rs` — orch_tag parameter added, worker_output events emitted from stdout reader
- `src-tauri/src/commands/router.rs` — orch_tag parameter threaded through dispatch_task_internal
