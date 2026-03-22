---
id: T01
parent: S01
milestone: M001
provides:
  - SubTaskDef.id field for LLM-provided task ID preservation
  - DAG construction using LLM IDs with positional fallback
  - decomposition_failed event emission on parse failure
key_files:
  - src-tauri/src/router/orchestrator.rs
  - src-tauri/src/commands/orchestrator.rs
key_decisions:
  - id field is Option<String> with #[serde(default)] for backward compatibility
  - decomposition_failed event fires before fallback, preserving graceful recovery
patterns_established:
  - Use def.id.clone().unwrap_or_else(|| format!("t{}", i+1)) for DAG node IDs
observability_surfaces:
  - @@orch::decomposition_failed event with { error: string } payload
duration: 25m
verification_result: passed
completed_at: 2026-03-20
blocker_discovered: false
---

# T01: Add SubTaskDef ID field, wire DAG construction, and emit decomposition_failed event

**Added `id: Option<String>` to SubTaskDef, wired DAG construction to use LLM-provided IDs, and emit decomposition_failed event on parse failure before single-task fallback.**

## What Happened

Made three targeted changes to the orchestration backend:

1. **SubTaskDef.id field** — Added `pub id: Option<String>` with `#[serde(default)]` as the first field of `SubTaskDef` in `router/orchestrator.rs`. This preserves LLM-provided task IDs (e.g., `"setup"`, `"auth"`) through deserialization. The `#[derive(Type)]` from Specta will auto-regenerate TypeScript bindings on next build.

2. **DAG construction** — Changed `commands/orchestrator.rs` line ~1062 to use `def.id.clone().unwrap_or_else(|| format!("t{}", i + 1))` for `DagNode.id`. When the LLM provides IDs like `"setup"` and `"auth"` with `depends_on: ["setup"]`, the DAG now correctly resolves these dependencies instead of breaking because positional IDs don't match.

3. **decomposition_failed event** — Added `emit_orch(&on_event, "decomposition_failed", ...)` in the retry-also-failed `None` match arm, before the fallback decomposition. The existing single-task fallback and `@@orch::info` "Fallback" message are preserved — this adds visibility without changing recovery behavior.

4. **Unit tests** — Added 4 new tests: `test_subtaskdef_deserialize_with_id`, `test_subtaskdef_deserialize_without_id`, `test_parse_decomposition_json_preserves_ids`, and `test_try_parse_decomposition_sub_tasks_preserves_ids`.

Also added `id: None` to the inline `SubTaskDef` struct literal in the fallback construction site (the only place that constructs `SubTaskDef` directly).

## Verification

All 48 orchestrator tests pass (including 4 new ones). Full test suite could not complete within timeout due to compilation scale — the orchestrator module tests verify all changed code paths.

Grep verification checks all pass:
- `pub id: Option<String>` present in `router/orchestrator.rs`
- `decomposition_failed` present in `commands/orchestrator.rs`
- `def.id.clone()` present in `commands/orchestrator.rs`

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `cargo test --lib commands::orchestrator` | 0 | ✅ pass | 7.5s |
| 2 | `grep -q 'pub id: Option<String>' src-tauri/src/router/orchestrator.rs` | 0 | ✅ pass | <1s |
| 3 | `grep -q 'decomposition_failed' src-tauri/src/commands/orchestrator.rs` | 0 | ✅ pass | <1s |
| 4 | `grep -q 'def.id.clone()' src-tauri/src/commands/orchestrator.rs` | 0 | ✅ pass | <1s |
| 5 | `cargo test 2>&1 \| tail -5` (full suite) | — | ⏱️ timeout | >600s |

Slice-level checks (partial — T02 scope items expected to fail):
| # | Check | Verdict | Notes |
|---|-------|---------|-------|
| 1 | SubTaskDef has id field | ✅ pass | |
| 2 | decomposition_failed in backend | ✅ pass | |
| 3 | decomposition_failed in frontend | ❌ expected | T02 scope |
| 4 | updateTaskResult count >= 3 | ❌ expected | T02 scope |
| 5 | dag_id in handleOrchEvent | ✅ pass | Already present |

## Diagnostics

- **Runtime inspection:** After triggering a failed decomposition, check orchestration logs for `@@orch::decomposition_failed` event with `{ error: "..." }` payload.
- **DAG inspection:** Orchestration debug logs show `DagNode` IDs — verify they match LLM-provided IDs when present (e.g., `"setup"` instead of `"t1"`).
- **Backward compatibility:** Existing JSON without `id` field deserializes to `id: None`, and DAG falls back to positional `t{i+1}` IDs.

## Deviations

- Added `id: None` to the inline `SubTaskDef` construction in the fallback block — this was not explicitly called out in the plan but is required for compilation since the struct now has an additional field.

## Known Issues

- Full `cargo test` suite exceeds 600s timeout in this worktree environment. The 48 orchestrator-scoped tests all pass. A full suite run should be validated in a clean build environment or CI before merge.

## Files Created/Modified

- `src-tauri/src/router/orchestrator.rs` — Added `id: Option<String>` field with `#[serde(default)]` to `SubTaskDef` struct
- `src-tauri/src/commands/orchestrator.rs` — Updated DAG construction to use LLM IDs, emitted `decomposition_failed` event on retry failure, added `id: None` to fallback SubTaskDef, added 4 unit tests
