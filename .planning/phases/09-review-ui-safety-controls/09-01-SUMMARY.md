---
phase: 09-review-ui-safety-controls
plan: 01
subsystem: worktree
tags: [git2, diff, selective-merge, ipc, tauri-specta]

# Dependency graph
requires:
  - phase: 05-worktree-isolation
    provides: WorktreeManager, conflict detection, auto-commit
provides:
  - generate_worktree_diff for per-file unified diffs
  - selective_merge for accept/reject file merging
  - get_worktree_diff IPC command
  - merge_worktree with optional accepted_files parameter
  - FileDiff and WorktreeDiffReport TypeScript types
affects: [09-02-review-ui-safety-controls]

# Tech tracking
tech-stack:
  added: []
  patterns: [in-memory index for selective tree building, patch truncation at 50KB]

key-files:
  created: [src-tauri/src/worktree/diff.rs]
  modified: [src-tauri/src/worktree/models.rs, src-tauri/src/worktree/mod.rs, src-tauri/src/commands/worktree.rs, src-tauri/src/commands/mod.rs, src-tauri/src/lib.rs, src/bindings.ts, src/hooks/useWorktree.ts]

key-decisions:
  - "In-memory git2::Index for selective merge instead of TreeBuilder (handles nested paths)"
  - "50KB patch truncation per file to prevent UI overload"
  - "Merge commit with two parents preserves branch history in selective merge"

patterns-established:
  - "Selective merge via in-memory index: read default tree, overlay accepted files from branch, write new tree"
  - "Auto-commit worktree before diff generation to capture uncommitted tool changes"

requirements-completed: [SAFE-01, SAFE-02]

# Metrics
duration: 5min
completed: 2026-03-06
---

# Phase 9 Plan 1: Backend Diff and Selective Merge Summary

**Per-file unified diff generation with git2 diff_tree_to_tree and selective merge via in-memory index for accept/reject workflow**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-06T20:17:19Z
- **Completed:** 2026-03-06T20:22:47Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments
- generate_worktree_diff produces per-file diffs with patch text, status (added/modified/deleted), and line counts
- selective_merge applies only user-accepted files from branch to default branch using in-memory index
- get_worktree_diff IPC command with auto-commit before diff generation
- merge_worktree extended with optional accepted_files parameter (backward compatible)

## Task Commits

Each task was committed atomically:

1. **Task 1: Diff generation module and new types (TDD RED)** - `2a89658` (test)
2. **Task 1: Diff generation module and new types (TDD GREEN)** - `ed80d9f` (feat)
3. **Task 2: IPC commands and bindings** - `0248497` (feat)

_Note: Task 1 was TDD with RED/GREEN commits. No refactoring needed._

## Files Created/Modified
- `src-tauri/src/worktree/diff.rs` - New module: generate_worktree_diff and selective_merge functions with 8 tests
- `src-tauri/src/worktree/models.rs` - Added FileDiff and WorktreeDiffReport types
- `src-tauri/src/worktree/mod.rs` - Registered diff module
- `src-tauri/src/commands/worktree.rs` - New get_worktree_diff IPC, modified merge_worktree with accepted_files
- `src-tauri/src/commands/mod.rs` - Re-exported get_worktree_diff
- `src-tauri/src/lib.rs` - Registered get_worktree_diff in collect_commands
- `src/bindings.ts` - Added getWorktreeDiff, FileDiff, WorktreeDiffReport types, updated mergeWorktree
- `src/hooks/useWorktree.ts` - Updated mergeWorktree call for new signature

## Decisions Made
- Used in-memory git2::Index (not TreeBuilder) for selective merge to handle nested file paths correctly
- 50KB per-file patch truncation with "[diff truncated]" marker to prevent UI overload
- Merge commit references both branch and default as parents to preserve history
- Manual bindings.ts update since tauri-specta export runs at app runtime, not build time

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed mutable borrow on git2::Patch**
- **Found during:** Task 1 (GREEN phase)
- **Issue:** `patch.to_buf()` requires mutable reference but `patch` was not declared mutable
- **Fix:** Added `mut` to `if let Some(mut patch) = patch`
- **Files modified:** src-tauri/src/worktree/diff.rs
- **Verification:** All 8 tests pass
- **Committed in:** ed80d9f (part of GREEN commit)

**2. [Rule 3 - Blocking] Manual bindings.ts update and useWorktree.ts fix**
- **Found during:** Task 2
- **Issue:** tauri-specta exports bindings at runtime (app startup), not at cargo build time; existing useWorktree.ts caller did not pass new third argument
- **Fix:** Manually added getWorktreeDiff command, FileDiff/WorktreeDiffReport types, updated mergeWorktree signature in bindings.ts; updated useWorktree.ts to pass null for accepted_files
- **Files modified:** src/bindings.ts, src/hooks/useWorktree.ts
- **Verification:** cargo build succeeds, all 22 worktree tests pass
- **Committed in:** 0248497

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking)
**Impact on plan:** Both fixes necessary for compilation and correctness. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Backend diff and selective merge ready for frontend review UI (plan 09-02)
- getWorktreeDiff and mergeWorktree(with acceptedFiles) available via TypeScript bindings

---
*Phase: 09-review-ui-safety-controls*
*Completed: 2026-03-06*
