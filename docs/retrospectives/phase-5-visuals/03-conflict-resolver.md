# Visual obs 03 — merge conflict resolver popover (Step 3)

**Recorded:** 2026-04-23 using two workers writing the same file
(`shared.txt`) with incompatible content — same shape as the
Phase 4 Step 0 fake-agent fixtures for Category C but at the
merge layer.

## What to watch

- `MergeConflict` → ErrorBanner surfaces with "Open resolver"
  action + derived "Merge conflict on N files" copy (Phase 5 Step
  3 copy derivation).
- Popover renders as modal-style overlay with `fixed inset-0`
  backdrop (`z-40`). Body inside a 560px fixed-width card. File
  list + per-worker attribution chips rendered from the store's
  `subtaskDiffs` map cross-referenced with `mergeConflict.files`.
- Retry apply button fires `retry_apply` IPC; on second conflict
  the title flips to "Still conflicted (attempt N)" with the
  counter from `MergeRetryFailed.retry_attempt`.

## Observations

1. **Retry-attempt counter.** First conflict fires `MergeConflict`
   (stable Phase 2 contract). Subsequent retries fire
   `MergeRetryFailed` with `retry_attempt: u32` starting at 1.
   Counter lives in `merge_phase` loop state, incremented only on
   `RetryReason::Conflict` (the Step 2 distinction). Pinned by
   `retry_apply_increments_attempt_on_each_persistent_conflict` +
   `initial_conflict_does_not_carry_retry_attempt_counter`.
2. **Stale state falls through.** Retry apply after a raced
   discard returns `WrongState` / `RunNotFound`. Frontend toasts
   via `currentError`. Success criterion #5 directly tested by
   `retry_apply_after_discard_returns_wrong_state`.
3. **No in-app merge editor.** Per spec, we ship the workflow —
   identify conflicted files + per-worker attribution + reveal +
   retry — not a text merge UI. User resolves on base branch with
   their own tool; the reveal buttons scope to each worker's
   worktree so side-by-side comparison is cheap.
4. **conflictResolverOpen store flag.** Popover open state lives
   on the store, not local component state, so the ErrorBanner's
   "Open resolver" action can reopen after the user dismisses
   (Escape / backdrop). Auto-open on every new conflict event so
   the user never misses an attempt.

## Regressions: none.
