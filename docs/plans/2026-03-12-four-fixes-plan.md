# Four Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix four UX issues: task lifecycle (Queued/In Progress/Done), dev mode command input, same-session new tasks, and Usage view with real token data.

**Architecture:** All fixes are frontend-heavy. Tasks 1-3 are pure TypeScript changes in `useTaskDispatch.ts`, `TerminalView.tsx`, and `AppShell.tsx`. Task 4 adds `usage_stats` fields to the Rust `ProcessEntry` and extracts token/cost data from NDJSON result events before they're discarded.

**Tech Stack:** React 19, Zustand, TypeScript, Tauri v2, Rust

---

### Task 1: Fix Task Lifecycle — Real-Time Status Updates

**Problem:** `dispatchOrchestratedTask` adds all sub-tasks to `taskStore` only AFTER orchestration completes (line 328-339 of `useTaskDispatch.ts`). By that time all tasks are already completed, so they skip Queued and In Progress columns.

**Files:**
- Modify: `src/hooks/useTaskDispatch.ts:223-370`

**Step 1: Parse orchestrator messages for task lifecycle events**

In `channel.onmessage` inside `dispatchOrchestratedTask`, the `[orchestrator]` messages already contain structured lifecycle info. Add parsing to create/update tasks in real-time.

Replace the `channel.onmessage` handler (lines 223-282) with:

```typescript
channel.onmessage = (msg: OutputEvent) => {
  if (msg.event === 'exit') {
    const code = Number(msg.data);
    useProcessStore.getState()._updateStatus(
      orchestrationId,
      code === 0 ? 'completed' : 'failed',
      code,
    );
    emitProcessOutput(orchestrationId, msg);
    return;
  }
  emitProcessOutput(orchestrationId, msg);

  if (msg.event === 'stdout' && msg.data) {
    const line = msg.data;
    const masterAgent = orchestratorConfig.masterAgent;

    // --- Task lifecycle tracking from orchestrator messages ---
    // "Assigned to <agent>: <desc>" → add sub-task as pending (Queued)
    const assignMatch = line.match(/^Assigned to (\w+): (.+)$/);
    if (assignMatch) {
      const [, agent, desc] = assignMatch;
      const subId = crypto.randomUUID();
      useTaskStore.getState().addTask({
        taskId: subId,
        prompt: desc,
        toolName: agent as ToolName,
        status: 'pending',
        description: desc.length > 60 ? desc.slice(0, 57) + '...' : desc,
        startedAt: null,
        dependsOn: null,
      });
    }

    // "Phase 2: Executing..." → move all pending tasks to running (In Progress)
    if (line.includes('Phase 2: Executing')) {
      const taskState = useTaskStore.getState();
      const newTasks = new Map(taskState.tasks);
      for (const [id, task] of newTasks) {
        if (task.status === 'pending') {
          newTasks.set(id, { ...task, status: 'running', startedAt: Date.now() });
        }
      }
      useTaskStore.setState({ tasks: newTasks });
    }

    // "Completed (exit 0): ..." or "Failed (exit X): ..." → mark task done
    const completionMatch = line.match(/^(Completed|Failed) \(exit (\d+)\): (.+)/);
    if (completionMatch) {
      const [, result, , summary] = completionMatch;
      const status = result === 'Completed' ? 'completed' : 'failed';
      // Find the matching running task by agent name in the summary
      const taskState = useTaskStore.getState();
      for (const [id, task] of taskState.tasks) {
        if (task.status === 'running') {
          // Match by checking if summary contains agent-related text
          useTaskStore.getState().updateTaskStatus(id, status as TaskStatus);
          break;
        }
      }
    }

    // --- Orchestration log routing (existing logic) ---
    if (line.startsWith('[orchestrator]')) {
      useTaskStore.getState().addOrchestrationLog({
        agent: masterAgent,
        level: 'cmd',
        message: line,
      });
    } else if (line.startsWith('{')) {
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'assistant' && ev.message?.content) {
          for (const block of ev.message.content) {
            if (block.type === 'text' && block.text) {
              useTaskStore.getState().addOrchestrationLog({
                agent: masterAgent,
                level: 'info',
                message: block.text,
              });
            }
          }
        } else if (ev.type === 'result' && ev.result) {
          useTaskStore.getState().addOrchestrationLog({
            agent: masterAgent,
            level: 'success',
            message: ev.result,
          });
        }
      } catch {
        // Not valid JSON — skip
      }
    } else if (line.trim()) {
      useTaskStore.getState().addOrchestrationLog({
        agent: masterAgent,
        level: 'info',
        message: line,
      });
    }
  }
};
```

