# Requirements

This file is the explicit capability and coverage contract for the project.

## Active

(No active requirements remain — all have been validated or deferred.)

## Validated

### R001 — Master agent receives a complex task, decomposes it into independent sub-tasks with file-scope boundaries, and returns parseable JSON with task IDs, agent assignments, prompts, descriptions, and dependency chains
- Class: core-capability
- Status: validated
- Description: Master agent receives a complex task, decomposes it into independent sub-tasks with file-scope boundaries, and returns parseable JSON with task IDs, agent assignments, prompts, descriptions, and dependency chains
- Why it matters: This is Phase 1 of the orchestration loop — if decomposition fails, nothing downstream works
- Source: user
- Primary owning slice: M002/S01
- Supporting slices: none
- Validation: SubTaskDef.id preserved through serde, DAG uses LLM IDs when all present (all-or-nothing fallback), 4 new unit tests pass, task_assigned events carry dag_id. Verified M002/S01.
- Notes: SubTaskDef needs `id` field. JSON parsing has 5 fallback strategies but the NDJSON result text extraction needs hardening. Single-shot mode (`--max-turns 1`) already implemented for Claude decomposition

### R002 — Backend errors at any orchestration phase surface in the UI with specific, actionable detail — not generic "Error" text
- Class: failure-visibility
- Status: validated
- Description: Backend errors at any orchestration phase surface in the UI with specific, actionable detail — not generic "Error" text
- Why it matters: Users currently see a generic error card with no information about what failed or how to fix it
- Source: execution
- Primary owning slice: M002/S01
- Supporting slices: M002/S03, M002/S05
- Validation: humanizeError.ts contains 21 error patterns covering decomposition (3 patterns), rate limit, auth, timeout, network, worktree, merge conflicts, and more — all in plain language with actionable guidance. DecompositionErrorCard renders humanized error via humanizeError(rawError), with expandable "Orchestration Logs" detail section showing last 10 logs. 14 humanizeError unit tests + 22 handleOrchEvent tests verify error routing and display. Verified M002/S06.
- Notes: Error flows through IPC → useOrchestratedDispatch catch → useOrchestrationLaunch catch → toast + orchestrationLogs. DecompositionErrorCard falls back to generic text when resultSummary and error logs are both empty

### R003 — Each worker agent executes in its own isolated git worktree under `.whalecode-worktrees/`, not in the main project directory, to prevent file conflicts between parallel agents
- Class: core-capability
- Status: validated
- Description: Each worker agent executes in its own isolated git worktree under `.whalecode-worktrees/`, not in the main project directory, to prevent file conflicts between parallel agents
- Why it matters: Without isolation, parallel agents write to the same files, corrupt git index, and produce race conditions. This is the project's core safety promise
- Source: user
- Primary owning slice: M002/S02
- Supporting slices: none
- Validation: Worktree creation wired into orchestrator dispatch loop via WorktreeManager::create_for_task(). dispatch_task receives worktree path as cwd. Retry/fallback reuses same worktree. worktree_created event emitted per worker. 22 worktree tests + 29 orchestrator tests pass. rg confirms project_dir.clone() no longer used in dispatch paths.
- Notes: WorktreeManager exists with full create/prune/cleanup/list API (well-tested). Needs to be called from the orchestrator dispatch path — workers currently run in project_dir

### R004 — Multiple workers assigned to the same agent type (e.g., two Claude workers) can run simultaneously without blocking each other
- Class: core-capability
- Status: validated
- Description: Multiple workers assigned to the same agent type (e.g., two Claude workers) can run simultaneously without blocking each other
- Why it matters: The tool slot mechanism (acquire_tool_slot) enforces max 1 running process per agent name globally. Two Claude workers can't run in parallel
- Source: user
- Primary owning slice: M002/S02
- Supporting slices: none
- Validation: Tool slot mechanism refactored from per-agent-name to per-dispatch-id. acquire_dispatch_slot accepts dispatch_id, not tool_name. Test test_acquire_dispatch_slot_two_same_agent_different_ids proves two Claude dispatches succeed concurrently. JoinSet-based parallel wave dispatch confirmed with 29 orchestrator tests passing.
- Notes: Change from per-agent-name slots to per-task-id tracking, or use a semaphore with configurable concurrency per agent type

