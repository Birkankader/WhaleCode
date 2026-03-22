---
estimated_steps: 5
estimated_files: 3
skills_used: []
---

# T01: Defer worktree cleanup, generate diffs before review, enrich review prompt

**Slice:** S04 — Review & Merge Pipeline
**Milestone:** M001

## Description

The orchestrator currently destroys worktrees immediately after Phase 2 workers complete (success path, lines ~1537-1547) and before the user can review diffs or merge. The review prompt in Phase 3 only includes `output_summary` (stdout text), not actual file diffs. This task fixes both: (1) defer worktree cleanup on the success path so diffs and merges work, (2) before sending the review prompt, auto-commit and generate diffs on each worktree, (3) include diff summaries in the review prompt, (4) emit a `@@orch::diffs_ready` event carrying per-worktree metadata so the frontend knows what to render.

The failure-path cleanup (when ALL workers fail, lines ~1403-1412) stays as-is — there's nothing to review when all tasks failed.

## Steps

1. **Add `Deserialize` to `FileDiff` and `WorktreeDiffReport`** in `src-tauri/src/worktree/models.rs`. Change `#[derive(Debug, Clone, Serialize, Type)]` to `#[derive(Debug, Clone, Serialize, Deserialize, Type)]` on both structs. This is needed because `WorktreeDiffReport` values will be serialized into the `@@orch::diffs_ready` event payload and may later need to be stored on `OrchestrationPlan`.

2. **Remove success-path worktree cleanup** in `src-tauri/src/commands/orchestrator.rs`. Find the block after Phase 3 review (around lines 1537-1550) that iterates `plan.worktree_entries`, calls `remove_worktree`, and emits `worktrees_cleaned`. Remove this entire block. The `worktrees_cleaned` event will now only fire from the failure path (lines ~1403-1412) or from the frontend after user merge/discard. Keep the plan cleanup timer (lines ~1558-1565) — it only removes the in-memory plan struct, not worktree files.

3. **Generate diffs before Phase 3 review prompt** in `src-tauri/src/commands/orchestrator.rs`. Before the line `let review_prompt = Orchestrator::build_review_prompt(...)` (around line 1456), insert a new block:
   - Create a `Vec<(String, WorktreeDiffReport)>` to hold `(dag_id, diff_report)` pairs
   - For each `(dag_id, entry)` in `plan.worktree_entries`:
     - Call `auto_commit_worktree(&entry.path)` to capture uncommitted agent changes (import from `crate::worktree::conflict`)
     - Call `generate_worktree_diff(&project_dir_path, &entry.branch_name)` to get the diff report (import from `crate::worktree::diff`). `project_dir_path` is `PathBuf::from(&project_dir)` — the main repo path, not the worktree path
     - Both are synchronous git2 calls. Wrap each pair in `tokio::task::spawn_blocking` or wrap the entire loop since it's sequential. The orchestrator is already in an async context.
     - If auto-commit or diff fails, log the error and include an empty diff report for that worktree (non-fatal)
   - Emit `@@orch::diffs_ready` event with a JSON array of objects: `{ dag_id, branch_name, file_count, additions, deletions }` for each worktree
   - Pass the diff reports to the review prompt builder

4. **Add `build_review_prompt_with_diffs`** to `Orchestrator` in `src-tauri/src/router/orchestrator.rs`. Signature: `pub fn build_review_prompt_with_diffs(original_prompt: &str, worker_results: &[WorkerResult], diffs: &[(String, WorktreeDiffReport)]) -> String`. This method includes diff summaries (file list + stats per worktree) in the review prompt alongside worker output summaries. For each diff report, include: branch name, number of files changed, total additions/deletions, and the list of changed file paths (NOT full patches — too large for context window). Keep it under ~2KB per worktree by listing only file paths and stats. Then update the orchestrator call site to use this new method when diffs are available, falling back to the existing `build_review_prompt` when no diffs exist.

5. **Write unit tests:**
   - In `src-tauri/src/router/orchestrator.rs` tests module: Test `build_review_prompt_with_diffs` produces a prompt containing file paths, additions/deletions stats, and the original prompt text. Test it handles empty diffs (zero files changed).
   - In `src-tauri/src/commands/orchestrator.rs` tests module: Verify `WorktreeDiffReport` serializes correctly (tests the `Deserialize` derive indirectly via serde round-trip).

## Must-Haves

- [ ] Success-path worktree cleanup removed from orchestrator (failure-path cleanup preserved)
- [ ] `auto_commit_worktree` called on each worktree entry before diff generation
- [ ] `generate_worktree_diff` called on each worktree entry before review prompt
- [ ] `build_review_prompt_with_diffs` method exists and includes file-level diff summaries
- [ ] `@@orch::diffs_ready` event emitted with per-worktree metadata
- [ ] `FileDiff` and `WorktreeDiffReport` derive `Deserialize`
- [ ] All existing `cargo test --lib commands::orchestrator` tests pass (57+)
- [ ] All existing `cargo test --lib router::orchestrator` tests pass
- [ ] New unit tests for diff-enriched review prompt

## Verification

- `cargo test --lib commands::orchestrator` — 57+ existing tests pass + new tests
- `cargo test --lib router::orchestrator` — existing + new tests pass
- `grep -q 'auto_commit_worktree' src-tauri/src/commands/orchestrator.rs` — auto-commit wired
- `grep -q 'generate_worktree_diff' src-tauri/src/commands/orchestrator.rs` — diff generation wired
- `grep -q 'diffs_ready' src-tauri/src/commands/orchestrator.rs` — event emitted
- `grep -q 'build_review_prompt_with_diffs' src-tauri/src/router/orchestrator.rs` — method exists

## Observability Impact

- Signals added: `@@orch::diffs_ready` event with `[{dag_id, branch_name, file_count, additions, deletions}]` payload
- Signals removed: `@@orch::worktrees_cleaned` no longer fires on success path (only on failure path)
- How a future agent inspects this: `grep '@@orch::diffs_ready' orchestrator.rs` to find the emit site; diff reports are logged to orchestration messenger
- Failure state exposed: diff generation errors are logged as warnings and result in empty diff reports (non-fatal)

## Inputs

- `src-tauri/src/commands/orchestrator.rs` — current orchestrator with immediate worktree cleanup and stdout-only review
- `src-tauri/src/router/orchestrator.rs` — current `build_review_prompt` taking only `&[WorkerResult]`
- `src-tauri/src/worktree/models.rs` — `WorktreeDiffReport` and `FileDiff` structs (missing `Deserialize`)
- `src-tauri/src/worktree/diff.rs` — `generate_worktree_diff()` function to call
- `src-tauri/src/worktree/conflict.rs` — `auto_commit_worktree()` function to call

## Expected Output

- `src-tauri/src/commands/orchestrator.rs` — success-path cleanup removed, diffs generated before review, `diffs_ready` emitted, new test(s)
- `src-tauri/src/router/orchestrator.rs` — `build_review_prompt_with_diffs` method + test(s)
- `src-tauri/src/worktree/models.rs` — `Deserialize` derive added to `FileDiff` and `WorktreeDiffReport`
