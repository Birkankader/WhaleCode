# M002: Working Pipeline & UI Overhaul

**Vision:** Fix the broken orchestration pipeline end-to-end and clean up the UI so that WhaleCode delivers on its core promise: decompose a complex task, dispatch workers in parallel worktrees, review results, and merge — all through a clean, functional desktop GUI with actionable error handling at every phase.

## Success Criteria

- User can submit a complex task and see it decomposed into sub-tasks by the master agent
- Workers execute in isolated git worktrees in parallel (including multiple workers of the same agent type)
- Errors at any phase display actionable, user-friendly detail with expandable technical info
- Task approval flow works with manual approval by default (no countdown timer)
- Worker streaming output is visible in real-time, correctly attributed to each worker by task ID
- Review agent receives actual worktree diffs and provides integration summary
- User can review per-worktree diffs and selectively merge/discard individual results
- Worktrees are cleaned up automatically after orchestration completes
- UI has no dead code, no direct DOM manipulation anti-patterns, no silent error swallowing

## Key Risks / Unknowns

- Decomposition JSON parsing reliability across all 3 agent types — each wraps JSON differently in NDJSON streams
- Tool slot refactoring cascading effects — changing from per-agent-name to per-task-id touches process lifecycle tracking
- Worktree ↔ dispatch wiring — workers currently receive project_dir as cwd, changing to worktree paths requires touching dispatch flow, adapters, and tracking
- Frontend state migration — changing Map keys from ToolName to task-id affects multiple components

## Proof Strategy

- Decomposition reliability → retire in S01 by proving master agent returns parseable JSON with all 3 agent types and errors surface in the UI
- Worktree isolation + parallel execution → retire in S02 by proving two Claude workers run simultaneously in separate worktrees
- Frontend state correctness → retire in S03 by proving approval flow and task completion matching work with real events
- Merge flow → retire in S04 by proving selective_merge handles real worktree diffs through the UI

## Verification Classes

- Contract verification: Rust unit tests for SubTaskDef parsing, DAG scheduling, tool slot concurrency, worktree creation. TypeScript compilation. ripgrep wiring checks
- Integration verification: Real CLI agent spawned, output parsed, worktree created and used, diff generated, merge executed
- Operational verification: Stale worktrees cleaned on completion and startup, zombie processes reaped, errors surface in UI
- UAT / human verification: Full pipeline run through the GUI with a real multi-step task using real CLI agents

## Milestone Definition of Done

This milestone is complete only when all are true:

- All slice deliverables are complete with passing verification
- A real multi-step task runs through the full pipeline (decompose → approve → parallel execute in worktrees → review → merge) via the GUI
- All three agent types (Claude, Gemini, Codex) work as both master and worker
- Errors at any phase produce actionable, user-friendly UI feedback with expandable technical detail
- Workers run in isolated git worktrees with proper cleanup
- Per-worktree granular merge works from the review screen
- No zombie processes remain after orchestration completes or fails
- 50+ orchestrator tests pass plus new tests for fixed functionality
- TypeScript compiles with zero errors
- UI has no dead code, no inline style DOM manipulation, no silent error catches

## Requirement Coverage

- Covers: R001, R002, R003, R004, R005, R006, R007, R008, R009, R010, R011, R012, R021, R022, R023, R024, R025
- Partially covers: none
- Leaves for later: R013, R014, R015, R016, R017, R018
- Orphan risks: none

## Slices

- [x] **S01: Decomposition & Error Pipeline** `risk:high` `depends:[]`
  > After this: Master agent decomposes a task into sub-tasks with correct JSON parsing and preserved task IDs. Errors surface with actionable, user-friendly detail in the UI. Verified by running a real decomposition through the GUI with at least one agent type.

- [x] **S02: Worktree Isolation & Parallel Workers** `risk:high` `depends:[S01]`
  > After this: Workers execute in isolated git worktrees (cwd is worktree path, not project_dir). Multiple workers of the same agent type run in parallel without tool slot blocking. Verified by dispatching 2+ workers and confirming separate worktree directories with independent changes.