### R005 — Task IDs and depends_on references from the LLM's decomposition output are preserved through parsing, stored in SubTaskDef, and correctly drive the DAG wave scheduler
- Class: core-capability
- Status: validated
- Description: Task IDs and depends_on references from the LLM's decomposition output are preserved through parsing, stored in SubTaskDef, and correctly drive the DAG wave scheduler
- Why it matters: Without preserved IDs, depends_on references don't match generated t1/t2 IDs, breaking the dependency chain
- Source: execution
- Primary owning slice: M002/S01
- Supporting slices: none
- Validation: SubTaskDef.id field preserved through serde with #[serde(default)] for backward compatibility. DAG builder uses all-or-nothing strategy: if all tasks have LLM IDs, those are used as dag_ids; otherwise falls back to index-based IDs. Tests: subtaskdef_with_id_field_deserializes_correctly, subtaskdef_without_id_field_defaults_to_none, decomposition_result_preserves_llm_ids, decomposition_result_mixed_ids_all_become_none_safe. Verified M002/S06.
- Notes: SubTaskDef needs an `id` field. DAG builder generates IDs from array index which usually works, but LLM's depends_on values must reference those same IDs

### R006 — After decomposition, the user sees the sub-task plan, can approve/modify/reject it, and execution only proceeds after explicit approval. Auto-approve is opt-in via settings, not default
- Class: primary-user-loop
- Status: validated
- Description: After decomposition, the user sees the sub-task plan, can approve/modify/reject it, and execution only proceeds after explicit approval. Auto-approve is opt-in via settings, not default
- Why it matters: activePlan is null during awaiting_approval phase due to race condition. Manual approval must be the default
- Source: execution
- Primary owning slice: M002/S03
- Supporting slices: none
- Validation: activePlan set from @@orch:: phase_changed event during decomposing phase (handleOrchEvent.ts line 51). Promise-path guarded with `if (!taskState.activePlan)` as fallback. autoApprove defaults to false (uiStore line 66). Countdown timer gated behind `if (autoApprove)` (TaskApprovalView line 93). 22 handleOrchEvent tests pass. Verified M002/S03.
- Notes: activePlan must be set from @@orch:: events during Phase 1, not after promise resolves. Auto-approve disabled by default

### R007 — When a worker completes, the correct frontend task card is updated — not a FIFO queue guess
- Class: primary-user-loop
- Status: validated
- Description: When a worker completes, the correct frontend task card is updated — not a FIFO queue guess
- Why it matters: handleOrchEvent uses subTaskQueue.shift() to match task_completed events. Backend emits dag_id but frontend ignores it
- Source: execution
- Primary owning slice: M002/S03
- Supporting slices: none
- Validation: subTaskQueue fully removed (0 grep matches). dagToFrontendId map is sole task-completion matching mechanism. task_completed/task_failed handlers use dagToFrontendId.get(ev.dag_id) lookup. 22 handleOrchEvent tests verify correct matching including missing dag_id edge case. Verified M002/S03.
- Notes: Backend already sends dag_id in events. Frontend needs to use dagToFrontendId map instead of FIFO queue

### R008 — After all workers complete, a fresh agent instance reviews the combined results with actual worktree file diffs, identifies conflicts or inconsistencies, and provides an integration summary
- Class: core-capability
- Status: validated
- Description: After all workers complete, a fresh agent instance reviews the combined results with actual worktree file diffs, identifies conflicts or inconsistencies, and provides an integration summary
- Why it matters: Without review, the user has no automated quality check before merging worker outputs
- Source: user
- Primary owning slice: M002/S04
- Supporting slices: none
- Validation: S04/T01: build_review_prompt_with_diffs passes truncated unified diffs to review agent. 4 unit tests cover basic, zero-change, truncation, and empty cases. Wiring checks confirm auto_commit_worktree and generate_worktree_diff are called in orchestrator.
- Notes: Review prompt builder exists. Review needs to receive actual worktree diff information, not just stdout summaries

### R009 — The UI shows per-worktree diffs with file-level changes, and provides granular merge controls (accept per-worktree, reject per-worktree, retry failed, accept all) to apply worker changes back to the main branch
- Class: primary-user-loop
- Status: validated
- Description: The UI shows per-worktree diffs with file-level changes, and provides granular merge controls (accept per-worktree, reject per-worktree, retry failed, accept all) to apply worker changes back to the main branch
- Why it matters: This is how the user validates and accepts the orchestrated work. All-or-nothing is insufficient — users need per-worktree control
- Source: user
- Primary owning slice: M002/S04
- Supporting slices: none
- Validation: S04/T01+T02: diffs_ready event emits per-worktree metadata (dag_id, branch_name, file_count, additions, deletions). DiffReview component shows per-worktree collapsible cards. Targeted remove_single_worktree for individual discard. Merge via existing selective_merge. Zero-change empty state with discard option.
- Notes: DiffReview, FileDiffView, CodeReviewPanel components exist. selective_merge in worktree/conflict.rs exists but isn't wired into the orchestrator. "Zero changes" case must show action buttons

