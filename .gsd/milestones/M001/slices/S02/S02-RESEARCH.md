# S02: Worktree Isolation & Parallel Workers — Research

**Date:** 2026-03-20

## Summary

S02 addresses two requirements: R003 (each worker runs in an isolated git worktree) and R004 (multiple same-type workers run simultaneously). Both have clear solutions using existing, well-tested infrastructure.

**Worktree isolation (R003):** `WorktreeManager` in `src-tauri/src/worktree/manager.rs` is a complete, tested API (`create_for_task`, `remove_worktree`, `cleanup_stale_worktrees`) with 7 passing tests — but it is never called from the orchestrator. The orchestrator's `dispatch_orchestrated_task` dispatches workers via `dispatch_task()` which passes `project_dir` as-is to `spawn_claude_task`/`spawn_gemini_task`/`spawn_codex_task`. Each of those calls `adapter.build_command(prompt, cwd, api_key)` with `cwd = project_dir`. The fix: before dispatching each worker, call `WorktreeManager::create_for_task(dag_id)`, then pass `worktree_entry.path` as the `cwd` instead of `project_dir`.

**Parallel same-type workers (R004):** `acquire_tool_slot` in `process/manager.rs` enforces max 1 running process per agent name globally — scanning all processes for matching `tool_name`. `dispatch_task` in `commands/router.rs` calls this before every spawn. For orchestrated workers, this means two Claude workers can't run simultaneously. Decision D001 already chose the fix: replace per-agent-name enforcement with per-task-id tracking for orchestrated workers. The simplest approach: bypass `acquire_tool_slot` for orchestrated workers entirely (they're already managed by the orchestrator's wave scheduler), or add an `orchestrated: bool` parameter that skips the check.

**Rate limit retry (R011):** Already implemented in `dispatch_orchestrated_task`. The retry loop with `should_retry`, `retry_delay_ms`, and `select_fallback_agent` exists and handles rate limits with 30s delay + exponential backoff. R011 needs validation criteria, not new code.

## Recommendation

**Approach:** Wire existing `WorktreeManager` into the orchestrator dispatch path and bypass tool slot enforcement for orchestrated workers. Both changes are surgical — they modify the orchestrator command file and the router dispatch, not the underlying infrastructure.

**Why this approach:** The worktree and diff infrastructure already works (22 tests pass). The tool slot is the right abstraction for single-dispatch mode (preventing double-dispatches from the UI), but wrong for orchestrated mode where the orchestrator manages concurrency via DAG waves. Bypass is cleaner than refactoring the tool slot system because it leaves single-dispatch safety intact.

## Implementation Landscape

### Key Files

- `src-tauri/src/commands/orchestrator.rs` (~2258 lines) — The main orchestration command. Phase 2 dispatches workers via `super::router::dispatch_task()` with `project_dir`. This is where worktree creation must be wired in (before each dispatch) and worktree tracking must be stored. Also where `WorktreeEntry` per-worker must be collected for S04's merge pipeline.

- `src-tauri/src/commands/router.rs` (~185 lines) — Contains `dispatch_task()` which calls `acquire_tool_slot()` before spawning. For orchestrated workers, this blocks parallel same-type agents. Needs a way to bypass the tool slot for orchestrated dispatches.

- `src-tauri/src/process/manager.rs` (~320 lines) — Contains `acquire_tool_slot()` and `release_tool_slot()`. The bottleneck function. No changes needed here if bypass is done at the call site.

- `src-tauri/src/worktree/manager.rs` (~185 lines) — `WorktreeManager::create_for_task(task_id)` returns `WorktreeEntry` with `path`, `branch_name`, `worktree_name`. Already handles duplicate cleanup and stale recovery. 7 tests pass.

- `src-tauri/src/worktree/models.rs` — `WorktreeEntry` struct with `task_id`, `worktree_name`, `branch_name`, `path`, `created_at`. Already derives `Serialize` + `Type` (Specta).

- `src-tauri/src/router/orchestrator.rs` (~280 lines) — `OrchestrationPlan` struct needs a new field for worktree tracking: `HashMap<String, WorktreeEntry>` mapping task DAG IDs to their worktrees. This is consumed by S04's merge pipeline.

- `src-tauri/src/commands/claude.rs` / `gemini.rs` / `codex.rs` — Per-agent spawn functions. They receive `project_dir` and use it as `cwd`. Currently, the orchestrator dispatches via `dispatch_task()` in `router.rs`. To pass a different `cwd`, either: (a) modify `dispatch_task()` to accept an optional `cwd_override`, or (b) bypass `dispatch_task()` in the orchestrator and call the adapter's spawn function directly.

### Build Order

**Task 1 (Backend - Tool Slot Bypass):** Modify `dispatch_task` in `commands/router.rs` to accept an optional `skip_tool_slot: bool` parameter (or add a parallel function `dispatch_task_orchestrated`). When true, skip the `acquire_tool_slot`/`release_tool_slot` calls. This unblocks parallel execution immediately.

- Why first: Without this, even if worktrees work, two Claude workers can't run at the same time, which blocks all integration testing.
- Verification: Unit test that two processes with `tool_name = "claude"` can coexist in `AppState.processes` without hitting the slot error.

