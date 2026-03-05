---
phase: 02-process-core
plan: 01
subsystem: process
tags: [tokio, nix, libc, signals, subprocess, pgid, tauri-ipc]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: "AppState with Mutex, OutputEvent enum, Channel pipeline, RunEvent::Exit hook"
provides:
  - "Process manager: spawn with pgid isolation, cancel (SIGTERM->SIGKILL), pause (SIGSTOP), resume (SIGCONT)"
  - "Four IPC commands: spawn_process, cancel_process, pause_process, resume_process"
  - "Process registry in AppState with ProcessEntry/ProcessStatus"
  - "Exit hook killing all tracked process groups"
  - "Type-safe frontend bindings for all process commands"
affects: [02-process-core, 03-claude-integration, 06-gemini-integration]

# Tech tracking
tech-stack:
  added: [nix 0.29, libc 0.2, uuid 1, tokio process/time/io-util features]
  patterns: [pgid isolation via setpgid(0,0), process group signaling, Arc<Mutex> for async-cloneable state]

key-files:
  created:
    - src-tauri/src/process/manager.rs
    - src-tauri/src/process/signals.rs
    - src-tauri/src/process/mod.rs
    - src-tauri/src/commands/process.rs
  modified:
    - src-tauri/Cargo.toml
    - src-tauri/src/state.rs
    - src-tauri/src/commands/mod.rs
    - src-tauri/src/lib.rs
    - src/bindings.ts

key-decisions:
  - "Changed AppState from Mutex<AppStateInner> to Arc<Mutex<AppStateInner>> for cloneable state in async waiter tasks"
  - "tokio::process::Command provides pre_exec natively, no need for std::os::unix::process::CommandExt import"

patterns-established:
  - "Process group isolation: every subprocess gets setpgid(0,0), all signal operations use killpg on pgid"
  - "Stream reading: separate tokio tasks for stdout/stderr, each sending OutputEvent via Channel"
  - "Process lifecycle: waiter task calls child.wait() then updates ProcessEntry status in state"

requirements-completed: [PROC-05, PROC-06, PROC-07]

# Metrics
duration: 5min
completed: 2026-03-05
---

# Phase 2 Plan 1: Process Manager Summary

**Rust process manager with pgid-isolated subprocess spawning, SIGTERM/SIGKILL cancel, SIGSTOP/SIGCONT pause/resume, and zombie-free exit hook**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-05T18:39:53Z
- **Completed:** 2026-03-05T18:45:49Z
- **Tasks:** 2
- **Files modified:** 10

## Accomplishments
- Process manager module with spawn (pgid isolation), cancel (graceful SIGTERM then SIGKILL), pause (SIGSTOP), resume (SIGCONT)
- Four IPC commands registered and exposed via tauri-specta with typed frontend bindings
- RunEvent::Exit hook kills all tracked process groups to prevent zombies
- Process registry in AppState tracks pgid and lifecycle status per task

## Task Commits

Each task was committed atomically:

1. **Task 1: Process manager module with spawn, cancel, pause, resume** - `e8c2bf7` (feat)
2. **Task 2: Wire IPC commands and exit hook** - `c42c999` (feat)

## Files Created/Modified
- `src-tauri/src/process/manager.rs` - Core spawn/cancel/pause/resume operations with pgid isolation
- `src-tauri/src/process/signals.rs` - Signal helpers: killpg, graceful_kill, pause_group, resume_group
- `src-tauri/src/process/mod.rs` - Process module declarations
- `src-tauri/src/commands/process.rs` - Four Tauri IPC command wrappers
- `src-tauri/Cargo.toml` - Added nix, libc, uuid, tokio deps
- `src-tauri/src/state.rs` - ProcessEntry, ProcessStatus, Arc<Mutex> AppState
- `src-tauri/src/commands/mod.rs` - Process module and re-exports
- `src-tauri/src/lib.rs` - Command registration and exit hook
- `src/bindings.ts` - Regenerated with spawnProcess, cancelProcess, pauseProcess, resumeProcess

## Decisions Made
- Changed AppState type from `Mutex<AppStateInner>` to `Arc<Mutex<AppStateInner>>` so state can be cloned into async waiter tasks that update process status after child.wait()
- tokio::process::Command natively provides `pre_exec` without needing explicit `CommandExt` import

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added tokio process feature to Cargo.toml**
- **Found during:** Task 1 (Process manager module)
- **Issue:** Plan specified `tokio = { version = "1", features = ["io-util", "time"] }` but `tokio::process::Command` requires the `process` feature
- **Fix:** Added `process` to tokio features list
- **Files modified:** src-tauri/Cargo.toml
- **Verification:** cargo build succeeds
- **Committed in:** e8c2bf7 (Task 1 commit)

**2. [Rule 1 - Bug] Changed AppState to Arc<Mutex> for async task cloning**
- **Found during:** Task 1 (Process manager module)
- **Issue:** `tauri::State::inner()` returns `&T` which cannot be moved into `'static` async tasks. The waiter task needs owned access to update process status.
- **Fix:** Changed `pub type AppState = Mutex<AppStateInner>` to `pub type AppState = Arc<Mutex<AppStateInner>>` so `.clone()` gives a cheap Arc clone
- **Files modified:** src-tauri/src/state.rs
- **Verification:** cargo build succeeds, all 6 existing tests pass
- **Committed in:** e8c2bf7 (Task 1 commit)

**3. [Rule 3 - Blocking] Added Manager trait import for app_handle.state()**
- **Found during:** Task 2 (Wire IPC commands)
- **Issue:** `app_handle.state::<AppState>()` in exit hook requires `tauri::Manager` trait to be in scope
- **Fix:** Added `use tauri::Manager;` to lib.rs
- **Files modified:** src-tauri/src/lib.rs
- **Verification:** cargo build succeeds
- **Committed in:** c42c999 (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (1 bug, 2 blocking)
**Impact on plan:** All auto-fixes necessary for compilation. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Process manager ready for integration with Claude CLI (Phase 3) and Gemini CLI (Phase 6)
- Frontend bindings available for process management UI (Plan 02-02)
- Exit hook ensures clean shutdown with no zombie processes

## Self-Check: PASSED

- All 4 created files verified present
- Commit e8c2bf7 verified in git log
- Commit c42c999 verified in git log
- cargo build exits 0
- cargo test: 6 passed, 0 failed
- bindings.ts contains all 4 new commands

---
*Phase: 02-process-core*
*Completed: 2026-03-05*