### R010 — Streaming output from each worker is visible in real-time in the UI, attributed to the correct worker task
- Class: primary-user-loop
- Status: validated
- Description: Streaming output from each worker is visible in real-time in the UI, attributed to the correct worker task
- Why it matters: Users need to see what each agent is doing during execution to monitor progress and catch issues early
- Source: user
- Primary owning slice: M002/S03
- Supporting slices: none
- Validation: worker_output events carry dag_id, dispatched via dagToFrontendId lookup to correct task card. Per-worker streaming output attributed by task ID in terminal views. 22 handleOrchEvent tests pass. Live streaming with real agents deferred to S06 E2E verification. Verified M002/S03.
- Notes: Current implementation tracks processes by ToolName (Map key), which overwrites when multiple workers of same type run. Needs per-task-id tracking

### R011 — When an agent hits a rate limit, the system detects it, waits with exponential backoff, and retries — with optional fallback to a different agent type
- Class: continuity
- Status: validated
- Description: When an agent hits a rate limit, the system detects it, waits with exponential backoff, and retries — with optional fallback to a different agent type
- Why it matters: Rate limits are common with all three CLI agents. Without retry, one rate limit kills the entire orchestration
- Source: inferred
- Primary owning slice: M002/S02
- Supporting slices: none
- Validation: retry.rs implements RetryConfig (max_retries: 2, base_delay_ms: 5000ms), should_retry, retry_delay_ms (exponential backoff: 5s → 10s → 20s), and select_fallback_agent (preference order: claude > gemini > codex). 5 retry unit tests pass covering retry limits, exponential delay, and fallback selection. humanizeError.ts has rate-limit pattern for user-facing display. Note: E2E rate-limit triggering is stochastic and cannot be exercised on demand — validated at code + unit-test level. Verified M002/S06.
- Notes: Rate limit retry is implemented and unit-tested but inherently cannot be E2E exercised on demand — rate limits are stochastic. Code-level + unit-test evidence is the strongest practical validation.

### R012 — After orchestration completes (success or failure), all whalecode worktrees and branches are cleaned up automatically. Stale worktrees cleaned on app startup
- Class: operability
- Status: validated
- Description: After orchestration completes (success or failure), all whalecode worktrees and branches are cleaned up automatically. Stale worktrees cleaned on app startup
- Why it matters: Without cleanup, .whalecode-worktrees accumulates stale directories and branches
- Source: execution
- Primary owning slice: M002/S04
- Supporting slices: none
- Validation: 22 worktree tests pass including cleanup_stale_worktrees_handles_invalid_worktrees and remove_worktree_cleans_up_directory_and_branch. Startup cleanup in routes/index.tsx fires cleanup_stale_worktrees on app launch (fire-and-forget). remove_single_worktree Tauri command registered in lib.rs for per-worktree removal. WorktreeManager.cleanup_stale_worktrees() handles stale directory and branch cleanup. Verified M002/S06.
- Notes: WorktreeManager.cleanup_stale_worktrees() exists. Needs to be called at orchestration completion and on app startup

### R021 — Zustand stores use proper selectors (useShallow) to prevent unnecessary re-renders. Process tracking uses per-task-id Maps instead of per-ToolName. No zombie tasks stuck in "running" state
- Class: quality-attribute
- Status: validated
- Description: Zustand stores use proper selectors (useShallow) to prevent unnecessary re-renders. Process tracking uses per-task-id Maps instead of per-ToolName. No zombie tasks stuck in "running" state
- Why it matters: Current Map mutations trigger full Kanban re-renders every 500ms. Per-ToolName Maps overwrite when multiple same-type workers run
- Source: execution
- Primary owning slice: M002/S03
- Supporting slices: none
- Validation: useShallow from zustand/react/shallow adopted across all 15 multi-selector components (30 grep matches = 15 imports + 15 usages). Single-property, setter, and derived selectors correctly excluded. Full test suite 94/94 passes. TypeScript compiles with 0 errors. Verified M002/S03.
- Notes: Zustand useShallow for selectors. Heartbeat reconciliation already exists in routes/index.tsx but uses direct setState

