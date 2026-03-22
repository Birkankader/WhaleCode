# M002: Working Pipeline & UI Overhaul

**Gathered:** 2026-03-22
**Status:** Ready for planning

## Project Description

WhaleCode is a Tauri v2 desktop app that orchestrates Claude Code, Gemini CLI, and Codex CLI to work on the same codebase in parallel. The core loop: master agent decomposes a task → workers execute in isolated git worktrees → review agent checks results → user merges via GUI. The pipeline exists structurally but is broken end-to-end. M001 planning was completed but code changes never merged. M002 fixes everything from the actual codebase state.

## Why This Milestone

The orchestration pipeline is the app's entire reason to exist, and it doesn't work. The master agent fails at decomposition, workers can't run in parallel, the approval flow has race conditions, and the UI has anti-patterns that make errors invisible. Without this milestone, WhaleCode is a shell with no functioning core.

## User-Visible Outcome

### When this milestone is complete, the user can:

- Open WhaleCode, select a project directory, choose master + worker agents, type a complex task, and watch it get decomposed into sub-tasks
- Review and approve the sub-task plan before execution starts (manual approval by default)
- Watch workers execute in parallel with real-time output per worker
- Review per-worktree file diffs and selectively merge/discard individual worktree results
- See actionable error messages when something fails, with expandable technical detail

### Entry point / environment

- Entry point: WhaleCode desktop app (Tauri v2)
- Environment: macOS local dev (desktop app)
- Live dependencies involved: Claude Code CLI, Gemini CLI, Codex CLI (at least one must be installed and authenticated)

## Completion Class

- Contract complete means: Rust unit tests pass for orchestrator, DAG, worktree, and process management. TypeScript compiles clean. Wiring checks confirm backend↔frontend contracts
- Integration complete means: Real CLI agent spawned, output parsed, worktree created and used, diff generated, merge executed
- Operational complete means: Stale worktrees cleaned on startup, zombie processes reaped by heartbeat, errors surface in UI

## Final Integrated Acceptance

To call this milestone complete, we must prove:

- A real multi-step task runs through the full pipeline (decompose → approve → parallel execute in worktrees → review → merge) via the GUI
- All three agent types work as both master and worker
- Errors at any phase produce actionable, user-friendly UI feedback with expandable technical detail
- No zombie processes remain after orchestration completes or fails
- Worktrees are created for workers, used during execution, diffed for review, and cleaned up after merge

## Risks and Unknowns

- **Decomposition JSON parsing from real agents** — The 5-strategy parser looks thorough but hasn't been proven with all 3 agent types' actual NDJSON output formats. Each agent wraps JSON differently
- **Tool slot refactoring scope** — Changing `acquire_tool_slot` from per-agent-name to per-task-id could have cascading effects on process lifecycle tracking throughout the app
- **Worktree ↔ dispatch wiring** — Workers currently receive `project_dir` as cwd. Changing this to worktree paths requires touching the dispatch flow, adapter commands, and process tracking
- **Frontend state migration** — Changing Map keys from ToolName to task-id affects multiple components and hooks simultaneously

## Existing Codebase / Prior Art

- `src-tauri/src/commands/orchestrator.rs` — Main orchestration command, ~2200 lines. Phase 1-3 orchestration flow, decomposition parsing, DAG dispatch, retry logic
- `src-tauri/src/router/orchestrator.rs` — Types (SubTaskDef, OrchestrationPlan, etc.) and prompt builders
- `src-tauri/src/process/manager.rs` — Process spawning, tool slot mechanism, kill/cleanup
- `src-tauri/src/worktree/` — WorktreeManager with create/prune/cleanup/list, conflict detection, diff generation
- `src/hooks/orchestration/` — useOrchestratedDispatch (dispatch + channel handling), handleOrchEvent (event routing)
- `src/stores/taskStore.ts` — Zustand store for orchestration state, tasks Map, phases
- `src/components/orchestration/` — KanbanBoard, TaskApproval, DecompositionErrorCard, StagePipeline
- `src/components/views/` — CodeReviewView, TaskApprovalView, WorkingView
- `need_to_be_fixed.md` — Comprehensive 20+ issue audit from multi-agent analysis. Maps directly to requirements

> See `.gsd/DECISIONS.md` for all architectural and pattern decisions — it is an append-only register; read it during planning, append to it during execution.

## Relevant Requirements

- R001–R005 — Core pipeline (decomposition, worktrees, parallel execution, DAG)
- R006–R007, R010, R021, R024 — Frontend state and approval flow
- R008–R009, R012 — Review, merge, cleanup
- R002, R022–R023 — Error surfacing and UI cleanup
- R025 — End-to-end verification with real agents

## Scope

### In Scope

- Fix decomposition JSON parsing to work reliably with all 3 agent types
- Add SubTaskDef.id field, preserve through DAG
- Wire worktree creation into orchestrator dispatch path
- Change tool slot from per-agent-name to per-task-id
- Fix activePlan race condition in approval flow
- Replace FIFO task matching with dag_id-based matching
- Fix per-worker output streaming (per-task-id, not per-ToolName)
- Wire review agent to receive worktree diffs
- Wire selective_merge into review/merge UI
- Per-worktree granular merge controls
- Worktree cleanup on completion and app startup
- Zustand Map performance optimization (useShallow)
- Remove dead code, fix DOM manipulation anti-patterns
- Replace silent error catches with user feedback
- User-friendly error messages with expandable technical detail
- Manual approval default, auto-approve opt-in only
- End-to-end verification with real CLI agents

### Out of Scope / Non-Goals

- Single-agent mode (R013) — deferred until pipeline works
- Budget caps (R014) — deferred
- New agent types beyond Claude/Gemini/Codex
- Cross-platform support (Windows/Linux)
- UI visual redesign — this is fix and clean, not redesign
- New features not related to making the existing pipeline work

## Technical Constraints

- Tauri v2 IPC via channels — all backend→frontend communication through `Channel<OutputEvent>`
- CLI agents are spawned as subprocesses — no SDK/API integration
- git2 crate for worktree operations — no shell git commands
- Zustand for state management — no Redux migration
- `acquire_tool_slot` must still prevent TOCTOU races, just not block parallel same-agent workers

## Integration Points

- **Claude Code CLI** — Spawned via `claude -p` with `--output-format stream-json`. NDJSON output with `type: "result"` events
- **Gemini CLI** — Spawned via `gemini` with JSON output. Different NDJSON structure than Claude
- **Codex CLI** — Spawned via `codex` with `--output-format json`. Another NDJSON variant
- **git2** — Worktree creation, branch management, diff generation, merge operations
- **Tauri IPC** — `@@orch::` prefixed structured events for orchestration state, raw NDJSON for agent output

## Open Questions

- Whether `build_single_shot_command` (with `--max-turns 1 --allowedTools ""`) produces better decomposition results than the standard `build_command` with `-p` flag — needs testing with real agents
- Optimal concurrency limit per agent type — currently proposing per-task-id tracking with no global limit, but rate limits may require a configurable cap
