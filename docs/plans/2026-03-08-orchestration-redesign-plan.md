# Orchestration Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform WhaleCode from a loose fan-out multi-agent system to a true two-phase master-agent orchestration with persistent input bar, stdin routing, and messenger view.

**Architecture:** Master agent decomposes tasks via CLI (Phase 1), backend parses JSON and dispatches sub-tasks to workers (Phase 2), master reviews results (Phase 3). Messenger tab shows orchestration events. Persistent input bar replaces the toggle-based "New Task" button and supports follow-up messages via stdin routing.

**Tech Stack:** Tauri v2 (Rust), React 19, TypeScript, Zustand, Tailwind CSS 4, tauri-specta

---

### Task 1: Create Messenger Data Model (Rust)

**Files:**
- Create: `src-tauri/src/messenger/mod.rs`
- Create: `src-tauri/src/messenger/models.rs`
- Modify: `src-tauri/src/lib.rs:1-10` (add `mod messenger`)

**Step 1: Create messenger models**

Create `src-tauri/src/messenger/models.rs`:

```rust
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use specta::Type;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
pub enum MessageSource {
    System,
    Agent(String), // tool_name: "claude" | "gemini" | "codex"
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
pub enum MessageType {
    OrchestrationStarted,
    TaskAssigned,
    TaskCompleted,
    TaskFailed,
    AgentSummary,
    MasterDecision,
    DecompositionResult,
    ReviewResult,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct MessengerMessage {
    pub id: String,
    pub timestamp: i64, // millis since epoch (for specta compat)
    pub source: MessageSource,
    pub content: String,
    pub message_type: MessageType,
    pub plan_id: String, // which orchestration plan this belongs to
}

impl MessengerMessage {
    pub fn system(plan_id: &str, content: String, message_type: MessageType) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            timestamp: Utc::now().timestamp_millis(),
            source: MessageSource::System,
            content,
            message_type,
            plan_id: plan_id.to_string(),
        }
    }

    pub fn agent(plan_id: &str, agent: &str, content: String, message_type: MessageType) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            timestamp: Utc::now().timestamp_millis(),
            source: MessageSource::Agent(agent.to_string()),
            content,
            message_type,
            plan_id: plan_id.to_string(),
        }
    }
}
```

**Step 2: Create messenger module file**

Create `src-tauri/src/messenger/mod.rs`:

```rust
pub mod models;
pub use models::*;
```

**Step 3: Register module in lib.rs**

Add `mod messenger;` after `mod ipc;` in `src-tauri/src/lib.rs:4`.

**Step 4: Run tests to verify compilation**

Run: `cd src-tauri && cargo check`
Expected: Compiles without errors

**Step 5: Commit**

```bash
git add src-tauri/src/messenger/
git commit -m "feat: add messenger data model for orchestration events"
```

---

### Task 2: Extend OrchestrationPlan with Phases and Decomposition (Rust)

**Files:**
- Modify: `src-tauri/src/router/orchestrator.rs`
- Modify: `src-tauri/src/state.rs:71-76`

**Step 1: Add new types to orchestrator.rs**

