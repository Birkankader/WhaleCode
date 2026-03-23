---
estimated_steps: 3
estimated_files: 1
skills_used: []
---

# T02: Write and run S05 verification suite

**Slice:** S05 — End-to-End Integration & Polish
**Milestone:** M001

## Description

Every requirement deferred to S05 UAT (R001, R002, R005, R006, R007, R008, R009, R010, R012) needs scripted proof that the backend↔frontend contracts are wired end-to-end. This task writes a comprehensive bash verification script that uses `rg` (ripgrep) to check code-level wiring for each requirement, then runs `cargo test --lib` and `npx tsc --noEmit` as final gates. It also documents the manual UAT steps needed for full runtime verification with real agents.

## Steps

1. Create `verify-s05.sh` in `.gsd/milestones/M001/slices/S05/`. The script should:
   - Set `set -euo pipefail` and track pass/fail counts
   - For each requirement, run targeted `rg` checks confirming the backend↔frontend wiring:
     - **R001:** `SubTaskDef` has `id` field in `src-tauri/src/router/orchestrator.rs`; `parse_decomposition_from_output` exists
     - **R002:** `decomposition_failed` event emitted in backend (`src-tauri/src/commands/orchestrator.rs`); handled in frontend (`handleOrchEvent.ts`); `DecompositionErrorCard` reads `resultSummary` (`src/components/`)
     - **R005:** `dag_id` used in DAG scheduler; `SubTaskDef` has `id` field
     - **R006:** `setActivePlan` called from `phase_changed` handler in `handleOrchEvent.ts`; guarded with `ev.plan_id`
     - **R007:** `dagToFrontendId` used in `task_completed` handler; no `subTaskQueue.shift()` in `handleOrchEvent.ts`
     - **R008:** `build_review_prompt_with_diffs` exists in `src-tauri/src/router/orchestrator.rs`
     - **R009:** `DiffReview` imported in `CodeReviewView.tsx`; merge controls ("Merge All", per-worktree merge/discard) present; `worktreeEntries` in `taskStore.ts`
     - **R010:** `worker_output` event type in `handleOrchEvent.ts`; `orch_tag` parameter in spawn functions
     - **R012:** `cleanup_stale_worktrees` exists in `src-tauri/src/worktree/manager.rs`; `cleanupWorktrees` called in `src/routes/index.tsx` (from T01); cleanup called in `CodeReviewView.tsx`
     - **S05 fixes:** `"diffs"` (not `"worktrees"`) in diffs_ready emit; startup cleanup in `index.tsx`
   - Run `cargo test --lib` from `src-tauri/` and check exit code
   - Run `npx tsc --noEmit` from project root and check exit code
   - Print summary with pass/fail counts and exit non-zero if any check failed

2. Make the script executable and run it. Fix any failing checks (they should all pass if T01 was completed correctly).

3. Add a UAT runbook section at the end of the script (as comments) documenting the manual steps for full runtime verification:
   - Start app with `cargo tauri dev`
   - Submit a multi-step task to trigger decomposition
   - Verify sub-tasks appear as cards (R001)
   - Approve tasks in TaskApprovalView (R006)
   - Watch workers execute in parallel with attributed output (R010)
   - Verify CodeReviewView shows per-worktree diffs after review (R008, R009)
   - Merge changes and confirm worktree cleanup (R012)
   - Deliberately trigger a failure and confirm error card shows detail (R002)

## Must-Haves

- [ ] `verify-s05.sh` exists and is executable
- [ ] Script checks wiring for all 9 targeted requirements (R001, R002, R005, R006, R007, R008, R009, R010, R012)
- [ ] Script runs `cargo test --lib` and `npx tsc --noEmit` as final gates
- [ ] Script exits 0 when all checks pass
- [ ] All checks pass when the script is run

## Verification

- `bash .gsd/milestones/M001/slices/S05/verify-s05.sh` exits 0 with all checks passing
- `test -x .gsd/milestones/M001/slices/S05/verify-s05.sh` — script is executable

## Inputs

- `src-tauri/src/commands/orchestrator.rs` — T01 output with fixed `"diffs"` field name
- `src/routes/index.tsx` — T01 output with startup cleanup useEffect
- `src-tauri/src/router/orchestrator.rs` — contains `build_review_prompt_with_diffs`, `SubTaskDef`, parsing functions
- `src/hooks/orchestration/handleOrchEvent.ts` — contains all `@@orch::` event handling
- `src/components/views/CodeReviewView.tsx` — contains DiffReview rendering and merge controls
- `src/stores/taskStore.ts` — contains `worktreeEntries` state
- `src-tauri/src/worktree/manager.rs` — contains `cleanup_stale_worktrees`

## Expected Output

- `.gsd/milestones/M001/slices/S05/verify-s05.sh` — executable verification script covering all 9 requirements + compile gates
