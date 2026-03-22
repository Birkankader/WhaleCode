# M001: End-to-End Orchestration Pipeline

**Gathered:** 2026-03-20
**Status:** Ready for planning

## Project Description

WhaleCode is a Tauri v2 desktop app (Rust + React) that orchestrates CLI-based AI coding agents (Claude Code, Gemini CLI, Codex CLI) to work on the same codebase in parallel. The core loop: master agent decomposes a task → workers execute in isolated git worktrees → review agent checks results → user merges.

## Why This Milestone

The orchestration pipeline — WhaleCode's entire reason to exist — doesn't work end-to-end. The master agent fails during decomposition with errors that are swallowed before reaching the UI. Even if decomposition succeeded, workers would run in the main project directory (not worktrees), can't run in parallel (tool slot bottleneck), and frontend state has race conditions that break the approval and completion tracking flows. The worktree and merge infrastructure exists in the codebase but isn't wired into the orchestrator. This milestone fixes all of it.

## User-Visible Outcome

### When this milestone is complete, the user can:

- Submit a complex task → see it decomposed into sub-tasks → approve/modify the plan → watch workers execute in parallel → review diffs → merge results
- See actionable error messages when any phase fails (not generic "Error")
- Monitor real-time streaming output from each worker, correctly attributed
- Use all three agents (Claude, Gemini, Codex) as master or worker interchangeably

### Entry point / environment

- Entry point: Desktop app GUI — task input in SetupPanel, orchestration in WorkingView/KanbanView
- Environment: Local dev (macOS), `cargo tauri dev`
- Live dependencies involved: Claude Code CLI, Gemini CLI, Codex CLI (each with their own auth/OAuth)

## Completion Class

- Contract complete means: Rust tests pass for decomposition parsing, worktree integration, DAG scheduling, tool slot concurrency. Frontend state transitions are correct for all orchestration phases
- Integration complete means: A real task is decomposed by a real CLI agent, workers execute in real worktrees, changes are diffed and mergeable
- Operational complete means: Stale worktrees are cleaned up, zombie processes don't accumulate, errors at any phase surface in the UI

## Final Integrated Acceptance

To call this milestone complete, we must prove:

- A multi-step task (e.g., "refactor module X and update tests") is decomposed by a master agent, approved by the user, executed by 2+ workers in parallel worktrees, reviewed, and merged — all through the GUI
- An error in any phase (decomposition parse failure, worker crash, rate limit) surfaces with actionable detail in the UI error card
- Multiple workers of the same agent type run concurrently without tool slot conflicts

## Risks and Unknowns

- LLM output format instability — Claude/Gemini/Codex may change their CLI output formats. The NDJSON parsing and JSON extraction strategies need to be robust against format drift
- Rate limit variability — each agent has different rate limit behaviors and error formats. Retry/fallback logic needs real-world testing
- Worktree merge conflicts — when workers modify overlapping files despite file-scope boundaries, the selective_merge strategy needs to handle real git conflicts gracefully
- The exact error causing the current "Error" card is unknown until reproduction — could be a spawn failure, path issue, or CLI tool configuration problem

## Existing Codebase / Prior Art

