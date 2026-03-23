# S02 Summary: Worktree Isolation & Parallel Workers

**Status:** Complete
**Tasks:** T01 (infrastructure), T02 (tests) — both passed
**Duration:** ~40m total
**Requirements validated:** R003 (worktree isolation), R004 (parallel same-type workers), R011 (retry/fallback)

## What This Slice Delivered

Workers dispatched during orchestrated execution now run in isolated git worktrees instead of the main project directory, and multiple workers of the same agent type can execute in parallel without "already running" errors.

### Core Changes

1. **`dispatch_task_internal` (router.rs)** — A `pub(crate)` internal dispatch function with `skip_tool_slot: bool` parameter. When `true` (used by orchestrator), tool slot reservation is bypassed so two Claude workers can coexist. The existing `dispatch_task` Tauri command delegates to it with `skip_tool_slot: false`, preserving the existing API.

2. **`spawn_with_env_internal` (process/manager.rs)** — Internal variant of `spawn_with_env` that accepts `&AppState` directly instead of `tauri::State<'_, AppState>`. Necessary because `tauri::State` can't be constructed from `&AppState`, and modifying the 3 spawn functions would break their Tauri command signatures.

3. **WorktreeManager wired into orchestrator Phase 2** — Before the wave dispatch loop, a `WorktreeManager` is instantiated. For each DAG task, `create_for_task(dag_id)` creates an isolated worktree, the entry is stored in `plan.worktree_entries`, and the worktree path is passed as `cwd` to `dispatch_task_internal` instead of raw `project_dir`.

4. **`worktree_entries` on OrchestrationPlan** — `HashMap<String, WorktreeEntry>` with `#[serde(default)]` for backward compatibility. Maps `dag_id → WorktreeEntry`. This is the contract surface that S04 consumes for review diffs and merge.

5. **Cleanup on both paths** — On orchestration completion (success or failure), all worktree entries are iterated and `remove_worktree()` is called. Cleanup errors are logged but non-fatal. Emits `@@orch::worktrees_cleaned` event with count.

6. **Test coverage** — 8 new tests across router.rs and orchestrator.rs validating R003, R004, and R011. All 86 tests across the 4 affected modules pass with zero regressions (54 orchestrator, 24 worktree, 6 process manager, 2 router).

## Boundary Contract for Downstream Slices

### S04 consumes:
- `OrchestrationPlan.worktree_entries: HashMap<String, WorktreeEntry>` — each entry has `task_id`, `worktree_name`, `branch_name`, `path`, `created_at`
- `dispatch_task_internal` with `skip_tool_slot: true` — all 3 dispatch calls in Phase 2 (initial, retry, fallback) use this
- Cleanup wired on both success/failure — S04 may need to delay cleanup until after merge

### S03 consumes:
- Nothing directly from S02 — S03 is frontend state sync. But the new `@@orch::worktree_created` events should be handled in `handleOrchEvent.ts` if the frontend needs worktree info during execution.

## Observability Surfaces

| Event | Payload | When |
|-------|---------|------|
| `@@orch::worktree_created` | `{ dag_id, worktree_path, branch_name }` | After each worktree creation in Phase 2 |
| `@@orch::dispatch_error` | `{ dag_id, error }` (git2 error string) | When worktree creation fails |
| `@@orch::worktrees_cleaned` | `{ count }` | On orchestration completion (both paths) |

## Patterns Established

- **Internal dispatch bypass**: `pub(crate)` function with `skip_tool_slot` param; Tauri command delegates with `false`. Use this pattern when orchestrator needs different behavior than manual dispatch.
- **`spawn_with_env_internal` for non-Tauri callers**: When code needs to call process spawning from `&AppState` without `tauri::State`, use the `_internal` variant.
- **`#[serde(default)]` for backward-compatible plan fields**: New HashMap fields on `OrchestrationPlan` use `serde(default)` so deserialization of old plans doesn't break. Required adding `Deserialize` to `WorktreeEntry`.

## Key Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D006 | How to bypass tauri::State for orchestrated dispatch | Added `spawn_with_env_internal` (pub(crate)) accepting `&AppState` | Avoids modifying 3 spawn function signatures that are Tauri command exports |
| D001 | Tool slot concurrency model | `skip_tool_slot` bypass for orchestrated workers, retain per-agent-name slot for manual dispatch | Orchestrator needs N parallel workers; manual dispatch keeps max-1 safety |

## Files Modified

- `src-tauri/src/commands/router.rs` — `dispatch_task_internal` + 2 tests
- `src-tauri/src/commands/orchestrator.rs` — WorktreeManager wiring, cleanup, events + 6 tests
- `src-tauri/src/router/orchestrator.rs` — `worktree_entries` field on `OrchestrationPlan`
- `src-tauri/src/process/manager.rs` — `spawn_with_env_internal`
- `src-tauri/src/worktree/models.rs` — `Deserialize` derive on `WorktreeEntry`

## What the Next Slice Should Know

- **S03**: The new `@@orch::worktree_created` and `@@orch::dispatch_error` events are emitted but not yet handled in `handleOrchEvent.ts`. The TypeScript `OrchEvent` union type needs updating (it's manual — see KNOWLEDGE.md).
- **S04**: `worktree_entries` is the source of truth for per-worker diffs. Each entry's `path` is the filesystem worktree, `branch_name` is the git branch. Call `WorktreeManager::diff_worktree()` on each entry to get file changes. **Important**: cleanup currently runs immediately on completion — S04 may need to defer cleanup until after the user has reviewed and merged.
- **S05**: All worktree plumbing is in place. Runtime UAT needs a real multi-step task dispatched through the GUI to prove worktrees are created and workers execute in them.
