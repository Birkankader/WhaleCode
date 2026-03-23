# S04 — Research: Review & Merge Pipeline

**Date:** 2026-03-20
**Depth:** Targeted — established patterns exist in the codebase, but the wiring between subsystems is absent and the flow has a critical ordering bug.

## Summary

S04's job is to wire the existing worktree diff, review, and merge infrastructure into the orchestration pipeline so that: (1) the review agent receives actual file diffs instead of just stdout summaries, (2) the UI shows per-worktree file changes with merge controls, and (3) worktrees are cleaned up only after the user has reviewed and merged.

The backend primitives are **complete and well-tested**: `generate_worktree_diff`, `selective_merge`, `auto_commit_worktree`, `detect_conflicts`, and all 5 Tauri IPC commands (`create_worktree`, `get_worktree_diff`, `merge_worktree`, `check_worktree_conflicts`, `cleanup_worktrees`). The frontend components also exist: `DiffReview` (file-level diff viewer with per-file accept/reject checkboxes), `FileDiffView` (unified diff renderer), `CodeReviewPanel` (per-worktree approve/reject), and `useWorktree` hook (wraps all IPC).

The critical problem is **ordering**: the orchestrator cleans up all worktrees immediately after Phase 3 completes (lines ~1537-1547 in `commands/orchestrator.rs`), before the user can review diffs or merge. This destroys the branches and directories that `get_worktree_diff` and `merge_worktree` need. Additionally, the review prompt feeds the review agent only `output_summary` (stdout text), not actual diffs. And the frontend `CodeReviewView` is a simple accept/reject view — it doesn't surface per-worktree diffs or merge controls.

## Recommendation

Three-phase approach matching the three requirements:

1. **Backend: Defer cleanup + enrich review prompt (R008, R012)** — Move worktree cleanup out of `dispatch_orchestrated_task` and into a new phase that fires only after merge. Before Phase 3, call `auto_commit_worktree` + `generate_worktree_diff` on each worktree entry and include the diffs in the review prompt alongside output summaries. Emit a `@@orch::diffs_ready` event carrying per-worktree diff summaries (branch_name, file count, additions, deletions, dag_id) so the frontend knows what to render.

2. **Frontend: Wire review → merge flow (R009)** — Upgrade `CodeReviewView` to show per-worktree diffs using the existing `DiffReview` component. When orchestrationPhase transitions to `reviewing`, the frontend should use `worktree_entries` data (emitted via `@@orch::diffs_ready`) to render a tabbed view: one tab per worktree, each showing `DiffReview`. Merge controls (accept per-worktree, reject, accept all) invoke the existing `merge_worktree` IPC. After merge or discard, emit cleanup.

3. **Cleanup after merge (R012)** — After the user acts on all worktrees (merge or discard), call `cleanup_worktrees` via IPC. The backend already handles this. Add a `@@orch::merge_complete` event path and only then transition to `completed`.

## Implementation Landscape

### Key Files

**Backend (Rust):**
- `src-tauri/src/commands/orchestrator.rs` (2562 lines) — The orchestration pipeline. Phase 3 review (lines ~1446-1569) needs restructuring: insert auto_commit + diff generation before review prompt, include diffs in prompt, defer cleanup, emit `diffs_ready` event. Currently cleans up worktrees at line ~1537.
- `src-tauri/src/router/orchestrator.rs` — `build_review_prompt()` at line 157. Currently takes `&[WorkerResult]` with `output_summary` only. Needs a new signature or companion method that includes `WorktreeDiffReport` per worker.
- `src-tauri/src/worktree/diff.rs` — `generate_worktree_diff()` and `selective_merge()` — fully implemented, well-tested, ready to call from orchestrator.
- `src-tauri/src/worktree/conflict.rs` — `auto_commit_worktree()` — needed before generating diffs to capture uncommitted agent changes.
- `src-tauri/src/commands/worktree.rs` — 5 Tauri IPC commands all implemented. `merge_worktree` already does conflict checks, auto-commit, selective merge, and post-merge worktree cleanup. Ready to use as-is from frontend.

**Frontend (TypeScript/React):**
- `src/hooks/orchestration/handleOrchEvent.ts` — Needs new event handlers: `diffs_ready` (store worktree diff metadata), `worktrees_cleaned` (already defined in OrchEvent type). OrchEvent union type needs extending.
- `src/components/views/CodeReviewView.tsx` — Currently a simple accept/reject summary view. Needs major upgrade to show per-worktree diffs using `DiffReview`, merge controls, and cleanup trigger.
- `src/components/review/DiffReview.tsx` — File-level diff review with per-file checkboxes, merge button, discard button. Already functional — just needs to be rendered per-worktree inside the review flow.
- `src/hooks/useWorktree.ts` — `getWorktreeDiff()`, `selectiveMerge()`, `cleanupWorktrees()` all implemented. Ready to use.
- `src/stores/taskStore.ts` — Needs state for worktree entries (branch names per task) so review view can call diff/merge IPC. Currently has no worktree data.
- `src/routes/index.tsx` — Auto-navigates to `review` view when `orchestrationPhase === 'reviewing'`. This is correct, but the review view needs to block completion until merge/discard is done.

**Existing but not currently used in orchestration flow:**
- `src/components/review/CodeReviewPanel.tsx` — Per-worktree review panel with approve/reject per item, feedback input, "Proceed to Merge" button. Has the right interface (`ReviewItem` with `worktreeBranch`, `filesChanged`, `additions`, `deletions`) but is not wired to real data.
- `src/components/WorktreeStatus.tsx` — Worktree list with merge/review/conflict-check controls. Could be used in review view.

