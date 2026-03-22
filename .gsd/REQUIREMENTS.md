# Requirements

This file is the explicit capability and coverage contract for the project.

## Active

### R001 — Master Agent Task Decomposition
- Class: core-capability
- Status: active
- Description: Master agent receives a complex task, decomposes it into independent sub-tasks with file-scope boundaries, and returns parseable JSON with task IDs, agent assignments, prompts, descriptions, and dependency chains
- Why it matters: This is Phase 1 of the orchestration loop — if decomposition fails, nothing downstream works
- Source: user
- Primary owning slice: M002/S01
- Supporting slices: none
- Validation: unmapped
- Notes: SubTaskDef needs `id` field. JSON parsing has 5 fallback strategies but the NDJSON result text extraction needs hardening. Single-shot mode (`--max-turns 1`) already implemented for Claude decomposition

### R002 — Actionable Error Surfacing
- Class: failure-visibility
- Status: active
- Description: Backend errors at any orchestration phase surface in the UI with specific, actionable detail — not generic "Error" text
- Why it matters: Users currently see a generic error card with no information about what failed or how to fix it
- Source: execution
- Primary owning slice: M002/S01
- Supporting slices: M002/S03, M002/S05
- Validation: unmapped
- Notes: Error flows through IPC → useOrchestratedDispatch catch → useOrchestrationLaunch catch → toast + orchestrationLogs. DecompositionErrorCard falls back to generic text when resultSummary and error logs are both empty

### R003 — Worktree Isolation for Workers
- Class: core-capability
- Status: active
- Description: Each worker agent executes in its own isolated git worktree under `.whalecode-worktrees/`, not in the main project directory, to prevent file conflicts between parallel agents
- Why it matters: Without isolation, parallel agents write to the same files, corrupt git index, and produce race conditions. This is the project's core safety promise
- Source: user
- Primary owning slice: M002/S02
- Supporting slices: none
- Validation: unmapped
- Notes: WorktreeManager exists with full create/prune/cleanup/list API (well-tested). Needs to be called from the orchestrator dispatch path — workers currently run in project_dir

### R004 — Parallel Execution of Same Agent Type
- Class: core-capability
- Status: active
- Description: Multiple workers assigned to the same agent type (e.g., two Claude workers) can run simultaneously without blocking each other
- Why it matters: The tool slot mechanism (acquire_tool_slot) enforces max 1 running process per agent name globally. Two Claude workers can't run in parallel
- Source: user
- Primary owning slice: M002/S02
- Supporting slices: none
- Validation: unmapped
- Notes: Change from per-agent-name slots to per-task-id tracking, or use a semaphore with configurable concurrency per agent type

### R005 — DAG Dependency Preservation
- Class: core-capability
- Status: active
- Description: Task IDs and depends_on references from the LLM's decomposition output are preserved through parsing, stored in SubTaskDef, and correctly drive the DAG wave scheduler
- Why it matters: Without preserved IDs, depends_on references don't match generated t1/t2 IDs, breaking the dependency chain
- Source: execution
- Primary owning slice: M002/S01
- Supporting slices: none
- Validation: unmapped
- Notes: SubTaskDef needs an `id` field. DAG builder generates IDs from array index which usually works, but LLM's depends_on values must reference those same IDs

### R006 — Task Approval Flow
- Class: primary-user-loop
- Status: active
- Description: After decomposition, the user sees the sub-task plan, can approve/modify/reject it, and execution only proceeds after explicit approval. Auto-approve is opt-in via settings, not default
- Why it matters: activePlan is null during awaiting_approval phase due to race condition. Manual approval must be the default
- Source: execution
- Primary owning slice: M002/S03
- Supporting slices: none
- Validation: unmapped
- Notes: activePlan must be set from @@orch:: events during Phase 1, not after promise resolves. Auto-approve disabled by default

### R007 — Task Completion Event Matching
- Class: primary-user-loop
- Status: active
- Description: When a worker completes, the correct frontend task card is updated — not a FIFO queue guess
- Why it matters: handleOrchEvent uses subTaskQueue.shift() to match task_completed events. Backend emits dag_id but frontend ignores it
- Source: execution
- Primary owning slice: M002/S03
- Supporting slices: none
- Validation: unmapped
- Notes: Backend already sends dag_id in events. Frontend needs to use dagToFrontendId map instead of FIFO queue

### R008 — Review Phase with Worktree Diffs
- Class: core-capability
- Status: active
- Description: After all workers complete, a fresh agent instance reviews the combined results with actual worktree file diffs, identifies conflicts or inconsistencies, and provides an integration summary
- Why it matters: Without review, the user has no automated quality check before merging worker outputs
- Source: user
- Primary owning slice: M002/S04
- Supporting slices: none
- Validation: unmapped
- Notes: Review prompt builder exists. Review needs to receive actual worktree diff information, not just stdout summaries

