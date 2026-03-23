---
verdict: needs-attention
remediation_round: 0
---

# Milestone Validation: M001 — End-to-End Orchestration Pipeline

## Success Criteria Checklist

- [x] **User can submit a complex task and see it decomposed into sub-tasks by the master agent** — evidence: S01 added `SubTaskDef.id: Option<String>` with `#[serde(default)]`, reliable `parse_decomposition_from_output()`, 4 new unit tests. S05 verify-s05.sh confirms `SubTaskDef` struct, `id` field, and both parsing functions present and wired. 48→57 orchestrator tests pass.
- [x] **Workers execute in isolated git worktrees in parallel (including multiple workers of the same agent type)** — evidence: S02 wired `WorktreeManager.create_for_task()` into orchestrator Phase 2, each worker's `cwd` is the worktree path. `dispatch_task_internal` with `skip_tool_slot: true` bypasses per-agent-name slot reservation. `test_tool_slot_bypass_allows_concurrent_same_agent` proves two Claude `ProcessEntry` coexist. 86 tests pass across 4 modified modules.
- [x] **Errors at any phase display actionable detail in the UI (not generic "Error")** — evidence: S01 emits `@@orch::decomposition_failed` event before single-task fallback. `masterTask.resultSummary` populated on all 3 error paths (result.status==='error', catch block, decomposition_failed handler). `DecompositionErrorCard` reads `resultSummary` at first priority. S05 verify-s05.sh confirms `decomposition_failed` emit, handler, component, and `resultSummary` read.
- [x] **Task approval flow works (approve, modify, reject sub-tasks before execution)** — evidence: S03 calls `setActivePlan()` from `phase_changed` handler when phase is `decomposing`, with `ev.plan_id` guard. `activePlan` is available before `awaiting_approval` phase fires, eliminating the race condition where `TaskApprovalView` rendered blank.
- [x] **Worker streaming output is visible in real-time, correctly attributed to each worker** — evidence: S03 added `orch_tag: Option<String>` to `spawn_with_env_core` / `spawn_with_env_internal` / `dispatch_task_internal`. When set, stdout reader emits `@@orch::worker_output` events with `{dag_id, line}`. Frontend handler looks up `dagToFrontendId.get(ev.dag_id)` and calls `store.updateTaskOutputLine`. S05 confirm all 3 checks pass.
- [x] **Review agent receives actual worktree diffs and provides integration summary** — evidence: S04 added `auto_commit_worktree` + `generate_worktree_diff` per worktree before Phase 3. `build_review_prompt_with_diffs` includes branch name, file count, +/- stats, and changed file paths. 3 unit tests (normal diffs, empty diffs, multiple worktrees). S05 confirms function exists with tests.
- [x] **User can review per-worktree diffs and merge selected changes back to main branch** — evidence: S04 rewrote `CodeReviewView` with per-worktree collapsible cards rendering `DiffReview` at 480px height. Merge controls: per-worktree merge/discard buttons + "Merge All" batch button. S05 fixed `diffs_ready` field name (`"diffs"` not `"worktrees"`) enabling data flow from backend to frontend.
- [x] **Worktrees are cleaned up automatically after orchestration completes** — evidence: S02 wired failure-path cleanup (unchanged). S04 deferred success-path cleanup to after user merge/discard action. S05 added startup `useEffect` calling `cleanupWorktrees(projectDir)` for crash recovery. All 3 cleanup paths verified by S05 verify-s05.sh.

## Slice Delivery Audit

