# S04: Review, Merge & Cleanup — Research

**Date:** 2026-03-23
**Depth:** Targeted

## Summary

S04 owns R008 (review agent sees real diffs), R009 (per-worktree merge UI), and R012 (worktree cleanup). The surprising finding is that the frontend is nearly complete — CodeReviewView with per-worktree cards, DiffReview with file-level selective merge, and the `diffs_ready` event handler in handleOrchEvent.ts are all already built and wired. The `worktreeEntries` store field and its setter exist. The `useWorktree` hook wraps all 5 IPC commands.

What's **missing** is entirely backend-to-frontend bridging inside the orchestrator:

1. **No auto-commit + diff generation after workers finish.** The orchestrator has `worktree_entries` HashMap with branch names and paths, but never calls `auto_commit_worktree()` or `generate_worktree_diff()` on them after Phase 2 completes.
2. **No `diffs_ready` event emission.** The frontend handler exists (handleOrchEvent line 278) but the backend never emits this event, so `worktreeEntries` in the store is always empty.
3. **Review prompt only gets `output_summary` text, not actual file diffs.** `build_review_prompt()` formats worker results as agent name + exit code + output summary. The review agent never sees what files actually changed.
4. **No worktree cleanup after orchestration.** Worktrees persist until the user manually triggers cleanup or the app restarts. No cleanup-on-startup either.
5. **Auto-navigate timing is wrong.** The app navigates to CodeReviewView when `orchestrationPhase === 'completed'`, but users need to see the review screen during the `'reviewing'` phase so they can inspect diffs while the review agent works (or immediately after, before the user clicks "done").

## Recommendation

Three backend tasks + one verification task:

1. **Auto-commit + diff + diffs_ready emission** — After all DAG waves finish (just before Phase 3), iterate `worktree_entries`, call `auto_commit_worktree()` on each worktree path, then `generate_worktree_diff()` on each branch, and emit a single `diffs_ready` event with the diff metadata. This is the critical bridge that activates the entire frontend review UI.

2. **Enrich review prompt with diffs** — Add a new `build_review_prompt_with_diffs()` method (or extend the existing one) that includes truncated unified diffs alongside the output summaries. The review agent should see file-level changes, not just text output. Truncate total diff text to ~20KB to stay within agent context limits.

3. **Worktree cleanup lifecycle** — (a) After the user finishes the review screen (merges/discards all worktrees and clicks Done), the existing `cleanupWorktrees` call in CodeReviewView handles per-session cleanup. (b) Add startup cleanup: call `cleanup_stale_worktrees()` during Tauri `setup()` when a project_dir is known, or as a frontend-triggered call on app mount. (c) The discard flow in DiffReview currently calls `cleanupWorktrees()` which only prunes stale worktrees — it should call a targeted `remove_worktree` for the specific branch being discarded.

4. **Fix navigation timing** — Navigate to review when `orchestrationPhase === 'reviewing'` instead of `'completed'`, so the user sees diffs while/before the review agent runs. The "Done" button on CodeReviewView already transitions to completed state.

## Implementation Landscape

### Key Files

