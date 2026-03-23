---
estimated_steps: 5
estimated_files: 2
skills_used: []
---

# T01: Wire auto-commit, diff generation, diffs_ready emission, and enriched review prompt in orchestrator

**Slice:** S04 — Review, Merge & Cleanup
**Milestone:** M002

## Description

The frontend review UI (CodeReviewView, DiffReview, handleOrchEvent's `diffs_ready` handler, taskStore's `worktreeEntries`) is fully built but receives no data. The orchestrator never auto-commits worktrees after workers finish, never generates diffs, never emits `diffs_ready`, and the review prompt only contains text output summaries. This task bridges that gap by inserting the commit-diff-emit pipeline between Phase 2 completion and Phase 3 review start, and enriching the review prompt with actual diff text.

## Steps

1. **Add `build_review_prompt_with_diffs()` to `Orchestrator` in `src-tauri/src/router/orchestrator.rs`.** This method takes the original prompt, worker results, and a `Vec<(String, String)>` of `(dag_id, diff_text)` pairs. It formats the same review prompt as `build_review_prompt()` but appends a "File Changes" section with truncated unified diffs. Cap total diff text at ~20KB across all worktrees (distribute proportionally). If a worktree has zero changes, include a note like "No file changes detected." Keep the existing `build_review_prompt()` intact (it's tested).

2. **In `src-tauri/src/commands/orchestrator.rs`, insert the auto-commit + diff generation block between Phase 2 completion and Phase 3 review.** After the wave loop finishes and `plan.worker_results` is populated (around line 1690), but before `emit_orch("phase_changed", reviewing)`:
   - Iterate `worktree_entries` HashMap. For each `(dag_id, WorktreeEntry)`:
     - Call `conflict::auto_commit_worktree(&entry.path)` via `tokio::task::spawn_blocking` (it's a blocking git2 op). Log a warning if it fails but continue.
     - Call `diff::generate_worktree_diff(&project_dir_path, &entry.branch_name)` via `spawn_blocking`. On success, store `(dag_id, WorktreeDiffReport)` in a local vec. On failure, log warning and use a zero-diff placeholder.
   - Add `use crate::worktree::{conflict, diff};` at the top of the file if not already present.

3. **Emit the `diffs_ready` event.** After collecting all diff reports, build a JSON array with per-worktree metadata: `{ dag_id, branch_name, file_count, additions, deletions }` matching the shape expected by `handleOrchEvent.ts` line 27. Emit via `emit_orch(&on_event, "diffs_ready", ...)`. The frontend handler at line 278 already parses this shape and calls `store.setWorktreeEntries()`.

4. **Collect diff text for the enriched review prompt.** For each `WorktreeDiffReport`, concatenate the `patch` field from each `FileDiff` into a single diff string per worktree. Build a `Vec<(String, String)>` of `(dag_id, combined_patch_text)`. Pass this to `build_review_prompt_with_diffs()` instead of `build_review_prompt()`.

5. **Handle edge cases.** Zero-changes worktrees (worker made no changes): `auto_commit_worktree` returns `Ok(false)` and `generate_worktree_diff` returns a report with empty `files` vec. Include them in `diffs_ready` with `file_count: 0`. Worktrees where the worker failed (`failed_dag_ids`): skip auto-commit/diff — they may be in a broken state. Only process worktrees for workers that completed (check `plan.worker_results` or iterate only non-failed entries).

## Must-Haves

- [ ] `auto_commit_worktree()` called for each non-failed worktree after Phase 2
- [ ] `generate_worktree_diff()` called for each worktree using `project_dir` (main repo) and `entry.branch_name`
- [ ] `diffs_ready` event emitted with correct shape: `{ diffs: [{ dag_id, branch_name, file_count, additions, deletions }] }`
- [ ] `build_review_prompt_with_diffs()` method added and used for Phase 3 review prompt
- [ ] Total diff text in review prompt capped at ~20KB
- [ ] Zero-changes worktrees included in diffs_ready with file_count=0
- [ ] Failed worktrees (in `failed_dag_ids`) skipped during auto-commit/diff
- [ ] Individual worktree failures logged but don't halt orchestration

## Verification

- `cargo test --lib -- "router::"` passes (existing + if you add an inline test for the new method)
- `rg "diffs_ready" src-tauri/src/commands/orchestrator.rs` → ≥1 match
- `rg "auto_commit_worktree" src-tauri/src/commands/orchestrator.rs` → ≥1 match
- `rg "generate_worktree_diff" src-tauri/src/commands/orchestrator.rs` → ≥1 match
- `rg "build_review_prompt_with_diffs" src-tauri/src/router/orchestrator.rs` → ≥1 match
- `cargo build` compiles clean (Rust)

## Observability Impact

- Signals added: `diffs_ready` event carrying per-worktree diff metadata; log::warn on per-worktree auto-commit/diff failures
- How a future agent inspects this: `rg "diffs_ready" src-tauri/` to find emission; check `worktreeEntries` in taskStore via React DevTools
- Failure state exposed: Individual worktree commit/diff failures logged with dag_id + error detail; review prompt still generated with available diffs

## Inputs

- `src-tauri/src/commands/orchestrator.rs` — orchestrator dispatch_orchestrated_task fn with `worktree_entries` HashMap, Phase 2 → Phase 3 gap
- `src-tauri/src/router/orchestrator.rs` — `build_review_prompt()` method, `WorkerResult` struct
- `src-tauri/src/worktree/conflict.rs` — `auto_commit_worktree()` at line ~159
- `src-tauri/src/worktree/diff.rs` — `generate_worktree_diff()` at line 28, returns `WorktreeDiffReport`
- `src-tauri/src/worktree/models.rs` — `WorktreeEntry`, `WorktreeDiffReport`, `FileDiff` structs
- `src/hooks/orchestration/handleOrchEvent.ts` — `diffs_ready` handler at line 278 (read-only reference for expected event shape)

## Expected Output

- `src-tauri/src/commands/orchestrator.rs` — modified with auto-commit + diff + diffs_ready emission between Phase 2 and Phase 3
- `src-tauri/src/router/orchestrator.rs` — modified with `build_review_prompt_with_diffs()` method