### Build Order

1. **Backend: Defer cleanup + generate diffs before review** (unblocks everything)
   - Remove the immediate `remove_worktree` loop after Phase 3 (lines ~1537-1547)
   - Before Phase 3 review prompt: call `auto_commit_worktree` on each worktree entry, then `generate_worktree_diff` to get `WorktreeDiffReport` per worker
   - Enhance `build_review_prompt` (or add `build_review_prompt_with_diffs`) to include diff summaries in the review agent's prompt
   - Emit `@@orch::diffs_ready` event with per-worktree metadata (branch_name, dag_id, file_count, additions, deletions)
   - Change `OrchestrationPhase::Completed` to only fire after a new `@@orch::merge_complete` signal or when cleanup is externally triggered
   - Add a new Tauri command or use existing `cleanup_worktrees` + frontend-driven completion

2. **Frontend: Store worktree data + upgrade review view** (depends on backend events)
   - Add `worktreeEntries` to taskStore (Map<string, {branchName, dagId, fileCount, additions, deletions}>)
   - Handle `diffs_ready` in `handleOrchEvent.ts` to populate worktreeEntries
   - Rewrite `CodeReviewView` to show a tabbed per-worktree diff review using existing `DiffReview` component
   - After user merges or discards each worktree, call `cleanup_worktrees` IPC
   - Transition to completed phase only after all worktrees are handled

3. **Tests + verification** (parallel with above)
   - Backend: unit tests for new review prompt with diffs, test that cleanup is deferred
   - Frontend: TypeScript compilation check for modified files

### Verification Approach

**Backend:**
- `cargo test --lib commands::orchestrator` — existing 57 tests must pass + new tests for diff-enriched review prompt and deferred cleanup
- `cargo test --lib worktree` — existing 24 tests must pass (no changes to worktree modules themselves)
- `grep` checks: `auto_commit_worktree` called in orchestrator, `generate_worktree_diff` called in orchestrator, `diffs_ready` emitted, immediate cleanup removed

**Frontend:**
- `npx tsc --noEmit` — TypeScript compilation with zero errors
- `grep` checks: `diffs_ready` handled in `handleOrchEvent.ts`, `DiffReview` rendered in `CodeReviewView`, `worktreeEntries` in taskStore, `merge_worktree` or `selectiveMerge` called from review flow

**Integration (deferred to S05):**
- Full pipeline run through GUI: decompose → approve → execute → review with diffs visible → merge selected → cleanup → done

## Constraints

- **Worktree operations must run on `spawn_blocking`** — `generate_worktree_diff` uses git2 which is synchronous. The orchestrator already runs in an async context, so all worktree calls need `tokio::task::spawn_blocking` (the existing Tauri commands already do this; the orchestrator must follow the same pattern).
- **`WorktreeDiffReport` is `Serialize + Type` but not `Deserialize`** — It derives `Serialize` and `specta::Type` but not `Deserialize`. This is fine for emitting to frontend but means it can't be stored in `OrchestrationPlan` (which derives both). If diff reports need to be stored in the plan, add `Deserialize` to `WorktreeDiffReport` and `FileDiff`.
- **Review prompt size** — Full unified diffs could be very large. The review prompt should include truncated diff summaries (file list + stats), not full patches. The `MAX_PATCH_SIZE` (50KB) truncation in `generate_worktree_diff` helps but the aggregate could still be huge. Consider a summary-only variant.
- **OrchEvent types are manual** — Any new `@@orch::` event type (e.g., `diffs_ready`) requires manual TypeScript type additions to the `OrchEvent` union in `handleOrchEvent.ts`.
- **Frontend `commands` bindings are auto-generated** — The worktree IPC commands exist in `bindings.ts` already. No regeneration needed unless new commands are added.

## Common Pitfalls

- **Cleanup destroys merge data** — The current orchestrator deletes worktrees and branches immediately after Phase 3. If this isn't fixed first, all diff/merge work is impossible. This must be the first change.
- **auto_commit_worktree must run before generate_worktree_diff** — Agents may leave uncommitted changes in worktrees. Without auto-commit, `generate_worktree_diff` would show empty diffs. The existing `commands/worktree.rs` commands handle this automatically, but the orchestrator's internal calls must too.
- **`generate_worktree_diff` operates on the main repo, not the worktree** — It takes `repo_path` (the main project) and `branch_name`, not the worktree path. The auto-commit must target the worktree path, but the diff generation targets the main repo.
- **Multiple merges to the same default branch** — If two worktrees are merged sequentially, the second merge's diff base has changed (main branch moved forward from the first merge). The existing `selective_merge` handles this correctly (it reads the current default branch tree), but conflict detection should be re-run between merges.
- **"Zero changes" case** — A worktree where the agent made no changes should still be reviewable (show "No changes" state) and the action buttons should be visible. `DiffReview` already handles empty file lists but should show an explicit "No changes" message with a discard button.

## Open Risks

- **Review prompt token budget** — Including full diffs in the review prompt could exceed the agent's context window for large tasks. May need a summary-only mode that includes file names + stats but not full patches. The review agent can still provide useful integration analysis from file-level changes.
- **Race between merge and cleanup** — If the user closes the app mid-review, worktrees remain on disk. The existing `cleanup_stale_worktrees` handles this on next startup, but the orchestrator state (plan) is lost. This is acceptable for M001 — crash recovery is out of scope.
