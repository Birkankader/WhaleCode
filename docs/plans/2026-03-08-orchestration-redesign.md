# Orchestration Redesign

**Date**: 2026-03-08
**Status**: Approved

## Overview

Redesign WhaleCode's multi-agent orchestration from a loose fan-out pattern to a true two-phase master-agent orchestration with inter-agent messaging visibility.

## Changes

### 1. Remove "New Task" Button

Remove the toggle-based "New Task" button from ProcessPanel. Replace with a persistent input bar at the bottom of the screen.

### 2. Persistent Input Bar

- Always visible at the bottom
- Compact agent selector bar above the input field (checkboxes for agents, master dropdown)
- Prompt text field with contextual button:
  - No active task: "Run" — starts new orchestration or single-agent dispatch
  - Active task: "Send" — routes to active agent's stdin (single-agent) or master agent (multi-agent)

### 3. Two-Phase Orchestration

#### Phase 1: Decompose
- Master agent spawned via CLI with a decomposition system prompt
- Prompt instructs master to analyze the task and return strict JSON:
  ```json
  {
    "tasks": [
      { "agent": "gemini", "prompt": "...", "description": "..." },
      { "agent": "codex", "prompt": "...", "description": "..." }
    ]
  }
  ```
- Master can assign tasks to itself
- Fallback: if JSON parse fails, send entire prompt to master agent as single task

#### Phase 2: Execute
- Each sub-task dispatched to assigned agent in parallel
- Each agent gets its own git worktree
- Worker results collected (exit code, output summary)

#### Phase 3: Review
- After all workers complete, master agent spawned again with review prompt
- Review prompt includes worker output summaries
- Master produces final integration summary

#### Error Handling
- JSON parse failure → fallback to single-agent dispatch
- Worker failure → logged in messenger, master informed during review
- Master failure → orchestration marked as failed

### 4. Messenger Tab

New tab in the tab bar showing chronological orchestration events:

**Message types:**
- **System**: Orchestration lifecycle events (started, dispatched, completed, failed)
- **Agent Summary**: Worker completion with output summary (not full terminal output)
- **Master Decision**: Decomposition results, review conclusions

**Message structure:**
```rust
struct MessengerMessage {
    id: Uuid,
    timestamp: DateTime<Utc>,
    source: MessageSource,    // System | Agent(ToolName)
    content: String,
    message_type: MessageType, // TaskAssigned | TaskCompleted | TaskFailed | AgentSummary | MasterDecision
}
```

**Delivery:** Tauri events (`messenger-event`) → frontend `useMessengerStore` Zustand store → Messenger tab renders.

### 5. Stdin Routing

New Tauri command `send_to_process(task_id, text)` writes to a process's stdin pipe.

Frontend routing logic:
- Single agent active → send to that agent's stdin
- Multi-agent mode → send to master agent's stdin
- No active process → treat as new prompt (start orchestration)

### 6. Backend Data Model

```rust
enum OrchestrationPhase {
    Decomposing,
    Executing,
    Reviewing,
    Completed,
    Failed,
}

struct DecompositionResult {
    tasks: Vec<SubTaskDef>,
}

struct SubTaskDef {
    agent: String,
    prompt: String,
    description: String,
}

// Extended OrchestrationPlan
struct OrchestrationPlan {
    id: Uuid,
    phase: OrchestrationPhase,
    master_agent: ToolName,
    original_prompt: String,
    decomposition: Option<DecompositionResult>,
    messages: Vec<MessengerMessage>,
    worker_results: HashMap<Uuid, WorkerResult>,
}
```

### 7. Frontend State

New Zustand store `useMessengerStore`:
- Accumulates MessengerMessage items
- Listens to Tauri `messenger-event`
- Provides messages array for Messenger tab rendering

## Out of Scope

- Direct agent-to-agent messaging (always via master)
- Worker progress reporting to master during execution
- Concurrent orchestration plans (one at a time)