| Slice | Claimed | Delivered | Status |
|-------|---------|-----------|--------|
| S01 | Master agent decomposes with correct JSON parsing; errors surface with actionable detail | `SubTaskDef.id` preservation, `decomposition_failed` event, 3-path error propagation, 48 orchestrator tests | **pass** |
| S02 | Workers execute in isolated worktrees; multiple same-type workers run in parallel | `WorktreeManager` wired into Phase 2, `dispatch_task_internal` with `skip_tool_slot`, `worktree_entries` on `OrchestrationPlan`, cleanup on both paths, 86 tests | **pass** |
| S03 | Approval flow works; task completion matches by dag_id; per-worker streaming output | `setActivePlan` from `phase_changed`, `dagToFrontendId` replaces FIFO, `orch_tag` per-worker stdout tagging, 57 orchestrator tests | **pass** |
| S04 | Review agent receives worktree diffs; UI shows per-worktree merge controls; cleanup deferred to after merge | Deferred success-path cleanup, auto-commit + diff generation, `build_review_prompt_with_diffs`, CodeReviewView rewrite, merge/discard controls, 59+20 tests | **pass** |
| S05 | Full pipeline works end-to-end in one uninterrupted flow | Fixed `diffs_ready` field mismatch, startup worktree cleanup, 30/30 wiring checks, TypeScript compiles clean, 373 Rust tests compile | **pass** |

## Cross-Slice Integration

All boundary map contracts are satisfied:

| Boundary | Produces | Consumed By | Verified |
|----------|----------|-------------|----------|
| S01→S02 | `SubTaskDef.id` preserved in DAG construction | S02 worktree creation uses dag_id from DAG nodes | ✅ |
| S01→S03 | `@@orch::task_completed/task_failed` events with `dag_id` | S03 `dagToFrontendId.get(ev.dag_id)` matching | ✅ |
| S01→S03 | `@@orch::decomposition_failed` event | S03 handler sets `masterTask.resultSummary` | ✅ |
| S02→S04 | `WorktreeEntry` per worker in `plan.worktree_entries` | S04 iterates for auto-commit + diff generation | ✅ |
| S02→S04 | `dispatch_task_internal` with `cwd` override | S04 inherits — workers run in worktree paths | ✅ |
| S03→S04 | `activePlan` available during `awaiting_approval` | S04 builds on approval flow being functional | ✅ |
| S03→S04 | `dagToFrontendId` map for task correlation | S04 uses for review UI worktree-to-task mapping | ✅ |
| S03→S04 | Per-worker `lastOutputLine` attribution | S04 review display builds on correct attribution | ✅ |
| S04→S05 | Full review+merge pipeline | S05 verified all wiring + fixed `diffs_ready` field name | ✅ |

**One integration bug caught and fixed by S05:** The `diffs_ready` event emitted `"worktrees"` field but the frontend expected `"diffs"`. S05/T01 renamed the backend field to `"diffs"`. Without this fix, `CodeReviewView` would never populate `worktreeEntries`. This is exactly the kind of cross-slice integration issue the pipeline should catch, and it was caught and fixed within the milestone.

## Requirement Coverage

All 12 M001 requirements (R001–R012) are addressed:

| Req | Status | Primary Slice | Evidence Level |
|-----|--------|---------------|----------------|
| R001 | active | S01 | Contract verified (unit tests + grep checks + compilation) |
| R002 | active | S01, S03 | Contract verified (event chain + error path coverage) |
| R003 | validated | S02 | Unit tests proving worktree creation + dispatch wiring |
| R004 | validated | S02 | Unit tests proving concurrent same-type workers |
| R005 | active | S01 | Contract verified (dag_id + depends_on wiring) |
| R006 | active | S03 | Contract verified (setActivePlan timing fix) |
| R007 | active | S03 | Contract verified (FIFO removed, dagToFrontendId used) |
| R008 | active | S04 | Contract verified (build_review_prompt_with_diffs + 3 tests) |
| R009 | active | S04 | Contract verified (CodeReviewView + DiffReview + merge controls) |
| R010 | active | S03 | Contract verified (orch_tag + worker_output events) |
| R011 | validated | S02 | Unit tests for retry/backoff/fallback |
| R012 | active | S04, S05 | Contract verified (3 cleanup paths: failure, user-action, startup) |

Requirements R013–R018 are explicitly deferred and documented as out of scope for M001.

**No unaddressed requirements.** All 12 active/validated requirements have at least one slice providing evidence.

## Milestone Definition of Done — Gap Analysis

The roadmap defines 7 "Definition of Done" items. Assessment:

