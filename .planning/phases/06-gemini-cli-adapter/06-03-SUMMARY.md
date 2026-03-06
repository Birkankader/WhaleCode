---
phase: 06-gemini-cli-adapter
plan: 03
subsystem: api
tags: [rust, trait, adapter-pattern, polymorphism, cli-integration]

# Dependency graph
requires:
  - phase: 06-01
    provides: Gemini CLI adapter (command builder, parser, validator, rate limit detector)
  - phase: 06-02
    provides: Gemini frontend integration (event types, hook, API key settings)
provides:
  - ToolAdapter trait defining shared contract for all CLI tool adapters
  - ClaudeAdapter and GeminiAdapter implementing ToolAdapter
  - Unified ToolCommand, RateLimitInfo, RetryPolicy in adapters/mod.rs
  - Polymorphic dispatch via Box<dyn ToolAdapter> proven by test
affects: [07-task-router, future-adapter-plugins]

# Tech tracking
tech-stack:
  added: []
  patterns: [trait-based adapter pattern with unit struct delegation, shared types in mod.rs]

key-files:
  created: []
  modified:
    - src-tauri/src/adapters/mod.rs
    - src-tauri/src/adapters/claude.rs
    - src-tauri/src/adapters/gemini.rs
    - src-tauri/src/commands/claude.rs
    - src-tauri/src/commands/gemini.rs

key-decisions:
  - "ToolAdapter trait uses &self methods with zero-cost unit structs (ClaudeAdapter, GeminiAdapter)"
  - "parse_stream_line returns Option<String> (raw JSON) not a generic event type -- each adapter keeps its own typed enum"
  - "Trait impls delegate to existing standalone functions preserving all 47 existing tests unchanged"
  - "Shared RateLimitInfo and RetryPolicy in mod.rs avoid type aliasing conflicts"

patterns-established:
  - "Adapter pattern: unit struct + ToolAdapter impl delegating to module functions"
  - "Shared types in mod.rs, tool-specific types stay in tool module"

requirements-completed: [PROC-02, INTG-02, INTG-03, INTG-04]

# Metrics
duration: 2min
completed: 2026-03-06
---

# Phase 6 Plan 3: ToolAdapter Trait Gap Closure Summary

**ToolAdapter trait extracted from Claude/Gemini adapters enabling polymorphic dispatch via Box<dyn ToolAdapter>**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-06T09:53:34Z
- **Completed:** 2026-03-06T09:55:42Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Defined ToolAdapter trait with 6 methods (build_command, parse_stream_line, validate_result_json, detect_rate_limit, retry_policy, name) in adapters/mod.rs
- Implemented ToolAdapter for both ClaudeAdapter and GeminiAdapter as zero-cost unit structs
- Updated spawn commands and validate commands in both claude.rs and gemini.rs to use trait methods
- Proved interchangeability via Box<dyn ToolAdapter> test -- both adapters through same trait reference
- All 51 adapter tests pass (47 existing unchanged + 4 new trait tests)

## Task Commits

Each task was committed atomically:

1. **Task 1: Define ToolAdapter trait and unified ToolCommand in adapters/mod.rs** - `fda65fb` (feat)
2. **Task 2: Implement ToolAdapter for both adapters, update commands to use trait** - `3a7ea0d` (feat)

## Files Created/Modified
- `src-tauri/src/adapters/mod.rs` - ToolAdapter trait, ToolCommand, shared RateLimitInfo, shared RetryPolicy, trait-level tests
- `src-tauri/src/adapters/claude.rs` - ClaudeAdapter struct + impl ToolAdapter
- `src-tauri/src/adapters/gemini.rs` - GeminiAdapter struct + impl ToolAdapter
- `src-tauri/src/commands/claude.rs` - spawn_claude_task and validate_claude_result use trait methods
- `src-tauri/src/commands/gemini.rs` - spawn_gemini_task and validate_gemini_result use trait methods

## Decisions Made
- ToolAdapter trait uses &self methods with zero-cost unit structs -- no heap allocation for adapter dispatch
- parse_stream_line returns Option<String> (raw JSON) rather than generic event type -- Claude and Gemini have different event enums, keeping type-safe access in each module
- Trait impls delegate to existing standalone functions -- preserves all 47 existing adapter tests unchanged
- Shared RateLimitInfo and RetryPolicy moved to mod.rs with adapter-local types kept for backward compat (imported as SharedRateLimitInfo/SharedRetryPolicy)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- ToolAdapter trait ready for Phase 7 Task Router to dispatch to adapters polymorphically
- Adding a third adapter (e.g., Codex CLI) requires only: new module + impl ToolAdapter + IPC commands
- No changes needed to process manager or command scaffolding

---
*Phase: 06-gemini-cli-adapter*
*Completed: 2026-03-06*