**Step 2: Remove duplicate task addition after orchestration completes**

Replace the post-completion sub-task addition block (lines 323-353) with plan-only updates:

```typescript
if (result.status === 'ok') {
  const plan = result.data;
  const taskState = useTaskStore.getState();

  // Update any remaining pending/running tasks based on final plan status
  for (const subTask of plan.sub_tasks) {
    // If task wasn't already tracked via messenger events, add it now as completed
    const existingTask = Array.from(taskState.tasks.values()).find(
      t => t.prompt === subTask.prompt || t.description === subTask.prompt.slice(0, 57) + '...'
    );
    if (!existingTask) {
      taskState.addTask({
        taskId: subTask.id,
        prompt: subTask.prompt,
        toolName: subTask.assigned_agent as ToolName,
        status: 'completed',
        description: subTask.prompt.length > 60 ? subTask.prompt.slice(0, 57) + '...' : subTask.prompt,
        startedAt: Date.now(),
        dependsOn: null,
      });
    }
  }

  // If no sub-tasks (master handled directly), add the master as a completed task
  if (plan.sub_tasks.length === 0 && taskState.tasks.size === 0) {
    taskState.addTask({
      taskId: plan.task_id,
      prompt,
      toolName: plan.master_agent as ToolName,
      status: 'completed',
      description: description,
      startedAt: Date.now(),
      dependsOn: null,
    });
  }

  // Store active plan
  taskState.setActivePlan({
    task_id: plan.task_id,
    master_agent: plan.master_agent,
    master_process_id: plan.master_process_id,
  });

  // Mark orchestration phase as completed
  const phaseStr = plan.phase as string;
  if (phaseStr === 'Completed' || phaseStr === 'Failed') {
    taskState.setOrchestrationPhase(phaseStr === 'Completed' ? 'completed' : 'failed');
  } else {
    taskState.setOrchestrationPhase('completed');
  }

  useProcessStore.getState()._updateStatus(orchestrationId, 'completed', 0);
}
```

**Step 3: Fix KanbanView `waiting` status mapping**

In `src/components/views/KanbanView.tsx`, `waiting` should map to `queued` not `done`:

```typescript
function mapColumn(status: TaskEntry['status']): ColumnKey {
  switch (status) {
    case 'pending':
    case 'routing':
    case 'waiting':
      return 'queued';
    case 'running':
      return 'running';
    case 'completed':
    case 'review':
    case 'failed':
      return 'done';
    default:
      return 'queued';
  }
}
```

**Step 4: Verify**

Run: `npx tsc --noEmit --skipLibCheck`
Expected: No new errors

**Step 5: Commit**

```bash
git add src/hooks/useTaskDispatch.ts src/components/views/KanbanView.tsx
git commit -m "fix: task lifecycle — real-time Queued/In Progress/Done transitions"
```

---

### Task 2: Fix Dev Mode Command Input

**Problem:** TerminalView's dev mode input captures text but Enter only clears input — never sends to process.

**Files:**
- Modify: `src/components/views/TerminalView.tsx:48-55,381-384`

**Step 1: Import sendToProcess and add handler**

Add imports and wire up the Enter handler to send commands to the active process:

```typescript
// At top of file, add import:
import { commands } from '@/bindings';
```

Replace the `onKeyDown` handler (lines 381-384) with:

```typescript
onKeyDown={async (e) => {
  if (e.key === 'Enter' && devInput.trim()) {
    const input = devInput.trim();
    setDevInput('');

    // Find active process to send to
    const plan = useTaskStore.getState().activePlan;
    const processId = plan?.master_process_id;

    if (!processId) {
      addLog({ agent: 'claude', level: 'error', message: 'No active process to send command to' });
      return;
    }

    // Echo the command in terminal
    addLog({ agent: (plan.master_agent as ToolName) || 'claude', level: 'cmd', message: `$ ${input}` });

    try {
      const result = await commands.sendToProcess(processId, input);
      if (result.status === 'error') {
        addLog({ agent: 'claude', level: 'error', message: `Send failed: ${result.error}` });
      }
    } catch (err) {
      addLog({ agent: 'claude', level: 'error', message: `Send failed: ${err}` });
    }
  }
}}
```

**Step 2: Verify**

Run: `npx tsc --noEmit --skipLibCheck`
Expected: No new errors

**Step 3: Commit**

```bash
git add src/components/views/TerminalView.tsx
git commit -m "fix: dev mode command input sends to active process"
```

---

