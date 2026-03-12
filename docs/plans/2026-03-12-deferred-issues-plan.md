# Deferred Issues Completion — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete all 7 deferred issues: TOCTOU race, polling→notify, Codex adapter real JSONL, view wiring, settings view, SetupPanel cleanup, and auto-answer stdin closure.

**Architecture:** Backend-first (Rust fixes for process management and Codex adapter), then frontend (view wiring and UI cleanup). Each task is independently testable and committable.

**Tech Stack:** Rust (Tauri v2, tokio, serde), React 19, TypeScript, Zustand

**Design Doc:** `docs/plans/2026-03-12-deferred-issues-design.md`

---

## Task 1: TOCTOU Race Fix — Centralized Tool Slot Acquisition

**Files:**
- Modify: `src-tauri/src/process/manager.rs:232-262`
- Modify: `src-tauri/src/commands/router.rs:43-110`
- Modify: `src-tauri/src/commands/orchestrator.rs:298-309`

**Step 1: Add `acquire_tool_slot` and `release_tool_slot` to process manager**

Add these two public functions at the end of `src-tauri/src/process/manager.rs` (before `#[cfg(test)]`):

```rust
/// Atomically check that no running process exists for `tool_name` and reserve the slot.
/// Returns `Err` if the tool already has a running process or is being dispatched.
pub fn acquire_tool_slot(state: &AppState, tool_name: &str) -> Result<(), String> {
    let mut inner = state.lock().map_err(|e| e.to_string())?;
    for (_id, proc) in inner.processes.iter() {
        if proc.tool_name == tool_name && matches!(proc.status, ProcessStatus::Running) {
            return Err(format!("{} is already running a task", tool_name));
        }
    }
    if !inner.reserved_tools.insert(tool_name.to_string()) {
        return Err(format!("{} is already being dispatched", tool_name));
    }
    Ok(())
}

/// Release a tool slot reservation. Idempotent.
pub fn release_tool_slot(state: &AppState, tool_name: &str) {
    if let Ok(mut inner) = state.lock() {
        inner.reserved_tools.remove(tool_name);
    }
}
```

**Step 2: Update `dispatch_task` in `router.rs` to use centralized functions**

Replace the inline reservation logic (lines 96-110) with:

```rust
    // Atomically check + reserve tool slot
    process::manager::acquire_tool_slot(&*state, &tool_name)?;
    let mut guard = ReservationGuard::new((*state).clone(), tool_name.clone());
```

Remove the old inline check that does `state.lock()` + iter + `reserved_tools.insert()`.

Update `ReservationGuard::release()` to call `release_tool_slot`:

```rust
    fn release(&mut self) {
        if !self.released {
            crate::process::manager::release_tool_slot(&self.state, &self.tool_name);
            self.released = true;
        }
    }
```

**Step 3: Add reservation check before `spawn_interactive` in orchestrator.rs**

In `dispatch_orchestrated_task` (around line 303), add reservation before spawning master:

```rust
    // Reserve tool slot for master agent before spawning
    process::manager::acquire_tool_slot(state_ref, &config.master_agent)?;

    let master_task_id = process::manager::spawn_interactive(
        tool_command,
        &format!("Orchestration master: {}", truncate(&prompt, 60)),
        &config.master_agent,
        on_event.clone(),
        state_ref,
    ).await.map_err(|e| {
        // Release reservation on spawn failure
        process::manager::release_tool_slot(state_ref, &config.master_agent);
        e
    })?;

    // Release reservation after successful spawn (process now tracked in state)
    process::manager::release_tool_slot(state_ref, &config.master_agent);
```

**Step 4: Add tests for acquire/release**

Add to `src-tauri/src/process/manager.rs` tests module:

