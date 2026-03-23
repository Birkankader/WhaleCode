---
id: T01
parent: S05
milestone: M001
provides:
  - diffs_ready backend→frontend field name consistency
  - startup worktree cleanup on project open
key_files:
  - src-tauri/src/commands/orchestrator.rs
  - src/routes/index.tsx
key_decisions: []
patterns_established:
  - useEffect cleanup pattern: fire-and-forget command call with .catch() console.warn on projectDir change
observability_surfaces:
  - console.warn('Startup worktree cleanup failed:', err) on cleanup failure
  - diffs_ready event now populates worktreeEntries in taskStore (observable via React DevTools or store.getState())
duration: 25m
verification_result: partial
completed_at: 2026-03-20
blocker_discovered: false
---

# T01: Fix diffs_ready field mismatch and add startup worktree cleanup

**Renamed `"worktrees"` → `"diffs"` in backend diffs_ready emit and added startup worktree cleanup useEffect on projectDir change**

## What Happened

Two integration bugs were fixed:

1. **diffs_ready field mismatch:** In `src-tauri/src/commands/orchestrator.rs` line 1519, the `emit_orch` call for `diffs_ready` used `"worktrees"` as the JSON field name, but the frontend `OrchEvent` type in `handleOrchEvent.ts` expects `"diffs"`. Changed `"worktrees"` to `"diffs"` so `ev.diffs` resolves correctly and `worktreeEntries` in the task store gets populated, enabling CodeReviewView to show file changes.

2. **Startup worktree cleanup:** Added a `useEffect` in `src/routes/index.tsx` that watches `projectDir` from `useUIStore`. When `projectDir` becomes non-empty (user opens a project), it calls `commands.cleanupWorktrees(projectDir)` to remove stale worktrees from crashed previous sessions. Errors are caught and logged to console.warn to avoid blocking app startup.

## Verification

- `rg '"diffs"' src-tauri/src/commands/orchestrator.rs` → finds `"diffs": diffs_summary` ✅
- `rg 'cleanupWorktrees' src/routes/index.tsx` → finds `commands.cleanupWorktrees(projectDir)` ✅
- `tsc --noEmit --project tsconfig.json` → zero errors, clean exit ✅
- `cargo test --lib -- --list` → 373 tests listed, compilation succeeds ✅
- `cargo test --lib` → timed out in worktree environment (cold build overhead, not test failures)

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `rg '"diffs"' src-tauri/src/commands/orchestrator.rs` | 0 | ✅ pass | <1s |
| 2 | `rg 'cleanupWorktrees' src/routes/index.tsx` | 0 | ✅ pass | <1s |
| 3 | `tsc --noEmit --project tsconfig.json` | 0 | ✅ pass | 2s |
| 4 | `cargo test --lib -- --list` | 0 | ✅ pass (373 tests listed) | ~8min (compilation) |
| 5 | `cargo test --lib` | — | ⏱ timeout | >300s (worktree cold build) |

## Diagnostics

- **diffs_ready wiring:** After orchestration completes, check `useTaskStore.getState().worktreeEntries` in browser devtools — it should be a populated Map when workers produced changes.
- **Startup cleanup:** On app launch with a project open, browser console should NOT show "Startup worktree cleanup failed" warnings. If it does, the backend `cleanupWorktrees` command is failing.
- **Failure shape:** cleanup errors surface as `console.warn` in browser console only — they don't block the app or show user-facing errors.

## Deviations

- Had to run `npm install` in the worktree since `node_modules` doesn't carry over from the main git worktree.
- `cargo test --lib` execution timed out due to cold compilation in the worktree. The test binary compiles and lists all 373 tests successfully; the change is a single string literal rename in runtime code with no test coverage of that specific field name, so test pass is near-certain. T02 should retry this check.

## Known Issues

- `cargo test --lib` full execution not confirmed in this worktree due to compilation time. T02's verification script should include this check and will benefit from the now-warm build cache.

## Files Created/Modified

- `src-tauri/src/commands/orchestrator.rs` — renamed `"worktrees"` to `"diffs"` in diffs_ready JSON emit (line 1520)
- `src/routes/index.tsx` — added `projectDir` selector and useEffect calling `commands.cleanupWorktrees(projectDir)` on startup
