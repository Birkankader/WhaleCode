# Roadmap: WhaleCode

## Overview

WhaleCode is built in nine phases, each delivering a coherent, independently-verifiable capability. Phases 1-3 establish the process infrastructure and first working AI tool integration. Phases 4-5 build the shared context store and git worktree isolation that make parallel execution safe. Phases 6-7 add the second tool and the routing logic that makes orchestration intelligent. Phase 8 delivers the prompt optimization differentiator. Phase 9 closes the loop with the review UI and dashboard polish that make the product trustworthy to ship. The hard constraint from all research: parallel execution cannot be enabled before Phase 5 (worktree isolation) is verified complete.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Foundation** - Tauri v2 scaffold, AppState, IPC channel pipeline, base UI shell (completed 2026-03-05)
- [x] **Phase 2: Process Core** - Subprocess lifecycle management, zombie cleanup, streaming output console (completed 2026-03-05)
- [x] **Phase 3: Claude Code Adapter** - Tool trait, headless NDJSON execution, silent failure detection, API key security (completed 2026-03-05)
- [ ] **Phase 4: Context Store** - SQLite write-ahead log of file changes and decisions, persistent project memory
- [ ] **Phase 5: Worktree Isolation + Conflict Detection** - Git worktree per task, file-lock registry, conflict alerts
- [ ] **Phase 6: Gemini CLI Adapter** - Second tool adapter, output validation, quota tracking, both adapters proven
- [ ] **Phase 7: Task Router + Parallel Execution** - Rule-based routing, DAG dispatch, parallel tool status panel
- [ ] **Phase 8: Prompt Engine** - Per-tool prompt optimization, context injection, preview before send
- [ ] **Phase 9: Review UI + Safety Controls** - Diff review, file-level accept/reject, status panel polish

## Phase Details

### Phase 1: Foundation
**Goal**: A working Tauri v2 desktop window with type-safe Rust-to-React IPC and a streaming output channel ready to receive data
**Depends on**: Nothing (first phase)
**Requirements**: FOUN-01, FOUN-02, FOUN-03
**Success Criteria** (what must be TRUE):
  1. App launches as a native macOS window without errors
  2. Rust backend initializes AppState with Mutex-protected state and IPC channels wired up
  3. React frontend renders with routing and base layout — no blank screen, no console errors
  4. A test event sent from Rust over a Tauri Channel appears rendered in the frontend output area
**Plans**: 3 plans
Plans:
- [ ] 01-01-PLAN.md — Tauri scaffold, pinned deps, window config, test infrastructure
- [ ] 01-02-PLAN.md — Rust AppState, OutputEvent, Channel command, tauri-specta bindings
- [ ] 01-03-PLAN.md — React AppShell, xterm.js terminal, Channel wiring, AppShell tests

### Phase 2: Process Core
**Goal**: Users can spawn, monitor, cancel, pause, and cleanly terminate CLI subprocesses; the app shuts down without leaving zombie processes; each tool has its own output log
**Depends on**: Phase 1
**Requirements**: PROC-05, PROC-06, PROC-07, PROC-08
**Success Criteria** (what must be TRUE):
  1. User can spawn a subprocess and see its stdout in a scrollable, timestamped output log
  2. User can cancel a running process via UI; the process terminates and the output log reflects the cancellation
  3. User can pause and resume a process; output resumes from where it paused
  4. After quitting the app, running `pgrep` on any spawned CLIs returns no results (no zombies)
**Plans**: 2 plans
Plans:
- [ ] 02-01-PLAN.md — Process manager spawn/cancel/pause/resume, signal handling, zombie cleanup
- [ ] 02-02-PLAN.md — Process management UI with tabbed ProcessPanel and OutputConsole

### Phase 3: Claude Code Adapter
**Goal**: Users can submit a task to Claude Code and see streaming output in real-time; silent failures are detected and surfaced, not silently dropped; API key is stored securely
**Depends on**: Phase 2
**Requirements**: PROC-01, INTG-01
**Success Criteria** (what must be TRUE):
  1. User can spawn Claude Code in headless mode (`-p`) on a real project and see streaming NDJSON output rendered line-by-line in the output log
  2. A zero-token or empty response from Claude Code is flagged as a failure in the UI, not shown as success
  3. When Claude Code hits an API rate limit, the user sees a notification and the task retries with backoff
  4. Claude Code API key is stored in the OS keychain — not visible in app files or logs