```rust
    #[test]
    fn test_acquire_tool_slot_success() {
        let state: AppState = Arc::new(Mutex::new(Default::default()));
        assert!(acquire_tool_slot(&state, "claude").is_ok());
        // Reservation exists
        assert!(state.lock().unwrap().reserved_tools.contains("claude"));
    }

    #[test]
    fn test_acquire_tool_slot_already_reserved() {
        let state: AppState = Arc::new(Mutex::new(Default::default()));
        acquire_tool_slot(&state, "claude").unwrap();
        let err = acquire_tool_slot(&state, "claude");
        assert!(err.is_err());
        assert!(err.unwrap_err().contains("already being dispatched"));
    }

    #[test]
    fn test_acquire_tool_slot_running_process() {
        let state: AppState = Arc::new(Mutex::new(Default::default()));
        let (_tx, rx) = tokio::sync::watch::channel(false);
        let (_ltx, lrx) = tokio::sync::watch::channel(0usize);
        {
            let mut inner = state.lock().unwrap();
            inner.processes.insert("t1".to_string(), ProcessEntry {
                pgid: 1, status: ProcessStatus::Running,
                tool_name: "claude".to_string(), task_description: "test".to_string(),
                started_at: 0, stdin_tx: None, output_lines: vec![],
                completion_rx: rx, line_count_rx: lrx,
            });
        }
        let err = acquire_tool_slot(&state, "claude");
        assert!(err.is_err());
        assert!(err.unwrap_err().contains("already running"));
    }

    #[test]
    fn test_release_tool_slot() {
        let state: AppState = Arc::new(Mutex::new(Default::default()));
        acquire_tool_slot(&state, "claude").unwrap();
        release_tool_slot(&state, "claude");
        assert!(!state.lock().unwrap().reserved_tools.contains("claude"));
        // Can re-acquire
        assert!(acquire_tool_slot(&state, "claude").is_ok());
    }
```

**Step 5: Run tests and commit**

Run: `cd src-tauri && cargo test -- --skip credentials`
Expected: All tests pass

```bash
git add src-tauri/src/process/manager.rs src-tauri/src/commands/router.rs src-tauri/src/commands/orchestrator.rs
git commit -m "fix: centralize tool slot acquisition to prevent TOCTOU race

spawn_interactive() now checks reserved_tools before spawning.
All spawn paths go through acquire_tool_slot/release_tool_slot."
```

---

## Task 2: Polling → Notify — Watch Channel for Line Count

**Files:**
- Modify: `src-tauri/src/state.rs:27-38`
- Modify: `src-tauri/src/process/manager.rs:56-178`
- Modify: `src-tauri/src/commands/orchestrator.rs:49-78,564-679`

**Step 1: Add `line_count_rx` to ProcessEntry**

In `src-tauri/src/state.rs`, add field to `ProcessEntry`:

```rust
pub struct ProcessEntry {
    pub pgid: i32,
    pub status: ProcessStatus,
    pub tool_name: String,
    pub task_description: String,
    pub started_at: i64,
    pub stdin_tx: Option<tokio::sync::mpsc::UnboundedSender<String>>,
    pub output_lines: Vec<String>,
    /// Signals when the process exits.
    pub completion_rx: tokio::sync::watch::Receiver<bool>,
    /// Signals new line count — subscribers can detect new output without polling.
    pub line_count_rx: tokio::sync::watch::Receiver<usize>,
}
```

Update all `ProcessEntry` construction sites in tests (state.rs tests) to include `line_count_rx`.

**Step 2: Create line_count channel in spawn_with_env_core**

In `src-tauri/src/process/manager.rs`, in `spawn_with_env_core()`:

After `let (completion_tx, completion_rx) = tokio::sync::watch::channel(false);` (line 130), add:

```rust
    let (line_count_tx, line_count_rx) = tokio::sync::watch::channel(0usize);
```

Add `line_count_rx` to the ProcessEntry insertion (around line 135-147):

```rust
            ProcessEntry {
                pgid: pid,
                status: ProcessStatus::Running,
                tool_name: tool_name.to_string(),
                task_description: task_description.to_string(),
                started_at: chrono::Utc::now().timestamp_millis(),
                stdin_tx,
                output_lines: Vec::new(),
                completion_rx,
                line_count_rx,
            },
```

**Step 3: Signal line count from stdout reader**

In the stdout reader task (lines 158-178), after pushing to `output_lines`, send count:

```rust
    if let Some(stdout) = stdout {
        let stdout_channel = channel.clone();
        let state_for_output = state.clone();
        let task_id_for_output = task_id.clone();
        tauri::async_runtime::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                stdout_channel.send(OutputEvent::Stdout(line.clone())).ok();
                if let Ok(mut inner) = state_for_output.lock() {
                    if let Some(entry) = inner.processes.get_mut(&task_id_for_output) {
                        entry.output_lines.push(line);
                        if entry.output_lines.len() > 50 {
                            entry.output_lines.drain(0..entry.output_lines.len() - 50);
                        }
                        // Signal new line count to watchers
                        line_count_tx.send(entry.output_lines.len()).ok();
                    }
                }
            }
        });
    }
```

