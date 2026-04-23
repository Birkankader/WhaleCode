# Visual obs 02 — base-branch dirty stash helper (Step 2)

**Recorded:** 2026-04-23 using the `seed.txt` dirty-base pattern
already exercised by Phase 4's `apply_with_dirty_base_branch_keeps_
run_in_merging_and_emits_event` test.

## What to watch

- Dirty base → Apply → `BaseBranchDirty` event fires → ErrorBanner
  shows with inline "Stash & retry apply" button (Phase 5 Step 2
  addition, sibling to the existing Dismiss button).
- Click → `stash_and_retry_apply` IPC → `StashCreated` event →
  merge retries → either succeeds (→ ApplySummary) or conflicts
  (→ MergeConflict, goes into Phase 5 Step 3 path).
- `StashBanner` renders below the main ErrorBanner surface — info-
  accent (running color) on "held" variant, error-accent on
  "conflict" variant.

## Observations

1. **Registry lives on Orchestrator.** Stash entries persist
   outside the per-run `Run` struct — crucial for the post-Done
   pop case where the run is torn down from the in-memory map.
   `pop_stash_happy_path_restores_dirty_content` asserts pop after
   Done reaches. Pop by SHA lookup via `git stash list --format=%H`
   translates to symbolic `stash@{N}` at pop time — defends against
   the user running `git stash` manually between push and pop
   (blind `stash@{0}` would pop the wrong entry).
2. **Short-ref + full-copy clipboard.** Banner shows first 10 chars
   of the SHA inline. Copy button writes the full SHA. Check icon
   swaps in for 1.5s on success; errors swallowed silently (iframe
   / HTTP refused clipboard — the ref is visible inline for manual
   selection anyway).
3. **"Pop now / Copy ref / Dismiss" decision per spec.** All three
   actions present in the "held" variant; the conflict variant
   hides the Pop button and shows "resolve in editor + git stash
   drop" copy instead. Dismissed-in-session via a local `dismissed`
   flag keyed on the ref; switching runs re-shows.
4. **`RetryReason::Conflict` vs `::DirtyBase`.** The main merge
   loop's retry counter only bumps on conflict retries, not on
   dirty-base retries. Without this the first `stash_and_retry_
   apply` + subsequent conflict would have fired `MergeRetryFailed`
   (attempt=1) instead of the stable `MergeConflict` event — a
   regression for Phase 3's event-contract consumers. Caught during
   Step 2 tests and fixed in the same commit.

## Regressions: none post the `RetryReason` discrimination.