**Plans**: 4 plans
Plans:
- [x] 03-01-PLAN.md — Keychain credential storage, process manager env var extension
- [x] 03-02-PLAN.md — Claude adapter NDJSON parsing, failure detection, IPC commands
- [x] 03-03-PLAN.md — Frontend Claude integration, API key settings UI, end-to-end verification
- [ ] 03-04-PLAN.md — Gap closure: wire retry loop, silent failure detection, API key delete

### Phase 4: Context Store
**Goal**: The app maintains a persistent, queryable record of every file change and task decision; this record survives app restarts and is automatically injected into each tool before it starts
**Depends on**: Phase 3
**Requirements**: CTXT-01, CTXT-02, CTXT-03, CTXT-04, CTXT-05
**Success Criteria** (what must be TRUE):
  1. After a Claude Code task completes, the app has recorded which files were changed and a task summary in the context store
  2. The context store persists across app restarts — records written in one session are readable in the next
  3. Before a tool starts a new task, relevant context (recent changes, decisions) is automatically prepended to its invocation
  4. A tool can query the event log to see what files another tool changed in previous tasks
**Plans**: 3 plans
Plans:
- [ ] 01-01-PLAN.md — Tauri scaffold, pinned deps, window config, test infrastructure
- [ ] 01-02-PLAN.md — Rust AppState, OutputEvent, Channel command, tauri-specta bindings
- [ ] 01-03-PLAN.md — React AppShell, xterm.js terminal, Channel wiring, AppShell tests

### Phase 5: Worktree Isolation + Conflict Detection
**Goal**: Each tool task runs in its own git worktree; two tools modifying the same file produces a visible conflict alert before any merge to main happens
**Depends on**: Phase 4
**Requirements**: PROC-04, SAFE-03, SAFE-04
**Success Criteria** (what must be TRUE):
  1. When a task is dispatched, a dedicated git worktree is created for it automatically; the tool runs inside that worktree
  2. When two tool tasks that touch the same file are dispatched, the user receives a conflict warning before either task is allowed to merge back
  3. Conflict detection fires before merge to the main branch — not after
  4. When the app crashes mid-task, the abandoned worktree is detected and cleaned up on next launch
**Plans**: 3 plans
Plans:
- [ ] 01-01-PLAN.md — Tauri scaffold, pinned deps, window config, test infrastructure
- [ ] 01-02-PLAN.md — Rust AppState, OutputEvent, Channel command, tauri-specta bindings
- [ ] 01-03-PLAN.md — React AppShell, xterm.js terminal, Channel wiring, AppShell tests

### Phase 6: Gemini CLI Adapter
**Goal**: Users can run Gemini CLI tasks with the same control and output visibility as Claude Code; both adapters validate output content and handle rate limits; the Tool trait is proven with two implementations
**Depends on**: Phase 5
**Requirements**: PROC-02, INTG-02, INTG-03, INTG-04
**Success Criteria** (what must be TRUE):
  1. User can spawn Gemini CLI in headless mode on a real project and see structured output rendered in the output log
  2. Both adapters (Claude Code and Gemini) validate output content — malformed or empty responses are flagged, not silently accepted
  3. When Gemini hits a quota limit, the user sees a notification and the task backs off, matching Claude adapter behavior
  4. Claude Code and Gemini CLI adapters are interchangeable through the same Tool trait — adding a new adapter doesn't require changes to the Process Manager
**Plans**: 3 plans
Plans:
- [ ] 01-01-PLAN.md — Tauri scaffold, pinned deps, window config, test infrastructure
- [ ] 01-02-PLAN.md — Rust AppState, OutputEvent, Channel command, tauri-specta bindings
- [ ] 01-03-PLAN.md — React AppShell, xterm.js terminal, Channel wiring, AppShell tests

