# Orchestration Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace stateless 3-phase orchestration with interactive master agent that stays alive, handles worker questions, and supports context backup/restore via `/clear`.

**Architecture:** Master agent runs in interactive mode (no `-p` flag) with stdin/stdout multi-turn conversation. Workers run single-shot. Per-adapter output parsers normalize display. Question routing via FIFO queue. Context persisted to `context.md` in project root.

**Tech Stack:** Rust (Tauri v2), React 19, TypeScript, Zustand, tokio async

**Design doc:** `docs/plans/2026-03-08-orchestration-redesign-design.md`

---

### Task 1: Add New Types to Adapter Module

**Files:**
- Modify: `src-tauri/src/adapters/mod.rs:1-69`

**Step 1: Write failing tests for new types**

Add to `src-tauri/src/adapters/mod.rs` at the end of the test module (after line 136):

```rust
#[test]
fn test_question_type_debug() {
    let q = Question {
        source_agent: "codex".to_string(),
        content: "Which schema to use?".to_string(),
        question_type: QuestionType::Clarification,
    };
    assert_eq!(q.source_agent, "codex");
    assert_eq!(q.content, "Which schema to use?");
    assert!(matches!(q.question_type, QuestionType::Clarification));
}

#[test]
fn test_display_line_types() {
    let line = DisplayLine {
        content: "Analyzing files...".to_string(),
        line_type: DisplayLineType::AgentThinking,
    };
    assert_eq!(line.content, "Analyzing files...");
    assert!(matches!(line.line_type, DisplayLineType::AgentThinking));
}

#[test]
fn test_ask_user_response() {
    let resp = AskUserResponse {
        ask_user: "Which database schema?".to_string(),
    };
    let json = serde_json::to_string(&resp).unwrap();
    assert!(json.contains("ask_user"));
    let parsed: AskUserResponse = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.ask_user, "Which database schema?");
}
```

**Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test adapter -- --test-threads=1 2>&1 | tail -20`
Expected: FAIL — `Question`, `DisplayLine`, `AskUserResponse` not found

**Step 3: Add new types before the `ToolAdapter` trait (after line 37, before line 43)**

```rust
/// A question detected from a worker agent's output stream.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct Question {
    pub source_agent: String,
    pub content: String,
    pub question_type: QuestionType,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub enum QuestionType {
    Technical,
    Clarification,
    Permission,
}

/// Normalized display line for uniform agent output rendering.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct DisplayLine {
    pub content: String,
    pub line_type: DisplayLineType,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub enum DisplayLineType {
    AgentThinking,
    ToolExecution,
    Result,
    Info,
}

/// Structured response when master agent needs user input.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AskUserResponse {
    pub ask_user: String,
}
```

**Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test adapter -- --test-threads=1 2>&1 | tail -20`
Expected: PASS

**Step 5: Commit**

```bash
git add src-tauri/src/adapters/mod.rs
git commit -m "feat(adapters): add Question, DisplayLine, AskUserResponse types"
```

---

### Task 2: Extend ToolAdapter Trait with New Methods

**Files:**
- Modify: `src-tauri/src/adapters/mod.rs:43-69` (ToolAdapter trait)

**Step 1: Write failing test**

Add to test module in `src-tauri/src/adapters/mod.rs`:

```rust
#[test]
fn test_trait_has_interactive_command() {
    let adapter = crate::adapters::claude::ClaudeAdapter;
    let cmd = adapter.build_interactive_command("/tmp", "test-key");
    assert!(!cmd.command.is_empty());
}
```

**Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test test_trait_has_interactive_command 2>&1 | tail -20`
Expected: FAIL — `build_interactive_command` not found on trait

**Step 3: Add new methods to `ToolAdapter` trait (inside the trait block, after `name()`)**

```rust
    /// Build command for interactive mode (no -p flag, stdin/stdout multi-turn).
    fn build_interactive_command(&self, cwd: &str, api_key: &str) -> ToolCommand;

    /// Detect if a stream line contains a question from the agent.
    fn detect_question(&self, line: &str) -> Option<Question>;

    /// Parse a raw stream line into a normalized display line.
    fn parse_display_output(&self, line: &str) -> Option<DisplayLine>;

    /// Extract the final JSON result from collected output lines.
    fn extract_result(&self, output_lines: &[String]) -> Option<String>;

    /// Detect if a stream line signals that the agent's current turn is complete.
    fn is_turn_complete(&self, line: &str) -> bool;
```

**Step 4: Compilation will fail until Tasks 3-5 implement these for all adapters. Proceed directly.**

---

### Task 3: Implement New Methods for ClaudeAdapter

**Files:**
- Modify: `src-tauri/src/adapters/claude.rs:229-268` (ClaudeAdapter impl)

**Step 1: Write failing tests**

Add to test module in `src-tauri/src/adapters/claude.rs`:

```rust
#[test]
fn test_build_interactive_command_no_prompt_flag() {
    let adapter = ClaudeAdapter;
    let cmd = adapter.build_interactive_command("/tmp/project", "sk-test-key");
    assert!(!cmd.args.iter().any(|a| a == "-p"));
    assert!(cmd.args.iter().any(|a| a == "stream-json"));
    assert_eq!(cmd.cwd, "/tmp/project");
    assert!(cmd.env.iter().any(|(k, _)| k == "ANTHROPIC_API_KEY"));
}

#[test]
fn test_detect_question_from_claude_stream() {
    let adapter = ClaudeAdapter;
    let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"I need to know: which framework?"}]}}"#;
    let result = adapter.detect_question(line);
    assert!(result.is_none()); // no [QUESTION] tag
}

#[test]
fn test_parse_display_output_claude_message() {
    let adapter = ClaudeAdapter;
    let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Analyzing the codebase..."}]}}"#;
    let result = adapter.parse_display_output(line);
    assert!(result.is_some());
    let display = result.unwrap();
    assert!(display.content.contains("Analyzing"));
}

#[test]
fn test_parse_display_output_claude_tool_use() {
    let adapter = ClaudeAdapter;
    let line = r#"{"type":"tool_use","name":"bash","input":{"command":"ls -la"}}"#;
    let result = adapter.parse_display_output(line);
    assert!(result.is_some());
    assert!(matches!(result.unwrap().line_type, DisplayLineType::ToolExecution));
}