| # | Criterion | Status | Notes |
|---|-----------|--------|-------|
| 1 | All slice deliverables complete with passing verification | ✅ Met | All 5 slices pass their verification suites |
| 2 | Real multi-step task through full pipeline via GUI | ⚠️ Not runtime-verified | Contract-verified by 30 wiring checks. Runtime UAT runbook documented in verify-s05.sh but not executed. Environmental limitation: full Tauri app cannot launch in worktree build environment |
| 3 | All three agent types work as master and worker | ⚠️ Not runtime-verified | Code paths handle all 3 agent types identically (adapter pattern). No runtime proof with all 3 agents. |
| 4 | Errors at any phase produce actionable UI feedback | ✅ Met | All 3 error paths populate `resultSummary` before phase transition. Event chain verified. |
| 5 | Worktrees created, used, diffed, cleaned up | ✅ Met | Full lifecycle wired: `create_for_task` → dispatch with `cwd` → `auto_commit` → `generate_worktree_diff` → DiffReview → merge/discard → `cleanupWorktrees` |
| 6 | No zombie processes after completion/failure | ⚠️ Not verified | No specific zombie process detection or test. Cleanup events fire, but process reaping not explicitly validated. |
| 7 | 276+ existing tests pass plus new tests | ⚠️ Partially met | 373 tests compile and list successfully. Module-scoped tests pass (59 orchestrator, 20 router, 24 worktree, 6 process, 2 dispatch = 111 tests in modified modules). Full suite execution timed out in worktree environment (>600s). |

## Verdict Rationale

**Verdict: needs-attention**

All 5 slices delivered their claimed outputs. All 12 requirements have contract-level evidence. All cross-slice boundary contracts are satisfied. The `diffs_ready` integration bug was caught and fixed within the milestone. The codebase compiles cleanly (TypeScript zero errors, 373 Rust tests compile).

The "needs-attention" items are:

1. **Runtime UAT not executed** — Every slice deferred runtime GUI verification to S05, and S05 itself could only run static wiring checks (not launch the Tauri app). This is an environmental limitation of the worktree-based execution model, not a code gap. A detailed 8-step UAT runbook exists in `verify-s05.sh` for manual execution.

2. **Full Rust test suite not run** — 373 tests compile and list, but execution timed out (>600s in worktree). The 111 module-scoped tests covering all modified code paths pass. A full `cargo test` run should be done in the main checkout or CI before merge.

3. **Zombie process verification missing** — No explicit test or check for orphaned processes after orchestration completes or fails. The cleanup wiring (success-path, failure-path, startup) is verified, but actual process reaping is not.

**Why not needs-remediation:** These gaps are all verification-environment limitations, not missing code deliverables. The pipeline's structural integrity is proven by 30 wiring checks, 111+ passing unit tests, and clean compilation of both Rust and TypeScript. No new code needs to be written — only runtime validation in a full build environment.

## Attention Items (Pre-Merge Checklist)

Before merging M001 to main, the developer should:

1. **Run full `cargo test` in main checkout** — Verify all 373+ tests pass (not just module-scoped subsets). Expected: ~276 pre-existing + ~97 new tests.

2. **Execute the UAT runbook** — Follow the 8 steps in `verify-s05.sh` comments (lines after `# UAT Runbook`) with at least one real CLI agent (Claude Code recommended). Key checkpoints:
   - Decomposition produces sub-task cards with IDs
   - Approval flow renders with `activePlan` populated
   - Workers execute in separate `.whalecode-worktrees/` directories simultaneously
   - Task cards update correctly regardless of completion order
   - CodeReviewView shows per-worktree diffs with merge controls
   - Worktrees cleaned after merge
   - Error card shows specific error text (not generic)

3. **Verify no zombie processes** — After a full pipeline run (and after a deliberately failed run), check `ps aux | grep -i claude` (or whichever agent was used) to confirm no orphaned processes remain.

## Remediation Plan

No remediation slices needed. All gaps are runtime verification items that should be resolved as a pre-merge manual step, not as additional code slices.
