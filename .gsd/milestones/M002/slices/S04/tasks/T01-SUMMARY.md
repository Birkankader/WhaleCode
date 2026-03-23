---
id: T01
parent: S04
milestone: M002
provides:
  - auto-commit + diff generation pipeline between Phase 2 and Phase 3
  - diffs_ready event emission with per-worktree metadata
  - build_review_prompt_with_diffs method for enriched review prompts
key_files:
  - src-tauri/src/commands/orchestrator.rs
  - src-tauri/src/router/orchestrator.rs
key_decisions:
  - Sequential per-worktree auto-commit and diff generation (not parallel) to avoid git contention on the main repo
  - Zero-diff placeholder for worktrees where diff generation fails so they still appear in diffs_ready
  - Proportional truncation budget across worktrees to stay within ~20KB total diff text
patterns_established:
  - Phase 2.5 block pattern: auto-commit → diff → emit → enrich prompt, between Phase 2 completion and Phase 3 review start
  - spawn_blocking for blocking git2 operations in async orchestrator context
observability_surfaces:
  - diffs_ready event with per-worktree dag_id, branch_name, file_count, additions, deletions
  - log::warn for per-worktree auto-commit and diff generation failures with dag_id context
  - info events emitted to frontend for individual worktree commit/diff failures
duration: 12m
verification_result: passed
completed_at: 2026-03-23
blocker_discovered: false
---

# T01: Wire auto-commit, diff generation, diffs_ready emission, and enriched review prompt in orchestrator

**Inserted commit-diff-emit pipeline between Phase 2 and Phase 3: auto-commits worktrees, generates unified diffs, emits diffs_ready event, and passes real diff text to the review agent via build_review_prompt_with_diffs**

## What Happened

Added `build_review_prompt_with_diffs()` to `Orchestrator` in `router/orchestrator.rs`. It extends the base review prompt with a "File Changes" section containing per-worktree unified diffs, with proportional truncation capped at ~20KB total. Zero-change worktrees get a "No file changes detected" note.

In `commands/orchestrator.rs`, inserted a Phase 2.5 block after the wave loop and plan update, before Phase 3 review:
1. Iterates `worktree_entries`, skipping any in `failed_dag_ids`
2. Calls `conflict::auto_commit_worktree` via `spawn_blocking` for each — logs warning on failure but continues
3. Calls `diff::generate_worktree_diff` via `spawn_blocking` for each — on failure, inserts a zero-diff placeholder
4. Emits `diffs_ready` with `{ diffs: [{ dag_id, branch_name, file_count, additions, deletions }] }` matching the frontend handler shape
5. Builds `Vec<(String, String)>` of `(dag_id, combined_patch_text)` and passes to `build_review_prompt_with_diffs` instead of the old `build_review_prompt`

Added `use crate::worktree::{conflict, diff}` import.

## Verification

- `cargo test --lib -- "router::"` — 54 tests passed (including 4 new `build_review_prompt_with_diffs` tests)
- `cargo test --lib -- "worktree::"` — 22 tests passed (existing suite, no regressions)
- `rg "diffs_ready" src-tauri/src/commands/orchestrator.rs` — 4 matches
- `rg "auto_commit_worktree" src-tauri/src/commands/orchestrator.rs` — 1 match
- `rg "generate_worktree_diff" src-tauri/src/commands/orchestrator.rs` — 1 match
- `rg "build_review_prompt_with_diffs" src-tauri/src/router/orchestrator.rs` — 9 matches

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `cargo test --lib -- "router::"` | 0 | ✅ pass | 5.6s |
| 2 | `cargo test --lib -- "worktree::"` | 0 | ✅ pass | 3.1s |
| 3 | `rg "diffs_ready" src-tauri/src/commands/orchestrator.rs` | 0 | ✅ pass | <1s |
| 4 | `rg "auto_commit_worktree" src-tauri/src/commands/orchestrator.rs` | 0 | ✅ pass | <1s |
| 5 | `rg "generate_worktree_diff" src-tauri/src/commands/orchestrator.rs` | 0 | ✅ pass | <1s |
| 6 | `rg "build_review_prompt_with_diffs" src-tauri/src/router/orchestrator.rs` | 0 | ✅ pass | <1s |

## Diagnostics

- `rg "diffs_ready" src-tauri/` — find emission point and event shape
- `rg "Phase 2.5" src-tauri/src/commands/orchestrator.rs` — locate the commit-diff-emit block
- Worktree commit/diff failures are logged at warn level with dag_id, surfaced as info events to frontend
- Frontend handler at `handleOrchEvent.ts:278` parses diffs_ready into `worktreeEntries` store

## Deviations

None. Implementation follows the task plan exactly.

## Known Issues

None.

## Files Created/Modified

- `src-tauri/src/commands/orchestrator.rs` — Added Phase 2.5 block (auto-commit, diff generation, diffs_ready emission, enriched review prompt), added worktree conflict/diff imports
- `src-tauri/src/router/orchestrator.rs` — Added `build_review_prompt_with_diffs()` method and 4 unit tests
