# Project

## What This Is

WhaleCode is a Tauri v2 desktop application (Rust backend + React frontend) that orchestrates multiple CLI-based AI coding agents — Claude Code, Gemini CLI, and Codex CLI — to work on the same codebase simultaneously. It spawns real CLI processes, streams their output, manages their lifecycle, and coordinates parallel execution in isolated git worktrees. It is a process orchestrator, not an LLM framework.

## Core Value

The three-phase orchestration loop: master agent decomposes a complex task → workers execute sub-tasks in parallel in isolated worktrees → review agent checks results and the user merges. If nothing else works, this loop must.

## Current State

~14K lines of Rust, ~90 React components, 199 tests across 5 suites. The three-phase orchestration pipeline is fully wired and tested:

1. **Decomposition:** Master agent decomposes a task into sub-tasks with parseable JSON. LLM-provided task IDs preserved through serde with all-or-nothing DAG ID assignment. Decomposition failures surface with 21 humanized error patterns and expandable technical detail.

2. **Parallel Execution:** Workers execute in isolated git worktrees (`.whalecode-worktrees/`). JoinSet-based parallel wave dispatch within DAG dependency waves. Per-dispatch-id tool slots enable concurrent same-agent workers. Rate-limit retry with exponential backoff and agent fallback.

3. **Review & Merge:** Auto-commit + unified diff generation per worktree (Phase 2.5). Review agent receives actual diff text. Per-worktree collapsible diff cards in UI with granular merge/discard controls. Worktree cleanup on completion and app startup.

**UI state management:** Zustand with useShallow on all multi-property selectors. dagToFrontendId map as sole task-matching mechanism. Manual approval by default (no countdown timer). Dead code removed, DOM manipulation anti-patterns eliminated, silent catches replaced with logging.

All 17 non-deferred requirements validated. 6 requirements deferred for future milestones.

## Architecture / Key Patterns

- **Backend:** Rust (Tauri v2), modules: `adapters/` (Claude/Gemini/Codex ToolAdapter trait), `router/` (orchestrator, DAG, retry), `process/` (manager, signals), `worktree/` (manager, conflict, diff), `commands/` (Tauri IPC handlers), `context/` (SQLite store), `credentials/` (keychain per agent)
- **Frontend:** React + TypeScript + Vite, stores: `taskStore` (Zustand, orchestration state), `uiStore`, `notificationStore`. Hooks: `useOrchestratedDispatch`, `handleOrchEvent`, `useOrchestrationLaunch`
- **IPC:** Tauri channels for streaming NDJSON output. Structured orchestrator events prefixed with `@@orch::` to distinguish from raw agent output
- **Process model:** Each CLI agent spawned as a subprocess with pgid isolation. Per-dispatch-id slot reservation via `acquire_dispatch_slot`. `dispatch_task_inner()` for spawned Tokio tasks (tauri::State lifetime constraint)
- **Worktrees:** git2 crate, branches under `whalecode/task/<prefix>`, directories under `.whalecode-worktrees/`. Sequential auto-commit + diff via `spawn_blocking`
- **Error display:** `humanizeError()` with 21 pattern matchers → plain-language message + expandable raw detail

## Capability Contract

See `.gsd/REQUIREMENTS.md` for the explicit capability contract, requirement status, and coverage mapping.

## Milestone Sequence

- [x] M001: End-to-End Orchestration Pipeline — Planning artifacts complete, code changes absorbed into M002
- [x] M002: Working Pipeline & UI Overhaul — Full pipeline wired and tested (decompose → approve → parallel worktree execute → review → merge). 17 requirements validated. 199 tests pass.