**Task 2 (Backend - Worktree Integration):** In `dispatch_orchestrated_task` Phase 2, before each worker dispatch:
1. Create `WorktreeManager::new(project_dir)` (once, outside the wave loop).
2. For each DAG task, call `manager.create_for_task(dag_id)` to get a `WorktreeEntry`.
3. Pass `worktree_entry.path.to_str()` as the `project_dir` argument to `dispatch_task()` instead of the original `project_dir`.
4. Store the mapping `dag_id -> WorktreeEntry` in the plan for S04.
5. Add a `worktree_entries` field to `OrchestrationPlan`.
6. After orchestration completes (success or failure), call `manager.cleanup_stale_worktrees()` or selectively remove each worktree.

- Why second: Depends on T1 for parallel execution. This is the core isolation change.
- Verification: `cargo test --lib worktree` (existing 22 tests), plus new test that verifies `WorktreeEntry.path` differs from `project_dir`, plus structural check that `dispatch_task` receives the worktree path.

**Task 3 (Verification & Cleanup):** Add worktree cleanup to the orchestration completion paths (both success and failure in `dispatch_orchestrated_task`). Add unit tests for the new orchestrator worktree flow. Validate R011 by mapping retry/fallback test coverage to the requirement.

- Verification: All 48 orchestrator tests + 22 worktree tests still pass, plus new integration tests.

### Verification Approach

1. `cargo test --lib commands::orchestrator` — Must pass all existing 48 tests + new tests for worktree integration.
2. `cargo test --lib worktree` — Must pass all 22 existing tests.
3. `cargo test --lib process::manager` — Must pass all 5 existing tests.
4. Structural verification via `grep`:
   - `grep -c "create_for_task" src-tauri/src/commands/orchestrator.rs` — must return ≥ 1 (worktree creation is wired in).
   - `grep -c "worktree_entries" src-tauri/src/router/orchestrator.rs` — must return ≥ 1 (tracking field exists on plan).
   - The `dispatch_task` call in the orchestrator's Phase 2 loop must pass a worktree path, not `project_dir`.
5. R004 validation: Test that two `ProcessEntry` objects with `tool_name = "claude"` can be in `AppState.processes` simultaneously when using the orchestrated dispatch path.

## Constraints

- `WorktreeManager` uses the `git2` crate — no shelling out to git CLI. All worktree operations are in-process.
- `WorktreeEntry.path` is a `PathBuf`. The spawn functions accept `cwd: &str`. Conversion via `.to_str()` can fail for non-UTF8 paths (unlikely on macOS but must handle gracefully).
- `dispatch_task` is a `#[tauri::command]` with `#[specta::specta]` — changing its signature regenerates TypeScript bindings. Adding a new function avoids breaking the frontend contract.
- `OrchestrationPlan` derives `Serialize, Deserialize, Type` — any new field must also be serializable. `WorktreeEntry` already derives these.
- The `reserved_tools: HashSet<String>` in `AppStateInner` is separate from the running process check in `acquire_tool_slot`. Both must be bypassed for orchestrated workers.

## Common Pitfalls

- **Worktree base dir resolution in non-standard paths** — `WorktreeManager.worktree_base_dir()` calls `self.repo_path.canonicalize()` then goes to parent. If `project_dir` is a symlink or contains `~`, `canonicalize` may resolve to a different directory than expected. The `expand_tilde` function in `commands/mod.rs` handles `~` but should be called before passing to `WorktreeManager::new()`.

- **Tool slot bypass leaks into single-dispatch mode** — If the bypass logic is too broad (e.g., always skip), single-dispatch mode loses its protection against double-dispatches from the UI. The bypass must only apply when dispatching from the orchestrator's Phase 2 loop.

- **Worktree cleanup on partial failure** — If orchestration fails mid-wave, some worktrees will exist and others won't. Cleanup must iterate the tracking map, not assume all tasks have worktrees. `cleanup_stale_worktrees()` handles this gracefully by scanning for `whalecode-` prefixed worktrees.

- **Specta binding regeneration** — Adding a `worktree_entries` field to `OrchestrationPlan` changes the TypeScript bindings generated on `cargo build`. S03/S04 should be aware that their TypeScript types may need updating after S02's changes land. However, since `worktree_entries` is an addition (not a breaking change), existing frontend code continues to compile.

## Open Risks

- **`dispatch_task` is both a Tauri command and called internally** — It's exported as `#[tauri::command]` for direct UI dispatch AND called from `dispatch_orchestrated_task` via `super::router::dispatch_task()`. Adding a bypass parameter to the Tauri command signature changes the frontend API. Safer approach: create an internal-only function that `dispatch_task` delegates to, and call the internal version directly from the orchestrator with different parameters.

- **Worktree branch naming collision with short DAG IDs** — `create_for_task(dag_id)` truncates the ID to 8 chars: `whalecode-{dag_id[..8]}`. DAG IDs like `t1`, `t2` are only 2 chars. Two orchestrations running simultaneously could collide on `whalecode-t1`. The existing duplicate recovery in `create_for_task` handles this (prunes old worktree and re-creates), but concurrent orchestrations would fight over the same worktree name. Mitigation: use a compound key like `{plan_task_id_prefix}-{dag_id}` for the worktree name, or use the `sub_task_id` (UUID) instead of `dag_id`.