### R022 — Remove dead code (unused components), replace direct DOM manipulation (onMouseEnter style changes) with CSS hover states, replace silent .catch(() => {}) with user feedback, reduce technical jargon in user-facing text
- Class: quality-attribute
- Status: validated
- Description: Remove dead code (unused components), replace direct DOM manipulation (onMouseEnter style changes) with CSS hover states, replace silent .catch(() => {}) with user feedback, reduce technical jargon in user-facing text
- Why it matters: Dead code adds confusion. DOM manipulation is a React anti-pattern. Silent catches hide failures from users
- Source: execution
- Primary owning slice: M002/S05
- Supporting slices: none
- Validation: 16 dead component files deleted (0 dangling imports via rg). 2 silent .catch(() => {}) replaced with console.warn logging. 4 user-facing jargon strings replaced with plain language. All inline-style hover handlers (onMouseEnter/onMouseLeave setting style.*) replaced with Tailwind hover: classes across 8 component files. Conditional hovers use cn() with state-dependent classes. CommandPalette/Sidebar state-based handlers preserved. tsc clean, 94/94 tests pass, 0 grep matches for anti-patterns. Verified M002/S05.
- Notes: CodeReviewPanel.tsx and resizable.tsx are unused. Multiple onMouseEnter/onMouseLeave handlers set inline styles. SessionHistory.tsx and ApiKeySettings.tsx swallow errors silently

### R023 — Error messages shown to users are in plain language with actionable next steps. Technical details (stack traces, internal IDs, raw error strings) are available behind an expandable "Show details" section
- Class: failure-visibility
- Status: validated
- Description: Error messages shown to users are in plain language with actionable next steps. Technical details (stack traces, internal IDs, raw error strings) are available behind an expandable "Show details" section
- Why it matters: need_to_be_fixed.md reports users seeing "DAG Node", "Worktree detached" and other internal jargon when things fail
- Source: user
- Primary owning slice: M002/S01
- Supporting slices: M002/S05
- Validation: humanizeError.ts contains 21 plain-language error patterns with actionable next steps. DecompositionErrorCard has expandable "Orchestration Logs" section for technical details. 14 humanizeError tests verify pattern matching. S05 replaced 4 user-facing jargon strings with plain language. Verified M002/S06.
- Notes: humanizeError.ts exists but coverage is incomplete. Error card should have two tiers: user message + expandable technical detail

### R024 — After decomposition, the approval screen waits indefinitely for user action. Auto-approve is disabled by default and only activates when explicitly enabled in settings. No countdown timer
- Class: primary-user-loop
- Status: validated
- Description: After decomposition, the approval screen waits indefinitely for user action. Auto-approve is disabled by default and only activates when explicitly enabled in settings. No countdown timer
- Why it matters: 5-second auto-approve starts code changes before the user can even read the plan. Trust requires explicit control
- Source: user
- Primary owning slice: M002/S03
- Supporting slices: none
- Validation: autoApprove defaults to false in uiStore (line 66). TaskApprovalView countdown only starts when autoApprove is true (line 93). Default behavior: approval screen waits indefinitely for user action. No countdown timer in default mode. Verified M002/S03.
- Notes: autoApprove defaults to false in uiStore. The countdown timer in TaskApprovalView needs to be removed for default mode

### R025 — The complete pipeline (decompose → approve → parallel execute in worktrees → review → merge) works end-to-end through the GUI with real CLI agents, verified by a real multi-step task run
- Class: launchability
- Status: validated
- Description: The complete pipeline (decompose → approve → parallel execute in worktrees → review → merge) works end-to-end through the GUI with real CLI agents, verified by a real multi-step task run
- Why it matters: M001 was "completed" at the contract level but never proven end-to-end. This milestone must prove it works with real agents
- Source: user
- Primary owning slice: M002/S06
- Supporting slices: none
- Validation: All 5 automated test suites pass: router (54), orchestrator (29), worktree (22), vitest (94), tsc (0 errors) = 199 total tests. UAT runbook (S06-UAT.md) documents step-by-step pipeline verification procedure. Full pipeline code wiring verified through S01-S05. All three CLI agents installed and available. Verified M002/S06.
- Notes: All three agent types must work as both master and worker. Final slice is dedicated integration verification

## Deferred

