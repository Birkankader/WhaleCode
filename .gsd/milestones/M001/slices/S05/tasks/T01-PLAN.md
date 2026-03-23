---
estimated_steps: 4
estimated_files: 2
skills_used: []
---

# T01: Fix diffs_ready field mismatch and add startup worktree cleanup

**Slice:** S05 — End-to-End Integration & Polish
**Milestone:** M001

## Description

Two confirmed integration bugs block the end-to-end pipeline:

1. **`diffs_ready` field name mismatch:** The backend emits `@@orch::diffs_ready` with a JSON field `"worktrees"` but the frontend TypeScript type and handler expect `"diffs"`. This causes `ev.diffs` to be `undefined`, so `worktreeEntries` in the task store is never populated, and CodeReviewView shows "No file changes to review" even when workers made changes.

2. **Missing startup worktree cleanup:** `WorktreeManager::cleanup_stale_worktrees()` exists and is exposed as the `cleanupWorktrees` Tauri command, but nothing calls it on app startup. If the app crashes during review, stale worktrees accumulate until manually cleaned.

## Steps

1. Open `src-tauri/src/commands/orchestrator.rs` and find the `emit_orch(&on_event, "diffs_ready", ...)` call (around line 1519-1521). Change the JSON field name from `"worktrees"` to `"diffs"` so it matches the frontend's `OrchEvent` type definition (`{ type: 'diffs_ready'; diffs: Array<...> }`).

2. Open `src/routes/index.tsx`. Add a `useEffect` that watches `projectDir` (from `useUIStore`) and calls `commands.cleanupWorktrees(projectDir)` when it becomes non-empty. This fires once when the user opens a project, cleaning up any stale worktrees from crashed previous sessions. The `commands` import already exists in this file at line 17.

3. Run `cd src-tauri && cargo test --lib` to confirm all Rust tests still pass. The rename is in runtime code, not in any test fixture, so tests should be unaffected.

4. Run `npx tsc --noEmit` (from project root) to confirm TypeScript compiles clean after the routes/index.tsx change.

## Must-Haves

- [ ] `diffs_ready` emit in `orchestrator.rs` uses field name `"diffs"` (not `"worktrees"`)
- [ ] `src/routes/index.tsx` calls `commands.cleanupWorktrees(projectDir)` in a useEffect when projectDir is non-empty
- [ ] All Rust tests pass (`cargo test --lib` in src-tauri)
- [ ] TypeScript compiles with zero errors (`npx tsc --noEmit`)

## Verification

- `rg '"diffs"' src-tauri/src/commands/orchestrator.rs` — finds the diffs_ready emit with `"diffs"` field
- `rg 'cleanupWorktrees' src/routes/index.tsx` — finds the startup cleanup call
- `cd src-tauri && cargo test --lib 2>&1 | tail -3` — "test result: ok" with 0 failures
- `npx tsc --noEmit 2>&1 | tail -3` — zero errors

## Inputs

- `src-tauri/src/commands/orchestrator.rs` — contains the `diffs_ready` emit with wrong field name `"worktrees"` at ~line 1520
- `src/routes/index.tsx` — App component with existing useEffect hooks; needs startup cleanup added
- `src/hooks/orchestration/handleOrchEvent.ts` — defines the `OrchEvent` type expecting `diffs` field (do NOT modify — this is the reference for what the backend should emit)
- `src/stores/uiStore.ts` — provides `projectDir` state via `useUIStore`

## Expected Output

- `src-tauri/src/commands/orchestrator.rs` — `"worktrees"` renamed to `"diffs"` in diffs_ready JSON emit
- `src/routes/index.tsx` — new useEffect that calls `commands.cleanupWorktrees(projectDir)` on startup

## Observability Impact

- **New signal:** `console.warn('Startup worktree cleanup failed:', err)` emitted when the cleanup command fails on project open. Absence = success.
- **Inspection:** After orchestration, check `useTaskStore.getState().worktreeEntries` — a populated Map confirms diffs_ready wiring works. Empty Map after workers completed = field name mismatch still present.
- **Failure visibility:** Cleanup errors are non-blocking (fire-and-forget with .catch). No user-facing error shown; browser console is the diagnostic surface.
