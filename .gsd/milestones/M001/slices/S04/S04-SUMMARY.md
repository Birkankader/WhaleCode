# S04: Review & Merge Pipeline — Summary

**Slice goal:** Review agent receives worktree diffs and provides integration summary, UI shows per-worktree file changes with merge controls, and worktrees are cleaned up only after merge/discard — not before the user can review them.

**Status:** Complete (contract verified — runtime UAT deferred to S05)

## What This Slice Delivered

Two tasks implemented the full review & merge pipeline, connecting backend diff generation to frontend merge controls:

### T01: Backend diff pipeline (Rust)
- **Deferred success-path worktree cleanup.** Removed the `remove_worktree` loop that destroyed worktrees immediately after Phase 2, before users could review. Failure-path cleanup preserved unchanged.
- **Auto-commit + diff generation before review.** Before building the Phase 3 review prompt, the orchestrator now iterates `plan.worktree_entries`, calls `auto_commit_worktree` on each worktree path, then `generate_worktree_diff` to produce per-file diff reports. Uses `spawn_blocking` since git2 is sync.
- **Diff-enriched review prompt.** Added `build_review_prompt_with_diffs` that includes branch name, file count, additions/deletions, and changed file paths per worktree alongside worker output summaries. File lists truncated at 2KB per worktree.
- **`@@orch::diffs_ready` event.** Emitted with per-worktree metadata array `[{dag_id, branch_name, file_count, additions, deletions}]`.
- **Serde derives.** Added `Deserialize` to `FileDiff` and `WorktreeDiffReport` for event payloads.

### T02: Frontend review flow (TypeScript/React)
- **`worktreeEntries` state** added to `taskStore` with setter and session-clear.
- **`diffs_ready` event handling** in `handleOrchEvent.ts` populates worktreeEntries from event payload.
- **CodeReviewView rewritten** with per-worktree collapsible cards. Each card shows branch name, file count, and +/- stats in the header, expanding to render the existing `DiffReview` component at 480px height.
- **Merge controls:** "Merge All" batch button iterates pending entries sequentially with per-entry progress updates. Per-worktree merge/discard buttons. DiffReview component handles merge IPC internally.
- **Cleanup after all handled.** `cleanupWorktrees()` from `useWorktree` hook called only after all worktrees are merged or discarded. Cleanup errors are non-fatal — transitions to completed regardless.
- **Zero-changes case.** Worktrees with no file changes show explicit empty state with discard option.

## Files Modified

| File | Change |
|------|--------|
| `src-tauri/src/worktree/models.rs` | Added `Deserialize` derive to `FileDiff` and `WorktreeDiffReport` |
| `src-tauri/src/commands/orchestrator.rs` | Removed success-path cleanup, added diff generation + `diffs_ready` emit, 2 new tests |
| `src-tauri/src/router/orchestrator.rs` | Added `build_review_prompt_with_diffs`, 3 new tests |
| `src/stores/taskStore.ts` | Added `worktreeEntries` state, setter, session-clear |
| `src/hooks/orchestration/handleOrchEvent.ts` | Added `diffs_ready` event case |
| `src/components/views/CodeReviewView.tsx` | Rewritten with per-worktree DiffReview + merge controls |

## Verification Results

| Check | Result |
|-------|--------|
| `cargo test --lib commands::orchestrator` | ✅ 59 passed |
| `cargo test --lib router::orchestrator` | ✅ 20 passed |
| `npx tsc --noEmit` | ✅ zero errors |
| `auto_commit_worktree` in orchestrator.rs | ✅ present |
| `generate_worktree_diff` in orchestrator.rs | ✅ present |
| `diffs_ready` in orchestrator.rs | ✅ present |
| `diffs_ready` in handleOrchEvent.ts | ✅ present |
| `DiffReview` in CodeReviewView.tsx | ✅ present |
| `worktreeEntries` in taskStore.ts | ✅ present |
| merge controls in CodeReviewView.tsx | ✅ present |

## Patterns Established

- **Non-fatal diff errors:** Produce empty `WorktreeDiffReport` with logged warning rather than aborting the review flow. Downstream always has a complete set of reports.
- **Review prompt truncation:** File lists capped at 2KB per worktree to stay within LLM context window budget.
- **Worktree card expansion:** Collapsible card header with inline stats, expanding to render DiffReview at fixed 480px height.
- **Batch merge progress:** Sequential iteration updating per-entry status so UI reflects progress during "Merge All".
- **Ephemeral UI state in component, not store:** Per-worktree merge/discard status tracked as local React state since it resets each session.

## Requirement Coverage

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R008 (review with diffs) | Contract verified | `build_review_prompt_with_diffs` includes file-level summaries. 3 new tests. |
| R009 (per-worktree UI + merge) | Contract verified | CodeReviewView renders DiffReview per worktree with merge/discard controls. |
| R012 (cleanup lifecycle) | Contract verified | Success-path cleanup deferred to user action. Failure-path cleanup preserved. |

All three requirements await runtime UAT in S05.

## What S05 Should Know

1. **Worktrees now persist after Phase 2 success.** The orchestrator no longer auto-cleans worktrees. The frontend is responsible for calling `cleanupWorktrees()` after user action. If the frontend crashes or the user closes the app during review, stale worktrees will remain until the next `cleanup_stale_worktrees` call.
2. **`@@orch::diffs_ready` bridges backend→frontend.** This event carries the worktree metadata array that populates `worktreeEntries` in taskStore. If it's not emitted (e.g., all diff generations fail), the CodeReviewView falls back to empty state with direct completion.
3. **Review prompt quality depends on diff generation.** If `auto_commit_worktree` or `generate_worktree_diff` fails for a worktree, the review prompt includes an empty diff entry for that worktree. The review agent still runs but with less information.
4. **DiffReview component handles merge IPC internally.** The CodeReviewView doesn't call merge IPC directly — it renders DiffReview which owns that interaction. The `onClose` callback signals merge completion to the parent.
5. **The full pipeline path is now wired** from decompose → approve → parallel execute in worktrees → auto-commit → diff → review with diffs → per-worktree merge/discard → cleanup. S05 needs to prove this works end-to-end with real agents.
