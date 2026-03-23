# M001: End-to-End Orchestration Pipeline

**Vision:** Fix the broken orchestration pipeline so that WhaleCode delivers on its core promise: decompose a complex task, dispatch workers in parallel worktrees, review results, and merge — all through a polished desktop GUI with actionable error handling at every phase.

## Success Criteria

- User can submit a complex task and see it decomposed into sub-tasks by the master agent
- Workers execute in isolated git worktrees in parallel (including multiple workers of the same agent type)
- Errors at any phase display actionable detail in the UI (not generic "Error")
- Task approval flow works (approve, modify, reject sub-tasks before execution)
- Worker streaming output is visible in real-time, correctly attributed to each worker
- Review agent receives actual worktree diffs and provides integration summary
- User can review per-worktree diffs and merge selected changes back to main branch
- Worktrees are cleaned up automatically after orchestration completes

## Key Risks / Unknowns

- Exact decomposition failure cause — the current "Error" card shows no detail; needs reproduction to diagnose root cause before fixing
- LLM output format instability — decompose prompt asks for strict JSON but LLMs may wrap in markdown, natural language, or use alternative key names
- Worktree merge conflicts — workers may modify overlapping files despite file-scope boundary instructions in the decompose prompt
- Rate limit behavior varies across agents — retry/fallback logic hasn't been exercised with real parallel workloads

## Proof Strategy

- Decomposition failure → retire in S01 by proving master agent returns parseable JSON and errors surface in the UI
- Worktree isolation + parallel execution → retire in S02 by proving two Claude workers run simultaneously in separate worktrees
- Frontend state correctness → retire in S03 by proving approval flow and task completion matching work with real events
- Merge conflicts → retire in S04 by proving selective_merge handles real worktree diffs through the UI

## Verification Classes

- Contract verification: Rust unit tests for SubTaskDef parsing, DAG scheduling, tool slot concurrency, worktree creation. Frontend tests for event handling
- Integration verification: Real CLI agent spawned, output parsed, worktree created and used, diff generated
- Operational verification: Stale worktrees cleaned on completion, zombie processes reaped, errors surface in UI
- UAT / human verification: Full pipeline run through the GUI with a real task

## Milestone Definition of Done

This milestone is complete only when all are true:

- All slice deliverables are complete with passing verification
- A real multi-step task runs through the full pipeline (decompose → approve → parallel execute in worktrees → review → merge) via the GUI
- All three agent types work as both master and worker
- Errors at any phase produce actionable UI feedback
- Worktrees are created for workers, used during execution, diffed for review, and cleaned up after merge
- No zombie processes remain after orchestration completes or fails
- 276+ existing Rust tests still pass plus new tests for fixed functionality

## Requirement Coverage

- Covers: R001, R002, R003, R004, R005, R006, R007, R008, R009, R010, R011, R012
- Partially covers: none
- Leaves for later: R013, R014, R015, R016, R017, R018
- Orphan risks: none

## Slices

- [x] **S01: Decomposition & Error Pipeline** `risk:high` `depends:[]`
  > After this: Master agent decomposes a task into sub-tasks with correct JSON parsing, and errors at any phase surface with actionable detail in the UI error card. Verified by running a real decomposition through the GUI.

- [x] **S02: Worktree Isolation & Parallel Workers** `risk:high` `depends:[S01]`
  > After this: Workers execute in isolated git worktrees, and multiple workers of the same agent type run in parallel. Verified by dispatching 2+ workers and confirming separate worktree directories exist with independent changes.

- [x] **S03: Frontend State Synchronization** `risk:medium` `depends:[S01]`
  > After this: Approval flow works reliably (activePlan available during approval), task completion events match the correct frontend task card by dag_id, and streaming output is attributed per-worker. Verified by running an orchestration and confirming UI state matches reality.

- [x] **S04: Review & Merge Pipeline** `risk:medium` `depends:[S02,S03]`
  > After this: Review agent receives worktree diffs and provides integration summary, UI shows per-worktree file changes, user can accept/reject per-worktree, and worktrees are cleaned up after merge. Verified by completing a full orchestration and merging changes via the GUI.

- [x] **S05: End-to-End Integration & Polish** `risk:low` `depends:[S04]`
  > After this: Full pipeline (decompose → approve → parallel execute → review → merge) works reliably in one uninterrupted flow with all three agent types. Verified by running a real multi-step task through the complete pipeline.

## Boundary Map

### S01 → S02

Produces:
- `SubTaskDef` with `id: String` field preserved from LLM output
- Reliable `parse_decomposition_from_output()` that extracts JSON from all three agent types' NDJSON streams
- Error propagation chain: backend `Err(String)` → IPC → frontend orchestrationLogs error entries → DecompositionErrorCard displays the actual error
- `OrchestrationPhase` transitions emitted as `@@orch::phase_changed` events with detail text

Consumes:
- nothing (first slice)

### S01 → S03

Produces:
- Structured `@@orch::task_completed` / `@@orch::task_failed` events with `dag_id` field
- Backend error strings that reach the frontend error display chain

Consumes:
- nothing (first slice)

### S02 → S04

Produces:
- `WorktreeEntry` per worker task — each worker's `cwd` is the worktree path, not `project_dir`
- Modified `dispatch_task` / `dispatch_orchestrated_task` that accepts a `cwd` override for worktree paths
- Per-agent-type concurrency: tool slot mechanism allows N workers of the same agent type
- Rate limit retry and agent fallback exercised through real worker dispatch
- Worktree tracking in orchestration state: `HashMap<String, WorktreeEntry>` mapping task_id → worktree

Consumes from S01:
- Reliable decomposition producing `Vec<SubTaskDef>` with IDs and agent assignments

### S03 → S04

Produces:
- `activePlan` available immediately when `awaiting_approval` phase fires (not after promise resolves)
- Task completion events matched by `dag_id` via `dagToFrontendId` map (not FIFO queue)
- Per-worker streaming output in UI, each attributed to the correct task card

Consumes from S01:
- Structured `@@orch::` events with dag_id and phase detail

### S04 → S05

Produces:
- Review agent receives `WorktreeDiffReport` per worker (actual file changes, not just stdout summaries)
- UI shows per-worktree diffs via existing `DiffReview` / `FileDiffView` components, wired to real worktree data
- Merge controls: accept per-worktree (selective_merge), reject per-worktree, accept all
- Worktree cleanup on orchestration completion (success or failure) via `WorktreeManager.cleanup_stale_worktrees()`
- "Zero changes" case handled (action buttons visible even when no files changed)

Consumes from S02:
- `WorktreeEntry` per worker with branch names and paths
- Worktree tracking map in orchestration state

Consumes from S03:
- Correct task-to-worktree mapping in frontend state
- Per-worker output attribution for review display