### R009 — Per-Worktree Diff Review & Granular Merge
- Class: primary-user-loop
- Status: active
- Description: The UI shows per-worktree diffs with file-level changes, and provides granular merge controls (accept per-worktree, reject per-worktree, retry failed, accept all) to apply worker changes back to the main branch
- Why it matters: This is how the user validates and accepts the orchestrated work. All-or-nothing is insufficient — users need per-worktree control
- Source: user
- Primary owning slice: M002/S04
- Supporting slices: none
- Validation: unmapped
- Notes: DiffReview, FileDiffView, CodeReviewPanel components exist. selective_merge in worktree/conflict.rs exists but isn't wired into the orchestrator. "Zero changes" case must show action buttons

### R010 — Real-Time Worker Output Streaming
- Class: primary-user-loop
- Status: active
- Description: Streaming output from each worker is visible in real-time in the UI, attributed to the correct worker task
- Why it matters: Users need to see what each agent is doing during execution to monitor progress and catch issues early
- Source: user
- Primary owning slice: M002/S03
- Supporting slices: none
- Validation: unmapped
- Notes: Current implementation tracks processes by ToolName (Map key), which overwrites when multiple workers of same type run. Needs per-task-id tracking

### R011 — Rate Limit Retry with Backoff
- Class: continuity
- Status: active
- Description: When an agent hits a rate limit, the system detects it, waits with exponential backoff, and retries — with optional fallback to a different agent type
- Why it matters: Rate limits are common with all three CLI agents. Without retry, one rate limit kills the entire orchestration
- Source: inferred
- Primary owning slice: M002/S02
- Supporting slices: none
- Validation: unmapped
- Notes: RetryConfig, should_retry, retry_delay_ms, select_fallback_agent all exist in router/retry.rs. The retry loop in orchestrator.rs needs to work with the new parallel dispatch model

### R012 — Worktree Cleanup
- Class: operability
- Status: active
- Description: After orchestration completes (success or failure), all whalecode worktrees and branches are cleaned up automatically. Stale worktrees cleaned on app startup
- Why it matters: Without cleanup, .whalecode-worktrees accumulates stale directories and branches
- Source: execution
- Primary owning slice: M002/S04
- Supporting slices: none
- Validation: unmapped
- Notes: WorktreeManager.cleanup_stale_worktrees() exists. Needs to be called at orchestration completion and on app startup

### R021 — Frontend State Management Cleanup
- Class: quality-attribute
- Status: active
- Description: Zustand stores use proper selectors (useShallow) to prevent unnecessary re-renders. Process tracking uses per-task-id Maps instead of per-ToolName. No zombie tasks stuck in "running" state
- Why it matters: Current Map mutations trigger full Kanban re-renders every 500ms. Per-ToolName Maps overwrite when multiple same-type workers run
- Source: execution
- Primary owning slice: M002/S03
- Supporting slices: none
- Validation: unmapped
- Notes: Zustand useShallow for selectors. Heartbeat reconciliation already exists in routes/index.tsx but uses direct setState

### R022 — UI Anti-Pattern Removal
- Class: quality-attribute
- Status: active
- Description: Remove dead code (unused components), replace direct DOM manipulation (onMouseEnter style changes) with CSS hover states, replace silent .catch(() => {}) with user feedback, reduce technical jargon in user-facing text
- Why it matters: Dead code adds confusion. DOM manipulation is a React anti-pattern. Silent catches hide failures from users
- Source: execution
- Primary owning slice: M002/S05
- Supporting slices: none
- Validation: unmapped
- Notes: CodeReviewPanel.tsx and resizable.tsx are unused. Multiple onMouseEnter/onMouseLeave handlers set inline styles. SessionHistory.tsx and ApiKeySettings.tsx swallow errors silently

### R023 — User-Friendly Error Display
- Class: failure-visibility
- Status: active
- Description: Error messages shown to users are in plain language with actionable next steps. Technical details (stack traces, internal IDs, raw error strings) are available behind an expandable "Show details" section
- Why it matters: need_to_be_fixed.md reports users seeing "DAG Node", "Worktree detached" and other internal jargon when things fail
- Source: user
- Primary owning slice: M002/S01
- Supporting slices: M002/S05
- Validation: unmapped
- Notes: humanizeError.ts exists but coverage is incomplete. Error card should have two tiers: user message + expandable technical detail

