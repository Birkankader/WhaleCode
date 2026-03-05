# Phase 2: Process Core - Context

**Gathered:** 2026-03-05
**Status:** Ready for planning

<domain>
## Phase Boundary

Subprocess lifecycle management: spawn, monitor, cancel, pause, and cleanly terminate CLI subprocesses. The app shuts down without leaving zombie processes. Each tool gets its own output log. This phase builds on Phase 1's AppState and Channel pipeline.

Requirements: PROC-05, PROC-06, PROC-07, PROC-08

</domain>

<decisions>
## Implementation Decisions

### Process Manager Architecture
- Use `tokio::process::Command` for spawning subprocesses from Rust
- Track all child PIDs in AppState process registry (established in Phase 1)
- Each spawned process gets a unique TaskId and its own `tauri::Channel<OutputEvent>`
- Process Manager is a Rust module that owns all subprocess lifecycle operations

### Zombie Prevention
- `RunEvent::Exit` hook already wired in Phase 1 — extend to kill all tracked processes
- Must kill grandchild processes too (Tauri only kills direct children)
- Use process group IDs (pgid) to kill entire process trees
- Verify with `pgrep` after app exit — zero tolerance for zombies

### Cancel/Pause/Resume
- Cancel: send SIGTERM to process group, wait 2s, then SIGKILL if still alive
- Pause: send SIGSTOP to process group
- Resume: send SIGCONT to process group
- All operations via IPC commands from frontend → Rust backend

### Per-Tool Output Logs
- Extend Phase 1's single OutputConsole to support multiple concurrent streams
- Each process gets its own scrollable, timestamped output panel
- Frontend manages tab/panel switching between active processes
- Output batching at 100-500ms intervals (from Phase 1 research)

### Claude's Discretion
- Exact process manager module structure
- Error handling strategy for failed spawns
- Output panel tab vs split-pane layout
- Timestamp format in output logs

</decisions>

<specifics>
## Specific Ideas

- Research warns: Tauri does NOT reliably kill grandchild processes on app exit — must handle via pgid
- Set NO_COLOR=1 and TERM=dumb in subprocess environment for clean output parsing
- Phase 1 already has AppState with process registry and RunEvent::Exit hook — extend, don't replace

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src-tauri/src/state.rs`: AppState with Mutex, task registry, process registry
- `src-tauri/src/ipc/events.rs`: OutputEvent enum (Stdout, Stderr, Exit, Error)
- `src-tauri/src/commands/mod.rs`: start_stream command with Channel pattern
- `src-tauri/src/lib.rs`: RunEvent::Exit hook, tauri-specta builder
- `src/components/terminal/OutputConsole.tsx`: xterm.js terminal wired to Channel
- `src/bindings.ts`: Auto-generated typed IPC bindings

### Established Patterns
- std::sync::Mutex for AppState (not tokio::sync::Mutex)
- tauri::Channel<OutputEvent> for streaming (not global events)
- tauri::async_runtime::spawn() for async work
- tauri-specta for type-safe IPC bindings

### Integration Points
- Process Manager extends AppState.process_registry
- New commands (spawn_process, cancel_process, pause_process, resume_process) added to generate_handler!
- Frontend adds process management UI alongside existing OutputConsole
- Multiple OutputConsole instances (one per process) managed by new ProcessPanel component

</code_context>

<deferred>
## Deferred Ideas

None — decisions made autonomously based on research and Phase 1 patterns.

</deferred>

---

*Phase: 02-process-core*
*Context gathered: 2026-03-05*
