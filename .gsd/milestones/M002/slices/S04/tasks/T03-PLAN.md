---
estimated_steps: 5
estimated_files: 3
skills_used: []
---

# T03: Verification — new tests, wiring checks, and full suite regression

**Slice:** S04 — Review, Merge & Cleanup
**Milestone:** M002

## Description

Ensures the new orchestrator diff pipeline, enriched review prompt, targeted worktree removal, and navigation timing are all correct. Adds unit tests for the new `build_review_prompt_with_diffs()` method and runs the full verification matrix: Rust test suites, TypeScript compilation, frontend tests, and ripgrep wiring checks.

## Steps

1. **Add unit tests for `build_review_prompt_with_diffs()` in `src-tauri/src/router/orchestrator.rs` tests module.** Three tests:
   - `review_prompt_with_diffs_includes_file_changes`: Provide worker results + diff text pairs. Assert prompt contains "File Changes" section, contains the diff text, contains worker output summaries.
   - `review_prompt_with_diffs_truncates_at_limit`: Provide diff text exceeding 20KB total. Assert the prompt length is bounded (total diff text ≤ ~20KB).
   - `review_prompt_with_diffs_handles_empty_diffs`: Provide a diff pair with empty string. Assert prompt contains "No file changes" or similar placeholder.

2. **Run Rust test suites.** Execute targeted test commands per K001:
   - `cargo test --lib -- "router::"` — ~50+ tests including the 3 new ones
   - `cargo test --lib orchestrator_test` — ~29 existing tests
   - `cargo test --lib -- "worktree::"` — 22 existing tests
   Fix any failures before proceeding.

3. **Run TypeScript verification.**
   - `npx tsc --noEmit` — must exit 0
   - `npx vitest run` — must report 94+ tests passing
   Fix any failures before proceeding.

4. **Run full wiring check suite.** Execute each `rg` command and verify expected output:
   - `rg "diffs_ready" src-tauri/src/commands/orchestrator.rs` → ≥1 match
   - `rg "auto_commit_worktree" src-tauri/src/commands/orchestrator.rs` → ≥1 match
   - `rg "generate_worktree_diff" src-tauri/src/commands/orchestrator.rs` → ≥1 match
   - `rg "build_review_prompt_with_diffs" src-tauri/src/router/orchestrator.rs` → ≥1 match
   - `rg "'reviewing'" src/routes/index.tsx` → matches auto-navigate condition
   - `rg "remove_single_worktree" src-tauri/src/commands/worktree.rs` → ≥1 match
   - `rg "remove_single_worktree" src-tauri/src/lib.rs` → ≥1 match
   - `rg "cleanupWorktrees\|cleanup_worktrees" src/routes/index.tsx` → ≥1 match (startup cleanup)

5. **Fix any regressions.** If any test or check fails, investigate and fix. Common issues: import paths for new worktree module references, specta binding generation for new IPC command, TypeScript type mismatches from new bindings.

## Must-Haves

- [ ] 3 new unit tests for `build_review_prompt_with_diffs()` — all pass
- [ ] `cargo test --lib -- "router::"` passes (50+ tests)
- [ ] `cargo test --lib orchestrator_test` passes (29+ tests)
- [ ] `cargo test --lib -- "worktree::"` passes (22 tests)
- [ ] `npx tsc --noEmit` exits 0
- [ ] `npx vitest run` reports 94+ tests passing
- [ ] All 8 wiring `rg` checks return expected matches

## Verification

- All commands in Steps 2-4 pass with expected output
- No Rust compilation warnings on new code
- No TypeScript errors

## Inputs

- `src-tauri/src/router/orchestrator.rs` — `build_review_prompt_with_diffs()` method from T01
- `src-tauri/src/commands/orchestrator.rs` — auto-commit + diff + diffs_ready wiring from T01
- `src-tauri/src/commands/worktree.rs` — `remove_single_worktree` from T02
- `src-tauri/src/lib.rs` — command registration from T02
- `src/routes/index.tsx` — navigation fix + startup cleanup from T02
- `src/components/review/DiffReview.tsx` — targeted discard from T02
- `src/hooks/useWorktree.ts` — `removeWorktree` from T02

## Observability Impact

This is a verification-only task — no new runtime signals are introduced. The observability value is indirect: the 4 `build_review_prompt_with_diffs` unit tests guard the diff truncation and empty-diff placeholder logic, ensuring the review agent always receives well-formed prompts. The 8 wiring checks confirm all required symbols are present at their expected locations.

- **Inspection:** Re-run any wiring check (`rg` command) to verify symbol presence
- **Failure visibility:** Test failures surface via `cargo test` exit code and failure output
- **No new runtime signals, log entries, or persisted state**

## Expected Output

- `src-tauri/src/router/orchestrator.rs` — modified: 3 new tests in the `#[cfg(test)]` module
- `src-tauri/src/commands/orchestrator_test.rs` — potentially modified if orchestrator-level tests need updating
