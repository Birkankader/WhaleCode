# S04: Review, Merge & Cleanup

**Goal:** Review agent receives actual worktree diffs, per-worktree collapsible diff cards display in the UI, granular merge/discard per worktree works, and worktrees are cleaned up automatically after orchestration and on app startup.
**Demo:** After workers finish, the orchestrator auto-commits each worktree, generates diffs, emits `diffs_ready` to populate the review UI, and passes real diff text to the review agent. The user sees per-worktree diff cards, can merge or discard individually, and all worktrees are cleaned up when done.

## Must-Haves

- Auto-commit + diff generation for each worktree after Phase 2 workers complete
- `diffs_ready` event emitted with per-worktree metadata (dag_id, branch_name, file_count, additions, deletions)
- Review prompt includes truncated unified diffs so the review agent sees actual file changes
- Navigation auto-switches to review view when `orchestrationPhase === 'reviewing'` (not `'completed'`)
- Targeted `remove_single_worktree` IPC command for discarding individual worktrees
- DiffReview discard calls targeted removal, not blanket stale cleanup
- Startup worktree cleanup on app mount when projectDir is set
- Zero-changes worktrees handled gracefully (empty diff, still shown with discard option)

## Proof Level

- This slice proves: integration (backend-to-frontend pipeline for diffs + review + cleanup)
- Real runtime required: no (contract-level verification via unit tests + wiring checks)
- Human/UAT required: no (S06 covers full end-to-end UAT)

## Verification

- `cargo test --lib -- "router::"` — existing review prompt tests pass + new `build_review_prompt_with_diffs` test
- `npx tsc --noEmit` — 0 TypeScript errors
- `npx vitest run` — 94+ tests pass (existing suite)
- Wiring checks:
  - `rg "diffs_ready" src-tauri/src/commands/orchestrator.rs` → ≥1 match
  - `rg "auto_commit_worktree" src-tauri/src/commands/orchestrator.rs` → ≥1 match
  - `rg "generate_worktree_diff" src-tauri/src/commands/orchestrator.rs` → ≥1 match
  - `rg "'reviewing'" src/routes/index.tsx` → matches auto-navigate condition
  - `rg "remove_single_worktree" src-tauri/src/commands/worktree.rs` → ≥1 match
  - `rg "cleanupWorktrees\|cleanup_worktrees" src/routes/index.tsx` → ≥1 match (startup cleanup)
- `cargo test --lib -- "worktree::"` — 22 existing tests pass

## Observability / Diagnostics

- Runtime signals: `diffs_ready` event with per-worktree metadata; `phase_changed` to `'reviewing'`; log warnings for failed auto-commit or diff generation per worktree
- Inspection surfaces: `worktreeEntries` in taskStore (Map<string, WorktreeReviewEntry>); orchestrationLogs entries for diff phase
- Failure visibility: Per-worktree auto-commit/diff errors logged but don't halt orchestration — failed worktrees appear with zero-change card and error context
- Redaction constraints: none

## Integration Closure

- Upstream surfaces consumed: `worktree_entries` HashMap in orchestrator (from S02); `worktreeEntries` store + `diffs_ready` handler in frontend (from S03); `auto_commit_worktree()` in `conflict.rs`; `generate_worktree_diff()` in `diff.rs`; `WorktreeManager::remove_worktree()` in `manager.rs`
- New wiring introduced in this slice: orchestrator calls auto-commit + diff between Phase 2 and Phase 3; `diffs_ready` event emission; enriched review prompt; `remove_single_worktree` IPC command; startup cleanup call
- What remains before the milestone is truly usable end-to-end: S05 (UI cleanup/polish), S06 (full pipeline UAT)

## Tasks