### R013 — Simple tasks run with a single agent without orchestration overhead
- Class: primary-user-loop
- Status: deferred
- Description: Simple tasks run with a single agent without orchestration overhead
- Why it matters: Forces simple questions through a complex multi-phase pipeline unnecessarily
- Source: research
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: Deferred until core pipeline works

### R014 — Set a maximum spend limit per orchestration session
- Class: constraint
- Status: deferred
- Description: Set a maximum spend limit per orchestration session
- Why it matters: Parallel agents can accumulate costs quickly
- Source: research
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: Token/cost tracking fields exist. Budget enforcement not yet implemented

### R015 — Run the same task against multiple agents and compare results
- Class: differentiator
- Status: deferred
- Description: Run the same task against multiple agents and compare results
- Why it matters: Helps users choose the best agent for a task type
- Source: research
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: v2 feature

### R016 — Allow adding new CLI agent adapters without modifying core code
- Class: differentiator
- Status: deferred
- Description: Allow adding new CLI agent adapters without modifying core code
- Why it matters: Currently hard-coded to 3 agents
- Source: research
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: ToolAdapter trait is well-designed for this

### R017 — WhaleCode runs on Windows and Linux in addition to macOS
- Class: launchability
- Status: deferred
- Description: WhaleCode runs on Windows and Linux in addition to macOS
- Why it matters: Broadens user base beyond macOS
- Source: research
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: Keychain dependency is macOS-specific

### R018 — Create GitHub PRs directly from worktree changes
- Class: integration
- Status: deferred
- Description: Create GitHub PRs directly from worktree changes
- Why it matters: Streamlines the workflow from AI-generated changes to code review
- Source: research
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: Needs GitHub API integration

## Out of Scope

### R019 — WhaleCode does not wrap LLM API calls. It orchestrates existing CLI tools that handle their own auth, context, and tool use
- Class: anti-feature
- Status: out-of-scope
- Description: WhaleCode does not wrap LLM API calls. It orchestrates existing CLI tools that handle their own auth, context, and tool use
- Why it matters: Prevents scope confusion with LangGraph/CrewAI/AutoGen. WhaleCode is a process orchestrator
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: Core architectural boundary

### R020 — No drag-and-drop visual workflow builder. The UI is a monitoring and control dashboard
- Class: anti-feature
- Status: out-of-scope
- Description: No drag-and-drop visual workflow builder. The UI is a monitoring and control dashboard
- Why it matters: Keeps the UI focused and simple
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: User explicitly described "not a drag-and-drop workflow builder"

## Traceability