- `src-tauri/src/commands/orchestrator.rs` — Lines ~1690-1700: the gap between Phase 2 completion and Phase 3 start is where auto-commit + diff + diffs_ready must be inserted. `worktree_entries` HashMap (line 1485) has all the data needed.
- `src-tauri/src/router/orchestrator.rs` — `build_review_prompt()` at line 152: needs a new variant or extension that includes diff text. `WorkerResult` struct at line 79 may need an optional `diff_text: Option<String>` field.
- `src-tauri/src/worktree/conflict.rs` — `auto_commit_worktree()` at line ~200: already works, just needs to be called from the orchestrator.
- `src-tauri/src/worktree/diff.rs` — `generate_worktree_diff()`: already works. Returns `WorktreeDiffReport` with per-file patches, additions, deletions.
- `src-tauri/src/lib.rs` — Tauri `setup()` at line ~147: add startup worktree cleanup call.
- `src/routes/index.tsx` — Line 71: change `orchestrationPhase === 'completed'` to `=== 'reviewing'` for auto-navigate.
- `src/hooks/orchestration/handleOrchEvent.ts` — Line 278: `diffs_ready` handler already complete, no changes needed.
- `src/stores/taskStore.ts` — `worktreeEntries` and `setWorktreeEntries` already exist, no changes needed.
- `src/components/views/CodeReviewView.tsx` — Complete with per-worktree cards, merge/discard buttons, cleanup-on-done. Only needs the `onMouseEnter`/`onMouseLeave` style handlers replaced (that's S05 territory though).
- `src/components/review/DiffReview.tsx` — Complete with file-level accept/reject and selective merge via IPC. The discard flow could be improved to call a targeted worktree removal instead of blanket stale cleanup.
- `src-tauri/src/commands/worktree.rs` — Has all IPC commands. Missing: a `remove_single_worktree` command for targeted discard (currently only `cleanup_worktrees` which prunes stale ones).

### Build Order

**Task 1: Auto-commit, diff generation, diffs_ready event, and enriched review prompt (backend).** This is the critical path that activates the entire frontend. After Phase 2 waves complete but before Phase 3 review starts:
- Iterate `worktree_entries`, auto-commit each worktree, generate diff for each branch
- Emit `diffs_ready` event with per-worktree metadata (dag_id, branch_name, file_count, additions, deletions)
- Build review prompt that includes truncated diff text so the review agent sees actual file changes
- Handles zero-changes case (worktree exists but no diff — worker made no changes)

**Task 2: Navigation timing fix + worktree cleanup lifecycle (frontend + backend).** Lower risk, independent of Task 1's internal logic:
- Fix auto-navigate: `'reviewing'` instead of `'completed'`
- Add `remove_single_worktree` IPC command for targeted discard
- Wire DiffReview's discard to call targeted removal instead of blanket stale cleanup
- Add startup cleanup: frontend calls `cleanupWorktrees` on mount when projectDir is set

**Task 3: Verification.** Tests for the new orchestrator logic + wiring checks:
- Unit tests for `build_review_prompt_with_diffs()` 
- Wiring checks: rg `diffs_ready` in orchestrator.rs, rg `auto_commit_worktree` in orchestrator.rs
- Existing worktree test suites still pass (22 worktree tests, 7 diff tests, 4 conflict tests)
- TypeScript compiles clean
- Frontend test suite passes (94 tests)

### Verification Approach

**Contract verification:**
- `cargo test --lib -- "worktree::"` — 22 existing tests pass
- `cargo test --lib -- "router::"` — existing review prompt tests pass + new diff-enriched prompt test
- `npx tsc --noEmit` — 0 errors
- `npx vitest run` — 94+ tests pass

**Wiring checks (ripgrep):**
- `rg "diffs_ready" src-tauri/src/commands/orchestrator.rs` → ≥1 match (currently 0)
- `rg "auto_commit_worktree" src-tauri/src/commands/orchestrator.rs` → ≥1 match (currently 0)
- `rg "generate_worktree_diff" src-tauri/src/commands/orchestrator.rs` → ≥1 match (currently 0)
- `rg "cleanup_stale_worktrees\|cleanup_worktrees" src-tauri/src/lib.rs src/routes/index.tsx` → ≥1 match
- `rg "'reviewing'" src/routes/index.tsx` → matches auto-navigate condition

**Operational check:**
- `cleanup_stale_worktrees` called on startup path
- `remove_worktree` callable from DiffReview discard

## Constraints

- `auto_commit_worktree()` and `generate_worktree_diff()` are blocking git2 operations — they must run via `tokio::task::spawn_blocking` or be called in the orchestrator's synchronous pre-dispatch context (they're fast local git ops, <100ms per worktree).
- Total diff text sent to the review agent must be truncated to ~20KB to avoid exceeding agent context limits. The per-file truncation at 50KB exists in `generate_worktree_diff()` but total payload needs capping too.
- The `worktree_entries` HashMap is in the orchestrator's local scope, not in shared state. The diffs_ready emission must happen in the same function scope that owns the map.
- K007 applies: the review dispatch uses `"{plan.task_id}-review"` as dispatch_id to avoid slot conflicts.

## Common Pitfalls

- **Emitting diffs_ready after Phase 3 review instead of before** — The frontend needs worktreeEntries populated when the review view appears. The event must be emitted before or at the start of Phase 3, not after review completes.
- **Calling auto_commit on the main repo instead of the worktree** — `auto_commit_worktree()` takes the worktree *path* (the `.whalecode-worktrees/whalecode-{prefix}` directory), not the main repo path. The `WorktreeEntry.path` field has this.
- **generate_worktree_diff needs the main repo path, not the worktree path** — It opens the main repo and diffs the branch against the default branch. Pass `project_dir`, not `entry.path`.
- **Discard currently only prunes stale worktrees** — `DiffReview.handleDiscard()` calls `cleanupWorktrees()` which delegates to `cleanup_stale_worktrees()`. An active, valid worktree won't be pruned. Need a targeted `remove_worktree` IPC command.