#[test]
fn test_extract_result_claude() {
    let adapter = ClaudeAdapter;
    let lines = vec![
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"thinking..."}]}}"#.to_string(),
        r#"{"type":"result","result":"final answer here","is_error":false,"num_turns":3}"#.to_string(),
    ];
    let result = adapter.extract_result(&lines);
    assert!(result.is_some());
    assert!(result.unwrap().contains("final answer"));
}

#[test]
fn test_is_turn_complete_claude() {
    let adapter = ClaudeAdapter;
    assert!(adapter.is_turn_complete(r#"{"type":"result","result":"done","is_error":false}"#));
    assert!(!adapter.is_turn_complete(r#"{"type":"assistant","message":{"content":[]}}"#));
}
```

**Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test claude -- --test-threads=1 2>&1 | tail -30`
Expected: FAIL — methods not implemented

**Step 3: Implement methods in `ClaudeAdapter` impl block**

```rust
fn build_interactive_command(&self, cwd: &str, api_key: &str) -> ToolCommand {
    ToolCommand {
        command: "claude".to_string(),
        args: vec![
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--verbose".to_string(),
            "--dangerously-skip-permissions".to_string(),
        ],
        env: vec![("ANTHROPIC_API_KEY".to_string(), api_key.to_string())],
        cwd: cwd.to_string(),
    }
}

fn detect_question(&self, line: &str) -> Option<Question> {
    let event: ClaudeStreamEvent = serde_json::from_str(line).ok()?;
    match event {
        ClaudeStreamEvent::Message { message } => {
            let text: String = message.content
                .iter()
                .filter_map(|b| b.text.as_ref())
                .cloned()
                .collect::<Vec<_>>()
                .join(" ");
            if text.contains("[QUESTION]") || text.contains("[ASK]") {
                Some(Question {
                    source_agent: "claude".to_string(),
                    content: text,
                    question_type: QuestionType::Clarification,
                })
            } else {
                None
            }
        }
        _ => None,
    }
}

fn parse_display_output(&self, line: &str) -> Option<DisplayLine> {
    let event: ClaudeStreamEvent = serde_json::from_str(line).ok()?;
    match event {
        ClaudeStreamEvent::Message { message } => {
            let text: String = message.content
                .iter()
                .filter_map(|b| b.text.as_ref())
                .cloned()
                .collect::<Vec<_>>()
                .join(" ");
            if text.is_empty() { return None; }
            Some(DisplayLine {
                content: text,
                line_type: DisplayLineType::AgentThinking,
            })
        }
        ClaudeStreamEvent::ToolUse { name, input } => {
            let desc = format!("[{}] {}", name.unwrap_or_default(),
                input.map(|v| v.to_string()).unwrap_or_default());
            Some(DisplayLine {
                content: desc,
                line_type: DisplayLineType::ToolExecution,
            })
        }
        ClaudeStreamEvent::ToolResult { content } => {
            Some(DisplayLine {
                content: content.unwrap_or_default(),
                line_type: DisplayLineType::Result,
            })
        }
        ClaudeStreamEvent::Result { result, .. } => {
            Some(DisplayLine {
                content: result.unwrap_or_default(),
                line_type: DisplayLineType::Result,
            })
        }
        _ => None,
    }
}

fn extract_result(&self, output_lines: &[String]) -> Option<String> {
    for line in output_lines.iter().rev() {
        if let Ok(event) = serde_json::from_str::<ClaudeStreamEvent>(line) {
            if let ClaudeStreamEvent::Result { result, .. } = event {
                return result;
            }
        }
    }
    None
}

fn is_turn_complete(&self, line: &str) -> bool {
    serde_json::from_str::<ClaudeStreamEvent>(line)
        .map(|e| matches!(e, ClaudeStreamEvent::Result { .. }))
        .unwrap_or(false)
}
```

**Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test claude -- --test-threads=1 2>&1 | tail -30`
Expected: PASS

**Step 5: Do NOT commit yet — wait for Tasks 4 and 5**

---

### Task 4: Implement New Methods for GeminiAdapter

**Files:**
- Modify: `src-tauri/src/adapters/gemini.rs:237-276` (GeminiAdapter impl)

**Step 1: Write failing tests**

Add to test module in `src-tauri/src/adapters/gemini.rs`:

```rust
#[test]
fn test_build_interactive_command_gemini() {
    let adapter = GeminiAdapter;
    let cmd = adapter.build_interactive_command("/tmp/project", "gemini-key");
    assert!(!cmd.args.iter().any(|a| a == "-p"));
    assert!(cmd.args.iter().any(|a| a == "stream-json"));
    assert!(cmd.args.iter().any(|a| a == "--yolo"));
}

#[test]
fn test_parse_display_output_gemini_message() {
    let adapter = GeminiAdapter;
    let line = r#"{"type":"message","content":"Looking at the code structure..."}"#;
    let result = adapter.parse_display_output(line);
    assert!(result.is_some());
}

#[test]
fn test_extract_result_gemini() {
    let adapter = GeminiAdapter;
    let lines = vec![
        r#"{"type":"message","content":"working..."}"#.to_string(),
        r#"{"type":"result","result":"completed analysis","stats":{"total_tokens":1500}}"#.to_string(),
    ];
    let result = adapter.extract_result(&lines);
    assert!(result.is_some());
}

#[test]
fn test_is_turn_complete_gemini() {
    let adapter = GeminiAdapter;
    assert!(adapter.is_turn_complete(r#"{"type":"result","result":"done"}"#));
    assert!(!adapter.is_turn_complete(r#"{"type":"message","content":"hi"}"#));
}
```

**Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test gemini -- --test-threads=1 2>&1 | tail -20`
Expected: FAIL

**Step 3: Implement methods in `GeminiAdapter` impl block**

Follow same pattern as ClaudeAdapter. Key differences:
- Interactive command: `gemini` binary with `--yolo` and `--output-format stream-json`
- Message content is plain `String` (not `ContentBlock` array)
- Question detection checks for `[QUESTION]`/`[ASK]` in message content
- `extract_result` looks for `GeminiStreamEvent::Result`
- `is_turn_complete` checks for `Result` event

**Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test gemini -- --test-threads=1 2>&1 | tail -20`
Expected: PASS

**Step 5: Do NOT commit yet — wait for Task 5**

---

### Task 5: Implement New Methods for CodexAdapter

**Files:**
- Modify: `src-tauri/src/adapters/codex.rs:238-277` (CodexAdapter impl)

**Step 1: Write failing tests**

Add to test module in `src-tauri/src/adapters/codex.rs`:

```rust
#[test]
fn test_build_interactive_command_codex() {
    let adapter = CodexAdapter;
    let cmd = adapter.build_interactive_command("/tmp/project", "openai-key");
    assert!(!cmd.args.iter().any(|a| a == "-p"));
    assert!(cmd.args.iter().any(|a| a == "--full-auto"));
}

#[test]
fn test_parse_display_output_codex_tool_use() {
    let adapter = CodexAdapter;
    let line = r#"{"type":"tool_use","function_name":"shell","arguments":{"command":"ls"}}"#;
    let result = adapter.parse_display_output(line);
    assert!(result.is_some());
    assert!(matches!(result.unwrap().line_type, DisplayLineType::ToolExecution));
}

#[test]
fn test_extract_result_codex() {
    let adapter = CodexAdapter;
    let lines = vec![
        r#"{"type":"message","content":"analyzing..."}"#.to_string(),
        r#"{"type":"result","result":"done","stats":{"prompt_tokens":100}}"#.to_string(),
    ];
    let result = adapter.extract_result(&lines);
    assert!(result.is_some());
}

#[test]
fn test_is_turn_complete_codex() {
    let adapter = CodexAdapter;
    assert!(adapter.is_turn_complete(r#"{"type":"result","result":"done"}"#));
    assert!(!adapter.is_turn_complete(r#"{"type":"message","content":"thinking"}"#));
}
```

**Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test codex -- --test-threads=1 2>&1 | tail -20`
Expected: FAIL

**Step 3: Implement methods in `CodexAdapter` impl block**

Follow same pattern. Key differences:
- Interactive command: `codex` binary with `--full-auto`
- Uses `function_name` instead of `name` for tool use events
- Stats use OpenAI naming: `prompt_tokens`/`completion_tokens`

**Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test codex -- --test-threads=1 2>&1 | tail -20`
Expected: PASS

**Step 5: Commit all adapter changes together**

```bash
git add src-tauri/src/adapters/
git commit -m "feat(adapters): extend ToolAdapter with interactive mode, question detection, display parsing"
```

---

### Task 6: Update State and Orchestration Models

**Files:**
- Modify: `src-tauri/src/router/orchestrator.rs:49-75`
- Modify: `src-tauri/src/state.rs:75-82`

**Step 1: Write failing tests**

Add to `src-tauri/src/router/orchestrator.rs` test module:

```rust
#[test]
fn test_orchestration_phase_has_waiting_for_input() {
    let phase = OrchestrationPhase::WaitingForInput;
    let json = serde_json::to_string(&phase).unwrap();
    assert!(json.contains("WaitingForInput"));
}

#[test]
fn test_orchestration_plan_has_master_process_id() {
    let plan = Orchestrator::create_plan("test-task", "test prompt", "claude", vec![]);
    assert!(plan.master_process_id.is_none());
}

#[test]
fn test_pending_question_struct() {
    let entry = PendingQuestion {
        question: crate::adapters::Question {
            source_agent: "codex".to_string(),
            content: "Which DB?".to_string(),
            question_type: crate::adapters::QuestionType::Clarification,
        },
        worker_task_id: "task-123".to_string(),
    };
    assert_eq!(entry.worker_task_id, "task-123");
}
```

**Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test orchestrator -- --test-threads=1 2>&1 | tail -20`
Expected: FAIL

**Step 3: Add `WaitingForInput` to `OrchestrationPhase` (line 49)**

```rust
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub enum OrchestrationPhase {
    Decomposing,
    Executing,
    WaitingForInput,
    Reviewing,
    Completed,
    Failed,
}
```

**Step 4: Add `master_process_id` to `OrchestrationPlan` (line 28)**

```rust
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct OrchestrationPlan {
    pub task_id: String,
    pub original_prompt: String,
    pub sub_tasks: Vec<SubTask>,
    pub master_agent: String,
    pub phase: OrchestrationPhase,
    pub decomposition: Option<DecompositionResult>,
    pub worker_results: Vec<WorkerResult>,
    pub master_process_id: Option<String>,
}
```

**Step 5: Add `PendingQuestion` struct (after `WorkerResult`)**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingQuestion {
    pub question: crate::adapters::Question,
    pub worker_task_id: String,
}
```

**Step 6: Update `Orchestrator::create_plan()` to initialize new field**

Add `master_process_id: None,` to the struct initialization.

**Step 7: Add question queue to `AppStateInner` (state.rs line 75)**

```rust
pub struct AppStateInner {
    pub tasks: HashMap<TaskId, TaskInfo>,
    pub processes: HashMap<TaskId, ProcessEntry>,
    pub orchestration_plans: HashMap<TaskId, OrchestrationPlan>,
    pub cached_prompt_context: Option<CachedPromptContext>,
    pub question_queue: Vec<crate::router::orchestrator::PendingQuestion>,
}
```

Initialize `question_queue: Vec::new()` in any constructors/Default impls.

**Step 8: Run tests to verify they pass**

Run: `cd src-tauri && cargo test orchestrator state -- --test-threads=1 2>&1 | tail -20`
Expected: PASS

**Step 9: Commit**

```bash
git add src-tauri/src/router/orchestrator.rs src-tauri/src/state.rs
git commit -m "feat(state): add WaitingForInput phase, master_process_id, question queue"
```

---

### Task 7: Update Messenger Models

**Files:**
- Modify: `src-tauri/src/messenger/models.rs:11-20`

**Step 1: Write failing test**

Add test module to `src-tauri/src/messenger/models.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_message_types_serialize() {
        let types = vec![
            MessageType::QuestionForUser,
            MessageType::UserAnswer,
            MessageType::ContextBackup,
            MessageType::ContextRestore,
        ];
        for t in types {
            let json = serde_json::to_string(&t).unwrap();
            assert!(!json.is_empty());
        }
    }
}
```

**Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test messenger -- --test-threads=1 2>&1 | tail -20`
Expected: FAIL

**Step 3: Add new variants to `MessageType` enum (line 11)**

```rust
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub enum MessageType {
    OrchestrationStarted,
    TaskAssigned,
    TaskCompleted,
    TaskFailed,
    AgentSummary,
    MasterDecision,
    DecompositionResult,
    ReviewResult,
    QuestionForUser,
    UserAnswer,
    ContextBackup,
    ContextRestore,
}
```

**Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test messenger -- --test-threads=1 2>&1 | tail -20`
Expected: PASS

**Step 5: Commit**

```bash
git add src-tauri/src/messenger/
git commit -m "feat(messenger): add QuestionForUser, UserAnswer, ContextBackup, ContextRestore message types"
```

---

### Task 8: Add Interactive Spawn to Process Manager

**Files:**
- Modify: `src-tauri/src/process/manager.rs`

**Step 1: Write failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_spawn_interactive_builds_correct_args() {
        let adapter = crate::adapters::claude::ClaudeAdapter;
        let cmd = adapter.build_interactive_command("/tmp", "test-key");
        assert!(!cmd.args.iter().any(|a| a == "-p"));
        assert!(cmd.args.contains(&"--output-format".to_string()));
    }
}
```

**Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test spawn_interactive -- --test-threads=1 2>&1 | tail -20`
Expected: FAIL

**Step 3: Add `spawn_interactive()` after `spawn_with_env()` (after line 201)**

```rust
/// Spawn an agent in interactive mode for multi-turn conversation.
/// Returns task_id. Use ProcessEntry.stdin_tx to send subsequent prompts.
pub async fn spawn_interactive(
    tool_command: ToolCommand,
    task_description: &str,
    tool_name: &str,
    channel: Channel<OutputEvent>,
    state: &AppState,
    app_handle: &AppHandle,
) -> Result<String, String> {
    spawn_with_env(
        &tool_command.command,
        &tool_command.args.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
        &tool_command.cwd,
        task_description,
        tool_name,
        &tool_command.env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect::<Vec<_>>(),
        None,
        channel,
        state,
        app_handle,
    ).await
}
```

**Step 4: Add `send_to_process()` helper**

```rust
/// Send a message to a running process's stdin channel.
pub fn send_to_process(
    state: &AppState,
    task_id: &str,
    message: &str,
) -> Result<(), String> {
    let state_guard = state.lock().map_err(|e| e.to_string())?;
    let entry = state_guard.processes.get(task_id)
        .ok_or_else(|| format!("Process {} not found", task_id))?;
    let stdin_tx = entry.stdin_tx.as_ref()
        .ok_or_else(|| format!("Process {} has no stdin channel", task_id))?;
    stdin_tx.send(format!("{}\n", message))
        .map_err(|e| format!("Failed to send to stdin: {}", e))
}
```

**Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test process -- --test-threads=1 2>&1 | tail -20`
Expected: PASS

**Step 6: Commit**

```bash
git add src-tauri/src/process/manager.rs
git commit -m "feat(process): add spawn_interactive and send_to_process for multi-turn agents"
```

---

### Task 9: Add New Prompt Builders to Orchestrator

**Files:**
- Modify: `src-tauri/src/router/orchestrator.rs` (after line 175)

**Step 1: Write failing tests**

Add to test module:

```rust
#[test]
fn test_build_question_relay_prompt() {
    let prompt = Orchestrator::build_question_relay_prompt("codex", "Which DB?");
    assert!(prompt.contains("codex"));
    assert!(prompt.contains("Which DB?"));
    assert!(prompt.contains("ask_user"));
}

#[test]
fn test_build_context_backup_prompt() {
    let prompt = Orchestrator::build_context_backup_prompt();
    assert!(prompt.contains("context_backup"));
}

#[test]
fn test_build_context_restore_prompt() {
    let prompt = Orchestrator::build_context_restore_prompt("prev context", "new task");
    assert!(prompt.contains("prev context"));
    assert!(prompt.contains("new task"));
}
```

**Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test orchestrator -- --test-threads=1 2>&1 | tail -20`
Expected: FAIL

**Step 3: Add new prompt builders to `Orchestrator` impl**

```rust
pub fn build_question_relay_prompt(worker_agent: &str, question: &str) -> String {
    format!(
        r#"Worker agent "{}" is asking the following question:

{}

If you can answer this confidently, respond with just your answer.
If you need the user's input, respond with exactly this JSON format:
{{"ask_user": "<your question for the user>"}}"#,
        worker_agent, question
    )
}

pub fn build_context_backup_prompt() -> String {
    r#"Back up all context from this session. Write a comprehensive summary including:
- Original task and sub-tasks assigned
- What each worker agent accomplished and their results
- Which files were changed
- Open questions or remaining work
- Key decisions and their rationale

Respond with exactly this JSON format:
{"context_backup": "<your markdown summary>"}"#.to_string()
}

pub fn build_context_restore_prompt(context_md: &str, new_prompt: &str) -> String {
    format!(
        r#"Previous session context is below. Read and remember it, then proceed to the new task.

{}

---
New task: {}"#,
        context_md, new_prompt
    )
}
```

**Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test orchestrator -- --test-threads=1 2>&1 | tail -20`
Expected: PASS

**Step 5: Commit**

```bash
git add src-tauri/src/router/orchestrator.rs
git commit -m "feat(orchestrator): add question relay, context backup/restore prompt builders"
```

---

### Task 10: Rewrite `dispatch_orchestrated_task` — Phase 1 (Decompose)

**Files:**
- Modify: `src-tauri/src/commands/orchestrator.rs:20-108`

**Step 1: Replace Phase 1 implementation**

The current Phase 1 uses `run_agent_and_collect_output()` (one-shot). Replace with:

1. `spawn_interactive()` — master stays alive
2. `send_to_process()` — send decompose prompt
3. `wait_for_turn_complete()` — new helper that monitors output for `is_turn_complete()`
4. `adapter.extract_result()` — adapter-specific JSON extraction

Key code structure:

```rust
// Phase 1: Spawn interactive master
update_plan_phase(&state, &task_id, OrchestrationPhase::Decomposing)?;

let adapter = get_adapter(&config.master_agent)?;
let api_key = get_api_key(&config.master_agent, &state)?;
let cmd = adapter.build_interactive_command(&project_dir, &api_key);

let master_task_id = process::manager::spawn_interactive(
    cmd, "orchestration master", &config.master_agent,
    channel.clone(), &state, &app_handle,
).await?;

// Store master process id in plan
{
    let mut s = state.lock().map_err(|e| e.to_string())?;
    if let Some(p) = s.orchestration_plans.get_mut(&task_id) {
        p.master_process_id = Some(master_task_id.clone());
    }
}

// Check for context.md and build first prompt
let context_path = std::path::Path::new(&project_dir).join("context.md");
let decompose_prompt = Orchestrator::build_decompose_prompt(&prompt, &config);
let first_prompt = if context_path.exists() {
    let context_md = std::fs::read_to_string(&context_path).unwrap_or_default();
    let _ = std::fs::remove_file(&context_path);
    emit_messenger(&app_handle, MessengerMessage::system(
        "Restoring context from previous session",
        MessageType::ContextRestore, &task_id,
    ));
    Orchestrator::build_context_restore_prompt(&context_md, &decompose_prompt)
} else {
    decompose_prompt
};

// Send prompt and wait for result
process::manager::send_to_process(&state, &master_task_id, &first_prompt)?;
let master_output = wait_for_turn_complete(&state, &master_task_id, adapter.as_ref()).await?;

// Parse decomposition
let decomposition = adapter.extract_result(&master_output)
    .and_then(|json| serde_json::from_str::<DecompositionResult>(&json).ok())
    .ok_or_else(|| "Failed to parse decomposition JSON from master agent".to_string())?;
```

**Step 2: Add `wait_for_turn_complete()` helper**

```rust
async fn wait_for_turn_complete(
    state: &AppState,
    task_id: &str,
    adapter: &dyn ToolAdapter,
) -> Result<Vec<String>, String> {
    let mut lines_seen = 0;
    loop {
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

        let (current_lines, status) = {
            let s = state.lock().map_err(|e| e.to_string())?;
            let entry = s.processes.get(task_id)
                .ok_or_else(|| format!("Process {} not found", task_id))?;
            (entry.output_lines.clone(), entry.status.clone())
        };

        for line in current_lines.iter().skip(lines_seen) {
            if adapter.is_turn_complete(line) {
                return Ok(current_lines);
            }
        }
        lines_seen = current_lines.len();

        match status {
            ProcessStatus::Failed(e) => return Err(format!("Process died: {}", e)),
            ProcessStatus::Completed(_) => return Ok(current_lines),
            _ => {}
        }
    }
}
```

**Step 3: Add helper functions `get_adapter()` and `get_api_key()`**

```rust
fn get_adapter(agent_name: &str) -> Result<Box<dyn ToolAdapter>, String> {
    match agent_name {
        "claude" => Ok(Box::new(crate::adapters::claude::ClaudeAdapter)),
        "gemini" => Ok(Box::new(crate::adapters::gemini::GeminiAdapter)),
        "codex" => Ok(Box::new(crate::adapters::codex::CodexAdapter)),
        _ => Err(format!("Unknown agent: {}", agent_name)),
    }
}

fn get_api_key(agent_name: &str, state: &AppState) -> Result<String, String> {
    // Use credentials module to get API key for the agent
    let key_name = match agent_name {
        "claude" => "ANTHROPIC_API_KEY",
        "gemini" => "GEMINI_API_KEY",
        "codex" => "OPENAI_API_KEY",
        _ => return Err(format!("Unknown agent: {}", agent_name)),
    };
    crate::credentials::get_credential(key_name)
        .map_err(|e| format!("Failed to get API key for {}: {}", agent_name, e))
}
```

**Step 4: Run tests**

Run: `cd src-tauri && cargo test -- --test-threads=1 2>&1 | tail -30`
Expected: PASS

**Step 5: Commit**

```bash
git add src-tauri/src/commands/orchestrator.rs
git commit -m "feat(orchestrator): rewrite Phase 1 with interactive master spawn"
```

---

### Task 11: Rewrite `dispatch_orchestrated_task` — Phase 2 (Execute with Question Routing)

**Files:**
- Modify: `src-tauri/src/commands/orchestrator.rs:121-204`

**Step 1: Replace Phase 2 implementation**

Key changes:
- Workers spawned as before (single-shot via `dispatch_task`)
- Monitor worker streams for questions via `adapter.detect_question()`
- Route questions to master via `send_to_process()`
- Parse master response for `{"ask_user": "..."}` or direct answer
- If ask_user: emit `QuestionForUser` message, set phase to `WaitingForInput`, pause until `answer_user_question` command called
- If direct answer: send to worker's stdin

```rust
// Phase 2: Execute workers with question monitoring
update_plan_phase(&state, &task_id, OrchestrationPhase::Executing)?;

let mut worker_tasks: Vec<(String, String)> = Vec::new(); // (task_id, agent)

for sub_task in &decomposition.tasks {
    let sub_task_id = uuid::Uuid::new_v4().to_string();
    emit_messenger(&app_handle, MessengerMessage::system(
        &format!("[{}] {}", sub_task.agent, sub_task.description),
        MessageType::TaskAssigned, &task_id,
    ));

    let worker_id = dispatch_task(
        &sub_task.agent, &sub_task.prompt, &project_dir,
        channel.clone(), &state, &app_handle,
    ).await?;
    worker_tasks.push((worker_id, sub_task.agent.clone()));
}

// Wait for all workers, monitoring for questions
let mut worker_results: Vec<WorkerResult> = Vec::new();
for (worker_id, agent) in &worker_tasks {
    let worker_adapter = get_adapter(agent)?;

    loop {
        tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;

        let (lines, status) = {
            let s = state.lock().map_err(|e| e.to_string())?;
            let entry = s.processes.get(worker_id)
                .ok_or_else(|| format!("Worker {} not found", worker_id))?;
            (entry.output_lines.clone(), entry.status.clone())
        };

        // Check for questions in new lines
        for line in &lines {
            if let Some(question) = worker_adapter.detect_question(line) {
                // Route to master
                let q_prompt = Orchestrator::build_question_relay_prompt(
                    &question.source_agent, &question.content,
                );
                process::manager::send_to_process(&state, &master_task_id, &q_prompt)?;

                let master_response = wait_for_turn_complete(
                    &state, &master_task_id, adapter.as_ref(),
                ).await?;

                if let Some(result_json) = adapter.extract_result(&master_response) {
                    if let Ok(ask) = serde_json::from_str::<AskUserResponse>(&result_json) {
                        // Master needs user input
                        emit_messenger(&app_handle, MessengerMessage::system(
                            &ask.ask_user,
                            MessageType::QuestionForUser, &task_id,
                        ));
                        update_plan_phase(&state, &task_id, OrchestrationPhase::WaitingForInput)?;
                        // Wait for answer_user_question command to resume
                        // The answer will be sent to master, master will respond,
                        // and that response goes to worker
                    } else {
                        // Master answered directly, send to worker
                        process::manager::send_to_process(&state, worker_id, &result_json)?;
                    }
                }
            }
        }

        // Check if worker is done
        match &status {
            ProcessStatus::Completed(code) => {
                let summary = get_process_output_summary(&state, worker_id);
                worker_results.push(WorkerResult {
                    task_id: worker_id.clone(),
                    agent: agent.clone(),
                    exit_code: *code,
                    output_summary: summary,
                });
                emit_messenger(&app_handle, MessengerMessage::system(
                    &format!("{} completed (exit {})", agent, code),
                    MessageType::TaskCompleted, &task_id,
                ));
                break;
            }
            ProcessStatus::Failed(e) => {
                worker_results.push(WorkerResult {
                    task_id: worker_id.clone(),
                    agent: agent.clone(),
                    exit_code: -1,
                    output_summary: e.clone(),
                });
                emit_messenger(&app_handle, MessengerMessage::system(
                    &format!("{} failed: {}", agent, e),
                    MessageType::TaskFailed, &task_id,
                ));
                break;
            }
            _ => {} // still running, continue loop
        }
    }
}
```

**Step 2: Run tests**

Run: `cd src-tauri && cargo test -- --test-threads=1 2>&1 | tail -30`
Expected: PASS

**Step 3: Commit**

```bash
git add src-tauri/src/commands/orchestrator.rs
git commit -m "feat(orchestrator): rewrite Phase 2 with question routing to master"
```

---

### Task 12: Rewrite `dispatch_orchestrated_task` — Phase 3 (Review) and Phase 4 (Continue)

**Files:**
- Modify: `src-tauri/src/commands/orchestrator.rs:206-250`

**Step 1: Replace Phase 3 — send review to still-alive master**

```rust
// Phase 3: Review — master is still alive, send review prompt
update_plan_phase(&state, &task_id, OrchestrationPhase::Reviewing)?;

let review_prompt = Orchestrator::build_review_prompt(&prompt, &worker_results);
process::manager::send_to_process(&state, &master_task_id, &review_prompt)?;

let review_output = wait_for_turn_complete(&state, &master_task_id, adapter.as_ref()).await?;
let review_summary = adapter.extract_result(&review_output)
    .unwrap_or_else(|| review_output.join("\n"));

emit_messenger(&app_handle, MessengerMessage::system(
    &review_summary,
    MessageType::ReviewResult, &task_id,
));

// Phase 4: Master stays alive for follow-up
// Update plan but do NOT kill master
{
    let mut s = state.lock().map_err(|e| e.to_string())?;
    if let Some(p) = s.orchestration_plans.get_mut(&task_id) {
        p.phase = OrchestrationPhase::Completed;
        p.worker_results = worker_results;
    }
}
```

**Step 2: Run tests**

Run: `cd src-tauri && cargo test -- --test-threads=1 2>&1 | tail -30`
Expected: PASS

**Step 3: Commit**

```bash
git add src-tauri/src/commands/orchestrator.rs
git commit -m "feat(orchestrator): rewrite Phase 3 review via live master, master stays alive"
```

---

### Task 13: Add New Commands — `clear_orchestration_context` and `answer_user_question`

**Files:**
- Modify: `src-tauri/src/commands/orchestrator.rs` (append new commands)

**Step 1: Add `clear_orchestration_context` command**

```rust
#[tauri::command]
#[specta::specta]
pub async fn clear_orchestration_context(
    state: tauri::State<'_, AppState>,
    app_handle: AppHandle,
    plan_id: String,
    project_dir: String,
) -> Result<String, String> {
    let master_task_id = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let plan = s.orchestration_plans.get(&plan_id)
            .ok_or("Plan not found")?;
        plan.master_process_id.clone()
            .ok_or("No master process")?
    };

    let adapter = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let plan = s.orchestration_plans.get(&plan_id)
            .ok_or("Plan not found")?;
        get_adapter(&plan.master_agent)?
    };

    emit_messenger(&app_handle, MessengerMessage::system(
        "Backing up context...", MessageType::ContextBackup, &plan_id,
    ));

    // Send backup prompt to master
    let backup_prompt = Orchestrator::build_context_backup_prompt();
    process::manager::send_to_process(&state, &master_task_id, &backup_prompt)?;

    // Wait for response with 30s timeout
    let result = tokio::time::timeout(
        tokio::time::Duration::from_secs(30),
        wait_for_turn_complete(&state, &master_task_id, adapter.as_ref()),
    ).await;

    let context_content = match result {
        Ok(Ok(lines)) => {
            adapter.extract_result(&lines).and_then(|json| {
                #[derive(Deserialize)]
                struct ContextBackup { context_backup: String }
                serde_json::from_str::<ContextBackup>(&json)
                    .ok()
                    .map(|cb| cb.context_backup)
            }).unwrap_or_else(|| lines.join("\n"))
        }
        _ => {
            // Timeout fallback
            let s = state.lock().map_err(|e| e.to_string())?;
            s.processes.get(&master_task_id)
                .map(|e| e.output_lines.join("\n"))
                .unwrap_or_default()
        }
    };

    // Write context.md
    let context_path = std::path::Path::new(&project_dir).join("context.md");
    std::fs::write(&context_path, &context_content)
        .map_err(|e| format!("Failed to write context.md: {}", e))?;

    // Kill all processes
    {
        let task_ids: Vec<String> = {
            let s = state.lock().map_err(|e| e.to_string())?;
            s.processes.keys().cloned().collect()
        };
        for tid in task_ids {
            let _ = process::manager::cancel(&tid, &state, &app_handle).await;
        }
    }

    // Clear state
    {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.orchestration_plans.remove(&plan_id);
        s.question_queue.clear();
    }

    emit_messenger(&app_handle, MessengerMessage::system(
        "Context backed up and cleared", MessageType::ContextBackup, &plan_id,
    ));

    Ok(context_path.to_string_lossy().to_string())
}
```

**Step 2: Add `answer_user_question` command**

```rust
#[tauri::command]
#[specta::specta]
pub async fn answer_user_question(
    state: tauri::State<'_, AppState>,
    app_handle: AppHandle,
    plan_id: String,
    answer: String,
) -> Result<(), String> {
    let master_task_id = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let plan = s.orchestration_plans.get(&plan_id)
            .ok_or("Plan not found")?;
        plan.master_process_id.clone()
            .ok_or("No master process")?
    };

    process::manager::send_to_process(
        &state, &master_task_id,
        &format!("The user answered: {}", answer),
    )?;

    emit_messenger(&app_handle, MessengerMessage::system(
        &format!("User answered: {}", truncate(&answer, 100)),
        MessageType::UserAnswer, &plan_id,
    ));

    update_plan_phase(&state, &plan_id, OrchestrationPhase::Executing)?;
    Ok(())
}
```

**Step 3: Run tests**

Run: `cd src-tauri && cargo test -- --test-threads=1 2>&1 | tail -30`
Expected: PASS

**Step 4: Commit**

```bash
git add src-tauri/src/commands/orchestrator.rs
git commit -m "feat(orchestrator): add clear_orchestration_context and answer_user_question commands"
```

---

### Task 14: Register New Commands and Regenerate Bindings

**Files:**
- Modify: `src-tauri/src/lib.rs` (command registration)
- Auto-generated: `src/bindings.ts`

**Step 1: Find command registration**

Search for `invoke_handler` or `generate_handler` in `src-tauri/src/lib.rs`.

**Step 2: Add new commands to the handler list**

Add `clear_orchestration_context` and `answer_user_question` to the `tauri::generate_handler![]` macro.

**Step 3: Build to regenerate bindings**

Run: `cd src-tauri && cargo build 2>&1 | tail -20`

**Step 4: Verify `src/bindings.ts` includes new exports**

Check for:
- `clearOrchestrationContext`
- `answerUserQuestion`
- `OrchestrationPhase` includes `"WaitingForInput"`
- `MessageType` includes new variants
- New types: `Question`, `DisplayLine`, etc.

**Step 5: Commit**

```bash
git add src-tauri/src/lib.rs src/bindings.ts
git commit -m "feat: register new orchestration commands and regenerate bindings"
```

---

### Task 15: Remove Dead Code

**Files:**
- Modify: `src-tauri/src/commands/orchestrator.rs`

**Step 1: Remove `parse_decomposition_json()` (lines ~323-349)**

Replaced by `adapter.extract_result()`.

**Step 2: Remove `run_agent_and_collect_output()` (lines ~352-379)**

Replaced by `spawn_interactive()` + `send_to_process()` + `wait_for_turn_complete()`.

**Step 3: Run tests to verify no remaining callers**

Run: `cd src-tauri && cargo test -- --test-threads=1 2>&1 | tail -30`
Expected: PASS

**Step 4: Commit**

```bash
git add src-tauri/src/commands/orchestrator.rs
git commit -m "refactor: remove deprecated parse_decomposition_json and run_agent_and_collect_output"
```

---

### Task 16: Frontend — Update Stores

**Files:**
- Modify: `src/stores/messengerStore.ts`
- Modify: `src/stores/taskStore.ts`

**Step 1: Add PendingQuestion state to taskStore**

```typescript
export interface PendingQuestion {
  questionId: string;
  sourceAgent: string;
  content: string;
  planId: string;
}

// Add to TaskState interface:
pendingQuestion: PendingQuestion | null;
setPendingQuestion: (q: PendingQuestion | null) => void;

// Add to store implementation:
pendingQuestion: null,
setPendingQuestion: (q) => set({ pendingQuestion: q }),
```

**Step 2: Update messengerStore to detect QuestionForUser and set pending question**

In `initMessengerListener()`, after adding message to store:

```typescript
if (normalized.messageType === 'QuestionForUser') {
  useTaskStore.getState().setPendingQuestion({
    questionId: normalized.id,
    sourceAgent: typeof normalized.source === 'string' ? normalized.source : 'master',
    content: normalized.content,
    planId: normalized.planId,
  });
}
```

**Step 3: Commit**

```bash
git add src/stores/
git commit -m "feat(stores): add pending question state and QuestionForUser detection"
```

---

### Task 17: Frontend — Question/Answer UI

**Files:**
- Modify: `src/components/messenger/MessengerPanel.tsx`

**Step 1: Add question input UI**

Import `answerUserQuestion` from bindings. Add state for answer input. When `pendingQuestion` is set, show input field below message list.

```tsx
import { answerUserQuestion } from '../../bindings';

// Inside component:
const pendingQuestion = useTaskStore(s => s.pendingQuestion);
const setPendingQuestion = useTaskStore(s => s.setPendingQuestion);
const [answer, setAnswer] = useState('');

const handleAnswer = async () => {
  if (!pendingQuestion || !answer.trim()) return;
  await answerUserQuestion(pendingQuestion.planId, answer.trim());
  setPendingQuestion(null);
  setAnswer('');
};

// In JSX, after messages div:
{pendingQuestion && (
  <div className="border-t border-zinc-700 p-3">
    <div className="text-sm text-yellow-400 mb-2">
      {pendingQuestion.sourceAgent} is asking:
    </div>
    <div className="text-sm text-zinc-300 mb-2">
      {pendingQuestion.content}
    </div>
    <div className="flex gap-2">
      <input
        value={answer}
        onChange={e => setAnswer(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && handleAnswer()}
        className="flex-1 bg-zinc-800 border border-zinc-600 rounded px-2 py-1 text-sm text-zinc-200"
        placeholder="Type your answer..."
        autoFocus
      />
      <button onClick={handleAnswer} className="px-3 py-1 bg-blue-600 rounded text-sm text-white">
        Send
      </button>
    </div>
  </div>
)}
```

**Step 2: Commit**

```bash
git add src/components/messenger/MessengerPanel.tsx
git commit -m "feat(ui): add question/answer input in messenger panel"
```

---

### Task 18: Frontend — DisplayLine Output Styling

**Files:**
- Modify: `src/components/orchestration/MultiAgentOutput.tsx`

**Step 1: Add DisplayLine styles**

```typescript
const DISPLAY_LINE_STYLES: Record<string, string> = {
  AgentThinking: 'text-zinc-500 italic',
  ToolExecution: 'font-mono bg-zinc-900 px-2 py-0.5 text-emerald-400',
  Result: 'text-zinc-200',
  Info: 'text-blue-400',
};
```

**Step 2: Update OutputConsole rendering**

If the `OutputEvent` includes a `display_type` field (from Rust-side parsing), apply the corresponding style class. This requires extending `OutputEvent` to carry `display_type: Option<string>`.

Check if `OutputEvent` in `src/bindings.ts` was updated during binding regeneration (Task 14). If not, extend it in `state.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct OutputEvent {
    pub event: String,
    pub data: String,
    pub display_type: Option<String>,
}
```

Frontend reads `display_type` and applies style:

```tsx
const lineStyle = event.display_type
  ? DISPLAY_LINE_STYLES[event.display_type] || ''
  : '';
```

**Step 3: Commit**

```bash
git add src/components/orchestration/MultiAgentOutput.tsx src-tauri/src/state.rs
git commit -m "feat(ui): render agent output with DisplayLine type styling"
```

---

### Task 19: Frontend — /clear Command

**Files:**
- Modify: `src/components/terminal/ProcessPanel.tsx` (or main input component)

**Step 1: Add /clear detection in prompt handler**

```typescript
import { clearOrchestrationContext } from '../../bindings';

const handleSubmit = async (input: string) => {
  if (input.trim() === '/clear') {
    await handleClear();
    return;
  }
  // ... existing prompt handling
};

const [isClearing, setIsClearing] = useState(false);

const handleClear = async () => {
  const plan = useTaskStore.getState().orchestrationPlan;
  if (!plan?.taskId) return;
  setIsClearing(true);
  try {
    await clearOrchestrationContext(plan.taskId, projectDir);
    useMessengerStore.getState().clearMessages();
    useTaskStore.getState().setOrchestrationPlan(null);
  } catch (err) {
    console.error('Clear failed:', err);
  } finally {
    setIsClearing(false);
  }
};
```

**Step 2: Add clearing state UI**

```tsx
{isClearing && (
  <div className="text-center text-zinc-400 py-2 animate-pulse">
    Backing up context...
  </div>
)}
```

**Step 3: Commit**

```bash
git add src/components/terminal/ProcessPanel.tsx
git commit -m "feat(ui): add /clear command with context backup flow"
```

---

### Task 20: Integration Tests

**Files:**
- Create: `src-tauri/tests/orchestration_integration.rs`

**Step 1: Write integration tests**

```rust
use whalecode::router::orchestrator::*;
use whalecode::adapters::*;

#[test]
fn test_full_plan_lifecycle() {
    let plan = Orchestrator::create_plan("t1", "optimize code", "claude", vec![]);
    assert!(plan.master_process_id.is_none());
    assert!(matches!(plan.phase, OrchestrationPhase::Decomposing));
}

#[test]
fn test_decomposition_parsing() {
    let json = r#"{"tasks":[{"agent":"codex","prompt":"analyze","description":"analyze code"}]}"#;
    let result: DecompositionResult = serde_json::from_str(json).unwrap();
    assert_eq!(result.tasks.len(), 1);
    assert_eq!(result.tasks[0].agent, "codex");
}

#[test]
fn test_ask_user_response_parsing() {
    let json = r#"{"ask_user": "Which database schema?"}"#;
    let resp: AskUserResponse = serde_json::from_str(json).unwrap();
    assert_eq!(resp.ask_user, "Which database schema?");
}

#[test]
fn test_prompt_builders() {
    let q = Orchestrator::build_question_relay_prompt("codex", "Which DB?");
    assert!(q.contains("codex") && q.contains("ask_user"));

    let b = Orchestrator::build_context_backup_prompt();
    assert!(b.contains("context_backup"));

    let r = Orchestrator::build_context_restore_prompt("old", "new");
    assert!(r.contains("old") && r.contains("new"));
}

#[test]
fn test_claude_adapter_extract_result() {
    let adapter = whalecode::adapters::claude::ClaudeAdapter;
    let lines = vec![
        r#"{"type":"result","result":"answer","is_error":false}"#.to_string(),
    ];
    assert!(adapter.extract_result(&lines).is_some());
}
```

**Step 2: Run tests**

Run: `cd src-tauri && cargo test orchestration_integration -- --test-threads=1 2>&1 | tail -20`
Expected: PASS

**Step 3: Commit**

```bash
git add src-tauri/tests/
git commit -m "test: add orchestration integration tests"
```

---

### Task 21: Final Verification

**Step 1: Run full Rust test suite**

Run: `cd src-tauri && cargo test -- --skip credentials --test-threads=1 2>&1 | tail -30`
Expected: All tests PASS

**Step 2: Build frontend**

Run: `npm run build 2>&1 | tail -20`
Expected: Build succeeds

**Step 3: Manual smoke test**

Run: `npm run tauri dev`

Manual checks:
- [ ] Select 2+ agents, pick a master
- [ ] Send a prompt → master decomposes → workers execute
- [ ] Verify uniform output display across agents
- [ ] Test `/clear` → verify context.md created in project dir
- [ ] Send new prompt after clear → verify context restored
- [ ] Check ContextInfoPanel shows per-agent tokens
- [ ] Check MessengerPanel shows orchestration events

**Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address issues from smoke test"
```
