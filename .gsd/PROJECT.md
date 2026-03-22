# Project

## What This Is

WhaleCode is a Tauri v2 desktop application (Rust backend + React frontend) that orchestrates multiple CLI-based AI coding agents — Claude Code, Gemini CLI, and Codex CLI — to work on the same codebase simultaneously. It spawns real CLI processes, streams their output, manages their lifecycle, and coordinates parallel execution in isolated git worktrees. It is a process orchestrator, not an LLM framework.

## Core Value

The three-phase orchestration loop: master agent decomposes a complex task → workers execute sub-tasks in parallel in isolated worktrees → review agent checks results and the user merges. If nothing else works, this loop must.

## Current State

~14K lines of Rust, ~90 React components. The project structure is complete — adapters for three CLI agents (Claude Code, Gemini CLI, Codex CLI) with ToolAdapter trait, process manager with streaming via Tauri IPC, DAG-based task scheduling, worktree management (create/prune/cleanup), Zustand state management, and a full desktop UI with Kanban board, terminal views, diff viewer, and settings. 388 Rust tests compile (50 orchestrator tests pass in <1s).

The end-to-end orchestration pipeline is broken. The master agent spawns but decomposition JSON parsing from NDJSON streams is fragile. Workers don't use worktree isolation (they run in the main project directory). The tool slot mechanism (`acquire_tool_slot`) prevents parallel execution of the same agent type with a global max-1 lock. Frontend state synchronization has race conditions (activePlan null during approval, FIFO task completion matching). The worktree and selective_merge infrastructure exists but isn't wired into the orchestrator dispatch path. The UI has anti-patterns (direct DOM manipulation, silent error swallowing, dead code).

M001 planning artifacts exist but the code changes were never merged from the worktree — the codebase is pre-M001 state. M002 absorbs all M001 scope and re-implements fixes from the actual code.

## Architecture / Key Patterns

- **Backend:** Rust (Tauri v2), modules: `adapters/` (Claude/Gemini/Codex ToolAdapter trait), `router/` (orchestrator, DAG, retry), `process/` (manager, signals), `worktree/` (manager, conflict, diff), `commands/` (Tauri IPC handlers), `context/` (SQLite store), `credentials/` (keychain per agent)
- **Frontend:** React + TypeScript + Vite, stores: `taskStore` (Zustand, orchestration state), `uiStore`, `notificationStore`, `processStore` (legacy, being phased out). Hooks: `useOrchestratedDispatch`, `handleOrchEvent`, `useOrchestrationLaunch`
- **IPC:** Tauri channels for streaming NDJSON output. Structured orchestrator events prefixed with `@@orch::` to distinguish from raw agent output
- **Process model:** Each CLI agent spawned as a subprocess with pgid isolation. Tool slot reservation prevents TOCTOU races (currently max 1 per agent type — needs to become per-task-id)
- **Worktrees:** git2 crate, branches under `whalecode/task/<prefix>`, directories under `.whalecode-worktrees/`

## Capability Contract

See `.gsd/REQUIREMENTS.md` for the explicit capability contract, requirement status, and coverage mapping.

## Milestone Sequence

- [x] M001: End-to-End Orchestration Pipeline — Planning artifacts complete, code changes not merged (absorbed into M002)
- [ ] M002: Working Pipeline & UI Overhaul — Fix the broken pipeline end-to-end, clean up UI, prove with real agents
