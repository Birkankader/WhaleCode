# S05: End-to-End Integration & Polish

**Goal:** Full orchestration pipeline (decompose → approve → parallel execute → review → merge) works reliably with all integration bugs fixed and all requirements verified.
**Demo:** All 373+ Rust tests pass, TypeScript compiles cleanly, `diffs_ready` event correctly populates the frontend review view, stale worktrees are cleaned on startup, and every requirement deferred to S05 UAT (R001, R002, R005, R006, R007, R008, R009, R010, R012) has scripted verification proving the contract is wired end-to-end.

## Must-Haves

- Backend `diffs_ready` event field name matches frontend expectation (`"diffs"` not `"worktrees"`)
- Startup worktree cleanup runs when the app launches (via `useEffect` on `projectDir`)
- All 373+ existing Rust tests pass
- TypeScript compiles with zero production errors
- Every requirement R001–R012 (except R003, R004, R011 validated earlier) has at least one scripted consistency check proving backend↔frontend wiring

## Proof Level

- This slice proves: final-assembly
- Real runtime required: yes (UAT through GUI — documented as manual steps)
- Human/UAT required: yes (real CLI agents needed for full pipeline run)

## Verification

- `cd src-tauri && cargo test --lib 2>&1 | tail -3` — shows "test result: ok" with 0 failures
- `npx tsc --noEmit --project tsconfig.json 2>&1 | tail -3` — zero errors
- `bash .gsd/milestones/M001/slices/S05/verify-s05.sh` — all checks pass (field name consistency, startup cleanup, requirement wiring)

## Integration Closure

- Upstream surfaces consumed: All S01–S04 outputs — `SubTaskDef` parsing, worktree creation, `dagToFrontendId` matching, `activePlan` from events, per-worker output attribution, `build_review_prompt_with_diffs`, `CodeReviewView` merge controls, `diffs_ready` event, worktree cleanup
- New wiring introduced in this slice: `"worktrees"` → `"diffs"` field rename in backend diffs_ready emit; startup worktree cleanup effect in App component
- What remains before the milestone is truly usable end-to-end: Manual UAT with real CLI agents (documented as runbook steps in verify script)

## Tasks

- [x] **T01: Fix diffs_ready field mismatch and add startup worktree cleanup** `est:30m`
  - Why: Two confirmed integration bugs prevent the review UI from rendering worktree diffs and allow stale worktrees to accumulate across sessions
  - Files: `src-tauri/src/commands/orchestrator.rs`, `src/routes/index.tsx`
  - Do: (1) In orchestrator.rs line 1520, rename `"worktrees"` to `"diffs"` in the `diffs_ready` JSON emit. (2) In `src/routes/index.tsx`, add a `useEffect` that calls `commands.cleanupWorktrees(projectDir)` when `projectDir` becomes non-empty. Import `commands` if needed.
  - Verify: `cd src-tauri && cargo test --lib` passes; `npx tsc --noEmit` passes; `rg '"diffs"' src-tauri/src/commands/orchestrator.rs` finds the renamed field; `rg 'cleanupWorktrees' src/routes/index.tsx` finds the startup call
  - Done when: Both bugs are fixed, all tests pass, TypeScript compiles clean

- [x] **T02: Write and run S05 verification suite** `est:45m`
  - Why: Every requirement deferred to S05 UAT needs scripted proof that backend↔frontend contracts are wired. This is the milestone's final verification gate.
  - Files: `.gsd/milestones/M001/slices/S05/verify-s05.sh`
  - Do: Write a bash verification script that checks: (1) `diffs_ready` field consistency between backend and frontend, (2) startup cleanup call exists, (3) R001 wiring (SubTaskDef.id + parse_decomposition), (4) R002 wiring (decomposition_failed event + DecompositionErrorCard), (5) R005 wiring (dag_id in SubTaskDef + DAG scheduler), (6) R006 wiring (activePlan set from phase_changed), (7) R007 wiring (dagToFrontendId matching, no FIFO), (8) R008 wiring (build_review_prompt_with_diffs exists), (9) R009 wiring (CodeReviewView + DiffReview + merge controls), (10) R010 wiring (worker_output events + orch_tag), (11) R012 wiring (cleanup_stale_worktrees + cleanupWorktrees calls). Run `cargo test --lib` and `npx tsc --noEmit`. Run the script and confirm all checks pass.
  - Verify: `bash .gsd/milestones/M001/slices/S05/verify-s05.sh` exits 0 with all checks passing
  - Done when: Verification script exists, passes, and covers all 9 targeted requirements

## Observability / Diagnostics

- **diffs_ready wiring:** After orchestration, `useTaskStore.getState().worktreeEntries` should be a populated Map. Empty Map means the backend→frontend field name is mismatched.
- **Startup cleanup:** `console.warn('Startup worktree cleanup failed:', ...)` in browser console indicates the cleanup command failed. Absence of this warning = success.
- **Verification script:** `verify-s05.sh` prints per-check PASS/FAIL lines and exits non-zero on any failure.
- **Redaction:** No secrets or user data in any of these signals.

## Files Likely Touched

- `src-tauri/src/commands/orchestrator.rs`
- `src/routes/index.tsx`
- `.gsd/milestones/M001/slices/S05/verify-s05.sh`