- [x] **T01: Wire auto-commit, diff generation, diffs_ready emission, and enriched review prompt in orchestrator** `est:1h30m`
  - Why: The frontend review UI is fully built but receives no data — the backend never auto-commits worktrees, never generates diffs, never emits `diffs_ready`, and the review prompt only shows text output summaries. This task bridges that gap, activating the entire review flow.
  - Files: `src-tauri/src/commands/orchestrator.rs`, `src-tauri/src/router/orchestrator.rs`
  - Do: After Phase 2 waves complete but before Phase 3 review starts, iterate `worktree_entries`, call `auto_commit_worktree()` on each worktree path (via `spawn_blocking`), then `generate_worktree_diff()` on each branch with `project_dir`. Collect per-worktree metadata and emit a single `diffs_ready` event. Add `build_review_prompt_with_diffs()` method to `Orchestrator` that includes truncated unified diff text (cap total at ~20KB). Replace the `build_review_prompt()` call in the orchestrator with the new diff-enriched variant. Handle zero-changes worktrees (no diff, still include in diffs_ready with file_count=0). Log warnings for individual worktree failures but continue with remaining worktrees.
  - Verify: `cargo test --lib -- "router::"` passes including new test; `rg "diffs_ready" src-tauri/src/commands/orchestrator.rs` shows ≥1 match; `rg "auto_commit_worktree" src-tauri/src/commands/orchestrator.rs` shows ≥1 match
  - Done when: orchestrator auto-commits worktrees, generates diffs, emits `diffs_ready`, and review prompt contains actual diff text

- [x] **T02: Fix navigation timing, add targeted worktree removal, and wire startup cleanup** `est:1h`
  - Why: Navigation currently goes to review on `'completed'` instead of `'reviewing'` — the user misses the review screen. Discard only does blanket stale cleanup instead of targeted removal. No startup cleanup exists. These are the remaining R009/R012 pieces.
  - Files: `src/routes/index.tsx`, `src-tauri/src/commands/worktree.rs`, `src-tauri/src/lib.rs`, `src/components/review/DiffReview.tsx`, `src/hooks/useWorktree.ts`
  - Do: (1) Change auto-navigate condition from `'completed'` to `'reviewing'` in `src/routes/index.tsx`. (2) Add `remove_single_worktree` IPC command in `worktree.rs` that takes `project_dir` and `branch_name`, derives the worktree name, and calls `WorktreeManager::remove_worktree()`. Register it in `src-tauri/src/lib.rs` invoke_handler. (3) Wire `DiffReview.handleDiscard()` to call the new targeted removal instead of blanket `cleanupWorktrees()`. Add `removeWorktree` to `useWorktree` hook. (4) Add startup cleanup: call `cleanupWorktrees` on app mount in `src/routes/index.tsx` when `projectDir` is set (useEffect on mount). (5) Handle zero-changes case in DiffReview — show explicit empty state with discard option.
  - Verify: `npx tsc --noEmit` passes; `npx vitest run` passes; `rg "'reviewing'" src/routes/index.tsx` shows match; `rg "remove_single_worktree" src-tauri/src/commands/worktree.rs` shows match
  - Done when: review view appears during `'reviewing'` phase, discard removes the specific worktree, stale worktrees cleaned on startup

- [x] **T03: Verification — new tests, wiring checks, and full suite regression** `est:45m`
  - Why: Ensures the new orchestrator logic is correct, all wiring is in place, and no regressions were introduced across Rust and TypeScript codebases.
  - Files: `src-tauri/src/router/orchestrator.rs`, `src-tauri/src/commands/orchestrator_test.rs`
  - Do: (1) Add unit test for `build_review_prompt_with_diffs()` in `router/orchestrator.rs` tests — verify diff text appears in prompt, verify truncation at ~20KB, verify zero-diff handling. (2) Run full wiring check suite (all `rg` commands from Verification section). (3) Run `cargo test --lib -- "worktree::"` (22 tests), `cargo test --lib -- "router::"` (~50 tests), `cargo test --lib orchestrator_test` (~29 tests). (4) Run `npx tsc --noEmit` and `npx vitest run`. (5) Fix any regressions found.
  - Verify: All test suites pass; all wiring checks return expected matches; `npx tsc --noEmit` exits 0; `npx vitest run` reports 94+ tests passing
  - Done when: all verification commands pass with zero failures

## Files Likely Touched

- `src-tauri/src/commands/orchestrator.rs`
- `src-tauri/src/router/orchestrator.rs`
- `src-tauri/src/commands/worktree.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/commands/orchestrator_test.rs`
- `src/routes/index.tsx`
- `src/components/review/DiffReview.tsx`
- `src/hooks/useWorktree.ts`
