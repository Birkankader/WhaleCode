# S04: Review & Merge Pipeline

**Goal:** Review agent receives worktree diffs and provides integration summary, UI shows per-worktree file changes with merge controls, and worktrees are cleaned up only after merge/discard — not before the user can review them.
**Demo:** After workers complete, the orchestrator auto-commits and diffs each worktree, includes diff summaries in the review prompt, and emits `@@orch::diffs_ready`. The CodeReviewView shows per-worktree tabs with the existing DiffReview component. User can accept/reject per-worktree and merge selected changes. Cleanup fires only after all worktrees are handled.

## Must-Haves

- Worktree cleanup deferred from Phase 2 completion to after user merge/discard action (R012)
- Auto-commit + diff generation on each worktree before Phase 3 review prompt (R008)
- Review prompt includes diff summaries (file list + stats), not just stdout text (R008)
- `@@orch::diffs_ready` event emitted with per-worktree metadata (R009)
- Frontend stores worktree entries from `diffs_ready` event (R009)
- CodeReviewView upgraded to show per-worktree diffs via existing DiffReview component (R009)
- Merge controls: accept per-worktree (selective_merge), reject per-worktree, accept all (R009)
- Worktree cleanup called only after all worktrees are merged or discarded (R012)
- "Zero changes" worktree shows explicit empty state with discard option (R009)
- Failure path cleanup preserved — worktrees still cleaned on all-workers-failed (R012)

## Proof Level

- This slice proves: contract + integration (diffs generated, events emitted, frontend wired)
- Real runtime required: no (runtime UAT deferred to S05)
- Human/UAT required: no (deferred to S05)

## Verification

- `cargo test --lib commands::orchestrator` — all existing tests pass + new tests for diff-enriched review and deferred cleanup
- `cargo test --lib router::orchestrator` — review prompt tests pass including new diff variant
- `npx tsc --noEmit` (run in main project dir with worktree files copied) — zero TypeScript errors
- `grep -q 'auto_commit_worktree' src-tauri/src/commands/orchestrator.rs` — auto-commit wired
- `grep -q 'generate_worktree_diff' src-tauri/src/commands/orchestrator.rs` — diff generation wired
- `grep -q 'diffs_ready' src-tauri/src/commands/orchestrator.rs` — event emitted
- `grep -q 'diffs_ready' src/hooks/orchestration/handleOrchEvent.ts` — event handled
- `grep -q 'DiffReview' src/components/views/CodeReviewView.tsx` — diff component used in review view
- `grep -q 'worktreeEntries' src/stores/taskStore.ts` — worktree state stored
- `grep -q 'selectiveMerge\|mergeWorktree\|merge_worktree' src/components/views/CodeReviewView.tsx` — merge wired

## Observability / Diagnostics

- Runtime signals: `@@orch::diffs_ready` event with per-worktree `{dag_id, branch_name, file_count, additions, deletions}`; `@@orch::worktrees_cleaned` fires only after user merge/discard (success path) or immediately (failure path)
- Inspection surfaces: `orchestrationLogs` in taskStore captures diff generation results; `worktreeEntries` in taskStore shows pending worktree state
- Failure visibility: Diff generation errors logged to orchestrationLogs with `error` level; merge failures shown via `useWorktree` error state in the UI
- Redaction constraints: none

## Integration Closure

- Upstream surfaces consumed: `OrchestrationPlan.worktree_entries` (from S02), `dagToFrontendId` map (from S03), `WorktreeManager`, `auto_commit_worktree`, `generate_worktree_diff`, `DiffReview` component, `useWorktree` hook, `merge_worktree`/`cleanup_worktrees` IPC commands
- New wiring introduced in this slice: orchestrator calls auto_commit + diff before review; `diffs_ready` event bridges backend worktree data to frontend; CodeReviewView renders DiffReview per worktree; merge/discard triggers cleanup
- What remains before the milestone is truly usable end-to-end: S05 runtime UAT — full pipeline run through GUI proving all phases work in sequence

