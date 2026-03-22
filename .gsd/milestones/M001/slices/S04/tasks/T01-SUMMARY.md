---
id: T01
parent: S04
milestone: M001
provides:
  - deferred worktree cleanup on success path
  - auto-commit + diff generation before review prompt
  - diff-enriched review prompt via build_review_prompt_with_diffs
  - @@orch::diffs_ready event with per-worktree metadata
  - Deserialize derives on FileDiff and WorktreeDiffReport
key_files:
  - src-tauri/src/commands/orchestrator.rs
  - src-tauri/src/router/orchestrator.rs
  - src-tauri/src/worktree/models.rs
key_decisions:
  - Diff generation uses spawn_blocking around the entire sequential loop (not per-iteration) since git2 calls are synchronous and ordering doesn't matter
  - Empty diff reports are inserted on failure rather than skipping the worktree, so downstream always has a complete set
patterns_established:
  - Non-fatal diff errors produce empty WorktreeDiffReport with logged warning rather than aborting the review flow
  - Review prompt with diffs truncates file lists at 2KB per worktree to stay within context window budget
observability_surfaces:
  - @@orch::diffs_ready event with [{dag_id, branch_name, file_count, additions, deletions}] payload
  - worktrees_cleaned event now only fires on failure path (not success path)
  - auto-commit and diff generation errors logged at warn level
duration: 12min
verification_result: passed
completed_at: 2026-03-20
blocker_discovered: false
---

# T01: Defer worktree cleanup, generate diffs before review, enrich review prompt

**Deferred success-path worktree cleanup, added auto-commit + diff generation before review, built diff-enriched review prompt, and emitted @@orch::diffs_ready event**

## What Happened

Three files were modified to implement the core backend pipeline for the review & merge flow:

1. **models.rs**: Added `Deserialize` derive to `FileDiff` and `WorktreeDiffReport` so they can round-trip through serde (needed for event payloads and future storage on `OrchestrationPlan`).

2. **commands/orchestrator.rs**: Removed the success-path worktree cleanup block (which destroyed worktrees before users could review/merge). Added a new block before the Phase 3 review prompt that: (a) snapshots worktree entries, (b) runs `auto_commit_worktree` on each to capture uncommitted agent changes, (c) calls `generate_worktree_diff` to get per-file diff reports, (d) emits `@@orch::diffs_ready` with per-worktree metadata, and (e) uses `build_review_prompt_with_diffs` when diffs are available. The failure-path cleanup (all workers failed) is preserved unchanged. Added 2 serde round-trip tests for `WorktreeDiffReport` and `FileDiff`.

3. **router/orchestrator.rs**: Added `build_review_prompt_with_diffs` method that includes file-level diff summaries (branch name, file count, additions/deletions, changed file paths) in the review prompt alongside worker output summaries. File lists are truncated at 2KB per worktree. Added 3 tests covering normal diffs, empty diffs, and multiple worktrees.

## Verification

- `cargo test --lib router::orchestrator` — 20 tests passed (17 existing + 3 new)
- `cargo test --lib commands::orchestrator` — 59 tests passed (57 existing + 2 new)
- All grep checks for `auto_commit_worktree`, `generate_worktree_diff`, `diffs_ready`, and `build_review_prompt_with_diffs` pass
- Confirmed `worktrees_cleaned` emit exists only on the failure path (line 1415), not the success path

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `cargo test --lib commands::orchestrator` | 0 | ✅ pass | 8.6s |
| 2 | `cargo test --lib router::orchestrator` | 0 | ✅ pass | 3.2s |
| 3 | `grep -q 'auto_commit_worktree' src-tauri/src/commands/orchestrator.rs` | 0 | ✅ pass | <1s |
| 4 | `grep -q 'generate_worktree_diff' src-tauri/src/commands/orchestrator.rs` | 0 | ✅ pass | <1s |
| 5 | `grep -q 'diffs_ready' src-tauri/src/commands/orchestrator.rs` | 0 | ✅ pass | <1s |
| 6 | `grep -q 'build_review_prompt_with_diffs' src-tauri/src/router/orchestrator.rs` | 0 | ✅ pass | <1s |
| 7 | `grep -q 'DiffReview' src/components/views/CodeReviewView.tsx` | 1 | ⏳ future task | <1s |
| 8 | `grep -q 'worktreeEntries' src/stores/taskStore.ts` | 1 | ⏳ future task | <1s |
| 9 | `grep -q 'diffs_ready' src/hooks/orchestration/handleOrchEvent.ts` | 1 | ⏳ future task | <1s |
| 10 | `grep -q 'selectiveMerge\|mergeWorktree\|merge_worktree' src/components/views/CodeReviewView.tsx` | 1 | ⏳ future task | <1s |

## Diagnostics

- `grep '@@orch::diffs_ready' src-tauri/src/commands/orchestrator.rs` — find the emit site
- `grep 'auto_commit_worktree\|generate_worktree_diff' src-tauri/src/commands/orchestrator.rs` — find diff generation logic
- Diff generation errors appear in Tauri logs at `warn` level with worktree name and dag_id
- `worktrees_cleaned` event now only fires on the failure path (all workers failed); on success path, worktrees persist until the user handles them via the CodeReviewView (T02+)

## Deviations

None. Implementation followed the task plan exactly.

## Known Issues

None.

## Files Created/Modified

- `src-tauri/src/worktree/models.rs` — Added `Deserialize` derive to `FileDiff` and `WorktreeDiffReport`
- `src-tauri/src/commands/orchestrator.rs` — Removed success-path worktree cleanup, added diff generation + `diffs_ready` event emission before review prompt, added 2 serde round-trip tests
- `src-tauri/src/router/orchestrator.rs` — Added `build_review_prompt_with_diffs` method with file-level diff summaries, added `WorktreeDiffReport` import, added 3 unit tests
