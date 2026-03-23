# S06: End-to-End Integration Verification — Research

**Date:** 2026-03-23
**Depth:** Light — verification-only slice using established patterns, no new code

## Summary

S06 is the final proof slice for M002. All code changes are complete (S01–S05). What remains is running the full pipeline end-to-end through the GUI with real CLI agents and documenting a UAT runbook. All three CLI agents (claude, gemini, codex) are installed and available locally. The existing test baseline is clean: 405 Rust tests, 94 frontend tests, 0 TypeScript errors.

The primary requirement is R025 (launchability): prove decompose → approve → parallel execute in worktrees → review → merge works with real agents. Secondary requirements still marked "active" (R002, R005, R011, R012, R023) can be validated or explicitly noted during E2E runs — they were implemented in prior slices but never formally validated.

This slice produces no new application code. It produces: (1) a UAT runbook document, (2) a verification run through the GUI, and (3) requirement status updates for R025 and any remaining active requirements that can be validated.

## Recommendation

Structure S06 as two tasks:

1. **T01: UAT Runbook** — Write a manual UAT runbook documenting the step-by-step procedure for running the full pipeline. This becomes durable documentation that any future contributor can follow. Covers: app launch, project selection, agent selection, task submission, approval flow, worker execution monitoring, review screen, merge/discard, cleanup verification.

2. **T02: E2E Verification Run** — Execute the runbook against the live app using `npm run tauri dev`, with at least one real multi-step task. Document results, validate R025, and update any remaining active requirements that show evidence of working.

The verification run must use the actual GUI — not mocked IPC or unit tests. The milestone definition of done requires "a real multi-step task runs through the full pipeline via the GUI."

## Implementation Landscape

### Key Files

- `src-tauri/src/commands/orchestrator.rs` — The orchestration pipeline (Phase 1–3 + Phase 2.5). No changes needed, but this is the backend that must work end-to-end.
- `src/hooks/orchestration/useOrchestratedDispatch.ts` — Frontend entry point for orchestration. Processes `@@orch::` events and routes to handleOrchEvent.
- `src/hooks/orchestration/handleOrchEvent.ts` — Event handler that updates Zustand stores. Phase transitions, task assignments, completions all flow through here.
- `src/components/views/TaskApprovalView.tsx` — Approval screen the user sees after decomposition. Manual approval by default (autoApprove=false).
- `src/components/views/CodeReviewView.tsx` — Review screen with per-worktree diff cards, merge/discard controls.
- `src/routes/index.tsx` — View routing based on `orchestrationPhase`. Auto-navigates to review when phase is 'reviewing'. Startup worktree cleanup.
- `src/stores/taskStore.ts` — Zustand store holding orchestration state, tasks Map, worktreeEntries, activePlan.
- `src/stores/uiStore.ts` — UI state including autoApprove (defaults false), activeView.

### Build Order

1. **T01 first** — Write the runbook before executing it. The runbook forces precise documentation of the expected flow, which catches any ambiguity before the live run.
2. **T02 second** — Execute the runbook. Results are recorded in a verification summary. Requirement statuses updated based on observed evidence.

### Verification Approach

**Pre-flight checks (before launching the app):**
- All existing tests pass: `cargo test --manifest-path src-tauri/Cargo.toml --lib -- "router::"` (54), `cargo test --manifest-path src-tauri/Cargo.toml --lib orchestrator_test` (29), `cargo test --manifest-path src-tauri/Cargo.toml --lib -- "worktree::"` (22), `npx vitest run` (94), `npx tsc --noEmit` (0 errors)
- At least one CLI agent installed: `which claude && which gemini && which codex`
- No stale worktrees: `ls .whalecode-worktrees/ 2>/dev/null` should be empty or not exist

**E2E pipeline verification (through the GUI):**
1. Launch app with `npm run tauri dev`
2. Select a test project directory (a disposable git repo with at least 2 files)
3. Choose master agent (claude) and worker agents (claude + gemini, or claude + codex — whichever two are authenticated)
4. Submit a multi-step task (e.g., "Add a README.md describing the project AND add a .gitignore file with common patterns")
5. **Phase 1 (Decompose):** Verify decomposition completes, task cards appear with IDs, agents assigned
6. **Approval:** Verify approval screen appears and waits indefinitely (no countdown). Approve the plan
7. **Phase 2 (Execute):** Verify workers start in parallel, streaming output visible per-worker, worktree directories created under `.whalecode-worktrees/`
8. **Phase 2.5 (Diff):** Verify diffs_ready event fires, review view auto-navigates
9. **Phase 3 (Review):** Verify review agent runs, per-worktree diff cards visible with file counts
10. **Merge:** Accept one worktree, discard another (or accept all). Verify merged changes appear in the main branch
11. **Cleanup:** Verify `.whalecode-worktrees/` is cleaned up after merge/discard

**Post-run verification:**
- No zombie processes: `ps aux | grep -E "claude|gemini|codex" | grep -v grep` should show no orphaned agent processes
- Worktree cleanup: `.whalecode-worktrees/` should be empty or removed
- Error scenarios: Intentionally trigger at least one error (e.g., invalid project dir) and verify the error card shows actionable detail with expandable technical info

**Requirement validation targets:**
- R025: Full pipeline proof (primary)
- R002: Error visibility — check error card content during intentional failure
- R005: Task IDs preserved — check that task cards show LLM-provided IDs
- R011: Rate limit retry — may not be triggerable on demand; note as "not exercised" if no rate limit occurs
- R012: Worktree cleanup — verify post-run
- R023: Plain language errors — verify error card content

## Constraints

- E2E verification requires the Tauri desktop app running — cannot be automated via headless browser or CI. This is a manual GUI verification by design.
- CLI agents must be authenticated. If an agent's auth has expired, re-authenticate before the run.
- The test project directory must be a valid git repository with at least one commit (worktree creation requires a git repo).
- R011 (rate limit retry) may not be exercisable on demand — rate limits are stochastic. If not triggered during the run, note it as "not exercised during E2E" rather than marking it validated.

## Common Pitfalls

- **Test project in dirty git state** — If the test project has uncommitted changes, worktree creation may behave unexpectedly. Start with a clean `git status`.
- **Agent auth expired** — Claude, Gemini, and Codex CLIs each have their own auth mechanisms. Verify with `claude --version`, `gemini --version`, `codex --version` before the run.
- **Stale worktrees from previous runs** — If `.whalecode-worktrees/` exists from a previous crashed session, the app should clean it up on startup. Verify this happens, or manually remove before the run.