### R024 — Manual Approval Default
- Class: primary-user-loop
- Status: active
- Description: After decomposition, the approval screen waits indefinitely for user action. Auto-approve is disabled by default and only activates when explicitly enabled in settings. No countdown timer
- Why it matters: 5-second auto-approve starts code changes before the user can even read the plan. Trust requires explicit control
- Source: user
- Primary owning slice: M002/S03
- Supporting slices: none
- Validation: unmapped
- Notes: autoApprove defaults to false in uiStore. The countdown timer in TaskApprovalView needs to be removed for default mode

### R025 — End-to-End Pipeline Verification
- Class: launchability
- Status: active
- Description: The complete pipeline (decompose → approve → parallel execute in worktrees → review → merge) works end-to-end through the GUI with real CLI agents, verified by a real multi-step task run
- Why it matters: M001 was "completed" at the contract level but never proven end-to-end. This milestone must prove it works with real agents
- Source: user
- Primary owning slice: M002/S06
- Supporting slices: none
- Validation: unmapped
- Notes: All three agent types must work as both master and worker. Final slice is dedicated integration verification

## Deferred

### R013 — Single-Agent Mode
- Class: primary-user-loop
- Status: deferred
- Description: Simple tasks run with a single agent without orchestration overhead
- Why it matters: Forces simple questions through a complex multi-phase pipeline unnecessarily
- Source: research
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: Deferred until core pipeline works

### R014 — Budget Caps
- Class: constraint
- Status: deferred
- Description: Set a maximum spend limit per orchestration session
- Why it matters: Parallel agents can accumulate costs quickly
- Source: research
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: Token/cost tracking fields exist. Budget enforcement not yet implemented

### R015 — Agent Comparison
- Class: differentiator
- Status: deferred
- Description: Run the same task against multiple agents and compare results
- Why it matters: Helps users choose the best agent for a task type
- Source: research
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: v2 feature

### R016 — Plugin System for New Agents
- Class: differentiator
- Status: deferred
- Description: Allow adding new CLI agent adapters without modifying core code
- Why it matters: Currently hard-coded to 3 agents
- Source: research
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: ToolAdapter trait is well-designed for this

### R017 — Cross-Platform Support
- Class: launchability
- Status: deferred
- Description: WhaleCode runs on Windows and Linux in addition to macOS
- Why it matters: Broadens user base beyond macOS
- Source: research
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: Keychain dependency is macOS-specific

### R018 — PR Creation from Worktrees
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

### R019 — LLM API Wrapping
- Class: anti-feature
- Status: out-of-scope
- Description: WhaleCode does not wrap LLM API calls. It orchestrates existing CLI tools that handle their own auth, context, and tool use
- Why it matters: Prevents scope confusion with LangGraph/CrewAI/AutoGen. WhaleCode is a process orchestrator
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: Core architectural boundary

### R020 — Workflow Builder UI
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
| R001 | core-capability | active | M002/S01 | none | unmapped |
| R002 | failure-visibility | active | M002/S01 | M002/S03, M002/S05 | unmapped |
| R003 | core-capability | active | M002/S02 | none | unmapped |
| R004 | core-capability | active | M002/S02 | none | unmapped |
| R005 | core-capability | active | M002/S01 | none | unmapped |
| R006 | primary-user-loop | active | M002/S03 | none | unmapped |
| R007 | primary-user-loop | active | M002/S03 | none | unmapped |
| R008 | core-capability | active | M002/S04 | none | unmapped |
| R009 | primary-user-loop | active | M002/S04 | none | unmapped |
| R010 | primary-user-loop | active | M002/S03 | none | unmapped |
| R011 | continuity | active | M002/S02 | none | unmapped |
| R012 | operability | active | M002/S04 | none | unmapped |
| R021 | quality-attribute | active | M002/S03 | none | unmapped |
| R022 | quality-attribute | active | M002/S05 | none | unmapped |
| R023 | failure-visibility | active | M002/S01 | M002/S05 | unmapped |
| R024 | primary-user-loop | active | M002/S03 | none | unmapped |
| R025 | launchability | active | M002/S06 | none | unmapped |
| R013 | primary-user-loop | deferred | none | none | unmapped |
| R014 | constraint | deferred | none | none | unmapped |
| R015 | differentiator | deferred | none | none | unmapped |
| R016 | differentiator | deferred | none | none | unmapped |
| R017 | launchability | deferred | none | none | unmapped |
| R018 | integration | deferred | none | none | unmapped |
| R019 | anti-feature | out-of-scope | none | none | n/a |
| R020 | anti-feature | out-of-scope | none | none | n/a |

## Coverage Summary

- Active requirements: 17
- Mapped to slices: 17
- Validated: 0
- Unmapped active requirements: 0
