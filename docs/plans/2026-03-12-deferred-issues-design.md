# Deferred Issues Completion — Design Document

**Date**: 2026-03-12
**Status**: Approved
**Scope**: Complete all deferred issues from previous work sessions

---

## 1. TOCTOU Race Fix

**Problem**: `dispatch_task()` uses reservation pattern via `reserved_tools`, but `spawn_interactive()` bypasses it entirely. Two concurrent calls can spawn duplicate processes for the same tool.

**Solution**: Centralize tool slot acquisition in `process/manager.rs`:

```rust
pub fn acquire_tool_slot(state: &AppState, tool_name: &str) -> Result<(), String>
pub fn release_tool_slot(state: &AppState, tool_name: &str)
```

- `acquire_tool_slot()`: Atomically checks no running process + inserts into `reserved_tools`
- `release_tool_slot()`: Removes from `reserved_tools`
- `dispatch_task()` (router.rs): Replace inline check with `acquire_tool_slot()` call, keep `ReservationGuard` for RAII cleanup
- `dispatch_orchestrated_task()` (orchestrator.rs): Call `acquire_tool_slot()` before `spawn_interactive()`, release after spawn succeeds or on error

**Files**: `src-tauri/src/process/manager.rs`, `src-tauri/src/commands/router.rs`, `src-tauri/src/commands/orchestrator.rs`

---

## 2. Polling → Notify (wait_for_turn_complete)

**Problem**: `wait_for_turn_complete()` and `wait_for_worker_with_questions()` use 100ms poll loop + full `output_lines.clone()` each iteration.

**Solution**: Add `line_count_rx: watch::Receiver<usize>` to `ProcessEntry`. Stdout reader signals line count after each new line.

- `ProcessEntry` gets new field: `line_count_rx`
- `spawn_with_env_core()` creates `watch::channel(0usize)`, passes `line_count_tx` to stdout reader task
- Stdout reader: after pushing line to `output_lines`, sends new count via `line_count_tx`
- `wait_for_turn_complete()`: subscribes to `line_count_rx.changed()`, reads only new lines (index-based, no Vec clone), checks `adapter.is_turn_complete()` on each new line
- `wait_for_worker_with_questions()`: same pattern — watch-based instead of polling

**Files**: `src-tauri/src/state.rs`, `src-tauri/src/process/manager.rs`, `src-tauri/src/commands/orchestrator.rs`

---

## 3. Codex Adapter — Real JSONL Format

**Problem**: Adapter assumes `init/message/tool_use/result` event types. Real Codex CLI (v0.111.0) outputs `thread.started/turn.started/item.completed/turn.completed`.

**Smoke test confirmed output**:
```jsonl
{"type":"thread.started","thread_id":"..."}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"hello"}}
{"type":"turn.completed","usage":{"input_tokens":8537,"cached_input_tokens":7296,"output_tokens":45}}
```

**Solution**:

1. **Command builder**: Add `--json` flag to both `build_command()` and `build_interactive_command()`

2. **Replace `CodexStreamEvent` enum**:
```rust
#[serde(tag = "type")]
pub enum CodexStreamEvent {
    #[serde(rename = "thread.started")]
    ThreadStarted { thread_id: Option<String> },
    #[serde(rename = "turn.started")]
    TurnStarted {},
    #[serde(rename = "item.completed")]
    ItemCompleted { item: Option<CodexItem> },
    #[serde(rename = "turn.completed")]
    TurnCompleted { usage: Option<CodexUsage> },
}
```

3. **Supporting structs**:
```rust
pub struct CodexItem {
    pub id: Option<String>,
    pub item_type: Option<String>,  // "agent_message", "tool_use", "tool_result"
    pub text: Option<String>,
    pub function_name: Option<String>,
    pub arguments: Option<serde_json::Value>,
    pub output: Option<String>,
}

pub struct CodexUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
}
```

4. **Trait method updates**:
   - `is_turn_complete()` → match `TurnCompleted`
   - `extract_result()` → last `ItemCompleted` with `item_type == "agent_message"`, return `text`
   - `detect_question()` → `ItemCompleted` (agent_message) containing `[QUESTION]`/`[ASK]`
   - `parse_display_output()` → map by `item_type` (agent_message → AgentThinking, tool_use → ToolExecution, etc.)
   - `validate_result_json()` → validate `TurnCompleted` or `ItemCompleted`

5. **Update all tests** to use real JSONL format

**Files**: `src-tauri/src/adapters/codex.rs`

---

## 4. View Wiring — Replace Mock Data with Real Store/Commands

### TerminalView
- **MOCK_LOGS** → Subscribe to `listen('process-output', ...)` OutputEvent stream, accumulate log lines in local state
- **MOCK_MERGE_QUEUE** → Derive from taskStore completed tasks with branch names
- Agent list already uses taskStore (no change)

### UsageView
- **MOCK_USAGE** → Use `taskStore.agentContexts` map. Call `getAgentContextInfo(taskId)` with `activePlan.task_id`. Show token counts without percentage (no quota limit available from backend).

### CodeReviewView
- **MOCK_FILES + STATS** → Derive from `taskStore.activePlan` worker_results and sub_tasks
- **Accept button** → Call `commands.approveDecomposition(planId, tasks)`
- **Skip button** → Call `commands.rejectDecomposition(planId, feedback)`

### DoneView
- **STATS** → Calculate from completed tasks (count, total duration, unique agents)
- **MOCK_PRS** → Build from worker_results (agent, branch, output_summary). Show branch name if PR number unavailable.

**Files**: `src/components/views/TerminalView.tsx`, `UsageView.tsx`, `CodeReviewView.tsx`, `DoneView.tsx`

---

## 5. Settings View + SetupPanel + Closures

### Settings View
- Replace "coming soon" placeholder with `ApiKeySettings` component (already fully wired to Tauri commands)

### SetupPanel
- Remove `gpt4` from `DISCOVERED_AGENTS` fallback (no real adapter)
- Keep existing `detectAgents()` → fallback pattern (already working)

### Auto-answer stdin (Issue 18)
- **Closed**: All CLIs either use `--full-auto` (Codex) or don't require confirmation (Claude, Gemini). No action needed.

**Files**: `src/routes/index.tsx`, `src/components/layout/SetupPanel.tsx`

---

## Execution Order

1. TOCTOU race fix (backend)
2. Polling → Notify (backend)
3. Codex adapter (backend)
4. View wiring (frontend)
5. Settings + SetupPanel + cleanup (frontend)

Each step is independently testable. Backend fixes don't break existing frontend behavior.