- `src-tauri/src/router/orchestrator.rs` — Orchestrator struct, decompose/review prompt builders, plan creation. This is the core orchestration logic
- `src-tauri/src/commands/orchestrator.rs` — The main `dispatch_orchestrated_task` Tauri command (~600 lines). Phases 1-3 implementation, JSON parsing with 5 fallback strategies, retry logic
- `src-tauri/src/router/dag.rs` — Kahn's algorithm for topological wave scheduling. Well-tested, works correctly
- `src-tauri/src/worktree/manager.rs` — WorktreeManager with create_for_task, remove_worktree, cleanup_stale_worktrees. Well-tested but not called from orchestrator
- `src-tauri/src/worktree/conflict.rs` — selective_merge, conflict detection. 500+ lines, not wired into orchestrator
- `src-tauri/src/worktree/diff.rs` — WorktreeDiffReport generation. Not wired into review phase
- `src-tauri/src/process/manager.rs` — spawn_interactive, acquire_tool_slot/release_tool_slot. Tool slot enforces max 1 per agent name
- `src-tauri/src/adapters/` — ClaudeAdapter, GeminiAdapter, CodexAdapter implementing ToolAdapter trait
- `src/hooks/orchestration/handleOrchEvent.ts` — Frontend event handler for `@@orch::` events. FIFO task matching, activePlan race condition
- `src/hooks/orchestration/useOrchestratedDispatch.ts` — Frontend orchestration dispatch with channel setup
- `src/components/orchestration/DecompositionErrorCard.tsx` — Error display card with retry/switch-agent actions
- `src-tauri/src/commands/router.rs` — `dispatch_task` command. Routes to per-agent spawn functions, uses tool slot reservation
- `need_to_be_fixed.md` — Comprehensive 20-agent analysis of all issues (at project root)

> See `.gsd/DECISIONS.md` for all architectural and pattern decisions — it is an append-only register; read it during planning, append to it during execution.

## Relevant Requirements

- R001 — Master agent decomposition is the entry point for the entire pipeline
- R002 — Error surfacing is critical for debuggability during all phases
- R003, R004 — Worktree isolation and parallel execution are the core safety and performance promises
- R005 — DAG dependency preservation ensures correct execution ordering
- R006, R007, R010 — Frontend state synchronization makes the UI reflect reality
- R008, R009 — Review and merge are how the user validates and accepts the work
- R011 — Rate limit retry ensures resilience during execution
- R012 — Worktree cleanup prevents accumulation of stale state

## Scope

### In Scope

- Fix master agent decomposition to produce parseable JSON reliably
- Surface backend errors with actionable detail in the UI
- Wire worktree isolation into the worker dispatch path
- Remove the per-agent-name tool slot bottleneck, enable parallel same-type workers
- Fix `SubTaskDef` to preserve LLM-generated task IDs for DAG dependencies
- Fix frontend `activePlan` race condition during approval phase
- Fix task completion matching to use dag_id instead of FIFO
- Wire selective_merge and worktree diff into the review and merge flow
- Clean up worktrees on orchestration completion and app startup
- Per-worker streaming output attribution in the UI

### Out of Scope / Non-Goals

- New agent adapters (plugin system) — deferred to future milestone
- Cross-platform support — deferred
- Budget caps — deferred
- Single-agent mode optimization — deferred
- UI visual redesign — only functional fixes to existing components
- App Store submission — deferred

## Technical Constraints

- Tauri v2 IPC: structured events via Channel<OutputEvent>, commands are async Rust functions
- git2 crate for worktree operations (not shelling out to git CLI)
- Each CLI agent uses its own auth (OAuth for Claude, API keys for Gemini/Codex via keychain)
- Process isolation via pgid groups, stdin/stdout pipes for communication
- Frontend uses Zustand with Map-based state (performance implications noted but not addressed in this milestone)

## Integration Points

- Claude Code CLI — spawned via `claude -p <prompt> --output-format stream-json --verbose --dangerously-skip-permissions`. NDJSON output with init/message/tool_use/tool_result/result events
- Gemini CLI — spawned via `gemini --yolo`. Different NDJSON format
- Codex CLI — spawned via `codex --full-auto`. Different NDJSON format with item.completed/turn.completed events
- macOS Keychain — API key storage for Gemini and Codex (Claude uses OAuth)
- Git — worktree branches under `whalecode/task/<id>`, directories under `.whalecode-worktrees/`

## Open Questions

- Exact error causing the current "Error" card — needs reproduction to diagnose. Likely a spawn failure or IPC error that's being caught but not propagated to the UI error card
- Optimal concurrency limit per agent type — should it be configurable, or is "unlimited parallel" safe? Rate limits may naturally throttle
- Whether to use `--max-turns 1` for decomposition (prevents tool use / runaway) or allow full tool use (better decomposition quality for complex tasks) — currently using `-p` single-shot which exits after one response