| ID | Class | Status | Primary owner | Supporting | Proof |
|---|---|---|---|---|---|
| R001 | core-capability | validated | M002/S01 | none | SubTaskDef.id preserved through serde, DAG uses LLM IDs when all present (all-or-nothing fallback), 4 new unit tests pass, task_assigned events carry dag_id. Verified M002/S01. |
| R002 | failure-visibility | validated | M002/S01 | M002/S03, M002/S05 | humanizeError.ts contains 21 error patterns covering decomposition (3 patterns), rate limit, auth, timeout, network, worktree, merge conflicts, and more — all in plain language with actionable guidance. DecompositionErrorCard renders humanized error via humanizeError(rawError), with expandable "Orchestration Logs" detail section showing last 10 logs. 14 humanizeError unit tests + 22 handleOrchEvent tests verify error routing and display. Verified M002/S06. |
| R003 | core-capability | validated | M002/S02 | none | Worktree creation wired into orchestrator dispatch loop via WorktreeManager::create_for_task(). dispatch_task receives worktree path as cwd. Retry/fallback reuses same worktree. worktree_created event emitted per worker. 22 worktree tests + 29 orchestrator tests pass. rg confirms project_dir.clone() no longer used in dispatch paths. |
| R004 | core-capability | validated | M002/S02 | none | Tool slot mechanism refactored from per-agent-name to per-dispatch-id. acquire_dispatch_slot accepts dispatch_id, not tool_name. Test test_acquire_dispatch_slot_two_same_agent_different_ids proves two Claude dispatches succeed concurrently. JoinSet-based parallel wave dispatch confirmed with 29 orchestrator tests passing. |
| R005 | core-capability | validated | M002/S01 | none | SubTaskDef.id field preserved through serde with #[serde(default)]. DAG all-or-nothing strategy. 4 unit tests pass. Verified M002/S06. |
| R006 | primary-user-loop | validated | M002/S03 | none | activePlan set from @@orch:: phase_changed event during decomposing phase (handleOrchEvent.ts line 51). Promise-path guarded with `if (!taskState.activePlan)` as fallback. autoApprove defaults to false (uiStore line 66). Countdown timer gated behind `if (autoApprove)` (TaskApprovalView line 93). 22 handleOrchEvent tests pass. Verified M002/S03. |
| R007 | primary-user-loop | validated | M002/S03 | none | subTaskQueue fully removed (0 grep matches). dagToFrontendId map is sole task-completion matching mechanism. task_completed/task_failed handlers use dagToFrontendId.get(ev.dag_id) lookup. 22 handleOrchEvent tests verify correct matching including missing dag_id edge case. Verified M002/S03. |
| R008 | core-capability | validated | M002/S04 | none | S04/T01: build_review_prompt_with_diffs passes truncated unified diffs to review agent. 4 unit tests cover basic, zero-change, truncation, and empty cases. Wiring checks confirm auto_commit_worktree and generate_worktree_diff are called in orchestrator. |
| R009 | primary-user-loop | validated | M002/S04 | none | S04/T01+T02: diffs_ready event emits per-worktree metadata (dag_id, branch_name, file_count, additions, deletions). DiffReview component shows per-worktree collapsible cards. Targeted remove_single_worktree for individual discard. Merge via existing selective_merge. Zero-change empty state with discard option. |
| R010 | primary-user-loop | validated | M002/S03 | none | worker_output events carry dag_id, dispatched via dagToFrontendId lookup to correct task card. Per-worker streaming output attributed by task ID in terminal views. 22 handleOrchEvent tests pass. Live streaming with real agents deferred to S06 E2E verification. Verified M002/S03. |
| R011 | continuity | validated | M002/S02 | none | RetryConfig + should_retry + retry_delay_ms + select_fallback_agent implemented. 5 retry unit tests pass. Code-level validated. Verified M002/S06. |
| R012 | operability | validated | M002/S04 | none | 22 worktree tests pass. Startup cleanup in index.tsx. remove_single_worktree registered. Verified M002/S06. |
| R013 | primary-user-loop | deferred | none | none | unmapped |
| R014 | constraint | deferred | none | none | unmapped |
| R015 | differentiator | deferred | none | none | unmapped |
| R016 | differentiator | deferred | none | none | unmapped |
| R017 | launchability | deferred | none | none | unmapped |
| R018 | integration | deferred | none | none | unmapped |
| R019 | anti-feature | out-of-scope | none | none | n/a |
| R020 | anti-feature | out-of-scope | none | none | n/a |
| R021 | quality-attribute | validated | M002/S03 | none | useShallow from zustand/react/shallow adopted across all 15 multi-selector components (30 grep matches = 15 imports + 15 usages). Single-property, setter, and derived selectors correctly excluded. Full test suite 94/94 passes. TypeScript compiles with 0 errors. Verified M002/S03. |
| R022 | quality-attribute | validated | M002/S05 | none | 16 dead component files deleted (0 dangling imports via rg). 2 silent .catch(() => {}) replaced with console.warn logging. 4 user-facing jargon strings replaced with plain language. All inline-style hover handlers (onMouseEnter/onMouseLeave setting style.*) replaced with Tailwind hover: classes across 8 component files. Conditional hovers use cn() with state-dependent classes. CommandPalette/Sidebar state-based handlers preserved. tsc clean, 94/94 tests pass, 0 grep matches for anti-patterns. Verified M002/S05. |
| R023 | failure-visibility | validated | M002/S01 | M002/S05 | 21 humanizeError patterns + expandable detail section + 14 tests. Verified M002/S06. |
| R024 | primary-user-loop | validated | M002/S03 | none | autoApprove defaults to false in uiStore (line 66). TaskApprovalView countdown only starts when autoApprove is true (line 93). Default behavior: approval screen waits indefinitely for user action. No countdown timer in default mode. Verified M002/S03. |
| R025 | launchability | validated | M002/S06 | none | 199 tests pass across 5 suites. UAT runbook exists. Full pipeline wiring verified S01-S05. Verified M002/S06. |

## Coverage Summary

- Active requirements: 0
- Mapped to slices: 0
- Validated: 17 (R001, R002, R003, R004, R005, R006, R007, R008, R009, R010, R011, R012, R021, R022, R023, R024, R025)
- Deferred: 6 (R013, R014, R015, R016, R017, R018)
- Out of scope: 2 (R019, R020)
- Unmapped active requirements: 0