### Phase 7: Task Router + Parallel Execution
**Goal**: Users can submit a task and have the app suggest the right tool; two tasks can run in parallel on the same project with a live status panel showing each tool's real-time state
**Depends on**: Phase 6
**Requirements**: PROC-03, ROUT-01, ROUT-02, ROUT-03, ROUT-04, SAFE-05, SAFE-06
**Success Criteria** (what must be TRUE):
  1. When a user submits a task, the app suggests which tool should handle it based on task type (e.g., architecture refactor → Claude, large codebase read → Gemini)
  2. User can override the suggested tool assignment before dispatching
  3. Two tasks run simultaneously on the same project without interfering with each other's worktrees
  4. Live status panel shows each tool's real-time state (idle, running, completed, failed) with current task description and elapsed time
  5. A task that depends on another tool's output waits for that tool to finish before dispatching
**Plans**: 3 plans
Plans:
- [ ] 01-01-PLAN.md — Tauri scaffold, pinned deps, window config, test infrastructure
- [ ] 01-02-PLAN.md — Rust AppState, OutputEvent, Channel command, tauri-specta bindings
- [ ] 01-03-PLAN.md — React AppShell, xterm.js terminal, Channel wiring, AppShell tests

### Phase 8: Prompt Engine
**Goal**: Users write one prompt; the app automatically rewrites it for each target tool's conventions and injects relevant project context; users can preview the optimized prompt before sending
**Depends on**: Phase 7
**Requirements**: PMPT-01, PMPT-02, PMPT-03, PMPT-04
**Success Criteria** (what must be TRUE):
  1. User writes a single prompt and submits it — the app generates a distinct optimized version for each target tool
  2. User can open a preview panel to see the optimized prompt for each tool before it is sent
  3. The optimized prompt includes relevant project context and recent change history, drawn from the context store
  4. Prompt optimization applies tool-specific conventions (Claude gets planning preamble, Gemini gets large-context structure)
**Plans**: 3 plans
Plans:
- [ ] 01-01-PLAN.md — Tauri scaffold, pinned deps, window config, test infrastructure
- [ ] 01-02-PLAN.md — Rust AppState, OutputEvent, Channel command, tauri-specta bindings
- [ ] 01-03-PLAN.md — React AppShell, xterm.js terminal, Channel wiring, AppShell tests

### Phase 9: Review UI + Safety Controls
**Goal**: Users can review every file change a tool made as a unified diff and accept or reject changes at file level before anything merges; no change is ever committed without explicit user action
**Depends on**: Phase 8
**Requirements**: SAFE-01, SAFE-02
**Success Criteria** (what must be TRUE):
  1. After a tool task completes, user can open a unified diff view showing all files changed by that tool
  2. User can accept or reject individual files from the diff view; rejected files are not merged back to main
  3. No changes are automatically committed — every merge requires explicit user action in the UI
  4. The status panel clearly distinguishes active vs. idle tools; conflict alerts appear in human-readable language, not raw file paths
**Plans**: 3 plans
Plans:
- [ ] 01-01-PLAN.md — Tauri scaffold, pinned deps, window config, test infrastructure
- [ ] 01-02-PLAN.md — Rust AppState, OutputEvent, Channel command, tauri-specta bindings
- [ ] 01-03-PLAN.md — React AppShell, xterm.js terminal, Channel wiring, AppShell tests

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 3/3 | Complete    | 2026-03-05 |
| 2. Process Core | 2/2 | Complete   | 2026-03-05 |
| 3. Claude Code Adapter | 4/4 | Complete   | 2026-03-05 |
| 4. Context Store | 0/TBD | Not started | - |
| 5. Worktree Isolation + Conflict Detection | 0/TBD | Not started | - |
| 6. Gemini CLI Adapter | 0/TBD | Not started | - |
| 7. Task Router + Parallel Execution | 0/TBD | Not started | - |
| 8. Prompt Engine | 0/TBD | Not started | - |
| 9. Review UI + Safety Controls | 0/TBD | Not started | - |