**Step 4: Rewrite wait_for_turn_complete to use watch**

Replace `wait_for_turn_complete` in `src-tauri/src/commands/orchestrator.rs`:

```rust
async fn wait_for_turn_complete(
    state: &AppState,
    task_id: &str,
    adapter: &dyn ToolAdapter,
) -> Result<Vec<String>, String> {
    // Clone receivers while holding lock, then drop lock
    let (mut line_rx, mut completion_rx) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let entry = s.processes.get(task_id)
            .ok_or_else(|| format!("Process {} not found", task_id))?;
        (entry.line_count_rx.clone(), entry.completion_rx.clone())
    };

    let mut lines_seen = 0usize;

    loop {
        // Wait for either new lines or process completion
        tokio::select! {
            res = line_rx.changed() => {
                if res.is_err() { break; }
            }
            res = completion_rx.changed() => {
                if res.is_err() || *completion_rx.borrow() {
                    // Process exited — return whatever we have
                    let s = state.lock().map_err(|e| e.to_string())?;
                    if let Some(entry) = s.processes.get(task_id) {
                        return Ok(entry.output_lines.clone());
                    }
                    return Ok(vec![]);
                }
            }
        }

        // Check new lines for turn completion
        let (current_lines, status) = {
            let s = state.lock().map_err(|e| e.to_string())?;
            let entry = s.processes.get(task_id)
                .ok_or_else(|| format!("Process {} not found", task_id))?;
            // Only clone if there are new lines to check
            if entry.output_lines.len() > lines_seen {
                (entry.output_lines.clone(), entry.status.clone())
            } else {
                continue;
            }
        };

        for line in current_lines.iter().skip(lines_seen) {
            if adapter.is_turn_complete(line) {
                return Ok(current_lines);
            }
        }
        lines_seen = current_lines.len();

        match status {
            ProcessStatus::Failed(ref e) => return Err(format!("Process died: {}", e)),
            ProcessStatus::Completed(_) => return Ok(current_lines),
            _ => {}
        }
    }

    // Channel closed — check final state
    let s = state.lock().map_err(|e| e.to_string())?;
    if let Some(entry) = s.processes.get(task_id) {
        Ok(entry.output_lines.clone())
    } else {
        Ok(vec![])
    }
}
```

**Step 5: Update wait_for_worker_with_questions similarly**

Replace the polling loop in `wait_for_worker_with_questions` (lines 564-679). Same pattern: clone `line_count_rx` + `completion_rx`, use `tokio::select!` instead of 100ms sleep, only check new lines.

The inner structure stays the same (question detection, master relay, ask_user flow), but the outer loop changes from:

```rust
loop {
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (current_lines, status) = { /* clone all */ };
    ...
}
```

to:

```rust
let (mut line_rx, mut completion_rx) = { /* clone receivers */ };
loop {
    tokio::select! {
        _ = line_rx.changed() => {}
        res = completion_rx.changed() => {
            if *completion_rx.borrow() { /* check exit code, return */ }
        }
    }
    let (new_lines_slice, status) = { /* read only new lines */ };
    ...
}
```

The user-answer polling loop (lines 632-648) stays as-is (200ms poll on plan phase) since that's waiting for user input, not process output.

**Step 6: Run tests and commit**

Run: `cd src-tauri && cargo test -- --skip credentials`
Expected: All tests pass

```bash
git add src-tauri/src/state.rs src-tauri/src/process/manager.rs src-tauri/src/commands/orchestrator.rs
git commit -m "perf: replace polling with watch channels in orchestrator

wait_for_turn_complete and wait_for_worker_with_questions now use
tokio::sync::watch for line count notifications instead of 100ms
poll loops with full Vec clones."
```

---

## Task 3: Codex Adapter — Real JSONL Format

**Files:**
- Modify: `src-tauri/src/adapters/codex.rs` (full rewrite of event types + trait methods)

**Step 1: Replace event types with real Codex CLI format**

Replace `CodexStreamEvent`, `CodexStats` (lines 22-84) with:

