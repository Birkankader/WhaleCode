---
id: T03
parent: S01
milestone: M002
provides:
  - humanizeError wired into DecompositionErrorCard for user-friendly error display
  - 3 new decomposition-specific error patterns (parse failure, fallback single task, timeout)
  - Raw error text preserved in expandable orchestration logs section
key_files:
  - src/lib/humanizeError.ts
  - src/components/orchestration/DecompositionErrorCard.tsx
  - src/tests/humanizeError.test.ts
key_decisions:
  - Removed old "Master agent timed out" pattern since the new decomposition-specific timeout pattern now matches first with a better message; avoids dead-code confusion
patterns_established:
  - Decomposition-specific patterns placed at top of ERROR_PATTERNS array so they match before generic patterns (e.g., "not valid JSON" matches decomposition pattern before generic "could not parse JSON")
observability_surfaces:
  - DecompositionErrorCard now shows humanized messages via humanizeError(); raw error text remains accessible in expandable "Orchestration Logs" section
  - The humanization chain is: backend decomposition_failed event → handleOrchEvent.ts sets masterTask.resultSummary → DecompositionErrorCard reads rawError → humanizeError(rawError) → display
duration: 10m
verification_result: passed
completed_at: 2026-03-23
blocker_discovered: false
---

# T03: Wire humanizeError into DecompositionErrorCard and add decomposition-specific patterns

**Wired humanizeError into DecompositionErrorCard error display and added 3 decomposition-specific patterns (parse failure, fallback single task, timeout) with 4 new tests**

## What Happened

Added 3 decomposition-specific patterns to the top of `ERROR_PATTERNS` in `humanizeError.ts`:
1. Parse failure (`Decomposition parse failed|not valid JSON|Could not parse decomposition`) → friendly message about unexpected response format
2. Fallback single task (`Falling back to.*single task|Fallback:.*single task`) → friendly message that task will run as single task
3. Decomposition timeout (`timed out during.*decomposition|Master agent timed out`) → friendly timeout message with actionable suggestions

Removed the old generic "Master agent timed out" pattern that was lower in the array, since the new decomposition-specific timeout pattern now matches first with a better, more actionable message.

In `DecompositionErrorCard.tsx`, imported `humanizeError` and refactored the error derivation: the raw error string is now computed as `rawError`, then passed through `humanizeError()` to produce the displayed `errorMessage`. The expandable "Orchestration Logs" section continues to show raw log entries unmodified, preserving technical detail for debugging.

Added 4 new test cases covering: decomposition parse failure, "not valid JSON" variant, fallback single task, and decomposition timeout. All 14 tests (10 existing + 4 new) pass.

## Verification

- `npx vitest run src/tests/humanizeError.test.ts` — 14/14 tests pass (10 existing + 4 new)
- `npx tsc --noEmit` — zero errors
- `grep "humanizeError" DecompositionErrorCard.tsx` — 2 matches (import + usage)
- `grep "parse decomposition|single task|timed out.*decomposition" humanizeError.ts` — 4 matches (new patterns present)
- `cargo test --lib orchestrator_test` — 21/21 pass (from T01/T02, confirming no regression)
- `grep "emit_orch.*decomposition_failed" orchestrator.rs` — 5 matches (from T02)
- `grep 'pub id: Option<String>' router/orchestrator.rs` — 1 match (from T01)

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx vitest run src/tests/humanizeError.test.ts` | 0 | ✅ pass (14/14) | 3.3s |
| 2 | `npx tsc --noEmit` | 0 | ✅ pass | 3.3s |
| 3 | `grep "humanizeError" src/components/orchestration/DecompositionErrorCard.tsx` | 0 | ✅ pass (2 matches) | <1s |
| 4 | `grep -E "parse decomposition\|single task\|timed out.*decomposition" src/lib/humanizeError.ts` | 0 | ✅ pass (4 matches) | <1s |
| 5 | `cd src-tauri && cargo test --lib orchestrator_test` | 0 | ✅ pass (21/21) | 6.5s |
| 6 | `grep "emit_orch.*decomposition_failed" src-tauri/src/commands/orchestrator.rs` | 0 | ✅ pass (5 matches) | <1s |
| 7 | `grep 'pub id: Option<String>' src-tauri/src/router/orchestrator.rs` | 0 | ✅ pass (1 match) | <1s |

## Diagnostics

- **Inspect humanizeError wiring**: `grep -n "humanizeError" src/components/orchestration/DecompositionErrorCard.tsx`
- **Inspect new patterns**: `grep -n "Decomposition parse\|single task\|timed out.*decomposition" src/lib/humanizeError.ts`
- **Runtime flow**: `decomposition_failed` event → `handleOrchEvent.ts` sets `masterTask.resultSummary` → `DecompositionErrorCard` reads it as `rawError` → `humanizeError(rawError)` returns friendly message → displayed in error card. Raw logs remain in expandable section.
- **Test coverage**: `npx vitest run src/tests/humanizeError.test.ts` covers all 3 new patterns plus existing 10 patterns

## Deviations

- Removed the old generic `Master agent timed out` pattern (line ~24 in original) since the new decomposition-specific pattern at the top of the array already matches and provides a better message. No existing tests depended on the old pattern's specific output.

## Known Issues

None.

## Files Created/Modified

- `src/lib/humanizeError.ts` — Added 3 decomposition-specific patterns at top of ERROR_PATTERNS array; removed superseded generic "Master agent timed out" pattern
- `src/components/orchestration/DecompositionErrorCard.tsx` — Imported humanizeError, refactored error derivation to compute rawError then humanize for display
- `src/tests/humanizeError.test.ts` — Added 4 new test cases for decomposition-specific error patterns
