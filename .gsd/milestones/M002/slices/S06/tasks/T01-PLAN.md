---
estimated_steps: 4
estimated_files: 1
skills_used: []
---

# T01: Write UAT Runbook & Run Pre-flight Verification

**Slice:** S06 — End-to-End Integration Verification
**Milestone:** M002

## Description

Write a comprehensive UAT runbook that documents the step-by-step procedure for testing the full WhaleCode orchestration pipeline through the GUI. Before writing the runbook, run all automated test suites as pre-flight gates and verify CLI agent availability. The runbook becomes durable documentation for any future contributor to verify the pipeline works.

## Steps

1. Run all 5 automated test suites and record pass counts:
   - `cargo test --manifest-path src-tauri/Cargo.toml --lib -- "router::"` (expect 50+)
   - `cargo test --manifest-path src-tauri/Cargo.toml --lib orchestrator_test` (expect 29+)
   - `cargo test --manifest-path src-tauri/Cargo.toml --lib -- "worktree::"` (expect 22+)
   - `npx vitest run` (expect 94+)
   - `npx tsc --noEmit` (expect 0 errors)
2. Check CLI agent availability: `which claude`, `which gemini`, `which codex`. Record which are installed.
3. Check for stale worktrees: `ls .whalecode-worktrees/ 2>/dev/null` — should be empty or non-existent.
4. Write `.gsd/milestones/M002/slices/S06/S06-UAT.md` with sections covering:
   - **Prerequisites**: git repo setup, agent auth, clean worktree state
   - **Pre-flight Checks**: the 5 test suites above, agent availability, stale worktree check
   - **Pipeline Test Procedure**: step-by-step walkthrough of decompose → approve → execute → review → merge
   - **Expected Observations**: what to verify at each phase (task cards, streaming output, worktree dirs, diff cards, merge result)
   - **Error Scenario Testing**: intentionally trigger an error (invalid project dir, bad agent name) and verify error card
   - **Post-run Checks**: zombie process check, worktree cleanup verification
   - **Requirement Checklist**: which requirements each observation validates

## Must-Haves

- [ ] All 5 pre-flight test suites pass
- [ ] CLI agent availability documented
- [ ] UAT runbook covers full pipeline from launch to cleanup
- [ ] Runbook includes error scenario testing
- [ ] Runbook includes post-run verification checks

## Verification

- `test -f .gsd/milestones/M002/slices/S06/S06-UAT.md` — file exists
- `grep -c "^## " .gsd/milestones/M002/slices/S06/S06-UAT.md` returns >= 6
- All 5 test suites passed during pre-flight (recorded in task output)

## Inputs

- `src-tauri/Cargo.toml` — Rust test manifest
- `src/` — Frontend source for vitest and tsc
- `src-tauri/src/commands/orchestrator.rs` — orchestration pipeline (reference for runbook accuracy)
- `src/hooks/orchestration/useOrchestratedDispatch.ts` — frontend entry point (reference for runbook accuracy)
- `src/hooks/orchestration/handleOrchEvent.ts` — event handler (reference for runbook accuracy)
- `src/components/views/TaskApprovalView.tsx` — approval screen (reference for runbook accuracy)
- `src/components/views/CodeReviewView.tsx` — review screen (reference for runbook accuracy)
- `src/routes/index.tsx` — view routing and startup cleanup (reference for runbook accuracy)

## Observability Impact

- **Signals changed**: No runtime code modified — this task is verification-only. The UAT runbook itself becomes the observability artifact, documenting what to look for at each pipeline phase.
- **Inspection**: Future agents inspect this task via `S06-UAT.md` (runbook) and `T01-SUMMARY.md` (pre-flight results with pass counts). Pre-flight pass counts are the primary health signal.
- **Failure visibility**: If pre-flight tests fail, the specific test names and counts are recorded in the task summary. If CLI agents are missing, that's documented as a prerequisite gap.

## Expected Output

- `.gsd/milestones/M002/slices/S06/S06-UAT.md` — comprehensive UAT runbook with pre-flight results and step-by-step pipeline test procedure
