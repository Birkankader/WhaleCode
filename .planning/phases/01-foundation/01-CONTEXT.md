# Phase 1: Foundation - Context

**Gathered:** 2026-03-05
**Status:** Ready for planning

<domain>
## Phase Boundary

Working Tauri v2 desktop window with type-safe Rust-to-React IPC and a streaming output channel ready to receive data. No AI logic, no tool integration — pure infrastructure scaffold that all subsequent phases build on.

Requirements: FOUN-01, FOUN-02, FOUN-03

</domain>

<decisions>
## Implementation Decisions

### App Shell Layout
- Single-window app with sidebar + main content area
- Sidebar: navigation for future tool panels (placeholder for now)
- Main area: streaming output console (xterm.js terminal) — this is the primary view in Phase 1
- Dark theme by default — coding tools are used in dark environments
- Window title: "WhaleCode"
- Minimum window size: 800x600

### Project Structure
- Monorepo: `src-tauri/` (Rust backend) + `src/` (React frontend)
- Use `create-tauri-app` with React + TypeScript + Vite template as starting point
- tauri-specta for type-safe IPC from day one — no manual TypeScript type definitions for commands
- Frontend state: Zustand for ephemeral UI state (tool panels, sidebar collapse, etc.)
- Styling: Tailwind CSS 4.x + shadcn/ui components — consistent with research recommendation

### Rust Backend Architecture
- AppState struct with `std::sync::Mutex` (not tokio::sync::Mutex) — research confirmed this
- AppState contains: task registry (`HashMap<TaskId, TaskInfo>`), process registry (`Vec<Child>` for cleanup)
- Use `tauri::async_runtime::spawn()` for async work — never block in command handlers
- `RunEvent::Exit` hook for process cleanup — verified zombie-free shutdown
- Do NOT use `#[tokio::main]` — conflicts with Tauri's internal runtime (research warning)

### IPC Streaming Pipeline
- Use `tauri::Channel<OutputEvent>` for streaming subprocess output to frontend
- OutputEvent enum: `{ Stdout(String), Stderr(String), Exit(i32), Error(String) }`
- One channel per future tool task — not a single shared channel
- Frontend subscribes to channel via tauri-specta generated bindings
- Batch output in 100-500ms windows to prevent IPC bottleneck (research pitfall)

### Terminal Output Console
- @xterm/xterm 5.5.0 with react-xtermjs wrapper
- Single terminal panel for Phase 1 — will split into per-tool panels in Phase 2
- Show timestamped output lines
- Support ANSI color codes from CLI output
- Scrollback buffer: 10,000 lines

### Claude's Discretion
- Exact sidebar width and collapse behavior
- Font choices and spacing
- Error boundary implementation details
- Dev tooling setup (ESLint, Prettier config)
- Exact Vite configuration

</decisions>

<specifics>
## Specific Ideas

- Research strongly recommends tauri-specta 2.x — this must be set up in Phase 1, not retrofitted later
- `tauri` and `tauri-build` must match minor version (both 2.10.x) — version mismatch causes build failures
- All `@xterm/*` addons must be the same major version (5.x)
- NO_COLOR=1 and TERM=dumb should be set in subprocess environment for clean output parsing (research pitfall prevention)

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- None — greenfield project, empty repository

### Established Patterns
- None yet — this phase establishes the patterns all subsequent phases follow

### Integration Points
- This phase creates the scaffold that Phase 2 (Process Core) plugs into
- The streaming Channel pipeline must be generic enough for Phase 3+ tool adapters
- AppState structure must be extensible for Phase 4 (Context Store) and Phase 5 (Worktree Isolation)

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope (decisions made autonomously based on research findings)

</deferred>

---

*Phase: 01-foundation*
*Context gathered: 2026-03-05*