## Tasks

- [x] **T01: Defer worktree cleanup, generate diffs before review, enrich review prompt** `est:1h`
  - Why: The orchestrator currently destroys worktrees immediately after Phase 2, before the user can review or merge. The review prompt only includes stdout text, not actual file diffs. This task fixes both: worktree cleanup moves to after user action, and diff summaries feed into the review prompt.
  - Files: `src-tauri/src/commands/orchestrator.rs`, `src-tauri/src/router/orchestrator.rs`, `src-tauri/src/worktree/models.rs`
  - Do: (1) Remove the success-path `remove_worktree` loop + `worktrees_cleaned` emit after Phase 3 (lines ~1537-1547). Keep the failure-path cleanup (lines ~1403-1412) for all-workers-failed. (2) Before building the Phase 3 review prompt, iterate `plan.worktree_entries`: for each entry, call `auto_commit_worktree` on the worktree path then `generate_worktree_diff` on the project_dir + branch_name. Collect results into a `Vec<(String, WorktreeDiffReport)>` (dag_id, report). Use `tokio::task::spawn_blocking` since git2 is sync. (3) Add `build_review_prompt_with_diffs` to `Orchestrator` that includes file-level diff summaries alongside worker output summaries. (4) Emit `@@orch::diffs_ready` event with per-worktree metadata array. (5) Add `Deserialize` derive to `FileDiff` and `WorktreeDiffReport`. (6) Write unit tests.
  - Verify: `cargo test --lib commands::orchestrator && cargo test --lib router::orchestrator && grep -q 'auto_commit_worktree' src-tauri/src/commands/orchestrator.rs && grep -q 'diffs_ready' src-tauri/src/commands/orchestrator.rs`
  - Done when: Success-path cleanup removed, diffs generated before review, review prompt includes diff summaries, `diffs_ready` event emitted, all Rust tests pass

- [x] **T02: Wire frontend review flow with per-worktree diffs and merge controls** `est:1h`
  - Why: The CodeReviewView is currently a simple accept/reject summary. It needs to show per-worktree file diffs using the existing DiffReview component, with merge controls that call the existing IPC commands, and trigger cleanup only after all worktrees are handled.
  - Files: `src/stores/taskStore.ts`, `src/hooks/orchestration/handleOrchEvent.ts`, `src/components/views/CodeReviewView.tsx`
  - Do: (1) Add `worktreeEntries` state (Map<string, {dagId, branchName, fileCount, additions, deletions}>) plus setter to taskStore. Clear on `clearSession`. (2) Add `diffs_ready` case to OrchEvent union type and handleOrchEvent handler — populate worktreeEntries from event payload. (3) Rewrite CodeReviewView: show review summary at top (existing), then a tabbed/list per-worktree section where each worktree renders the existing DiffReview component. Add "Accept All & Merge" and per-worktree merge/discard buttons. After all worktrees handled, call `cleanupWorktrees()` from useWorktree hook and transition to 'completed'. Handle zero-changes case. (4) Import and use `useWorktree` hook and `useUIStore.projectDir`.
  - Verify: `cd /Users/birkankader/Documents/Projects/WhaleCode && npx tsc --noEmit` (copy modified files to main project first) and `grep -q 'diffs_ready' src/hooks/orchestration/handleOrchEvent.ts && grep -q 'DiffReview' src/components/views/CodeReviewView.tsx && grep -q 'worktreeEntries' src/stores/taskStore.ts`
  - Done when: TypeScript compiles with zero errors, CodeReviewView renders DiffReview per worktree, merge/discard buttons wired to IPC, cleanup fires after all worktrees handled

## Files Likely Touched

- `src-tauri/src/commands/orchestrator.rs`
- `src-tauri/src/router/orchestrator.rs`
- `src-tauri/src/worktree/models.rs`
- `src/stores/taskStore.ts`
- `src/hooks/orchestration/handleOrchEvent.ts`
- `src/components/views/CodeReviewView.tsx`
