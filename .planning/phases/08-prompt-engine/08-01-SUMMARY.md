---
phase: 08-prompt-engine
plan: 01
subsystem: prompt
tags: [prompt-engine, template, context-injection, ipc]

# Dependency graph
requires:
  - phase: 04-context-engine
    provides: ContextStore, get_recent_events, build_context_preamble
provides:
  - PromptEngine with optimize() and optimize_all() for tool-specific prompt transformation
  - OptimizedPrompt type for IPC export
  - optimize_prompt IPC command for frontend preview
  - Centralized prompt context injection (removed from individual spawn functions)
affects: [09-polish, frontend-prompt-preview]

# Tech tracking
tech-stack:
  added: []
  patterns: [centralized-prompt-optimization, template-per-tool, context-truncation]

key-files:
  created:
    - src-tauri/src/prompt/mod.rs
    - src-tauri/src/prompt/models.rs
    - src-tauri/src/prompt/templates.rs
    - src-tauri/src/commands/prompt.rs
  modified:
    - src-tauri/src/commands/router.rs
    - src-tauri/src/commands/claude.rs
    - src-tauri/src/commands/gemini.rs
    - src-tauri/src/commands/mod.rs
    - src-tauri/src/lib.rs

key-decisions:
  - "Context injection centralized in dispatch_task via PromptEngine, removed from individual spawn functions"
  - "Claude template uses structured markdown sections with planning preamble; Gemini uses flat context-first format"
  - "8000 char max on optimized prompts with context truncation (user prompt never truncated)"

patterns-established:
  - "Template-per-tool: each tool gets a dedicated template function mapping prompt + context to optimized output"
  - "Centralized optimization: dispatch_task is the single point of prompt transformation before dispatching to spawn functions"

requirements-completed: [PMPT-01, PMPT-02, PMPT-04]

# Metrics
duration: 4min
completed: 2026-03-06
---

# Phase 8 Plan 1: Prompt Engine Summary

**Rust prompt engine with per-tool templates (Claude structured/Gemini flat) transforming user prompts with project context, wired into dispatch_task with optimize_prompt IPC for frontend preview**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-06T11:44:34Z
- **Completed:** 2026-03-06T11:48:34Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments
- PromptEngine produces distinct optimized prompts per tool: Claude gets structured planning preamble with markdown sections, Gemini gets flat context-first format with direct task instruction
- Context from ContextStore (recent events + file changes) automatically included in optimized prompts, omitted when empty
- dispatch_task centrally optimizes prompts before dispatching -- spawn functions no longer inject context (eliminating duplicate context)
- optimize_prompt IPC command registered for frontend prompt preview capability

## Task Commits

Each task was committed atomically:

1. **Task 1: Create prompt module with models, templates, and engine** - `3d03f69` (feat)
2. **Task 2: Add optimize_prompt IPC command and wire dispatch_task** - `67d6ac5` (feat)

## Files Created/Modified
- `src-tauri/src/prompt/mod.rs` - PromptEngine struct with optimize(), optimize_all(), build_prompt_context()
- `src-tauri/src/prompt/models.rs` - OptimizedPrompt, PromptContext, ContextEventSummary types
- `src-tauri/src/prompt/templates.rs` - claude_template(), gemini_template(), default_template() with context formatters and 8000 char truncation
- `src-tauri/src/commands/prompt.rs` - optimize_prompt IPC command for frontend preview
- `src-tauri/src/commands/router.rs` - dispatch_task now calls PromptEngine::optimize before dispatching
- `src-tauri/src/commands/claude.rs` - Removed build_context_preamble and context_store parameter
- `src-tauri/src/commands/gemini.rs` - Removed build_context_preamble and context_store parameter
- `src-tauri/src/commands/mod.rs` - Added prompt module and optimize_prompt export
- `src-tauri/src/lib.rs` - Added mod prompt, registered optimize_prompt in collect_commands

## Decisions Made
- Context injection centralized in dispatch_task via PromptEngine, removed from individual spawn functions to prevent duplicate context
- Claude template uses structured markdown sections (Task Plan -> Project Context -> Task) joined by horizontal rules; Gemini uses flat context-first format with bullet-point event listing
- 8000 char maximum on optimized prompts enforced by truncating context events (never the user prompt)
- default_template falls back to Claude-style as safe default for unknown tools

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Prompt engine fully operational, ready for Phase 8 Plan 2 (if any) or Phase 9 polish
- TypeScript bindings will regenerate on next debug app launch with OptimizedPrompt type and optimizePrompt command
- Frontend can call optimizePrompt IPC to preview how prompts transform per tool

---
*Phase: 08-prompt-engine*
*Completed: 2026-03-06*
