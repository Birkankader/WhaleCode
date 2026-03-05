# Requirements: WhaleCode

**Defined:** 2026-03-05
**Core Value:** Multiple AI coding tools working in parallel on the same project, fully aware of each other's changes and sharing a unified context

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### Foundation

- [x] **FOUN-01**: App launches as native macOS window with Tauri v2 shell
- [x] **FOUN-02**: Rust backend initializes with managed AppState and IPC channels
- [ ] **FOUN-03**: Frontend renders React app with routing and base layout

### Process Management

- [ ] **PROC-01**: User can spawn a Claude Code subprocess in headless mode and see streaming output in real-time
- [ ] **PROC-02**: User can spawn a Gemini CLI subprocess in headless mode and see streaming output in real-time
- [ ] **PROC-03**: User can run two tool processes in parallel on the same project
- [ ] **PROC-04**: Each tool process runs in its own git worktree, isolated from other tools
- [ ] **PROC-05**: User can cancel a running tool process without affecting other running processes
- [ ] **PROC-06**: User can pause and resume a tool process
- [ ] **PROC-07**: App cleans up all child and grandchild processes on exit (no zombies)
- [ ] **PROC-08**: Each tool has a dedicated scrollable output log with timestamps

### Context Management

- [ ] **CTXT-01**: App maintains a persistent project context store (code structure, files, past decisions)
- [ ] **CTXT-02**: Project context is automatically injected into each tool before it starts a task
- [ ] **CTXT-03**: App records every file change made by every tool in a structured event log
- [ ] **CTXT-04**: Each tool can read the event log to know what other tools have changed
- [ ] **CTXT-05**: Context persists across app restarts (SQLite-backed)

### Prompt Engine

- [ ] **PMPT-01**: User writes a single prompt for a task
- [ ] **PMPT-02**: App automatically optimizes the prompt for each target tool's conventions and strengths
- [ ] **PMPT-03**: User can preview the optimized prompt before sending
- [ ] **PMPT-04**: Prompt optimization includes relevant project context and recent change history

### Task Routing

- [ ] **ROUT-01**: App suggests which tool should handle a given task based on task type
- [ ] **ROUT-02**: User can override the suggested tool assignment
- [ ] **ROUT-03**: Routing considers tool strengths (Claude for refactoring/architecture, Gemini for large context reads)
- [ ] **ROUT-04**: Routing considers current tool availability (busy/idle status)

### Review & Safety

- [ ] **SAFE-01**: User can view unified diff of all changes made by a tool before committing
- [ ] **SAFE-02**: User can accept or reject changes at file level
- [ ] **SAFE-03**: App detects when two tools have modified the same file and alerts the user
- [ ] **SAFE-04**: Conflict detection happens before merge back to main branch
- [ ] **SAFE-05**: Live status panel shows each tool's state (idle, running, completed, failed)
- [ ] **SAFE-06**: Status panel shows current task description and progress for each tool

### Integration

- [ ] **INTG-01**: Claude Code adapter uses CLI subprocess with --output-format stream-json
- [ ] **INTG-02**: Gemini CLI adapter uses CLI subprocess with JSON output mode
- [ ] **INTG-03**: Each adapter validates output content (not just exit codes) for silent failures
- [ ] **INTG-04**: Adapters handle API rate limits with backoff and user notification

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Autonomy Controls

- **AUTO-01**: User can define file allowlist/denylist per task (bounded autonomy)
- **AUTO-02**: User can set guardrails for which commands a tool may run

### Task Decomposition

- **DCMP-01**: User describes a feature and app breaks it into subtasks
- **DCMP-02**: App assigns each subtask to the optimal tool automatically

### Conflict Resolution

- **CFRS-01**: App suggests AI-powered resolution when two tools conflict on same file
- **CFRS-02**: Side-by-side diff view with suggested merge

### Third Tool

- **CODX-01**: Codex CLI adapter with JSON-RPC app-server mode
- **CODX-02**: Codex CLI integrated into routing and prompt optimization

## Out of Scope

| Feature | Reason |
|---------|--------|
| Built-in code editor | WhaleCode orchestrates, doesn't replace IDE; scope explosion |
| Real-time agent-to-agent communication | Research shows equal-status agent communication kills throughput (Cursor finding) |
| Fully autonomous unattended operation | METR research: developers 19% slower with full autonomy; bounded approach better |
| Automatic push to remote | Safety risk; always require explicit push |
| More than 3 tools in v1 | Each tool = separate adapter, prompt template, tests; quadratic edge cases |
| Windows/Linux support | macOS first; cross-platform later |
| Chat interface for task entry | Creates confusion about product purpose; structured task input instead |
| Custom AI model selection per tool | Routing complexity explosion; lock orchestration model |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| FOUN-01 | Phase 1 | Complete |
| FOUN-02 | Phase 1 | Complete |
| FOUN-03 | Phase 1 | Pending |
| PROC-01 | Phase 3 | Pending |
| PROC-02 | Phase 6 | Pending |
| PROC-03 | Phase 7 | Pending |
| PROC-04 | Phase 5 | Pending |
| PROC-05 | Phase 2 | Pending |
| PROC-06 | Phase 2 | Pending |
| PROC-07 | Phase 2 | Pending |
| PROC-08 | Phase 2 | Pending |
| CTXT-01 | Phase 4 | Pending |
| CTXT-02 | Phase 4 | Pending |
| CTXT-03 | Phase 4 | Pending |
| CTXT-04 | Phase 4 | Pending |
| CTXT-05 | Phase 4 | Pending |
| PMPT-01 | Phase 8 | Pending |
| PMPT-02 | Phase 8 | Pending |
| PMPT-03 | Phase 8 | Pending |
| PMPT-04 | Phase 8 | Pending |
| ROUT-01 | Phase 7 | Pending |
| ROUT-02 | Phase 7 | Pending |
| ROUT-03 | Phase 7 | Pending |
| ROUT-04 | Phase 7 | Pending |
| SAFE-01 | Phase 9 | Pending |
| SAFE-02 | Phase 9 | Pending |
| SAFE-03 | Phase 5 | Pending |
| SAFE-04 | Phase 5 | Pending |
| SAFE-05 | Phase 7 | Pending |
| SAFE-06 | Phase 7 | Pending |
| INTG-01 | Phase 3 | Pending |
| INTG-02 | Phase 6 | Pending |
| INTG-03 | Phase 6 | Pending |
| INTG-04 | Phase 6 | Pending |

**Coverage:**
- v1 requirements: 34 total
- Mapped to phases: 34
- Unmapped: 0 ✓

---
*Requirements defined: 2026-03-05*
*Last updated: 2026-03-05 after roadmap creation — traceability complete*