```rust
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum CodexStreamEvent {
    #[serde(rename = "thread.started")]
    ThreadStarted {
        thread_id: Option<String>,
    },

    #[serde(rename = "turn.started")]
    TurnStarted {},

    #[serde(rename = "item.completed")]
    ItemCompleted {
        item: Option<CodexItem>,
    },

    #[serde(rename = "turn.completed")]
    TurnCompleted {
        usage: Option<CodexUsage>,
    },
}

#[derive(Debug, Deserialize)]
pub struct CodexItem {
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub item_type: Option<String>,
    pub text: Option<String>,
    // tool_use fields
    pub function_name: Option<String>,
    pub arguments: Option<serde_json::Value>,
    // tool_result fields
    pub output: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CodexUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
}
```

**Step 2: Add `--json` flag to command builders**

In `build_command` (line 116-127):

```rust
pub fn build_command(prompt: &str, cwd: &str, api_key: &str) -> CodexCommand {
    CodexCommand {
        cmd: "codex".to_string(),
        args: vec![
            "exec".to_string(),
            "--full-auto".to_string(),
            "--json".to_string(),
            prompt.to_string(),
        ],
        env: build_env(api_key),
        cwd: cwd.to_string(),
    }
}
```

In `build_interactive_command` trait method:

```rust
    fn build_interactive_command(&self, cwd: &str, api_key: &str) -> ToolCommand {
        ToolCommand {
            cmd: "codex".to_string(),
            args: vec![
                "--full-auto".to_string(),
                "--json".to_string(),
            ],
            env: build_env(api_key),
            cwd: cwd.to_string(),
        }
    }
```

**Step 3: Update validate_result**

```rust
pub fn validate_result(event: &CodexStreamEvent) -> Result<(), String> {
    match event {
        CodexStreamEvent::TurnCompleted { usage } => {
            if usage.is_none() {
                return Err("Codex CLI turn completed without usage data".to_string());
            }
            Ok(())
        }
        CodexStreamEvent::ItemCompleted { item } => {
            let item = item.as_ref().ok_or("Empty item in item.completed")?;
            if item.item_type.as_deref() == Some("agent_message") {
                if item.text.as_ref().map_or(true, |t| t.trim().is_empty()) {
                    return Err("Codex CLI returned empty agent message".to_string());
                }
            }
            Ok(())
        }
        _ => Ok(()),
    }
}
```

**Step 4: Update ToolAdapter trait methods**

```rust
impl ToolAdapter for CodexAdapter {
    fn build_command(&self, prompt: &str, cwd: &str, api_key: &str) -> ToolCommand {
        let c = build_command(prompt, cwd, api_key);
        ToolCommand { cmd: c.cmd, args: c.args, env: c.env, cwd: c.cwd }
    }

    fn parse_stream_line(&self, line: &str) -> Option<String> {
        parse_stream_line(line).map(|_| line.trim().to_string())
    }

    fn validate_result_json(&self, result_json: &str) -> Result<(), String> {
        let event = parse_stream_line(result_json)
            .ok_or_else(|| "Failed to parse Codex result JSON".to_string())?;
        validate_result(&event)
    }

    fn detect_rate_limit(&self, line: &str) -> Option<SharedRateLimitInfo> {
        detect_rate_limit(line).map(|info| SharedRateLimitInfo { retry_after_secs: info.retry_after_secs })
    }

    fn retry_policy(&self) -> SharedRetryPolicy {
        let p = RetryPolicy::default_codex();
        SharedRetryPolicy { max_retries: p.max_retries, base_delay_ms: p.base_delay_ms, max_delay_ms: p.max_delay_ms }
    }

    fn name(&self) -> &str { "Codex CLI" }

    fn build_interactive_command(&self, cwd: &str, api_key: &str) -> ToolCommand {
        ToolCommand {
            cmd: "codex".to_string(),
            args: vec!["--full-auto".to_string(), "--json".to_string()],
            env: build_env(api_key),
            cwd: cwd.to_string(),
        }
    }

    fn detect_question(&self, line: &str) -> Option<Question> {
        let event = parse_stream_line(line)?;
        match event {
            CodexStreamEvent::ItemCompleted { item } => {
                let item = item?;
                if item.item_type.as_deref() != Some("agent_message") { return None; }
                let text = item.text?;
                if text.contains("[QUESTION]") || text.contains("[ASK]") {
                    let qtype = QuestionType::from_text(&text);
                    Some(Question { source_agent: "codex".to_string(), content: text, question_type: qtype })
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    fn parse_display_output(&self, line: &str) -> Option<DisplayLine> {
        let event = parse_stream_line(line)?;
        match event {
            CodexStreamEvent::ItemCompleted { item } => {
                let item = item?;
                match item.item_type.as_deref() {
                    Some("agent_message") => {
                        let text = item.text?;
                        if text.is_empty() { return None; }
                        Some(DisplayLine { content: text, line_type: DisplayLineType::AgentThinking })
                    }
                    Some("tool_use") => {
                        let name = item.function_name.unwrap_or_else(|| "unknown".to_string());
                        let args = item.arguments.map(|v| serde_json::to_string(&v).unwrap_or_default()).unwrap_or_default();
                        Some(DisplayLine { content: format!("[{}] {}", name, args), line_type: DisplayLineType::ToolExecution })
                    }
                    Some("tool_result") => {
                        let content = item.output.unwrap_or_default();
                        if content.is_empty() { return None; }
                        Some(DisplayLine { content, line_type: DisplayLineType::Result })
                    }
                    _ => None,
                }
            }
            CodexStreamEvent::TurnCompleted { usage } => {
                let u = usage?;
                let input = u.input_tokens.unwrap_or(0);
                let output = u.output_tokens.unwrap_or(0);
                Some(DisplayLine {
                    content: format!("Turn complete ({}in/{}out tokens)", input, output),
                    line_type: DisplayLineType::Result,
                })
            }
            _ => None,
        }
    }

    fn extract_result(&self, output_lines: &[String]) -> Option<String> {
        // Find last agent_message text
        for line in output_lines.iter().rev() {
            if let Some(event) = parse_stream_line(line) {
                if let CodexStreamEvent::ItemCompleted { item: Some(item) } = event {
                    if item.item_type.as_deref() == Some("agent_message") {
                        return item.text;
                    }
                }
            }
        }
        None
    }

    fn is_turn_complete(&self, line: &str) -> bool {
        matches!(parse_stream_line(line), Some(CodexStreamEvent::TurnCompleted { .. }))
    }
}
```