Add before the `Orchestrator` struct (after line 43 in `src-tauri/src/router/orchestrator.rs`):

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
pub enum OrchestrationPhase {
    Decomposing,
    Executing,
    Reviewing,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct DecompositionResult {
    pub tasks: Vec<SubTaskDef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SubTaskDef {
    pub agent: String,
    pub prompt: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct WorkerResult {
    pub task_id: String,
    pub agent: String,
    pub exit_code: i32,
    pub output_summary: String, // last N lines of output
}
```

**Step 2: Add phase field to OrchestrationPlan**

Modify the `OrchestrationPlan` struct to add `phase`, `decomposition`, and `worker_results`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct OrchestrationPlan {
    pub task_id: String,
    pub original_prompt: String,
    pub sub_tasks: Vec<SubTask>,
    pub master_agent: String,
    pub phase: OrchestrationPhase,
    pub decomposition: Option<DecompositionResult>,
    pub worker_results: Vec<WorkerResult>,
}
```

**Step 3: Update create_plan to set initial phase**

In `Orchestrator::create_plan`, update the return value to include the new fields:

```rust
OrchestrationPlan {
    task_id,
    original_prompt: prompt.to_string(),
    sub_tasks,
    master_agent: config.master_agent.clone(),
    phase: OrchestrationPhase::Decomposing,
    decomposition: None,
    worker_results: Vec::new(),
}
```

**Step 4: Build the decomposition prompt**

Add a new method `build_decompose_prompt` to `Orchestrator`:

```rust
/// Build a prompt that asks the master agent to decompose a task into sub-tasks
/// and return strict JSON output.
pub fn build_decompose_prompt(prompt: &str, available_agents: &[AgentConfig]) -> String {
    let agent_list: Vec<String> = available_agents
        .iter()
        .map(|a| format!("- \"{}\"", a.tool_name))
        .collect();

    format!(
        "You are a task orchestrator. Analyze the following task and decompose it into sub-tasks \
         for the available agents. Return ONLY a JSON object with no other text.\n\n\
         Available agents:\n{}\n\n\
         Task: {}\n\n\
         Return format (strict JSON, no markdown fences):\n\
         {{\"tasks\": [{{\"agent\": \"<agent_name>\", \"prompt\": \"<detailed prompt for this agent>\", \"description\": \"<short description>\"}}]}}\n\n\
         Rules:\n\
         - Assign each sub-task to the most appropriate agent\n\
         - Each agent can receive multiple tasks\n\
         - Prompts should be self-contained and detailed\n\
         - You may assign tasks to yourself",
        agent_list.join("\n"),
        prompt
    )
}

/// Build a prompt for the master agent to review worker results.
pub fn build_review_prompt(
    original_prompt: &str,
    worker_results: &[WorkerResult],
) -> String {
    let result_sections: Vec<String> = worker_results
        .iter()
        .map(|r| {
            format!(
                "### {} (exit code: {})\n{}",
                r.agent, r.exit_code, r.output_summary
            )
        })
        .collect();

    format!(
        "You are reviewing the results of a multi-agent task.\n\n\
         Original task: {}\n\n\
         Worker results:\n{}\n\n\
         Please:\n\
         1. Summarize what each worker accomplished\n\
         2. Identify any conflicts or issues between outputs\n\
         3. Provide a final integration summary\n\
         4. Note any tasks that failed and suggest remediation",
        original_prompt,
        result_sections.join("\n\n")
    )
}
```

**Step 5: Fix existing tests**

Update tests that construct `OrchestrationPlan` to include the new fields. Example fix for `create_plan_generates_subtasks`:

The `create_plan` now returns with `phase: OrchestrationPhase::Decomposing`, so add assertions:

```rust
assert_eq!(plan.phase, OrchestrationPhase::Decomposing);
assert!(plan.decomposition.is_none());
assert!(plan.worker_results.is_empty());
```

**Step 6: Add new tests**

```rust
#[test]
fn decompose_prompt_includes_agents_and_task() {
    let agents = vec![
        AgentConfig { tool_name: "claude".to_string(), sub_agent_count: 1, is_master: true },
        AgentConfig { tool_name: "gemini".to_string(), sub_agent_count: 1, is_master: false },
    ];
    let prompt = Orchestrator::build_decompose_prompt("refactor auth", &agents);
    assert!(prompt.contains("gemini"));
    assert!(prompt.contains("claude"));
    assert!(prompt.contains("refactor auth"));
    assert!(prompt.contains("JSON"));
}

#[test]
fn review_prompt_includes_worker_results() {
    let results = vec![WorkerResult {
        task_id: "t1".to_string(),
        agent: "gemini".to_string(),
        exit_code: 0,
        output_summary: "Analysis complete".to_string(),
    }];
    let prompt = Orchestrator::build_review_prompt("fix bugs", &results);
    assert!(prompt.contains("fix bugs"));
    assert!(prompt.contains("gemini"));
    assert!(prompt.contains("Analysis complete"));
}
```

**Step 7: Run tests**

Run: `cd src-tauri && cargo test`
Expected: All tests pass

**Step 8: Commit**

```bash
git add src-tauri/src/router/orchestrator.rs src-tauri/src/state.rs
git commit -m "feat: extend OrchestrationPlan with phases, decomposition, and review prompts"
```

---

### Task 3: Add stdin Writing Support (Rust)

**Files:**
- Modify: `src-tauri/src/process/manager.rs`
- Modify: `src-tauri/src/state.rs:26-32`
- Create: `src-tauri/src/commands/stdin.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

**Step 1: Store stdin handle in ProcessEntry**

Modify `src-tauri/src/state.rs` — add a stdin sender to ProcessEntry:

```rust
use tokio::sync::mpsc;

#[derive(Debug)]
pub struct ProcessEntry {
    pub pgid: i32,
    pub status: ProcessStatus,
    pub tool_name: String,
    pub task_description: String,
    pub started_at: i64,
    pub stdin_tx: Option<mpsc::UnboundedSender<String>>,
}
```

**Step 2: Update spawn_with_env to keep stdin open**

In `src-tauri/src/process/manager.rs`, replace the stdin auto-answer block (lines 67-73) with a channel-based approach:

```rust
let stdin_tx = if let Some(mut stdin) = child.stdin.take() {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    tauri::async_runtime::spawn(async move {
        use tokio::io::AsyncWriteExt;
        // Auto-answer initial CLI prompts
        let _ = stdin.write_all(b"1\ny\n").await;

        // Then listen for user input
        while let Some(text) = rx.recv().await {
            if stdin.write_all(text.as_bytes()).await.is_err() {
                break;
            }
            if stdin.write_all(b"\n").await.is_err() {
                break;
            }
        }
    });

    Some(tx)
} else {
    None
};
```

Then include `stdin_tx` in the ProcessEntry registration (around line 81):

```rust
inner.processes.insert(
    task_id.clone(),
    ProcessEntry {
        pgid: pid,
        status: ProcessStatus::Running,
        tool_name: "test".to_string(),
        task_description: "".to_string(),
        started_at: chrono::Utc::now().timestamp_millis(),
        stdin_tx,
    },
);
```

**Step 3: Create stdin command**

Create `src-tauri/src/commands/stdin.rs`:

```rust
use crate::state::AppState;

/// Send text to a running process's stdin.
#[tauri::command]
#[specta::specta]
pub async fn send_to_process(
    task_id: String,
    text: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let inner = state.lock().map_err(|e| e.to_string())?;
    let entry = inner
        .processes
        .get(&task_id)
        .ok_or_else(|| format!("Process not found: {}", task_id))?;

    let tx = entry
        .stdin_tx
        .as_ref()
        .ok_or("Process has no stdin channel")?;

    tx.send(text).map_err(|e| format!("Failed to send to stdin: {}", e))
}
```

**Step 4: Register in commands/mod.rs**

Add `pub mod stdin;` and `pub use stdin::send_to_process;` to `src-tauri/src/commands/mod.rs`.

**Step 5: Register in lib.rs**

Add `send_to_process` to the imports and `collect_commands!` macro in `src-tauri/src/lib.rs`.

**Step 6: Run compilation check**

Run: `cd src-tauri && cargo check`
Expected: Compiles

**Step 7: Commit**

```bash
git add src-tauri/src/commands/stdin.rs src-tauri/src/commands/mod.rs src-tauri/src/process/manager.rs src-tauri/src/state.rs src-tauri/src/lib.rs
git commit -m "feat: add send_to_process command for stdin routing"
```

---

### Task 4: Implement Two-Phase Orchestration Backend (Rust)

**Files:**
- Modify: `src-tauri/src/commands/orchestrator.rs`

This is the core task. Replace the current `dispatch_orchestrated_task` with the three-phase flow.

**Step 1: Rewrite dispatch_orchestrated_task**

Replace the entire `dispatch_orchestrated_task` function in `src-tauri/src/commands/orchestrator.rs`:

```rust
use std::collections::HashMap;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter};

use crate::context::store::ContextStore;
use crate::ipc::events::OutputEvent;
use crate::messenger::models::{MessengerMessage, MessageType};
use crate::router::orchestrator::{
    AgentContextInfo, DecompositionResult, Orchestrator, OrchestratorConfig,
    OrchestrationPlan, OrchestrationPhase, SubTaskDef, WorkerResult,
};
use crate::state::{AppState, ProcessStatus};

/// Dispatch an orchestrated multi-agent task using two-phase orchestration.
///
/// Phase 1 (Decompose): Master agent analyzes task, returns JSON sub-task assignments.
/// Phase 2 (Execute): Each sub-task dispatched to assigned agent in parallel.
/// Phase 3 (Review): Master agent reviews all worker results and provides summary.
#[tauri::command]
#[specta::specta]
pub async fn dispatch_orchestrated_task(
    prompt: String,
    project_dir: String,
    config: OrchestratorConfig,
    on_event: Channel<OutputEvent>,
    app_handle: AppHandle,
    state: tauri::State<'_, AppState>,
    context_store: tauri::State<'_, ContextStore>,
) -> Result<OrchestrationPlan, String> {
    let mut plan = Orchestrator::create_plan(&prompt, &config);

    // Store plan
    {
        let mut inner = state.lock().map_err(|e| e.to_string())?;
        inner.orchestration_plans.insert(plan.task_id.clone(), plan.clone());
    }

    // Emit messenger: orchestration started
    emit_messenger(&app_handle, MessengerMessage::system(
        &plan.task_id,
        format!("Orchestration started: \"{}\"", truncate(&prompt, 80)),
        MessageType::OrchestrationStarted,
    ));

    // === Phase 1: Decompose ===
    on_event.send(OutputEvent::Stdout(
        "[orchestrator] Phase 1: Decomposing task via master agent...".to_string()
    )).ok();

    let decompose_prompt = Orchestrator::build_decompose_prompt(&prompt, &config.agents);

    // Dispatch master for decomposition — collect its full output
    let decompose_result = run_agent_and_collect_output(
        &config.master_agent,
        &decompose_prompt,
        &project_dir,
        &on_event,
        state.clone(),
        context_store.clone(),
    ).await;

    let decomposition = match decompose_result {
        Ok(output) => {
            match parse_decomposition_json(&output) {
                Some(result) => {
                    emit_messenger(&app_handle, MessengerMessage::agent(
                        &plan.task_id,
                        &config.master_agent,
                        format!("Decomposed into {} sub-tasks:\n{}",
                            result.tasks.len(),
                            result.tasks.iter()
                                .map(|t| format!("  - {} → {}", t.agent, t.description))
                                .collect::<Vec<_>>().join("\n")
                        ),
                        MessageType::DecompositionResult,
                    ));
                    result
                }
                None => {
                    // Fallback: send entire prompt to master
                    on_event.send(OutputEvent::Stderr(
                        "[orchestrator] JSON parse failed, falling back to single-agent".to_string()
                    )).ok();
                    emit_messenger(&app_handle, MessengerMessage::system(
                        &plan.task_id,
                        "Decomposition failed — falling back to single-agent dispatch".to_string(),
                        MessageType::TaskFailed,
                    ));
                    DecompositionResult {
                        tasks: vec![SubTaskDef {
                            agent: config.master_agent.clone(),
                            prompt: prompt.clone(),
                            description: "Fallback: full task".to_string(),
                        }],
                    }
                }
            }
        }
        Err(e) => {
            update_plan_phase(&state, &plan.task_id, OrchestrationPhase::Failed)?;
            plan.phase = OrchestrationPhase::Failed;
            emit_messenger(&app_handle, MessengerMessage::system(
                &plan.task_id,
                format!("Master agent failed during decomposition: {}", e),
                MessageType::TaskFailed,
            ));
            return Ok(plan);
        }
    };

    // Store decomposition
    plan.decomposition = Some(decomposition.clone());
    plan.phase = OrchestrationPhase::Executing;
    {
        let mut inner = state.lock().map_err(|e| e.to_string())?;
        if let Some(p) = inner.orchestration_plans.get_mut(&plan.task_id) {
            p.decomposition = plan.decomposition.clone();
            p.phase = OrchestrationPhase::Executing;
        }
    }

    // === Phase 2: Execute ===
    on_event.send(OutputEvent::Stdout(format!(
        "[orchestrator] Phase 2: Executing {} sub-tasks...",
        decomposition.tasks.len()
    ))).ok();

    // Build sub-tasks from decomposition and dispatch
    plan.sub_tasks.clear();
    let mut task_channels: Vec<(String, String, String)> = Vec::new(); // (sub_task_id, agent, description)

    for sub_def in &decomposition.tasks {
        let sub_task_id = uuid::Uuid::new_v4().to_string();

        plan.sub_tasks.push(crate::router::orchestrator::SubTask {
            id: sub_task_id.clone(),
            prompt: sub_def.prompt.clone(),
            assigned_agent: sub_def.agent.clone(),
            status: "pending".to_string(),
            parent_task_id: plan.task_id.clone(),
        });

        emit_messenger(&app_handle, MessengerMessage::system(
            &plan.task_id,
            format!("Assigned to {}: {}", sub_def.agent, sub_def.description),
            MessageType::TaskAssigned,
        ));

        task_channels.push((sub_task_id, sub_def.agent.clone(), sub_def.prompt.clone()));
    }

    // Dispatch all sub-tasks
    let mut worker_task_ids: Vec<(String, String)> = Vec::new(); // (task_id, agent)
    for (sub_id, agent, sub_prompt) in &task_channels {
        let dispatch_result = super::router::dispatch_task(
            sub_prompt.clone(),
            project_dir.clone(),
            agent.clone(),
            Some(sub_id.clone()),
            on_event.clone(),
            state.clone(),
            context_store.clone(),
        ).await;

        match dispatch_result {
            Ok(task_id) => {
                worker_task_ids.push((task_id, agent.clone()));
            }
            Err(e) => {
                emit_messenger(&app_handle, MessengerMessage::system(
                    &plan.task_id,
                    format!("Failed to dispatch to {}: {}", agent, e),
                    MessageType::TaskFailed,
                ));
            }
        }
    }

    // Wait for all workers to complete
    for (task_id, agent) in &worker_task_ids {
        let result = wait_for_process_completion(task_id, state.clone()).await;
        let output_summary = get_process_output_summary(task_id);

        let worker_result = WorkerResult {
            task_id: task_id.clone(),
            agent: agent.clone(),
            exit_code: result,
            output_summary: output_summary.clone(),
        };
        plan.worker_results.push(worker_result);

        let msg_type = if result == 0 { MessageType::TaskCompleted } else { MessageType::TaskFailed };
        emit_messenger(&app_handle, MessengerMessage::agent(
            &plan.task_id,
            agent,
            format!("{} (exit {}): {}",
                if result == 0 { "Completed" } else { "Failed" },
                result,
                truncate(&output_summary, 200),
            ),
            msg_type,
        ));
    }

    // === Phase 3: Review ===
    on_event.send(OutputEvent::Stdout(
        "[orchestrator] Phase 3: Master reviewing results...".to_string()
    )).ok();
    plan.phase = OrchestrationPhase::Reviewing;
    update_plan_phase(&state, &plan.task_id, OrchestrationPhase::Reviewing)?;

    let review_prompt = Orchestrator::build_review_prompt(&prompt, &plan.worker_results);
    let review_result = run_agent_and_collect_output(
        &config.master_agent,
        &review_prompt,
        &project_dir,
        &on_event,
        state.clone(),
        context_store.clone(),
    ).await;

    match review_result {
        Ok(output) => {
            emit_messenger(&app_handle, MessengerMessage::agent(
                &plan.task_id,
                &config.master_agent,
                format!("Review complete:\n{}", truncate(&output, 500)),
                MessageType::ReviewResult,
            ));
        }
        Err(e) => {
            emit_messenger(&app_handle, MessengerMessage::system(
                &plan.task_id,
                format!("Review failed: {}", e),
                MessageType::TaskFailed,
            ));
        }
    }

    plan.phase = OrchestrationPhase::Completed;
    update_plan_phase(&state, &plan.task_id, OrchestrationPhase::Completed)?;
    emit_messenger(&app_handle, MessengerMessage::system(
        &plan.task_id,
        "Orchestration completed".to_string(),
        MessageType::OrchestrationStarted, // reusing for "completed" lifecycle
    ));

    Ok(plan)
}

// ── Helper functions ──

fn emit_messenger(app_handle: &AppHandle, message: MessengerMessage) {
    let _ = app_handle.emit("messenger-event", &message);
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() > max {
        format!("{}...", &s[..max])
    } else {
        s.to_string()
    }
}

fn update_plan_phase(
    state: &tauri::State<'_, AppState>,
    plan_id: &str,
    phase: OrchestrationPhase,
) -> Result<(), String> {
    let mut inner = state.lock().map_err(|e| e.to_string())?;
    if let Some(plan) = inner.orchestration_plans.get_mut(plan_id) {
        plan.phase = phase;
    }
    Ok(())
}

/// Parse the master agent's decomposition JSON output.
/// Tries to extract a JSON object from the output (handles markdown fences, trailing text).
fn parse_decomposition_json(output: &str) -> Option<DecompositionResult> {
    // Try direct parse first
    if let Ok(result) = serde_json::from_str::<DecompositionResult>(output.trim()) {
        return Some(result);
    }

    // Try extracting JSON from markdown code fences
    let json_str = if let Some(start) = output.find("```json") {
        let after_fence = &output[start + 7..];
        if let Some(end) = after_fence.find("```") {
            &after_fence[..end]
        } else {
            after_fence
        }
    } else if let Some(start) = output.find('{') {
        // Try from first { to last }
        if let Some(end) = output.rfind('}') {
            &output[start..=end]
        } else {
            return None;
        }
    } else {
        return None;
    };

    serde_json::from_str::<DecompositionResult>(json_str.trim()).ok()
}

/// Run an agent CLI process and collect its full stdout output.
async fn run_agent_and_collect_output(
    agent: &str,
    prompt: &str,
    project_dir: &str,
    on_event: &Channel<OutputEvent>,
    state: tauri::State<'_, AppState>,
    context_store: tauri::State<'_, ContextStore>,
) -> Result<String, String> {
    let task_id = super::router::dispatch_task(
        prompt.to_string(),
        project_dir.to_string(),
        agent.to_string(),
        None,
        on_event.clone(),
        state.clone(),
        context_store,
    ).await?;

    // Wait for completion
    let exit_code = wait_for_process_completion(&task_id, state).await;
    let output = get_process_output_summary(&task_id);

    if exit_code != 0 {
        return Err(format!("Agent {} exited with code {}", agent, exit_code));
    }

    Ok(output)
}

/// Wait for a process to complete by polling its status.
async fn wait_for_process_completion(
    task_id: &str,
    state: tauri::State<'_, AppState>,
) -> i32 {
    loop {
        {
            let inner = state.lock().unwrap();
            if let Some(entry) = inner.processes.get(task_id) {
                match &entry.status {
                    ProcessStatus::Completed(code) => return *code,
                    ProcessStatus::Failed(_) => return -1,
                    _ => {}
                }
            } else {
                return -1;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}

/// Get the last N lines of a process's output as a summary string.
/// Reads from the output channel events stored in state.
fn get_process_output_summary(task_id: &str) -> String {
    // This will be connected to the output log in the frontend side
    // For now, return a placeholder that the frontend can populate
    format!("[Output summary for task {}]", task_id)
}
```

**Step 2: Update the function signature to accept AppHandle**

The new `dispatch_orchestrated_task` now takes `app_handle: AppHandle` for emitting events. Tauri auto-injects this.

**Step 3: Run compilation check**

Run: `cd src-tauri && cargo check`
Expected: Compiles (may have warnings about unused imports — fix as needed)

**Step 4: Commit**

```bash
git add src-tauri/src/commands/orchestrator.rs
git commit -m "feat: implement two-phase orchestration with decompose-execute-review flow"
```

---

### Task 5: Create Messenger Store (Frontend)

**Files:**
- Create: `src/stores/messengerStore.ts`

**Step 1: Create the store**

```typescript
import { create } from 'zustand';
import { listen } from '@tauri-apps/api/event';

export interface MessengerMessage {
  id: string;
  timestamp: number;
  source: { type: 'System' } | { type: 'Agent'; name: string };
  content: string;
  messageType: string;
  planId: string;
}

interface MessengerState {
  messages: MessengerMessage[];
  addMessage: (msg: MessengerMessage) => void;
  clearMessages: () => void;
  getMessagesForPlan: (planId: string) => MessengerMessage[];
}

export const useMessengerStore = create<MessengerState>((set, get) => ({
  messages: [],

  addMessage: (msg) => {
    set((state) => ({
      messages: [...state.messages, msg],
    }));
  },

  clearMessages: () => set({ messages: [] }),

  getMessagesForPlan: (planId) => {
    return get().messages.filter((m) => m.planId === planId);
  },
}));

// Initialize Tauri event listener
let listenerInitialized = false;

export function initMessengerListener() {
  if (listenerInitialized) return;
  listenerInitialized = true;

  listen<MessengerMessage>('messenger-event', (event) => {
    const msg = event.payload;
    // Normalize source from Rust enum format
    const normalized: MessengerMessage = {
      ...msg,
      source: typeof msg.source === 'string'
        ? { type: 'System' }
        : 'Agent' in (msg.source as Record<string, unknown>)
          ? { type: 'Agent', name: (msg.source as { Agent: string }).Agent }
          : { type: 'System' },
    };
    useMessengerStore.getState().addMessage(normalized);
  });
}
```

**Step 2: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No new errors (existing errors from bindings.ts are pre-existing)

**Step 3: Commit**

```bash
git add src/stores/messengerStore.ts
git commit -m "feat: add useMessengerStore with Tauri event listener for orchestration messages"
```

---

### Task 6: Create Messenger Tab Component (Frontend)

**Files:**
- Create: `src/components/messenger/MessengerPanel.tsx`

**Step 1: Create the component**

```tsx
import { useEffect, useRef } from 'react';
import { useMessengerStore, initMessengerListener } from '../../stores/messengerStore';
import type { MessengerMessage } from '../../stores/messengerStore';

const SOURCE_COLORS: Record<string, string> = {
  System: 'text-zinc-400',
  claude: 'text-violet-400',
  gemini: 'text-blue-400',
  codex: 'text-emerald-400',
};

const TYPE_ICONS: Record<string, string> = {
  OrchestrationStarted: '●',
  TaskAssigned: '→',
  TaskCompleted: '✓',
  TaskFailed: '✗',
  AgentSummary: '◆',
  MasterDecision: '★',
  DecompositionResult: '◇',
  ReviewResult: '◈',
};

function getSourceLabel(source: MessengerMessage['source']): string {
  return source.type === 'System' ? 'System' : source.name;
}

function getSourceColor(source: MessengerMessage['source']): string {
  const name = source.type === 'System' ? 'System' : source.name;
  return SOURCE_COLORS[name] ?? 'text-zinc-400';
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function MessengerPanel() {
  const messages = useMessengerStore((s) => s.messages);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    initMessengerListener();
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-600 text-sm">
        No orchestration messages yet. Start a multi-agent task to see activity here.
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="flex flex-col h-full overflow-y-auto p-4 space-y-3">
      {messages.map((msg) => (
        <div key={msg.id} className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-600">{formatTime(msg.timestamp)}</span>
            <span className={`text-xs font-medium ${getSourceColor(msg.source)}`}>
              {TYPE_ICONS[msg.messageType] ?? '●'} {getSourceLabel(msg.source)}
            </span>
          </div>
          <div className="pl-4 text-sm text-zinc-300 whitespace-pre-wrap font-mono leading-relaxed">
            {msg.content}
          </div>
        </div>
      ))}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add src/components/messenger/MessengerPanel.tsx
git commit -m "feat: add MessengerPanel component for orchestration event display"
```

---

### Task 7: Redesign ProcessPanel — Remove "New Task", Add Persistent Input Bar and Messenger Tab

**Files:**
- Modify: `src/components/terminal/ProcessPanel.tsx`

This is the largest frontend change. We'll restructure ProcessPanel to:
1. Remove the "New Task" button and its toggle mechanism
2. Move agent selector + input to a persistent bottom bar
3. Add "Messenger" tab to the tab bar
4. Add stdin routing logic for the "Send" button

**Step 1: Remove "New Task" button and showTaskInput state**

Remove from ProcessPanel:
- `const [showTaskInput, setShowTaskInput] = useState(false);` (line 71)
- The "New Task" `<Button>` block (lines 206-215)
- The `{showTaskInput && (...)}` conditional wrapper around the task input area (line 229)
- The Cancel button that sets `setShowTaskInput(false)` (lines 277-288)
- The `setShowTaskInput(false)` in handleDispatch (line 151)
- The empty state message referencing "New Task" (lines 421-423)

**Step 2: Remove "Test Process" button**

Remove lines 218-225 (the "+ Test Process" button and `handleSpawnTest`).

**Step 3: Add Messenger tab to tab bar**

Add a "Messenger" tab button after the multi-agent view button. Add state for active view:

```tsx
const [activeView, setActiveView] = useState<'process' | 'messenger'>('process');
```

In the tab bar, add:

```tsx
{/* Messenger tab */}
<button
  onClick={() => setActiveView('messenger')}
  className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-mono transition-all shadow-sm shrink-0 ${
    activeView === 'messenger'
      ? 'bg-amber-500/20 text-amber-200 border border-amber-500/30 shadow-amber-500/10'
      : 'bg-white/5 text-zinc-400 border border-white/5 hover:bg-white/10 hover:text-zinc-200 hover:border-white/10'
  }`}
>
  Messenger
</button>
```

**Step 4: Add MessengerPanel to output area**

In the output area, add a condition for the messenger view:

```tsx
{activeView === 'messenger' ? (
  <MessengerPanel />
) : hasMultiAgentOutput && !activeProcessId ? (
  <MultiAgentOutput taskIds={multiAgentTaskIds} />
) : /* ...existing process output logic... */}
```

**Step 5: Move input area to bottom (persistent)**

Remove the `{showTaskInput && (...)}` wrapper. The agent selector and prompt input now always render at the bottom of the panel, after the output area div.

Restructure the component JSX to this layout:

```tsx
return (
  <div className="flex flex-col h-full bg-transparent">
    {/* Tab bar */}
    <div className="flex items-center gap-2 px-3 py-2 ...">
      {/* process tabs */}
      {/* messenger tab */}
    </div>

    {/* Context info panel */}
    {typedContexts.size > 0 && <ContextInfoPanel ... />}

    {/* Control bar for active process */}
    {activeView === 'process' && !hasMultiAgentOutput && activeProcess && (
      <div className="...">...</div>
    )}

    {/* Output area */}
    <div className="flex-1 min-h-0 relative">
      {/* messenger view or process view */}
    </div>

    {/* Persistent input bar — always at bottom */}
    <div className="border-t border-white/5 bg-black/40 backdrop-blur-xl shrink-0">
      <AgentSelector
        config={orchestratorConfig}
        onConfigChange={setOrchestratorConfig}
        apiKeyStatus={apiKeyStatus}
      />
      <div className="px-4 py-3 flex gap-3">
        <Input
          type="text"
          value={taskPrompt}
          onChange={(e) => setTaskPrompt(e.target.value)}
          placeholder={hasActiveRunningProcess ? "Send follow-up message..." : "Enter prompt for task..."}
          className="flex-1 h-9 text-sm bg-black/40 border-white/10 text-zinc-200 placeholder:text-zinc-600 focus-visible:ring-violet-500/50 rounded-lg"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
        />
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={isDispatching || !taskPrompt.trim() || !projectDir.trim()}
          className="bg-violet-600 border border-violet-500/50 shadow-lg shadow-violet-500/20 text-white hover:bg-violet-500 transition-all rounded-lg h-9"
        >
          {hasActiveRunningProcess ? 'Send' : isMultiAgent ? 'Run All' : 'Run'}
        </Button>
      </div>
    </div>
  </div>
);
```

**Step 6: Add handleSubmit with stdin routing**

Replace `handleDispatch` with a unified `handleSubmit`:

```tsx
const hasActiveRunningProcess = useMemo(() => {
  for (const proc of processes.values()) {
    if (proc.status === 'running') return true;
  }
  return false;
}, [processes]);

const handleSubmit = useCallback(async () => {
  if (!taskPrompt.trim()) return;

  if (hasActiveRunningProcess) {
    // Send to active process stdin
    const targetId = isMultiAgent
      ? multiAgentTaskIds.get(orchestratorConfig.masterAgent) ?? activeProcessId
      : activeProcessId;

    if (targetId) {
      try {
        await commands.sendToProcess(targetId, taskPrompt.trim());
        setTaskPrompt('');
      } catch (e) {
        console.error('Failed to send to process:', e);
      }
    }
  } else {
    // New task dispatch
    if (!projectDir.trim()) return;
    setIsDispatching(true);

    if (isMultiAgent) {
      const results = await dispatchOrchestratedTask(
        taskPrompt.trim(),
        projectDir.trim(),
        orchestratorConfig,
      );
      setMultiAgentTaskIds(results);
    } else {
      const tool: ToolName = selectedTool ?? orchestratorConfig.agents[0]?.toolName ?? 'claude';
      await dispatchTask(taskPrompt.trim(), projectDir.trim(), tool);
    }

    setIsDispatching(false);
    setTaskPrompt('');
    setSuggestion(null);
    setSelectedTool(null);
  }
}, [taskPrompt, projectDir, selectedTool, suggestion, dispatchTask, dispatchOrchestratedTask, isMultiAgent, orchestratorConfig, hasActiveRunningProcess, activeProcessId, multiAgentTaskIds, processes]);
```

**Step 7: Run dev build to verify**

Run: `npm run dev`
Expected: App builds and renders correctly with persistent input bar

**Step 8: Commit**

```bash
git add src/components/terminal/ProcessPanel.tsx
git commit -m "feat: redesign ProcessPanel with persistent input bar, messenger tab, and stdin routing"
```

---

### Task 8: Regenerate TypeScript Bindings

**Files:**
- Auto-generated: `src/bindings.ts`

The Rust changes added new types and commands. We need to regenerate bindings.

**Step 1: Build Rust to trigger specta export**

Run: `cd src-tauri && cargo build`
Expected: `src/bindings.ts` is regenerated with `sendToProcess` command and new types

**Step 2: Verify new command exists in bindings**

Check that `sendToProcess` appears in `src/bindings.ts`.

**Step 3: Commit**

```bash
git add src/bindings.ts
git commit -m "chore: regenerate TypeScript bindings with new orchestration types and sendToProcess command"
```

---

### Task 9: Initialize Messenger Listener on App Start

**Files:**
- Modify: `src/routes/index.tsx` or `src/App.tsx` (wherever the app root is)

**Step 1: Find and read the app entry point**

Look for the root component that renders on app load.

**Step 2: Call initMessengerListener**

Add at the top level of the app:

```tsx
import { useEffect } from 'react';
import { initMessengerListener } from './stores/messengerStore';

// In the root component:
useEffect(() => {
  initMessengerListener();
}, []);
```

**Step 3: Commit**

```bash
git add src/routes/index.tsx
git commit -m "feat: initialize messenger event listener on app startup"
```

---

### Task 10: Output Summary Collection for Review Phase

**Files:**
- Modify: `src-tauri/src/commands/orchestrator.rs` (the `get_process_output_summary` function)
- Modify: `src-tauri/src/state.rs`

The review phase needs worker output summaries. We need to store output lines in the backend.

**Step 1: Add output buffer to ProcessEntry**

In `src-tauri/src/state.rs`, add an output buffer to ProcessEntry:

```rust
pub struct ProcessEntry {
    pub pgid: i32,
    pub status: ProcessStatus,
    pub tool_name: String,
    pub task_description: String,
    pub started_at: i64,
    pub stdin_tx: Option<mpsc::UnboundedSender<String>>,
    pub output_lines: Vec<String>, // last N lines of stdout
}
```

**Step 2: Append output lines in process manager**

In `src-tauri/src/process/manager.rs`, in the stdout reader task, also store lines in state:

```rust
// Inside the stdout reader spawn block, after sending to channel:
{
    let state_clone = state_for_output.clone();
    let tid = task_id_for_output.clone();
    let line_clone = line.clone();
    tauri::async_runtime::spawn(async move {
        if let Ok(mut inner) = state_clone.lock() {
            if let Some(entry) = inner.processes.get_mut(&tid) {
                entry.output_lines.push(line_clone);
                // Keep only last 50 lines
                if entry.output_lines.len() > 50 {
                    entry.output_lines.drain(0..entry.output_lines.len() - 50);
                }
            }
        }
    });
}
```

**Step 3: Implement get_process_output_summary properly**

In `src-tauri/src/commands/orchestrator.rs`:

```rust
fn get_process_output_summary(task_id: &str, state: &tauri::State<'_, AppState>) -> String {
    let inner = state.lock().unwrap();
    if let Some(entry) = inner.processes.get(task_id) {
        let lines = &entry.output_lines;
        let last_20: Vec<&str> = lines.iter().rev().take(20).map(|s| s.as_str()).collect();
        last_20.into_iter().rev().collect::<Vec<_>>().join("\n")
    } else {
        String::new()
    }
}
```

**Step 4: Update all callers of get_process_output_summary to pass state**

**Step 5: Run tests**

Run: `cd src-tauri && cargo test`
Expected: All tests pass

**Step 6: Commit**

```bash
git add src-tauri/src/state.rs src-tauri/src/process/manager.rs src-tauri/src/commands/orchestrator.rs
git commit -m "feat: collect process output lines for review phase summaries"
```

---

### Task 11: Integration Test — Full Orchestration Flow

**Files:**
- No new files, manual testing

**Step 1: Build and run the app**

Run: `npm run tauri dev`

**Step 2: Test single-agent flow**

1. Enter a prompt with single agent selected
2. Verify "Run" button dispatches
3. While agent runs, verify input shows "Send" and placeholder changes
4. Type a follow-up message, click "Send" — verify it goes to agent's stdin

**Step 3: Test multi-agent orchestration**

1. Enable 2+ agents, set master
2. Enter a prompt, click "Run All"
3. Observe Messenger tab populates with:
   - "Orchestration started" system message
   - Decomposition result from master
   - Task assignments
   - Worker completion/failure messages
   - Review result from master
4. Verify process tabs appear for each worker

**Step 4: Test messenger tab**

1. Click "Messenger" tab in tab bar
2. Verify messages render chronologically
3. Verify auto-scroll on new messages

**Step 5: Test error fallback**

1. Test with only 1 agent selected (single-agent path)
2. Verify direct dispatch without decomposition phase

**Step 6: Final commit if any fixes needed**

```bash
git commit -m "fix: integration test fixes for orchestration flow"
```
