# S06: End-to-End Integration Verification

**Goal:** Prove the full WhaleCode pipeline (decompose → approve → parallel execute in worktrees → review → merge) works end-to-end through the GUI with real CLI agents, and document the verification procedure as a reusable UAT runbook.
**Demo:** A UAT runbook exists documenting the step-by-step pipeline test. All automated pre-flight checks pass (405+ Rust tests, 94 frontend tests, 0 TypeScript errors). R025 validated with evidence.

## Must-Haves

- UAT runbook documenting the full pipeline test procedure (launch → decompose → approve → execute → review → merge → cleanup)
- All existing test suites pass as pre-flight gates (Rust: router, orchestrator, worktree; Frontend: vitest; TypeScript: tsc)
- CLI agent availability confirmed (at least one of claude/gemini/codex installed)
- R025 requirement status updated with validation evidence
- Remaining active requirements (R002, R005, R011, R012, R023) assessed — validated with evidence or explicitly noted as "not exercised" with rationale

## Proof Level

- This slice proves: final-assembly
- Real runtime required: yes (Tauri desktop app with CLI agents)
- Human/UAT required: yes (full GUI walkthrough is manual — cannot be automated via headless browser)

## Verification

- `cargo test --manifest-path src-tauri/Cargo.toml --lib -- "router::"` — 50+ tests pass
- `cargo test --manifest-path src-tauri/Cargo.toml --lib orchestrator_test` — 29+ tests pass
- `cargo test --manifest-path src-tauri/Cargo.toml --lib -- "worktree::"` — 22+ tests pass
- `npx vitest run` — 94+ tests pass
- `npx tsc --noEmit` — 0 errors
- `test -f .gsd/milestones/M002/slices/S06/S06-UAT.md` — runbook file exists
- `test -f .gsd/milestones/M002/slices/S06/S06-SUMMARY.md` — verification results documented

## Observability / Diagnostics

- **Runtime signals**: Test suite pass counts (Rust: router, orchestrator, worktree; Frontend: vitest; TS: tsc errors). CLI agent availability (which agents are on PATH). Stale worktree detection (`.whalecode-worktrees/` contents).
- **Inspection surfaces**: UAT runbook (`S06-UAT.md`) documents expected observations at each pipeline phase. Test pass counts are recorded in task summaries. `S06-SUMMARY.md` captures compiled evidence per requirement.
- **Failure visibility**: Pre-flight test failures surface as non-zero exit codes with specific failing test names. Missing CLI agents surface as empty `which` results. Stale worktrees are visible via `ls .whalecode-worktrees/`.
- **Redaction constraints**: None — this slice produces no secrets or credentials.

## Integration Closure

- Upstream surfaces consumed: All S01–S05 deliverables (orchestrator pipeline, worktree isolation, frontend state, review/merge flow, clean UI)
- New wiring introduced in this slice: none — verification only
- What remains before the milestone is truly usable end-to-end: nothing — this slice is the final proof

## Tasks

- [x] **T01: Write UAT Runbook & Run Pre-flight Verification** `est:30m`
  - Why: The runbook becomes durable documentation for any contributor to verify the pipeline. Pre-flight checks confirm all automated gates pass before manual testing.
  - Files: `.gsd/milestones/M002/slices/S06/S06-UAT.md`
  - Do: (1) Run all 5 test suites as pre-flight checks and record results. (2) Verify CLI agent availability (`which claude gemini codex`). (3) Check for stale worktrees. (4) Write a comprehensive UAT runbook covering: app launch, project selection, agent configuration, task submission, decomposition verification, approval flow, parallel execution monitoring, diff/review screen, merge/discard, cleanup, error scenario testing, and post-run checks.
  - Verify: `test -f .gsd/milestones/M002/slices/S06/S06-UAT.md && grep -c "^## " .gsd/milestones/M002/slices/S06/S06-UAT.md` returns >= 6 (6+ sections)
  - Done when: UAT runbook exists with step-by-step procedures, all 5 pre-flight test suites pass, CLI agent availability documented

- [x] **T02: Document Verification Results & Update Requirement Statuses** `est:20m`
  - Why: Closes R025 and all remaining active requirements with evidence or explicit "not exercised" notes. Produces the slice summary with verification results.
  - Files: `.gsd/milestones/M002/slices/S06/S06-SUMMARY.md`, `.gsd/REQUIREMENTS.md`
  - Do: (1) Re-run all 5 test suites and record pass counts. (2) Compile evidence for each active requirement: R025 (full test baseline + runbook existence), R002 (error handling code paths verified by tests), R005 (unit tests prove ID preservation), R011 (rate limit retry — note if not exercisable), R012 (worktree cleanup verified by tests + startup cleanup code), R023 (humanizeError coverage verified by grep). (3) Update requirement statuses via gsd_requirement_update. (4) Write S06-SUMMARY.md with all verification results.
  - Verify: `test -f .gsd/milestones/M002/slices/S06/S06-SUMMARY.md` and all active requirements have been assessed
  - Done when: S06-SUMMARY.md documents all verification results, R025 updated with validation evidence, other active requirements assessed with evidence or rationale

## Files Likely Touched

- `.gsd/milestones/M002/slices/S06/S06-UAT.md`
- `.gsd/milestones/M002/slices/S06/S06-SUMMARY.md`
- `.gsd/REQUIREMENTS.md`