**Step 5: Update all tests to use real JSONL format**

Replace all test JSON strings. Examples:

```rust
// Old: {"type":"init","session_id":"abc","model":"o4-mini"}
// New: {"type":"thread.started","thread_id":"abc"}

// Old: {"type":"message","role":"assistant","content":"Hello"}
// New: {"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Hello"}}

// Old: {"type":"result","status":"completed","response":"Done"}
// New: {"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}

// Old: {"type":"tool_use","function_name":"Bash","call_id":"t1","arguments":{"command":"ls"}}
// New: {"type":"item.completed","item":{"id":"i2","type":"tool_use","function_name":"Bash","arguments":{"command":"ls"}}}
```

Update the orchestrator test `test_adapter_extract_result_codex` as well — it currently uses old format.

**Step 6: Run tests and commit**

Run: `cd src-tauri && cargo test -- --skip credentials`
Expected: All tests pass

```bash
git add src-tauri/src/adapters/codex.rs src-tauri/src/commands/orchestrator.rs
git commit -m "fix: update Codex adapter to real CLI JSONL format

Codex CLI v0.111.0 uses thread.started/item.completed/turn.completed
events, not the assumed init/message/result format. Added --json flag
to command builders."
```

---

## Task 4: View Wiring — TerminalView

**Files:**
- Modify: `src/components/views/TerminalView.tsx`
- Modify: `src/stores/taskStore.ts`

**Step 1: Add log accumulation to taskStore**

Add to `src/stores/taskStore.ts` interface and store:

```typescript
// Add to TaskState interface (after decomposedTasks):
  orchestrationLogs: Array<{ id: string; timestamp: string; agent: ToolName; level: 'info' | 'success' | 'warn' | 'cmd' | 'error'; message: string }>;
  addOrchestrationLog: (log: { agent: ToolName; level: 'info' | 'success' | 'warn' | 'cmd' | 'error'; message: string }) => void;
  clearOrchestrationLogs: () => void;

// Add to store implementation:
  orchestrationLogs: [],
  addOrchestrationLog: (log) => {
    set((state) => ({
      orchestrationLogs: [
        ...state.orchestrationLogs.slice(-499), // keep last 500
        {
          id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
          timestamp: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          ...log,
        },
      ],
    }));
  },
  clearOrchestrationLogs: () => set({ orchestrationLogs: [] }),
```

