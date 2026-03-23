---
id: T02
parent: S04
milestone: M002
provides:
  - Auto-navigate to review view on 'reviewing' phase instead of 'completed'
  - Targeted remove_single_worktree IPC command for discarding individual worktrees
  - removeWorktree method in useWorktree hook
  - Startup worktree cleanup on app mount
  - Zero-changes empty state in DiffReview component
key_files:
  - src/routes/index.tsx
  - src-tauri/src/commands/worktree.rs
  - src-tauri/src/lib.rs
  - src/components/review/DiffReview.tsx
  - src/hooks/useWorktree.ts
  - src/bindings.ts
key_decisions:
  - Targeted worktree removal validates branch_name prefix before deriving worktree name, returning explicit error for invalid branch names
  - Startup cleanup is fire-and-forget — failures silently caught to avoid blocking app startup
patterns_established:
  - remove_single_worktree derives worktree dir name from branch name using same strip-prefix pattern as merge_worktree cleanup
  - Zero-changes conditional rendering in DiffReview — full sidebar+diff vs centered empty state with discard-only action
observability_surfaces:
  - remove_single_worktree error messages include branch name context for debugging
  - useWorktree.removeWorktree surfaces errors via hook error state
  - orchestrationPhase === 'reviewing' triggers navigation (observable via taskStore)
duration: 9m
verification_result: passed
completed_at: 2026-03-23
blocker_discovered: false
---

# T02: Fix navigation timing, add targeted worktree removal, and wire startup cleanup

**Fixed review navigation to trigger on 'reviewing' phase, added remove_single_worktree IPC command with targeted discard in DiffReview, wired startup worktree cleanup, and added zero-changes empty state**

## What Happened

Five independent changes completing the review-merge-cleanup lifecycle:

1. **Navigation timing:** Changed `orchestrationPhase === 'completed'` to `orchestrationPhase === 'reviewing'` in the auto-navigate useEffect in `index.tsx`. The review view now appears when diffs are ready and the review agent starts, not after everything finishes.

2. **`remove_single_worktree` IPC command:** Added in `commands/worktree.rs` with `#[tauri::command]` and `#[specta::specta]` attributes. Takes `project_dir` and `branch_name`, validates the `whalecode/task/` prefix, derives the worktree directory name, and calls `WorktreeManager::remove_worktree()`. Registered in `lib.rs` invoke_handler and re-exported through `commands/mod.rs`. Manually added the TypeScript binding since specta generates bindings at runtime.

3. **Targeted discard in DiffReview:** Replaced `cleanupWorktrees()` calls in `handleDiscard` and the zero-accepted-files path of `handleMerge` with `removeWorktree(branchName)`. Added `removeWorktree` to the `useWorktree` hook — calls `commands.removeSingleWorktree(projectDir, branchName)`, refreshes worktree list on success, surfaces errors via hook state.

4. **Startup cleanup:** Added a `useEffect` in `index.tsx` that calls `commands.cleanupWorktrees(projectDir)` when `projectDir` is set. Fire-and-forget with caught errors to avoid blocking app startup.

5. **Zero-changes empty state:** When `diffReport.files` is empty, DiffReview now shows a centered "This worker made no file changes." message with a "Discard Worktree" button instead of the file list sidebar + diff viewer layout. The bottom merge bar is hidden since there's nothing to merge.

## Verification

- `npx tsc --noEmit` — 0 errors
- `npx vitest run` — 94 tests pass
- `cargo build` — compiles clean (warnings are pre-existing)
- `cargo test --lib -- "router::"` — 54 tests pass
- `cargo test --lib -- "worktree::"` — 22 tests pass
- All wiring checks pass (see evidence table)

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx tsc --noEmit` | 0 | ✅ pass | 3.6s |
| 2 | `npx vitest run` | 0 | ✅ pass | 3.6s |
| 3 | `cargo build` (src-tauri) | 0 | ✅ pass | 5.7s |
| 4 | `cargo test --lib -- "router::"` | 0 | ✅ pass | 4.0s |
| 5 | `cargo test --lib -- "worktree::"` | 0 | ✅ pass | 10.8s |
| 6 | `rg "'reviewing'" src/routes/index.tsx` | 0 | ✅ pass | <1s |
| 7 | `rg "remove_single_worktree" src-tauri/src/commands/worktree.rs` | 0 | ✅ pass | <1s |
| 8 | `rg "remove_single_worktree" src-tauri/src/lib.rs` | 0 | ✅ pass | <1s |
| 9 | `rg "cleanupWorktrees" src/routes/index.tsx` | 0 | ✅ pass | <1s |

## Diagnostics

- `rg "remove_single_worktree" src-tauri/` — find the IPC command definition and registration
- `rg "removeWorktree" src/hooks/useWorktree.ts` — locate the hook method
- `rg "'reviewing'" src/routes/index.tsx` — verify navigation trigger condition
- `rg "cleanupWorktrees" src/routes/index.tsx` — find startup cleanup call
- Startup cleanup errors silently caught — check `listWorktrees` output to verify stale worktrees are removed
- `remove_single_worktree` errors include branch name for debugging invalid inputs

## Deviations

- Manually added `removeSingleWorktree` binding to `src/bindings.ts` — specta generates bindings at Tauri app runtime, not during `cargo build`. The binding follows the exact same pattern as existing commands.
- Added `remove_single_worktree` re-export in `src-tauri/src/commands/mod.rs` — not mentioned in the task plan but required for the import in `lib.rs` to resolve.

## Known Issues

None.

## Files Created/Modified

- `src/routes/index.tsx` — Changed auto-navigate from 'completed' to 'reviewing', added projectDir selector, added startup cleanup useEffect
- `src-tauri/src/commands/worktree.rs` — Added `remove_single_worktree` IPC command with branch name validation
- `src-tauri/src/commands/mod.rs` — Added `remove_single_worktree` to re-exports
- `src-tauri/src/lib.rs` — Added `remove_single_worktree` to imports and invoke_handler registration
- `src/components/review/DiffReview.tsx` — Replaced cleanupWorktrees with removeWorktree in discard flows, added zero-changes empty state
- `src/hooks/useWorktree.ts` — Added `removeWorktree` method and included it in return object
- `src/bindings.ts` — Added `removeSingleWorktree` TypeScript binding
- `.gsd/milestones/M002/slices/S04/tasks/T02-PLAN.md` — Added Observability Impact section