### Task 3: Same-Session New Task Input

**Problem:** After launching, SetupPanel closes and there's no way to add tasks without starting a new session.

**Files:**
- Modify: `src/components/layout/AppShell.tsx`
- Modify: `src/stores/uiStore.ts`

**Step 1: Add `showQuickTask` state to uiStore**

In `src/stores/uiStore.ts`, add:

```typescript
// In UIState interface, add:
showQuickTask: boolean;
setShowQuickTask: (show: boolean) => void;

// In create(), add:
showQuickTask: false,
setShowQuickTask: (show) => set({ showQuickTask: show }),
```

**Step 2: Add quick task popover in AppShell header**

In `src/components/layout/AppShell.tsx`, add state and the quick task UI. After the tabs section (after line 137 `</div>`), before `<div className="flex-1" />`:

First, add imports and state at the top of `AppShell` component:

```typescript
// Add to existing imports:
import { useState } from 'react';

// Inside AppShell function, add:
const projectDir = useUIStore((s) => s.projectDir);
const showQuickTask = useUIStore((s) => s.showQuickTask);
const setShowQuickTask = useUIStore((s) => s.setShowQuickTask);
const { dispatchTask } = useTaskDispatch();
const [quickPrompt, setQuickPrompt] = useState('');
const [quickAgent, setQuickAgent] = useState<ToolName>('claude');
const [quickSubmitting, setQuickSubmitting] = useState(false);

const handleQuickTask = async () => {
  if (!quickPrompt.trim() || !projectDir || quickSubmitting) return;
  setQuickSubmitting(true);
  try {
    await dispatchTask(quickPrompt.trim(), projectDir, quickAgent);
    setQuickPrompt('');
    setShowQuickTask(false);
    // Add log entry
    const store = useTaskStore.getState();
    store.addOrchestrationLog({
      agent: quickAgent,
      level: 'cmd',
      message: `New task dispatched: ${quickPrompt.trim().slice(0, 80)}`,
    });
  } catch (e) {
    console.error('Quick task failed:', e);
    useTaskStore.getState().addOrchestrationLog({
      agent: quickAgent,
      level: 'error',
      message: `Task failed: ${e}`,
    });
  } finally {
    setQuickSubmitting(false);
  }
};
```

Then add the `+` button and popover in the header, right after the tabs `</div>` and before `<div className="flex-1" />`:

```tsx
{/* Quick task button — only show when session is active */}
{activePlan && projectDir && (
  <div className="relative ml-2">
    <button
      onClick={() => setShowQuickTask(!showQuickTask)}
      className="flex items-center justify-center w-6 h-6 rounded-md text-xs font-bold transition-all"
      style={{
        background: showQuickTask ? C.accent : 'transparent',
        color: showQuickTask ? '#fff' : C.textMuted,
        border: `1px solid ${showQuickTask ? C.accent : C.borderStrong}`,
      }}
    >
      +
    </button>

    {showQuickTask && (
      <div
        className="absolute top-full left-0 mt-2 z-50 flex flex-col gap-2 p-3 rounded-xl"
        style={{
          width: 340,
          background: C.panel,
          border: `1px solid ${C.border}`,
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        }}
      >
        <div className="flex items-center gap-2">
          <select
            value={quickAgent}
            onChange={(e) => setQuickAgent(e.target.value as ToolName)}
            className="text-xs rounded-md px-2 py-1.5"
            style={{
              background: C.surface,
              color: C.textPrimary,
              border: `1px solid ${C.border}`,
              outline: 'none',
            }}
          >
            <option value="claude">Claude</option>
            <option value="gemini">Gemini</option>
            <option value="codex">Codex</option>
          </select>
          <input
            autoFocus
            type="text"
            value={quickPrompt}
            onChange={(e) => setQuickPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleQuickTask(); if (e.key === 'Escape') setShowQuickTask(false); }}
            placeholder="Describe the task..."
            className="flex-1 text-xs rounded-md px-2.5 py-1.5"
            style={{
              background: C.surface,
              color: C.textPrimary,
              border: `1px solid ${C.border}`,
              outline: 'none',
            }}
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs" style={{ color: C.textMuted }}>
            Project: {projectDir.split('/').pop()}
          </span>
          <button
            onClick={handleQuickTask}
            disabled={!quickPrompt.trim() || quickSubmitting}
            className="text-xs font-medium px-3 py-1 rounded-md transition-all"
            style={{
              background: quickPrompt.trim() ? C.accent : C.borderStrong,
              color: quickPrompt.trim() ? '#fff' : C.textMuted,
              opacity: quickSubmitting ? 0.5 : 1,
            }}
          >
            {quickSubmitting ? 'Sending...' : 'Run'}
          </button>
        </div>
      </div>
    )}
  </div>
)}
```