**Step 2: Wire TerminalView to real data**

Replace `MOCK_LOGS` usage with store data and event listener. In `TerminalView.tsx`:

```typescript
import { useState, useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { C, STATUS, LOG_COLOR } from '@/lib/theme';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTaskStore, type ToolName } from '@/stores/taskStore';

// ... keep types, AGENT_ICON, AGENT_LABEL, mergeStatusStyle as-is ...

export function TerminalView({ devMode }: TerminalViewProps) {
  const tasks = useTaskStore((s) => s.tasks);
  const logs = useTaskStore((s) => s.orchestrationLogs);
  const addLog = useTaskStore((s) => s.addOrchestrationLog);
  const [devInput, setDevInput] = useState('');

  // Subscribe to orchestration output events
  useEffect(() => {
    const unlisten = listen<string>('messenger-event', (event) => {
      try {
        const msg = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
        if (msg.agent && msg.content) {
          const level = msg.message_type?.includes('Failed') ? 'error'
            : msg.message_type?.includes('Completed') ? 'success'
            : msg.message_type?.includes('Started') || msg.message_type?.includes('Assigned') ? 'cmd'
            : 'info';
          addLog({ agent: msg.agent as ToolName || 'claude', level, message: msg.content });
        }
      } catch { /* ignore non-JSON */ }
    });
    return () => { unlisten.then(fn => fn()); };
  }, [addLog]);

  // Build merge queue from completed tasks
  const mergeQueue: MergeQueueItem[] = [];
  for (const [, task] of tasks) {
    if (task.status === 'completed' || task.status === 'review') {
      mergeQueue.push({
        branch: `wc/${task.toolName}-${task.taskId.slice(0, 6)}`,
        agent: task.toolName,
        status: task.status === 'completed' ? 'merged' : 'ready',
      });
    } else if (task.status === 'running') {
      mergeQueue.push({
        branch: `wc/${task.toolName}-${task.taskId.slice(0, 6)}`,
        agent: task.toolName,
        status: 'merging',
      });
    }
  }

  // ... rest of JSX stays the same but replace:
  // MOCK_LOGS -> logs
  // MOCK_MERGE_QUEUE -> mergeQueue
```

Remove `MOCK_LOGS` and `MOCK_MERGE_QUEUE` constants entirely.

**Step 3: Run TypeScript check and commit**

Run: `npx tsc --noEmit 2>&1 | grep -v bindings.ts | head -20`
Expected: No new errors (existing bindings.ts errors are pre-existing)

```bash
git add src/components/views/TerminalView.tsx src/stores/taskStore.ts
git commit -m "feat: wire TerminalView to real orchestration events

Replace mock logs with messenger-event listener. Build merge queue
from actual task state."
```

---

## Task 5: View Wiring — UsageView

**Files:**
- Modify: `src/components/views/UsageView.tsx`

**Step 1: Replace mock data with store data**

```typescript
import { useEffect } from 'react';
import { C } from '@/lib/theme';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTaskStore, type ToolName } from '@/stores/taskStore';
import { commands } from '@/bindings';

const AGENT_META: Record<ToolName, { name: string; model: string; icon: { letter: string; gradient: string } }> = {
  claude: { name: 'Claude Code', model: 'claude-sonnet-4', icon: { letter: 'C', gradient: 'linear-gradient(135deg, #6d5efc 0%, #8b5cf6 100%)' } },
  gemini: { name: 'Gemini CLI', model: 'gemini-2.5-pro', icon: { letter: 'G', gradient: 'linear-gradient(135deg, #0ea5e9 0%, #38bdf8 100%)' } },
  codex: { name: 'Codex CLI', model: 'o3-mini', icon: { letter: 'X', gradient: 'linear-gradient(135deg, #22c55e 0%, #4ade80 100%)' } },
};

export function UsageView() {
  const agentContexts = useTaskStore((s) => s.agentContexts);
  const activePlan = useTaskStore((s) => s.activePlan);
  const updateAgentContext = useTaskStore((s) => s.updateAgentContext);

  // Fetch usage data when plan is active
  useEffect(() => {
    if (!activePlan?.task_id) return;
    commands.getAgentContextInfo(activePlan.task_id)
      .then((infos) => {
        for (const info of infos) {
          updateAgentContext(info.tool_name as ToolName, {
            toolName: info.tool_name as ToolName,
            inputTokens: info.input_tokens ?? null,
            outputTokens: info.output_tokens ?? null,
            totalTokens: info.total_tokens ?? null,
            costUsd: info.cost_usd ?? null,
            status: info.status,
          });
        }
      })
      .catch(() => {});
  }, [activePlan?.task_id, updateAgentContext]);

  // Build usage list from contexts (or show empty state)
  const usageList = Array.from(agentContexts.entries()).map(([toolName, ctx]) => ({
    toolName: toolName as ToolName,
    meta: AGENT_META[toolName as ToolName],
    totalTokens: ctx.totalTokens ?? 0,
    inputTokens: ctx.inputTokens ?? 0,
    outputTokens: ctx.outputTokens ?? 0,
    costUsd: ctx.costUsd,
    status: ctx.status,
  }));

  // ... render usageList instead of MOCK_USAGE
  // Show token counts instead of percentage bars (no limit data from backend)
  // If usageList is empty, show "No active orchestration" message
```

