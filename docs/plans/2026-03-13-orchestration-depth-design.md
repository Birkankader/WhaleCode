# Orchestration Depth: DAG, Retry/Fallback, Smart Routing

**Date**: 2026-03-13
**Status**: Approved
**Focus**: Orchestration intelligence — the core differentiator

## Problem

Current orchestration is linear and fragile:
- No task dependencies — everything runs in flat parallel
- No error recovery — one failure stalls the whole pipeline
- Static agent assignment — no intelligence in who does what

## Feature 1: Task Dependency Graph (DAG)

### Data Model

Add `depends_on: Vec<String>` to `SubTaskEntry` (Rust) and frontend store.

Master's decompose output becomes:

```json
{
  "tasks": [
    { "id": "t1", "prompt": "Create DB schema", "agent": "claude", "depends_on": [] },
    { "id": "t2", "prompt": "Build API endpoints", "agent": "gemini", "depends_on": ["t1"] },
    { "id": "t3", "prompt": "Write tests", "agent": "claude", "depends_on": ["t1"] },
    { "id": "t4", "prompt": "Integration tests", "agent": "gemini", "depends_on": ["t2", "t3"] }
  ]
}
```

### Execution Engine

Topological sort produces execution waves:
- Wave 0: `[t1]` — no dependencies
- Wave 1: `[t2, t3]` — parallel, only depend on t1
- Wave 2: `[t4]` — needs both t2 and t3

Rules:
- Wave N completes before Wave N+1 starts
- Cycle detection: error + surface to user
- If a dependency fails, dependent tasks get status `blocked`

### UI Changes

- Kanban cards show thin dependency lines (left edge to right edge)
- Blocked tasks show "Waiting for t1" label in muted text
- Sidebar shows wave number indicator per task

### Backend Changes

- `SubTaskEntry` struct: add `depends_on: Vec<String>` field
- `DecompositionResult` parsing: extract depends_on from master output
- New module: `src-tauri/src/router/dag.rs`
  - `topological_sort(tasks) -> Result<Vec<Vec<SubTaskId>>, CycleError>`
  - `resolve_ready_tasks(tasks, completed) -> Vec<SubTaskId>`
- Orchestrator phase 2: dispatch by wave, not all-at-once
- Master decomposition prompt updated to request dependency info

## Feature 2: Retry & Agent Fallback

### Retry Strategy

Per worker task:
- **Max retries**: 2 (uses adapter's `retry_policy()` — already in trait)
- **Triggers**: process exit != 0, rate limit detected, timeout
- **Backoff**: adapter-specified delay (rate limit) or fixed 5s

### Agent Fallback

When retries exhausted:
- Fallback order: `claude -> gemini -> codex` (configurable)
- Same prompt dispatched to next agent
- Partial output from failed agent injected as context
- Max 1 fallback attempt (prevent infinite loops)

### New Task Statuses

Add to `TaskStatus` type:
- `retrying` — between retry attempts
- `falling_back` — being reassigned to different agent

### State Tracking

Per task, track in `TaskEntry`:
- `retry_count: u32`
- `original_agent: Option<ToolName>` (set on fallback)
- `failure_reason: Option<String>`

### UI Changes

- Kanban card: retry counter badge `1/2`
- Fallback: agent icon changes + "Reassigned: Claude -> Gemini" log entry
- Terminal: retry/fallback events in amber color

### Backend Changes

- `TaskEntry` struct: add retry_count, original_agent, failure_reason
- `ToolAdapter` trait: implement `retry_policy()` for each adapter
- Orchestrator: wrap worker dispatch in retry loop
- New function: `select_fallback_agent(failed_agent, available) -> Option<ToolName>`
- Fallback context builder: include partial output from failed attempt

## Feature 3: Smart Agent Routing

### Three-Layer Routing

**Layer 1 — Pattern Matching (fast)**

Rule-based keyword + file extension analysis:
- `"database", "schema", "migration"` -> claude (complex reasoning)
- `"test", "spec", "unit test"` -> gemini (structured output)
- `"refactor", "rename", "style"` -> codex (quick edits)
- File extensions in prompt: `.rs` -> claude, `.tsx` -> gemini

**Layer 2 — Agent Availability**

- Current process count per agent (from AppState)
- Recent rate limit status (from retry tracking)
- Prefer idle agents over loaded ones

**Layer 3 — Historical Performance**

Store in context DB:
```sql
task_outcomes(agent, task_type, success, duration_ms, timestamp)
```
- Query: which agent has best success rate for this task type?
- Moving average over last 50 tasks per type
- New agents start with neutral score

### Integration

- `resolve_agent(subtask) -> ToolName` function in router
- Called when master's decompose doesn't specify agent
- Master can suggest, router can override based on availability
- User can force-override in setup: "Always use Claude for Rust"

### UI Changes

- Kanban card tooltip: "Assigned to Claude (best at Rust, 92% success)"
- Usage view: agent comparison mini-chart (success rate, avg duration)
- Setup panel: routing rules configuration section

### Backend Changes

- New module: `src-tauri/src/router/routing.rs`
  - `resolve_agent(subtask, state, context_store) -> ToolName`
  - Pattern matcher with configurable rules
  - Load balancer checking process counts
  - History query against context store
- Context store extension: `record_task_outcome()` + `query_agent_stats()`
- Orchestrator: call resolve_agent when agent field is empty

## Logo Direction

WhaleCode stays as the name. Logo concept: stylized whale tail merging with `{ }` code brackets — single icon that conveys both "whale" and "code".

## Implementation Priority

1. **DAG** first — changes decomposition and dispatch flow
2. **Retry/Fallback** second — wraps existing dispatch with resilience
3. **Smart Routing** third — enhances agent selection on top of DAG