**Step 3: Verify**

Run: `npx tsc --noEmit --skipLibCheck`
Expected: No new errors

**Step 4: Commit**

```bash
git add src/stores/uiStore.ts src/components/layout/AppShell.tsx
git commit -m "feat: add quick task input for same-session task dispatch"
```

---

### Task 4: Usage View — Real Token Data

**Problem:** Backend `get_agent_context_info` returns None for all token/cost fields. Token data exists in NDJSON result events but isn't captured.

**Files:**
- Modify: `src-tauri/src/state.rs` (add usage fields to ProcessEntry)
- Modify: `src-tauri/src/process/manager.rs` (extract usage from output on exit)
- Modify: `src-tauri/src/commands/orchestrator.rs` (populate AgentContextInfo from ProcessEntry)
- Modify: `src/hooks/useTaskDispatch.ts` (extract usage from frontend NDJSON events)
- Modify: `src/stores/taskStore.ts` (update agent context on result events)

**Step 1: Add usage fields to ProcessEntry**

In `src-tauri/src/state.rs`, add fields to `ProcessEntry`:

```rust
#[derive(Debug)]
pub struct ProcessEntry {
    pub pgid: i32,
    pub status: ProcessStatus,
    pub tool_name: String,
    pub task_description: String,
    pub started_at: i64,
    pub stdin_tx: Option<tokio::sync::mpsc::UnboundedSender<String>>,
    pub output_lines: Vec<String>,
    /// Signals when the process exits. Clone the receiver, drop the lock, then await.
    pub completion_rx: tokio::sync::watch::Receiver<bool>,
    /// Signals new line count — subscribers can detect new output without polling.
    pub line_count_rx: tokio::sync::watch::Receiver<usize>,
    /// Token usage stats extracted from NDJSON result events
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub cost_usd: Option<f64>,
}
```

**Step 2: Initialize new fields in process manager spawn functions**

In `src-tauri/src/process/manager.rs`, find where `ProcessEntry` is created in both `spawn_with_env` and `spawn_interactive` functions. Add the new fields:

```rust
// In the ProcessEntry initialization (both spawn_with_env and spawn_interactive):
input_tokens: None,
output_tokens: None,
total_tokens: None,
cost_usd: None,
```

**Step 3: Extract usage from output lines on process exit**

In `src-tauri/src/process/manager.rs`, find the process exit handler (where `ProcessStatus::Completed` is set). Before setting the status, scan the last few output lines for result events:

```rust
// Add this function to manager.rs:
fn extract_usage_from_output(entry: &mut ProcessEntry) {
    // Scan last 10 lines for a result event with usage data
    let start = entry.output_lines.len().saturating_sub(10);
    for line in &entry.output_lines[start..] {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line.trim()) {
            if parsed.get("type").and_then(|v| v.as_str()) == Some("result") {
                // Claude: total_cost_usd at top level
                if let Some(cost) = parsed.get("total_cost_usd").and_then(|v| v.as_f64()) {
                    entry.cost_usd = Some(cost);
                }
                // Gemini: stats.input_tokens, stats.output_tokens, stats.total_tokens
                if let Some(stats) = parsed.get("stats") {
                    if let Some(input) = stats.get("input_tokens").and_then(|v| v.as_u64()) {
                        entry.input_tokens = Some(input);
                    }
                    if let Some(output) = stats.get("output_tokens").and_then(|v| v.as_u64()) {
                        entry.output_tokens = Some(output);
                    }
                    if let Some(total) = stats.get("total_tokens").and_then(|v| v.as_u64()) {
                        entry.total_tokens = Some(total);
                    }
                }
                break; // Found result event, stop scanning
            }
        }
    }
}
```

Call this function before setting the process status to Completed:

```rust
// Before: entry.status = ProcessStatus::Completed(code);
extract_usage_from_output(entry);
entry.status = ProcessStatus::Completed(code);
```

**Step 4: Populate AgentContextInfo from ProcessEntry usage data**

In `src-tauri/src/commands/orchestrator.rs`, update `get_agent_context_info` (line 969-975):

```rust
infos.push(AgentContextInfo {
    tool_name: sub_task.assigned_agent.clone(),
    input_tokens: proc.map(|p| p.input_tokens.map(|v| v as u32)).flatten(),
    output_tokens: proc.map(|p| p.output_tokens.map(|v| v as u32)).flatten(),
    total_tokens: proc.map(|p| p.total_tokens.map(|v| v as u32)).flatten(),
    cost_usd: proc.map(|p| p.cost_usd).flatten(),
    status,
});
```