Remove `MOCK_USAGE`, `AgentUsage` interface, `quotaColor`, `quotaBg` functions. Replace percentage-based progress bar with token count display.

**Step 2: Run TypeScript check and commit**

```bash
git add src/components/views/UsageView.tsx
git commit -m "feat: wire UsageView to real agent context data

Fetch token usage via getAgentContextInfo command. Show actual
token counts instead of mock percentage bars."
```

---

## Task 6: View Wiring — CodeReviewView

**Files:**
- Modify: `src/components/views/CodeReviewView.tsx`

**Step 1: Wire to real data and commands**

Replace mock data with store data and wire buttons:

```typescript
import { useState } from 'react';
import { C } from '@/lib/theme';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTaskStore } from '@/stores/taskStore';
import { commands } from '@/bindings';

export function CodeReviewView({ onDone }: CodeReviewViewProps) {
  const [response, setResponse] = useState('');
  const [accepted, setAccepted] = useState(false);
  const activePlan = useTaskStore((s) => s.activePlan);
  const tasks = useTaskStore((s) => s.tasks);
  const decomposedTasks = useTaskStore((s) => s.decomposedTasks);

  // Derive stats from tasks
  const tasksDone = Array.from(tasks.values()).filter(t => t.status === 'completed').length;
  const warnings = Array.from(tasks.values()).filter(t => t.status === 'failed').length;
  const prsReady = Array.from(tasks.values()).filter(t => t.status === 'completed' || t.status === 'review').length;

  // Derive file review list from decomposed tasks
  const files: FileReview[] = decomposedTasks.map(st => ({
    path: st.prompt.slice(0, 60),
    status: st.status === 'failed' ? 'warning' as const : 'pass' as const,
    note: `${st.assignedAgent} — ${st.status}`,
  }));

  const handleAccept = async () => {
    if (!activePlan?.task_id) return;
    try {
      await commands.approveDecomposition(activePlan.task_id, decomposedTasks.map(t => ({
        agent: t.assignedAgent,
        prompt: t.prompt,
        description: t.prompt.slice(0, 60),
      })));
      setAccepted(true);
    } catch (e) {
      console.error('Failed to approve:', e);
    }
  };

  const handleSkip = async () => {
    if (!activePlan?.task_id) return;
    try {
      await commands.rejectDecomposition(activePlan.task_id, response || 'Skipped by user');
      onDone();
    } catch (e) {
      console.error('Failed to reject:', e);
    }
  };

  // ... rest of JSX: use files, tasksDone, prsReady, warnings
  // Wire Accept button onClick to handleAccept
  // Wire Skip button onClick to handleSkip
```

Remove `MOCK_FILES`, `STATS`, `SUMMARY_TEXT` constants.

**Step 2: Run TypeScript check and commit**

```bash
git add src/components/views/CodeReviewView.tsx
git commit -m "feat: wire CodeReviewView to real task data and commands

Accept calls approveDecomposition, Skip calls rejectDecomposition.
Stats and file list derived from taskStore."
```

---

## Task 7: View Wiring — DoneView

**Files:**
- Modify: `src/components/views/DoneView.tsx`

**Step 1: Replace mock data with store-derived stats**

