---
estimated_steps: 5
estimated_files: 6
skills_used: []
---

# T02: Fix navigation timing, add targeted worktree removal, and wire startup cleanup

**Slice:** S04 — Review, Merge & Cleanup
**Milestone:** M002

## Description

Three independent frontend/backend fixes that complete the review-merge-cleanup lifecycle: (1) the review screen appears too late because navigation triggers on `'completed'` instead of `'reviewing'`, (2) discarding a worktree only does blanket stale cleanup instead of targeted removal, and (3) stale worktrees from crashed sessions aren't cleaned up on app startup.

## Steps

1. **Fix auto-navigate timing in `src/routes/index.tsx`.** Change the `useEffect` that watches `orchestrationPhase` from `orchestrationPhase === 'completed'` to `orchestrationPhase === 'reviewing'` so the review view appears when diffs are ready and the review agent starts, not after everything finishes. The "Done" button on CodeReviewView already handles the completed transition.

2. **Add `remove_single_worktree` IPC command in `src-tauri/src/commands/worktree.rs`.** The command takes `project_dir: String` and `branch_name: String`. Derive the worktree name from the branch name: if `branch_name` starts with `"whalecode/task/"`, strip that prefix and prepend `"whalecode-"` to get the worktree name (same pattern as `merge_worktree`'s cleanup logic at line ~215). Call `WorktreeManager::new(project_path).remove_worktree(&wt_name)`. Add the `#[tauri::command]` and `#[specta::specta]` attributes. Register the new command in `src-tauri/src/lib.rs` invoke_handler list (add `remove_single_worktree` to both the `use` import and the `invoke_handler` macro).

3. **Wire `DiffReview.handleDiscard()` to use targeted removal.** In `src/components/review/DiffReview.tsx`, the `handleDiscard` function currently calls `cleanupWorktrees()` which delegates to `cleanup_stale_worktrees()` — an active valid worktree won't be pruned. Change it to call a new `removeWorktree(branchName)` function instead. Add `removeWorktree` to the `useWorktree` hook in `src/hooks/useWorktree.ts`: it calls `commands.removeSingleWorktree(projectDir, branchName)` (the specta-generated binding name for `remove_single_worktree`). The branch name is available from the component's props or the diff report.

4. **Add startup cleanup in `src/routes/index.tsx`.** Add a `useEffect` that runs on mount (empty deps + projectDir check). When `projectDir` is set, call `commands.cleanupWorktrees(projectDir)` to prune stale worktrees from previous crashed sessions. This is fire-and-forget — don't block app startup on it. Import `commands` from bindings.

5. **Handle zero-changes case in DiffReview.** When a worktree's diff report has `files.length === 0`, show an explicit "No changes" empty state instead of an empty file list. The discard button should still be available. Check if the existing `DiffReview` already handles this — if `diffReport.files` is empty, add a message like "This worker made no file changes." with only the Discard button visible (no merge).

## Must-Haves

- [ ] Auto-navigate triggers on `orchestrationPhase === 'reviewing'` not `'completed'`
- [ ] `remove_single_worktree` IPC command registered and functional
- [ ] DiffReview discard calls targeted worktree removal for the specific branch
- [ ] `removeWorktree` method added to `useWorktree` hook
- [ ] Startup cleanup calls `cleanupWorktrees` on mount when `projectDir` is set
- [ ] Zero-changes worktrees show "No changes" message with discard option

## Verification

- `npx tsc --noEmit` exits 0
- `npx vitest run` — 94+ tests pass
- `rg "'reviewing'" src/routes/index.tsx` → matches in auto-navigate useEffect
- `rg "remove_single_worktree" src-tauri/src/commands/worktree.rs` → ≥1 match
- `rg "remove_single_worktree" src-tauri/src/lib.rs` → ≥1 match
- `rg "cleanupWorktrees\|cleanup_worktrees" src/routes/index.tsx` → ≥1 match (startup cleanup)
- `cargo build` compiles clean

## Inputs

- `src/routes/index.tsx` — auto-navigate useEffect at line ~71, orchestrationPhase watcher
- `src-tauri/src/commands/worktree.rs` — existing IPC commands pattern (merge_worktree, cleanup_worktrees)
- `src-tauri/src/lib.rs` — invoke_handler registration at line ~59
- `src/components/review/DiffReview.tsx` — handleDiscard at line ~118, cleanupWorktrees usage at line ~130
- `src/hooks/useWorktree.ts` — hook API, cleanupWorktrees pattern
- `src-tauri/src/worktree/manager.rs` — `remove_worktree()` at line 111

## Expected Output

- `src/routes/index.tsx` — modified: auto-navigate on `'reviewing'`, startup cleanup useEffect
- `src-tauri/src/commands/worktree.rs` — modified: `remove_single_worktree` command added
- `src-tauri/src/lib.rs` — modified: new command registered
- `src/components/review/DiffReview.tsx` — modified: discard uses targeted removal, zero-changes UI
- `src/hooks/useWorktree.ts` — modified: `removeWorktree` method added

## Observability Impact

- **New IPC surface:** `remove_single_worktree` command — errors include branch name context for debugging (e.g. "Invalid branch name 'x': expected 'whalecode/task/...' prefix")
- **Navigation signal change:** Auto-navigate now fires on `orchestrationPhase === 'reviewing'` instead of `'completed'` — observable via `orchestrationPhase` in taskStore
- **Startup cleanup:** Fire-and-forget `cleanupWorktrees` call on mount — failures silently caught; stale worktrees visible via `listWorktrees` if cleanup doesn't run
- **Inspection:** `removeWorktree` result in useWorktree hook surfaces errors via `error` state; `worktrees` list refreshes after successful removal
