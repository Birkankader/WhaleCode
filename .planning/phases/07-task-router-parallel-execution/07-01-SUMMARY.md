---
phase: 07-task-router-parallel-execution
plan: 01
subsystem: router
tags: [task-routing, heuristics, ipc, specta, tauri-commands]

# Dependency graph
requires:
  - phase: 06-gemini-cli-adapter
    provides: "spawn_gemini_task and GeminiAdapter for dispatch routing"
  - phase: 03-claude-streaming
    provides: "spawn_claude_task and ClaudeAdapter for dispatch routing"
provides:
  - "TaskRouter::suggest() keyword-based tool routing heuristic"
  - "suggest_tool IPC command for frontend tool suggestions"
  - "dispatch_task IPC command for unified task dispatch"
  - "ProcessEntry with tool_name, task_description, started_at metadata"
  - "RoutingSuggestion TypeScript type in bindings"
affects: [07-02, 08-prompt-optimization, 09-ui-polish]

# Tech tracking
tech-stack:
  added: []
  patterns: [keyword-weighted-scoring, availability-penalty, availability-bonus-shift]

key-files:
  created:
    - src-tauri/src/router/mod.rs
    - src-tauri/src/router/models.rs
    - src-tauri/src/commands/router.rs
  modified:
    - src-tauri/src/state.rs
    - src-tauri/src/process/manager.rs
    - src-tauri/src/commands/mod.rs
    - src-tauri/src/lib.rs
    - src/bindings.ts

key-decisions:
  - "Availability bonus pattern: when busy tool has score but available tool has 0, give available tool score+0.1 to shift suggestion"
  - "ProcessEntry tool_name defaults to 'test' for backwards-compatible spawn_with_env calls"

patterns-established:
  - "Keyword-weighted scoring: each tool has keyword list with 0.3-0.8 weights, matched against lowercased prompt"
  - "Busy penalty 0.3x multiplier with availability bonus shift for zero-score available tools"
  - "dispatch_task as unified IPC entry point routing to tool-specific spawn functions"

requirements-completed: [ROUT-01, ROUT-03, ROUT-04, PROC-03]

# Metrics
duration: 4min
completed: 2026-03-06
---

# Phase 07 Plan 01: Task Router Summary

**Keyword-weighted TaskRouter with busy-tool penalties, unified dispatch_task IPC, and ProcessEntry tool metadata**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-06T11:02:47Z
- **Completed:** 2026-03-06T11:06:25Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments
- TaskRouter with keyword heuristic scoring for Claude (refactor, debug, fix) and Gemini (analyze, read, search)
- Busy tool penalty (0.3x) with availability bonus shift to redirect suggestions to available tool
- suggest_tool and dispatch_task IPC commands with max-1-per-tool enforcement
- ProcessEntry extended with tool_name, task_description, started_at for status panel

## Task Commits

Each task was committed atomically:

1. **Task 1: Create router module with TaskRouter and RoutingSuggestion** - `e020f23` (test) + `ee4c7db` (feat) [TDD]
2. **Task 2: Extend ProcessEntry, add IPC commands, register in lib.rs** - `58aabb7` (feat)

## Files Created/Modified
- `src-tauri/src/router/mod.rs` - TaskRouter::suggest() with keyword scoring, availability penalties, 10 unit tests
- `src-tauri/src/router/models.rs` - RoutingSuggestion struct with specta::Type derive
- `src-tauri/src/commands/router.rs` - suggest_tool and dispatch_task IPC commands
- `src-tauri/src/state.rs` - ProcessEntry extended with tool_name, task_description, started_at
- `src-tauri/src/process/manager.rs` - Default tool_name/task_description/started_at on ProcessEntry creation
- `src-tauri/src/commands/mod.rs` - Router module and exports added
- `src-tauri/src/lib.rs` - Router module declared, commands registered in collect_commands!
- `src/bindings.ts` - suggestTool, dispatchTask commands and RoutingSuggestion type added

## Decisions Made
- Availability bonus pattern: when the busy tool has a positive score but the available tool scores 0, the available tool gets score+0.1 to ensure the suggestion shifts. Without this, a penalized 0.24 score would still beat 0.0.
- ProcessEntry tool_name defaults to "test" in spawn_with_env for backwards compatibility with existing spawn_process calls.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Added availability bonus to fix busy-tool penalty not shifting suggestion**
- **Found during:** Task 1 (TDD GREEN)
- **Issue:** "refactor auth" with claude_busy gave claude 0.8*0.3=0.24 but gemini had 0.0, so claude still won despite being busy
- **Fix:** When busy tool has score > 0 and available tool has 0, give available tool score+0.1
- **Files modified:** src-tauri/src/router/mod.rs
- **Verification:** penalize_busy_claude and penalize_busy_gemini tests now pass
- **Committed in:** ee4c7db (Task 1 GREEN commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Essential for correct busy-tool routing behavior. No scope creep.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Router engine ready for frontend integration (07-02)
- suggest_tool available for prompt input auto-suggestion UI
- dispatch_task ready as unified entry point replacing direct spawn_claude_task/spawn_gemini_task calls
- ProcessEntry metadata ready for status panel display

---
*Phase: 07-task-router-parallel-execution*
*Completed: 2026-03-06*