- [x] **S03: Frontend State & Approval Flow** `risk:medium` `depends:[S01]`
  > After this: activePlan available at approval time (set from @@orch:: events, not after promise). Manual approval by default, no countdown. Task completion matched by dag_id (FIFO removed). Per-worker streaming output attributed by task ID. Zustand selectors use useShallow.

- [x] **S04: Review, Merge & Cleanup** `risk:medium` `depends:[S02,S03]`
  > After this: Review agent receives worktree diffs (auto-commit + diff generation before review). Per-worktree collapsible diff cards in UI. Granular merge/discard per worktree. Worktrees cleaned up after merge/discard and on app startup.

- [x] **S05: UI Cleanup & Anti-Pattern Removal** `risk:low` `depends:[S03]`
  > After this: Dead code removed (unused components). Direct DOM manipulation (onMouseEnter style changes) replaced with CSS/Tailwind hover states. Silent .catch(() => {}) replaced with toast or log feedback. Technical jargon replaced with user-friendly language in error cards and status text.

- [x] **S06: End-to-End Integration Verification** `risk:low` `depends:[S04,S05]`
  > After this: Full pipeline (decompose → approve → parallel execute in worktrees → review → merge) works end-to-end through the GUI with a real multi-step task. All three agent types verified as both master and worker. UAT runbook documented.

## Boundary Map

### S01 → S02

Produces:
- `SubTaskDef` with `pub id: Option<String>` field preserved from LLM output through deserialization
- Reliable `parse_decomposition_from_output()` that extracts JSON from all three agent types' NDJSON streams
- `@@orch::decomposition_failed` event with `{ error: string }` payload for error visibility
- Error propagation chain: backend `Err(String)` → IPC → frontend orchestrationLogs error entries → DecompositionErrorCard displays actual error with expandable detail
- Normalized agent names (Claude Code → claude, Gemini CLI → gemini, etc.)

Consumes:
- nothing (first slice)

### S01 → S03

Produces:
- Structured `@@orch::task_completed` / `@@orch::task_failed` events with `dag_id` field
- `@@orch::phase_changed` events with phase detail text
- Backend error strings that reach the frontend error display chain
- `humanizeError` coverage for decomposition-specific failures

Consumes:
- nothing (first slice)

### S02 → S04

Produces:
- Workers dispatched with worktree path as `cwd` instead of `project_dir`
- `WorktreeEntry` per worker task — created via `WorktreeManager.create_for_task()`
- Per-task-id tool slot tracking (replaces per-agent-name max-1 lock)
- Worktree tracking in orchestration state: mapping task_id → worktree info
- Rate limit retry and agent fallback working with parallel dispatch

Consumes from S01:
- Reliable decomposition producing `Vec<SubTaskDef>` with IDs and agent assignments

### S03 → S04

Produces:
- `activePlan` set from `@@orch::phase_changed` events during Phase 1 (not after promise)
- Task completion events matched by `dag_id` via `dagToFrontendId` map (FIFO removed)
- Per-worker streaming output in UI, each attributed to correct task card by task ID
- `worktreeEntries` state in taskStore with setter and session-clear
- Manual approval by default, auto-approve opt-in via settings

Consumes from S01:
- Structured `@@orch::` events with dag_id and phase detail

### S04 → S05

Produces:
- Auto-commit + diff generation per worktree before review phase
- `@@orch::diffs_ready` event with per-worktree metadata (dag_id, branch, file_count, additions, deletions)
- CodeReviewView with per-worktree collapsible diff cards
- Granular merge controls: accept per-worktree, discard per-worktree, accept all
- Worktree cleanup after all worktrees handled (merge or discard) and on app startup
- "Zero changes" case shows explicit empty state with discard option

Consumes from S02:
- `WorktreeEntry` per worker with branch names and paths
- Worktree tracking map in orchestration state

Consumes from S03:
- Task-to-worktree mapping in frontend state
- Per-worker output attribution for review display

### S05 → S06

Produces:
- Clean UI codebase: no dead components, no DOM manipulation, no silent catches
- User-friendly error messages throughout (humanizeError expanded, jargon removed)
- CSS/Tailwind hover states replacing inline style handlers

Consumes from S03:
- Zustand selectors with useShallow (performance-clean state management)

Consumes from S04:
- Complete review/merge flow for end-to-end testing