```typescript
import { C } from '@/lib/theme';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTaskStore } from '@/stores/taskStore';

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}

export function DoneView({ onNew }: DoneViewProps) {
  const tasks = useTaskStore((s) => s.tasks);

  const allTasks = Array.from(tasks.values());
  const completedTasks = allTasks.filter(t => t.status === 'completed');
  const uniqueAgents = new Set(allTasks.map(t => t.toolName));

  // Calculate total duration
  const startTimes = allTasks.map(t => t.startedAt).filter(Boolean) as number[];
  const totalDuration = startTimes.length > 0
    ? Date.now() - Math.min(...startTimes)
    : 0;

  const stats = [
    { label: 'Tasks', value: String(allTasks.length) },
    { label: 'Completed', value: String(completedTasks.length) },
    { label: 'Total Time', value: formatDuration(totalDuration) },
    { label: 'Agents', value: String(uniqueAgents.size) },
  ];

  // Build PR list from completed tasks
  const prs = completedTasks.map((t, i) => ({
    number: i + 1,
    title: t.description || t.prompt.slice(0, 50),
    branch: `wc/${t.toolName}-${t.taskId.slice(0, 6)}`,
    agent: t.toolName.charAt(0).toUpperCase() + t.toolName.slice(1),
  }));

  // ... rest of JSX: use stats and prs instead of STATS and MOCK_PRS
```

Remove `STATS` and `MOCK_PRS` constants.

**Step 2: Run TypeScript check and commit**

```bash
git add src/components/views/DoneView.tsx
git commit -m "feat: wire DoneView to real task completion data

Stats and PR list derived from taskStore completed tasks."
```

---

## Task 8: Settings View + SetupPanel Cleanup

**Files:**
- Modify: `src/routes/index.tsx:51-58`
- Modify: `src/components/layout/SetupPanel.tsx:26-31`

**Step 1: Replace settings placeholder with ApiKeySettings**

In `src/routes/index.tsx`, replace the "coming soon" div (lines 51-58):

```typescript
import { ApiKeySettings } from '../components/settings/ApiKeySettings';

// ... then in JSX:
          {activeView === 'settings' && <ApiKeySettings />}
```

Remove the old placeholder `<div>`.

**Step 2: Remove gpt4 from SetupPanel fallback**

In `src/components/layout/SetupPanel.tsx`, remove the `gpt4` entry from `DISCOVERED_AGENTS` (line 31):

```typescript
const DISCOVERED_AGENTS: DetectedAgent[] = [
  { id: 'claude-opus', name: 'Claude Opus 4', cli: 'claude', icon: '\u{1F7E3}', auth: true, version: 'v1.2.3', model: 'claude-opus-4-5' },
  { id: 'claude-haiku', name: 'Claude Haiku 3.5', cli: 'claude', icon: '\u{1F7E3}', auth: true, version: 'v1.2.3', model: 'claude-haiku-3-5' },
  { id: 'gemini', name: 'Gemini 2.5 Pro', cli: 'gemini', icon: '\u{1F535}', auth: true, version: 'v0.9.1', model: 'gemini-2.5-pro' },
  { id: 'codex', name: 'Codex CLI', cli: 'codex', icon: '\u{2B1B}', auth: false, version: 'v0.1.2504', model: null },
];
```

**Step 3: Run TypeScript check and commit**

```bash
git add src/routes/index.tsx src/components/layout/SetupPanel.tsx
git commit -m "feat: render ApiKeySettings in settings view, remove gpt4 fallback

Replace 'coming soon' placeholder with the already-wired ApiKeySettings
component. Remove non-functional gpt4 entry from SetupPanel fallback."
```

---

## Task 9: Update Memory + Final Verification

**Files:**
- Modify: `~/.claude/projects/.../memory/MEMORY.md`
- Delete: `~/.claude/projects/.../memory/2026-03-08-remaining-issues.md`

**Step 1: Update memory**

Remove deferred issues from MEMORY.md "Current State" section. Remove or update the `2026-03-08-remaining-issues.md` to mark all items as completed. Remove "auto-answer stdin" from deferred list.

**Step 2: Run full test suite**

```bash
cd src-tauri && cargo test -- --skip credentials
npx tsc --noEmit 2>&1 | grep -v bindings.ts | head -20
```

Expected: All Rust tests pass, no new TS errors.

**Step 3: Final commit (if memory updated)**

```bash
git add -A
git commit -m "chore: update memory, all deferred issues completed"
```
