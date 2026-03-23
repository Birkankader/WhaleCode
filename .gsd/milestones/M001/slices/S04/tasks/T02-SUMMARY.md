---
id: T02
parent: S04
milestone: M001
provides:
  - worktreeEntries state in taskStore with setter and session-clear
  - diffs_ready event handling in handleOrchEvent
  - Per-worktree DiffReview rendering in CodeReviewView with merge controls
  - Batch "Merge All" and per-worktree merge/discard via existing DiffReview component
  - Cleanup only after all worktrees handled; zero-worktrees direct completion path
key_files:
  - src/stores/taskStore.ts
  - src/hooks/orchestration/handleOrchEvent.ts
  - src/components/views/CodeReviewView.tsx
key_decisions:
  - Per-worktree status tracked in local component state (not store) since it's ephemeral UI state that resets each review session
  - DiffReview onClose callback marks worktree as 'merged' (the DiffReview component itself handles the merge/discard IPC internally)
  - Cleanup errors are non-fatal — still transitions to completed to avoid blocking the user
patterns_established:
  - Worktree card expansion pattern: collapsible card header with inline stats, expanding to render DiffReview at fixed height (480px)
  - Batch merge iterates pending entries sequentially, updating status per-entry so the UI reflects progress
observability_surfaces:
  - worktreeEntries in taskStore shows pending worktree diff metadata from @@orch::diffs_ready
  - "Diffs ready: N worktrees" orchestration log entry at info level
  - useWorktree error state surfaces merge/cleanup failures in the UI
duration: 8min
verification_result: passed
completed_at: 2026-03-20
blocker_discovered: false
---

# T02: Wire frontend review flow with per-worktree diffs and merge controls

**Added worktreeEntries state, diffs_ready event handler, and rewrote CodeReviewView with per-worktree DiffReview panels, batch merge controls, and deferred cleanup**

## What Happened

Three files were modified to wire the frontend review flow:

1. **taskStore.ts**: Added `WorktreeReviewEntry` type and `worktreeEntries` Map state (keyed by dagId) with setter. Cleared on `clearSession` to avoid stale data across sessions.

2. **handleOrchEvent.ts**: Added `diffs_ready` variant to the `OrchEvent` union type with the per-worktree metadata shape (`dag_id`, `branch_name`, `file_count`, `additions`, `deletions`). Added handler case that builds a Map of `WorktreeReviewEntry` from the event payload and calls `store.setWorktreeEntries`. Logs `"Diffs ready: N worktrees"` at info level.

3. **CodeReviewView.tsx**: Rewrote from simple accept/reject to a full per-worktree review flow:
   - Kept existing header, stats grid, review summary, and task results table
   - Added per-worktree section: each worktree renders as a collapsible card showing branch name, file count, and +/-  stats. Expanding a card renders the existing `DiffReview` component (which has its own file sidebar, diff viewer, and merge/discard buttons)
   - Per-worktree status tracking (`pending` / `merged` / `discarded`) via local state
   - "Merge All (N)" batch button that sequentially merges all pending worktrees
   - "Done" button (appears only after all worktrees handled) that calls `cleanupWorktrees()` then transitions to completed
   - Zero-worktrees case shows "No file changes to review" with a direct "Complete" button

## Verification

- `npx tsc --noEmit` — zero TypeScript errors (exit 0)
- `cargo test --lib commands::orchestrator` — 59 tests passed
- `cargo test --lib router::orchestrator` — 20 tests passed
- All 7 slice-level grep checks pass

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `cd src-tauri && cargo test --lib commands::orchestrator` | 0 | ✅ pass | ~8s |
| 2 | `cd src-tauri && cargo test --lib router::orchestrator` | 0 | ✅ pass | ~3s |
| 3 | `npx tsc --noEmit` (main project with copied files) | 0 | ✅ pass | 1.9s |
| 4 | `grep -q 'diffs_ready' src/hooks/orchestration/handleOrchEvent.ts` | 0 | ✅ pass | <1s |
| 5 | `grep -q 'DiffReview' src/components/views/CodeReviewView.tsx` | 0 | ✅ pass | <1s |
| 6 | `grep -q 'worktreeEntries' src/stores/taskStore.ts` | 0 | ✅ pass | <1s |
| 7 | `grep -qE 'useWorktree\|mergeWorktree\|selectiveMerge' src/components/views/CodeReviewView.tsx` | 0 | ✅ pass | <1s |
| 8 | `grep -q 'cleanupWorktrees' src/components/views/CodeReviewView.tsx` | 0 | ✅ pass | <1s |
| 9 | `grep -q 'auto_commit_worktree' src-tauri/src/commands/orchestrator.rs` | 0 | ✅ pass | <1s |
| 10 | `grep -q 'generate_worktree_diff' src-tauri/src/commands/orchestrator.rs` | 0 | ✅ pass | <1s |

## Diagnostics

- `useTaskStore.getState().worktreeEntries` — inspect worktree diff metadata received from backend
- `grep 'Diffs ready' ` in orchestrationLogs — confirms event was received and processed
- `useWorktree` hook error state surfaces merge/cleanup failures in the DiffReview component
- Cleanup errors are non-fatal: caught and still transition to completed phase

## Deviations

- Removed unused `getTaskDescription` helper that was initially written to look up task descriptions by dagId — the branch name is more useful as the card title since dagIds are opaque
- The `WorktreeReviewEntry` type import was removed from CodeReviewView since it's only used in taskStore and handleOrchEvent

## Known Issues

None.

## Files Created/Modified

- `src/stores/taskStore.ts` — Added `WorktreeReviewEntry` type, `worktreeEntries` Map state with setter, cleared on `clearSession`
- `src/hooks/orchestration/handleOrchEvent.ts` — Added `diffs_ready` to `OrchEvent` union, added handler case that populates `worktreeEntries` store
- `src/components/views/CodeReviewView.tsx` — Rewrote with per-worktree DiffReview panels, batch merge controls, cleanup-on-done, and zero-worktrees fallback