This requires changing the lookup pattern slightly — store the `proc` reference:

```rust
for sub_task in &plan.sub_tasks {
    let proc = inner.processes.get(&sub_task.id);
    let status = if let Some(p) = proc {
        match &p.status {
            ProcessStatus::Running => "running".to_string(),
            ProcessStatus::Paused => "paused".to_string(),
            ProcessStatus::Completed(code) => format!("completed({})", code),
            ProcessStatus::Failed(msg) => format!("failed: {}", msg),
        }
    } else {
        sub_task.status.clone()
    };

    infos.push(AgentContextInfo {
        tool_name: sub_task.assigned_agent.clone(),
        input_tokens: proc.and_then(|p| p.input_tokens.map(|v| v as u32)),
        output_tokens: proc.and_then(|p| p.output_tokens.map(|v| v as u32)),
        total_tokens: proc.and_then(|p| p.total_tokens.map(|v| v as u32)),
        cost_usd: proc.and_then(|p| p.cost_usd),
        status,
    });
}
```

**Step 5: Frontend — extract usage from NDJSON result events**

In `src/hooks/useTaskDispatch.ts`, inside the `channel.onmessage` of `dispatchOrchestratedTask`, add usage extraction when we see a result event:

```typescript
// Inside the JSON parsing block (where ev.type === 'result'), add:
} else if (ev.type === 'result') {
  if (ev.result) {
    useTaskStore.getState().addOrchestrationLog({
      agent: masterAgent,
      level: 'success',
      message: ev.result,
    });
  }
  // Extract usage data from result event
  const toolName = masterAgent;
  const usageUpdate: Partial<AgentContextInfo> = {
    toolName,
    status: ev.is_error ? 'failed' : 'completed',
  };
  // Claude: total_cost_usd
  if (typeof ev.total_cost_usd === 'number') {
    usageUpdate.costUsd = ev.total_cost_usd;
  }
  // Gemini: stats object
  if (ev.stats) {
    usageUpdate.inputTokens = ev.stats.input_tokens ?? null;
    usageUpdate.outputTokens = ev.stats.output_tokens ?? null;
    usageUpdate.totalTokens = ev.stats.total_tokens ?? null;
  }
  useTaskStore.getState().updateAgentContext(toolName, {
    toolName,
    inputTokens: usageUpdate.inputTokens ?? null,
    outputTokens: usageUpdate.outputTokens ?? null,
    totalTokens: usageUpdate.totalTokens ?? null,
    costUsd: usageUpdate.costUsd ?? null,
    status: usageUpdate.status ?? 'unknown',
  });
}
```

Note: The NDJSON events in `channel.onmessage` are raw lines. The `ev` parsed from JSON needs to handle both Claude and Gemini formats. Update the ClaudeStreamEvent interface to include stats:

```typescript
// At the top of the onmessage JSON parsing section, the parsed `ev` is already generic.
// The Gemini stats field is accessed via ev.stats directly from the parsed JSON.
```

**Step 6: Add cost display to UsageView**

In `src/components/views/UsageView.tsx`, add cost row below the token grid (after the grid `</div>` closing on line 194):

```tsx
{/* Cost */}
{agent.meta && (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingTop: 12,
      marginTop: 12,
      borderTop: `1px solid ${C.border}`,
    }}
  >
    <span style={{ fontSize: 12, color: C.textMuted }}>Estimated Cost</span>
    <span style={{ fontSize: 16, fontWeight: 700, color: C.green }}>
      ${(agentContexts.get(agent.toolName)?.costUsd ?? 0).toFixed(4)}
    </span>
  </div>
)}
```

**Step 7: Verify backend compiles**

Run: `cd src-tauri && cargo check 2>&1 | head -20`
Expected: No errors

**Step 8: Verify frontend compiles**

Run: `npx tsc --noEmit --skipLibCheck`
Expected: No new errors

**Step 9: Run Rust tests**

Run: `cd src-tauri && cargo test -- --skip credentials 2>&1 | tail -5`
Expected: All tests pass

**Step 10: Commit**

```bash
git add src-tauri/src/state.rs src-tauri/src/process/manager.rs src-tauri/src/commands/orchestrator.rs src/hooks/useTaskDispatch.ts src/components/views/UsageView.tsx
git commit -m "feat: usage view with real token/cost data from NDJSON events"
```
