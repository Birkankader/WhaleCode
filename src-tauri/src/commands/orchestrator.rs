use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager};
use log::debug;

use crate::adapters::{AskUserResponse, ToolAdapter};
use crate::context::store::ContextStore;
use crate::ipc::events::OutputEvent;
use crate::messenger::models::{MessengerMessage, MessageType};
use crate::process;
use crate::router::dag::{DagNode, topological_waves};
use crate::router::orchestrator::{
    AgentContextInfo, DecompositionResult, Orchestrator, OrchestratorConfig,
    OrchestrationPlan, OrchestrationPhase, PendingQuestion, WorkerResult,
};
use crate::router::retry::{RetryConfig, should_retry, retry_delay_ms, select_fallback_agent};
use crate::state::{AppState, ProcessStatus};
use tokio::time::{timeout, Duration};

// Timeout defaults (overridden by AppConfig at runtime)
const MASTER_TIMEOUT_MS: u64 = 600_000; // 10 minutes
const WORKER_TIMEOUT_MS: u64 = 300_000; // 5 minutes

// ---------------------------------------------------------------------------
// Structured orchestrator events
// ---------------------------------------------------------------------------

/// Sends a structured JSON event through the channel.
/// Events are prefixed with `@@orch::` so the frontend can distinguish
/// them from regular NDJSON process output.
fn emit_orch(channel: &Channel<OutputEvent>, event_type: &str, data: serde_json::Value) {
    let mut obj = match data {
        serde_json::Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };
    obj.insert("type".to_string(), serde_json::Value::String(event_type.to_string()));
    let json = serde_json::to_string(&serde_json::Value::Object(obj)).unwrap_or_default();
    if let Err(e) = channel.send(OutputEvent::Stdout(format!("@@orch::{}", json))) {
        log::warn!("emit_orch send failed: {}", e);
    }
}

// ---------------------------------------------------------------------------
// Helper: get adapter by agent name
// ---------------------------------------------------------------------------

fn get_adapter(agent_name: &str) -> Result<Box<dyn ToolAdapter + Send>, String> {
    match agent_name {
        "claude" => Ok(Box::new(crate::adapters::claude::ClaudeAdapter)),
        "gemini" => Ok(Box::new(crate::adapters::gemini::GeminiAdapter)),
        "codex" => Ok(Box::new(crate::adapters::codex::CodexAdapter)),
        _ => Err(format!("Unknown agent: {}", agent_name)),
    }
}

// ---------------------------------------------------------------------------
// Helper: get API key for an agent
// ---------------------------------------------------------------------------

fn get_api_key(agent_name: &str) -> Result<String, String> {
    match agent_name {
        "claude" => crate::credentials::keychain::get_api_key(),
        "gemini" => crate::credentials::gemini_keychain::get_gemini_api_key(),
        "codex" => crate::credentials::codex_keychain::get_codex_api_key(),
        _ => Err(format!("No credential provider for agent: {}", agent_name)),
    }
}

// ---------------------------------------------------------------------------
// Helper: wait for an interactive agent's turn to complete
// ---------------------------------------------------------------------------

/// Waits for an interactive agent's turn to complete using watch channels
/// (no polling). Checks each new line with `adapter.is_turn_complete()`.
/// Returns all output lines accumulated so far.
///
/// Exits early if the process dies or completes (EOF).
async fn wait_for_turn_complete(
    state: &AppState,
    task_id: &str,
    adapter: &dyn ToolAdapter,
) -> Result<Vec<String>, String> {
    // Clone receivers while holding lock, then drop lock
    let (mut line_rx, mut completion_rx) = {
        let s = state.lock();
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
                    let s = state.lock();
                    if let Some(entry) = s.processes.get(task_id) {
                        return Ok(entry.output_lines.clone());
                    }
                    return Ok(vec![]);
                }
            }
        }

        // Check new lines for turn completion
        let (current_lines, status) = {
            let s = state.lock();
            let entry = s.processes.get(task_id)
                .ok_or_else(|| format!("Process {} not found", task_id))?;
            // Only clone if there are new lines to check
            if entry.output_lines.len() > lines_seen {
                (entry.output_lines[lines_seen..].to_vec(), entry.status.clone())
            } else {
                continue;
            }
        };

        for line in &current_lines {
            if adapter.is_turn_complete(line) {
                // Return full output — re-read all lines from state
                let s = state.lock();
                if let Some(entry) = s.processes.get(task_id) {
                    return Ok(entry.output_lines.clone());
                }
                return Ok(vec![]);
            }
        }
        lines_seen += current_lines.len();

        match status {
            ProcessStatus::Failed(ref e) => return Err(format!("Process died: {}", e)),
            ProcessStatus::Completed(_) => {
                let s = state.lock();
                if let Some(entry) = s.processes.get(task_id) {
                    return Ok(entry.output_lines.clone());
                }
                return Ok(vec![]);
            }
            _ => {}
        }
    }

    // Channel closed — check final state
    let s = state.lock();
    if let Some(entry) = s.processes.get(task_id) {
        Ok(entry.output_lines.clone())
    } else {
        Ok(vec![])
    }
}

// ---------------------------------------------------------------------------
// Helper: wait for a process to complete (watch channel based, no polling)
// ---------------------------------------------------------------------------

// Planned for future use: watch-channel-based process completion without polling.
#[allow(dead_code)]
async fn wait_for_process_completion(
    task_id: &str,
    state: &AppState,
) -> i32 {
    // Clone the watch receiver while holding the lock, then drop the lock before awaiting
    let mut rx = {
        let inner = state.lock();
        match inner.processes.get(task_id) {
            Some(entry) => {
                match &entry.status {
                    ProcessStatus::Completed(code) => return *code,
                    ProcessStatus::Failed(_) => return -1,
                    _ => entry.completion_rx.clone(),
                }
            }
            None => return -1,
        }
    };

    // Await completion signal (lock is dropped, no polling)
    while !*rx.borrow() {
        if rx.changed().await.is_err() {
            return -1; // Sender dropped without signaling
        }
    }

    // Re-check final status
    let inner = state.lock();
    match inner.processes.get(task_id) {
        Some(entry) => match &entry.status {
            ProcessStatus::Completed(code) => *code,
            _ => -1,
        },
        None => -1,
    }
}

// ---------------------------------------------------------------------------
// Helper: parse decomposition JSON from agent output
// ---------------------------------------------------------------------------

/// Extract `DecompositionResult` from the agent's collected output lines.
/// Tries the adapter's `extract_result()` first, then falls back to scanning
/// output for JSON.
fn parse_decomposition_from_output(
    output_lines: &[String],
    adapter: &dyn ToolAdapter,
) -> Option<DecompositionResult> {
    debug!("[orchestrator] parse_decomposition: {} output lines to parse", output_lines.len());

    // Strategy A: Try adapter's extract_result first (looks for "result" event)
    if let Some(result_text) = adapter.extract_result(output_lines) {
        debug!("[orchestrator] adapter.extract_result returned {} chars", result_text.len());
        if let Some(decomp) = parse_decomposition_json(&result_text) {
            return Some(normalize_decomposition_agents(decomp));
        }
    }

    // Strategy B: Extract text content from NDJSON message/result events
    // Claude returns decomposition JSON inside message content blocks or result text
    let mut extracted_texts: Vec<String> = Vec::new();
    let mut extracted_bytes: usize = 0;
    const MAX_EXTRACTED_BYTES: usize = 1_048_576; // 1MB safety limit
    for line in output_lines {
        if extracted_bytes > MAX_EXTRACTED_BYTES {
            log::warn!("[orchestrator] Strategy B: extracted text exceeded 1MB limit, stopping accumulation");
            break;
        }
        let trimmed = line.trim();
        if !trimmed.starts_with('{') { continue; }
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(trimmed) {
            let event_type = parsed.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match event_type {
                "message" | "assistant" => {
                    // Extract text from content blocks
                    if let Some(content) = parsed.get("content") {
                        if let Some(arr) = content.as_array() {
                            for block in arr {
                                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                    extracted_bytes += text.len();
                                    extracted_texts.push(text.to_string());
                                }
                            }
                        } else if let Some(text) = content.as_str() {
                            extracted_bytes += text.len();
                            extracted_texts.push(text.to_string());
                        }
                    }
                }
                "result" => {
                    if let Some(result) = parsed.get("result").and_then(|r| r.as_str()) {
                        extracted_bytes += result.len();
                        extracted_texts.push(result.to_string());
                    }
                    if let Some(response) = parsed.get("response").and_then(|r| r.as_str()) {
                        extracted_bytes += response.len();
                        extracted_texts.push(response.to_string());
                    }
                }
                _ => {}
            }
        }
    }

    // Try parsing extracted texts (most likely to contain the JSON)
    if !extracted_texts.is_empty() {
        let combined_text = extracted_texts.join("\n");
        debug!("[orchestrator] extracted {} text segments, {} total chars", extracted_texts.len(), combined_text.len());
        if let Some(decomp) = parse_decomposition_json(&combined_text) {
            debug!("[orchestrator] parse from extracted text succeeded");
            return Some(normalize_decomposition_agents(decomp));
        }
        // Also try each segment individually
        for text in &extracted_texts {
            if let Some(decomp) = parse_decomposition_json(text) {
                debug!("[orchestrator] parse from individual segment succeeded");
                return Some(normalize_decomposition_agents(decomp));
            }
        }
    }

    // Strategy C: Fall back to scanning raw output lines
    let combined = output_lines.join("\n");
    debug!("[orchestrator] falling back to raw combined output: {} chars", combined.len());
    let result = parse_decomposition_json(&combined);

    // Normalize agent names in the decomposition result
    result.map(normalize_decomposition_agents)
}

/// Normalize agent names in a decomposition result.
/// Maps common LLM hallucinations and variations to valid agent names:
/// - "claude code", "claude-code", "Claude" → "claude"
/// - "gemini cli", "gemini-cli", "Gemini" → "gemini"
/// - "codex cli", "codex-cli", "Codex", "openai" → "codex"
/// - "<agent_name>", "agent_name", unknown → falls back to "claude"
fn normalize_agent_name(name: &str) -> String {
    let lower = name.trim().to_lowercase();

    // Strip angle brackets (LLM placeholder artifacts like "<agent_name>")
    let cleaned = lower.trim_matches(|c| c == '<' || c == '>').trim().to_string();

    if cleaned == "claude" || cleaned == "claude code" || cleaned == "claude-code" || cleaned == "claude_code" {
        return "claude".to_string();
    }
    if cleaned == "gemini" || cleaned == "gemini cli" || cleaned == "gemini-cli" || cleaned == "gemini_cli" {
        return "gemini".to_string();
    }
    if cleaned == "codex" || cleaned == "codex cli" || cleaned == "codex-cli" || cleaned == "codex_cli" || cleaned == "openai" {
        return "codex".to_string();
    }

    // If it's a placeholder or unknown, default to claude
    log::warn!("[orchestrator] Unknown agent name '{}', defaulting to 'claude'", name);
    "claude".to_string()
}

/// Normalize all agent names in a DecompositionResult to valid tool names.
fn normalize_decomposition_agents(mut result: DecompositionResult) -> DecompositionResult {
    for task in &mut result.tasks {
        task.agent = normalize_agent_name(&task.agent);
    }
    result
}

/// Parse the master agent's decomposition JSON output.
/// Tries multiple strategies to extract a JSON object from the output,
/// handling markdown fences, natural language wrapping, and alternative key names.
///
/// Strategies (in order):
/// 1. Direct parse of the entire output
/// 2. Extract from markdown code fences (```json ... ```)
/// 3. Extract from first `{` to last `}`
/// 4. Scan for `"tasks"` key and extract the enclosing object
/// 5. Find any JSON array `[{...}]` and wrap as `{"tasks": [...]}`
///
/// Also handles alternative key names: `sub_tasks`, `subtasks` -> `tasks`.
fn parse_decomposition_json(output: &str) -> Option<DecompositionResult> {
    let trimmed = output.trim();

    // Strategy 1: Direct parse
    if let Some(result) = try_parse_decomposition(trimmed) {
        debug!("[orchestrator] parse_decomposition_json: Strategy 1 (direct) succeeded");
        return Some(result);
    }
    debug!("[orchestrator] parse_decomposition_json: Strategy 1 (direct) failed");

    // Strategy 2: Extract from markdown code fences
    if let Some(start) = output.find("```json") {
        let after_fence = &output[start + 7..];
        let json_str = if let Some(end) = after_fence.find("```") {
            &after_fence[..end]
        } else {
            after_fence
        };
        if let Some(result) = try_parse_decomposition(json_str.trim()) {
            debug!("[orchestrator] parse_decomposition_json: Strategy 2 (markdown fence) succeeded");
            return Some(result);
        }
        debug!("[orchestrator] parse_decomposition_json: Strategy 2 (markdown fence) failed");
    } else if let Some(start) = output.find("```") {
        // Try plain ``` fence (no json tag)
        let after_fence = &output[start + 3..];
        if let Some(end) = after_fence.find("```") {
            let json_str = &after_fence[..end];
            if let Some(result) = try_parse_decomposition(json_str.trim()) {
                debug!("[orchestrator] parse_decomposition_json: Strategy 2 (plain fence) succeeded");
                return Some(result);
            }
        }
        debug!("[orchestrator] parse_decomposition_json: Strategy 2 (plain fence) failed");
    }

    // Strategy 3: First `{` to last `}`
    if let (Some(start), Some(end)) = (output.find('{'), output.rfind('}')) {
        if start < end {
            let json_str = &output[start..=end];
            if let Some(result) = try_parse_decomposition(json_str.trim()) {
                debug!("[orchestrator] parse_decomposition_json: Strategy 3 (braces) succeeded");
                return Some(result);
            }
            debug!("[orchestrator] parse_decomposition_json: Strategy 3 (braces) failed");
        }
    }

    // Strategy 4: Scan for `"tasks"` key and extract the enclosing object
    // This handles cases where the JSON is deeply embedded in natural language
    if let Some(result) = extract_tasks_key_object(output) {
        debug!("[orchestrator] parse_decomposition_json: Strategy 4 (tasks key scan) succeeded");
        return Some(result);
    }
    debug!("[orchestrator] parse_decomposition_json: Strategy 4 (tasks key scan) failed");

    // Strategy 5: Find any JSON array `[{...}]` and wrap as `{"tasks": [...]}`
    if let Some(result) = extract_json_array_as_tasks(output) {
        debug!("[orchestrator] parse_decomposition_json: Strategy 5 (array wrap) succeeded");
        return Some(result);
    }
    debug!("[orchestrator] parse_decomposition_json: Strategy 5 (array wrap) failed — all strategies exhausted");

    None
}

/// Try to parse a JSON string as DecompositionResult, handling alternative key names.
/// Maps `sub_tasks` and `subtasks` to `tasks` before parsing.
fn try_parse_decomposition(json_str: &str) -> Option<DecompositionResult> {
    // Try direct parse first
    if let Ok(result) = serde_json::from_str::<DecompositionResult>(json_str) {
        if !result.tasks.is_empty() {
            return Some(result);
        }
    }

    // Try parsing as generic JSON and mapping alternative key names
    if let Ok(mut obj) = serde_json::from_str::<serde_json::Value>(json_str) {
        if let Some(map) = obj.as_object_mut() {
            // Map sub_tasks -> tasks
            if map.contains_key("sub_tasks") && !map.contains_key("tasks") {
                if let Some(val) = map.remove("sub_tasks") {
                    map.insert("tasks".to_string(), val);
                }
            }
            // Map subtasks -> tasks
            if map.contains_key("subtasks") && !map.contains_key("tasks") {
                if let Some(val) = map.remove("subtasks") {
                    map.insert("tasks".to_string(), val);
                }
            }

            if let Ok(result) = serde_json::from_value::<DecompositionResult>(obj) {
                if !result.tasks.is_empty() {
                    return Some(result);
                }
            }
        }
    }

    None
}

/// Strategy 4: Find `"tasks"` (or alternative keys) in the output and extract
/// the enclosing JSON object by bracket-matching from the preceding `{`.
fn extract_tasks_key_object(output: &str) -> Option<DecompositionResult> {
    for key in &["\"tasks\"", "\"sub_tasks\"", "\"subtasks\""] {
        if let Some(key_pos) = output.find(key) {
            // Walk backwards from the key to find the opening `{`
            let before = &output[..key_pos];
            if let Some(obj_start) = before.rfind('{') {
                // Walk forward from key to find the matching `}` using bracket counting
                let from_start = &output[obj_start..];
                if let Some(obj_end) = find_matching_brace(from_start) {
                    let json_str = &from_start[..=obj_end];
                    if let Some(result) = try_parse_decomposition(json_str.trim()) {
                        return Some(result);
                    }
                }
            }
        }
    }
    None
}

/// Strategy 5: Find a JSON array `[{...}]` in the output and wrap it as `{"tasks": [...]}`.
fn extract_json_array_as_tasks(output: &str) -> Option<DecompositionResult> {
    // Find the first `[{` pattern
    let arr_start = output.find("[{")?;
    let from_start = &output[arr_start..];

    // Find the matching `]` using bracket counting
    let arr_end = find_matching_bracket(from_start)?;
    let arr_str = &from_start[..=arr_end];

    // Verify it parses as a JSON array
    if let Ok(arr) = serde_json::from_str::<serde_json::Value>(arr_str) {
        if arr.is_array() {
            let wrapped = serde_json::json!({"tasks": arr});
            if let Ok(result) = serde_json::from_value::<DecompositionResult>(wrapped) {
                if !result.tasks.is_empty() {
                    return Some(result);
                }
            }
        }
    }

    None
}

/// Find the index of the closing `}` that matches the opening `{` at position 0.
fn find_matching_brace(s: &str) -> Option<usize> {
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escape_next = false;

    for (i, ch) in s.char_indices() {
        if escape_next {
            escape_next = false;
            continue;
        }
        if ch == '\\' && in_string {
            escape_next = true;
            continue;
        }
        if ch == '"' {
            in_string = !in_string;
            continue;
        }
        if in_string {
            continue;
        }
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

/// Find the index of the closing `]` that matches the opening `[` at position 0.
fn find_matching_bracket(s: &str) -> Option<usize> {
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escape_next = false;

    for (i, ch) in s.char_indices() {
        if escape_next {
            escape_next = false;
            continue;
        }
        if ch == '\\' && in_string {
            escape_next = true;
            continue;
        }
        if ch == '"' {
            in_string = !in_string;
            continue;
        }
        if in_string {
            continue;
        }
        match ch {
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Helper: kill a process using its pgid (does not require tauri::State)
// ---------------------------------------------------------------------------

/// Kill a process and remove it from state. Delegates to manager::kill_and_remove.
async fn kill_process(state: &AppState, task_id: &str) -> Result<(), String> {
    process::manager::kill_and_remove(task_id, state).await
}

// ---------------------------------------------------------------------------
// Shared helpers (kept from original)
// ---------------------------------------------------------------------------

/// Infer a broad task category from the prompt for performance tracking.
fn infer_task_type(prompt: &str) -> String {
    let lower = prompt.to_lowercase();
    if lower.contains("refactor") || lower.contains("redesign") {
        "refactor".to_string()
    } else if lower.contains("analyze") || lower.contains("review") || lower.contains("read") {
        "analyze".to_string()
    } else if lower.contains("generate") || lower.contains("scaffold") || lower.contains("create") {
        "generate".to_string()
    } else if lower.contains("fix") || lower.contains("bug") || lower.contains("debug") {
        "fix".to_string()
    } else if lower.contains("test") {
        "test".to_string()
    } else {
        "general".to_string()
    }
}

fn emit_messenger(app_handle: &AppHandle, message: MessengerMessage) {
    let _ = app_handle.emit("messenger-event", &message);
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    match s.char_indices().nth(max) {
        Some((idx, _)) => format!("{}...", &s[..idx]),
        None => s.to_string(),
    }
}

// Re-export from utils for backward compatibility
pub(crate) use crate::utils::truncate_str;

fn update_plan_phase(
    state: &AppState,
    plan_id: &str,
    phase: OrchestrationPhase,
) -> Result<(), String> {
    let mut inner = state.lock();
    if let Some(plan) = inner.orchestration_plans.get_mut(plan_id) {
        plan.phase = phase;
    }
    Ok(())
}

/// Get the last N lines of a process's output as a summary string.
fn get_process_output_summary(task_id: &str, state: &AppState) -> String {
    let inner = state.lock();
    if let Some(entry) = inner.processes.get(task_id) {
        let lines = &entry.output_lines;
        // Take last 40 lines to capture more error context
        let start = lines.len().saturating_sub(40);
        lines[start..].join("\n")
    } else {
        String::new()
    }
}

/// Detect authentication or API key errors from agent output lines.
fn detect_auth_error(output_lines: &[String], agent_name: &str) -> Option<String> {
    for line in output_lines {
        if line.contains("authentication_failed")
            || line.contains("Not logged in")
            || line.contains("Please run /login")
        {
            return Some(format!(
                "{} is not logged in. Please run '{} /login' in your terminal first.",
                agent_name, agent_name
            ));
        }
        if line.contains("Invalid API key")
            || line.contains("invalid_api_key")
            || line.contains("HTTP 401")
            || line.contains("status: 401")
            || line.contains("\"401\"")
            || line.contains("status_code: 401")
        {
            return Some(format!(
                "{} API key is invalid. Check Settings to update it.",
                agent_name
            ));
        }
    }
    None
}

// ===========================================================================
// Main orchestration command
// ===========================================================================

/// Dispatch an orchestrated multi-agent task using interactive master process.
///
/// Phase 1 (Decompose): Master agent spawned in interactive mode, receives
///   decompose prompt, returns JSON sub-task assignments.
/// Phase 2 (Execute): Each sub-task dispatched to assigned agent. Worker
///   questions are routed to the master for resolution.
/// Phase 3 (Review): Master (same process) reviews all worker results.
///   Master stays alive after completion for follow-up interactions.
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
    // Get a reference to the inner AppState (Arc<Mutex<_>>) for use with
    // spawn_interactive / send_to_process which accept &AppState, not tauri::State.
    let state_ref: &AppState = &state;

    // Load config for timeouts/retries
    let app_config = {
        let app_data_dir = app_handle.path().app_data_dir()
            .unwrap_or_else(|_| std::path::PathBuf::from("."));
        crate::config::AppConfig::load(&app_data_dir)
    };
    let master_timeout = Duration::from_secs(app_config.master_timeout_minutes as u64 * 60);
    let worker_timeout = Duration::from_secs(app_config.worker_timeout_minutes as u64 * 60);
    let cleanup_delay = Duration::from_secs(app_config.plan_cleanup_delay_secs as u64);

    let mut plan = Orchestrator::create_plan(&prompt, &config);

    // Store plan
    {
        let mut inner = state_ref.lock();
        inner.orchestration_plans.insert(plan.task_id.clone(), plan.clone());
    }

    // Emit messenger: orchestration started
    emit_messenger(&app_handle, MessengerMessage::system(
        &plan.task_id,
        format!("Orchestration started: \"{}\"", truncate(&prompt, 80)),
        MessageType::OrchestrationStarted,
    ));

    // === Phase 1: Decompose (master agent) ===
    emit_orch(&on_event, "phase_changed", serde_json::json!({
        "phase": "decomposing", "detail": "Spawning master agent",
        "plan_id": plan.task_id, "master_agent": config.master_agent
    }));

    let adapter = get_adapter(&config.master_agent)?;
    // API key is optional — CLIs like Claude Code use their own OAuth auth.
    // build_env() already handles empty keys by simply not setting the env var.
    let api_key = get_api_key(&config.master_agent).unwrap_or_default();

    // Check for context.md in project_dir for context restore
    let context_md_path = std::path::Path::new(&project_dir).join("context.md");
    let decompose_prompt = {
        let base_prompt = Orchestrator::build_decompose_prompt(&prompt, &config.agents);
        if context_md_path.exists() {
            let context_content = tokio::fs::read_to_string(&context_md_path)
                .await
                .map_err(|e| format!("Failed to read context.md: {}", e))?;
            let _ = tokio::fs::remove_file(&context_md_path).await;

            emit_messenger(&app_handle, MessengerMessage::system(
                &plan.task_id,
                "Restoring context from previous session".to_string(),
                MessageType::ContextRestore,
            ));

            Orchestrator::build_context_restore_prompt(&context_content, &base_prompt)
        } else {
            base_prompt
        }
    };

    // Reserve tool slot for master agent before spawning
    process::manager::acquire_tool_slot(state_ref, &config.master_agent)?;

    emit_orch(&on_event, "phase_changed", serde_json::json!({
        "phase": "decomposing", "detail": "Decomposing task via master agent",
        "plan_id": plan.task_id, "master_agent": config.master_agent
    }));

    // Phase 1 ALWAYS uses single-shot mode (-p flag) for decomposition.
    // This ensures Claude returns one response and exits, rather than
    // starting tool calls and running indefinitely.
    // Interactive mode is only used in Phase 2 (worker question routing)
    // and Phase 3 (review).
    let use_interactive = false; // Decomposition is always single-shot

    let master_task_id = {
        let tool_command = adapter.build_command(&decompose_prompt, &project_dir, &api_key);
        let task_id = process::manager::spawn_interactive(
            tool_command,
            &format!("Orchestration master: {}", truncate(&prompt, 60)),
            &config.master_agent,
            on_event.clone(),
            state_ref,
        ).await.map_err(|e| {
            process::manager::release_tool_slot(state_ref, &config.master_agent);
            e
        })?;
        task_id
    };

    // Release reservation after successful spawn (process now tracked in state)
    process::manager::release_tool_slot(state_ref, &config.master_agent);

    // Store master_process_id in plan
    plan.master_process_id = Some(master_task_id.clone());
    {
        let mut inner = state_ref.lock();
        if let Some(p) = inner.orchestration_plans.get_mut(&plan.task_id) {
            p.master_process_id = Some(master_task_id.clone());
        }
    }

    // Wait for master's turn to complete (detects result event or process exit)
    let output_lines = match timeout(
        master_timeout,
        wait_for_turn_complete(state_ref, &master_task_id, adapter.as_ref()),
    ).await {
        Ok(Ok(lines)) => lines,
        Ok(Err(e)) => {
            let _ = kill_process(state_ref, &master_task_id).await;
            emit_orch(&on_event, "decomposition_failed", serde_json::json!({
                "error": format!("Master agent process error: {}", e)
            }));
            return Err(e);
        }
        Err(_) => {
            let _ = kill_process(state_ref, &master_task_id).await;
            emit_orch(&on_event, "master_timeout", serde_json::json!({
                "timeout_minutes": app_config.master_timeout_minutes
            }));
            emit_orch(&on_event, "decomposition_failed", serde_json::json!({
                "error": "Master agent timed out during task decomposition"
            }));
            return Err("Master agent timed out".to_string());
        }
    };

    // Check for authentication errors before attempting to parse
    if let Some(auth_error) = detect_auth_error(&output_lines, &config.master_agent) {
        let _ = kill_process(state_ref, &master_task_id).await;
        emit_orch(&on_event, "decomposition_failed", serde_json::json!({
            "error": auth_error.clone()
        }));
        return Err(auth_error);
    }

    // Extract and parse decomposition result (with retry on failure)
    let (decomposition, is_decomposition_fallback) = match parse_decomposition_from_output(&output_lines, adapter.as_ref()) {
        Some(result) => {
            emit_messenger(&app_handle, MessengerMessage::agent(
                &plan.task_id,
                &config.master_agent,
                format!("Decomposed into {} sub-tasks:\n{}",
                    result.tasks.len(),
                    result.tasks.iter()
                        .map(|t| format!("  - {} -> {}", t.agent, t.description))
                        .collect::<Vec<_>>().join("\n")
                ),
                MessageType::DecompositionResult,
            ));
            (result, false)
        }
        None => {
            // --- Retry ONCE with a clarifying follow-up prompt ---
            debug!("[orchestrator] Decomposition parse failed on first attempt, retrying...");
            emit_orch(&on_event, "info", serde_json::json!({
                "message": "First decomposition attempt was not valid JSON. Retrying with clarification..."
            }));

            // Note: interactive retry removed — master uses single-shot mode
            let retry_result = {
                // Re-spawn with an explicit combined prompt
                let _ = kill_process(state_ref, &master_task_id).await;

                let combined_prompt = format!(
                    "{}\n\nIMPORTANT: You MUST respond with ONLY a JSON object. No explanations, no markdown. Just the JSON: {{\"tasks\": [{{\"agent\": \"<name>\", \"prompt\": \"...\", \"description\": \"...\"}}]}}",
                    decompose_prompt
                );
                let retry_cmd = adapter.build_command(&combined_prompt, &project_dir, &api_key);
                if let Ok(retry_task_id) = process::manager::spawn_interactive(
                    retry_cmd,
                    &format!("Decomposition retry: {}", truncate(&prompt, 60)),
                    &config.master_agent,
                    on_event.clone(),
                    state_ref,
                ).await {
                    // Update master_task_id in plan
                    plan.master_process_id = Some(retry_task_id.clone());
                    {
                        let mut inner = state_ref.lock();
                        if let Some(p) = inner.orchestration_plans.get_mut(&plan.task_id) {
                            p.master_process_id = Some(retry_task_id.clone());
                        }
                    }

                    match timeout(
                        master_timeout,
                        wait_for_turn_complete(state_ref, &retry_task_id, adapter.as_ref()),
                    ).await {
                        Ok(Ok(retry_lines)) => {
                            parse_decomposition_from_output(&retry_lines, adapter.as_ref())
                        }
                        _ => {
                            let _ = kill_process(state_ref, &retry_task_id).await;
                            None
                        }
                    }
                } else {
                    None
                }
            };

            match retry_result {
                Some(result) => {
                    debug!("[orchestrator] Decomposition retry succeeded");
                    emit_messenger(&app_handle, MessengerMessage::agent(
                        &plan.task_id,
                        &config.master_agent,
                        format!("Decomposed into {} sub-tasks (on retry):\n{}",
                            result.tasks.len(),
                            result.tasks.iter()
                                .map(|t| format!("  - {} -> {}", t.agent, t.description))
                                .collect::<Vec<_>>().join("\n")
                        ),
                        MessageType::DecompositionResult,
                    ));
                    (result, false)
                }
                None => {
                    debug!("[orchestrator] Decomposition retry also failed — falling back to single-task mode");

                    emit_orch(&on_event, "decomposition_failed", serde_json::json!({
                        "error": "Could not parse decomposition from agent output. Falling back to running the original prompt as a single task."
                    }));

                    // Instead of failing completely, create a single task with the original prompt
                    // assigned to the master agent. This handles simple/conversational prompts gracefully.
                    let fallback_decomposition = DecompositionResult {
                        tasks: vec![crate::router::orchestrator::SubTaskDef {
                            id: None,
                            agent: config.master_agent.clone(),
                            prompt: prompt.clone(),
                            description: if prompt.len() > 60 { format!("{}...", truncate_str(&prompt, 57)) } else { prompt.clone() },
                            depends_on: vec![],
                        }],
                    };

                    emit_orch(&on_event, "info", serde_json::json!({
                        "message": "Fallback: running original prompt as single task"
                    }));

                    // Kill the old master process before proceeding
                    let current_master = plan.master_process_id.as_deref().unwrap_or(&master_task_id);
                    let _ = kill_process(state_ref, current_master).await;

                    (fallback_decomposition, true)
                }
            }
        }
    };

    // After retry, master_task_id may have changed — re-read from plan
    let master_task_id = plan.master_process_id.clone().unwrap_or(master_task_id);

    // Store decomposition and enter approval phase
    plan.decomposition = Some(decomposition.clone());
    plan.phase = OrchestrationPhase::AwaitingApproval;

    // Send task_assigned events so frontend can show the approval screen
    // Check if all tasks have LLM-provided IDs (same logic as DAG construction)
    let all_have_ids = decomposition.tasks.iter().all(|def| def.id.is_some());

    for (i, sub_def) in decomposition.tasks.iter().enumerate() {
        let dag_id = if all_have_ids {
            sub_def.id.clone().unwrap_or_else(|| format!("t{}", i + 1))
        } else {
            format!("t{}", i + 1)
        };
        emit_orch(&on_event, "task_assigned", serde_json::json!({
            "agent": sub_def.agent,
            "description": sub_def.description,
            "prompt": sub_def.prompt,
            "depends_on": sub_def.depends_on,
            "dag_id": dag_id
        }));
    }

    // Only auto-approve when this is a TRUE decomposition fallback (decomposition
    // failed twice and we fell back to running the original prompt as-is).
    // When the LLM genuinely returns 1 task, still show it for approval.
    if is_decomposition_fallback {
        // Skip approval — auto-approve the fallback single task
        plan.phase = OrchestrationPhase::Executing;
        {
            let mut inner = state_ref.lock();
            if let Some(p) = inner.orchestration_plans.get_mut(&plan.task_id) {
                p.decomposition = plan.decomposition.clone();
                p.phase = OrchestrationPhase::Executing;
            }
        }
        emit_orch(&on_event, "phase_changed", serde_json::json!({
            "phase": "executing",
            "detail": "Fallback single task — auto-executing",
            "task_count": 1,
            "wave_count": 1
        }));
    } else {
    // Multi-task (or genuine single-task from LLM): require approval
    let mut approval_rx = {
        let mut inner = state_ref.lock();
        if let Some(p) = inner.orchestration_plans.get_mut(&plan.task_id) {
            p.decomposition = plan.decomposition.clone();
            p.phase = OrchestrationPhase::AwaitingApproval;
        }
        // Create watch channel for approval signaling (replaces polling)
        let (tx, rx) = tokio::sync::watch::channel(false);
        inner.approval_signals.insert(plan.task_id.clone(), tx);
        rx
    };

    // Emit awaiting_approval event
    emit_orch(&on_event, "phase_changed", serde_json::json!({
        "phase": "awaiting_approval",
        "detail": format!("{} sub-task(s) ready for review", decomposition.tasks.len()),
        "task_count": decomposition.tasks.len()
    }));

    // Wait for user approval (watch-channel based, no polling)
    loop {
        // Wait for signal from approve_orchestration command
        if approval_rx.changed().await.is_err() {
            // Sender dropped — plan was removed
            state_ref.lock().approval_signals.remove(&plan.task_id);
            let _ = kill_process(state_ref, &master_task_id).await;
            return Err("Orchestration cancelled during approval".to_string());
        }

        let phase = {
            let inner = state_ref.lock();
            inner.orchestration_plans.get(&plan.task_id)
                .map(|p| p.phase.clone())
        };
        match phase {
            Some(OrchestrationPhase::Executing) => break,
            Some(OrchestrationPhase::Failed) | None => {
                state_ref.lock().approval_signals.remove(&plan.task_id);
                let _ = kill_process(state_ref, &master_task_id).await;
                return Err("Orchestration cancelled during approval".to_string());
            }
            _ => {} // Keep waiting (shouldn't happen, but be safe)
        }
    }

    // Clean up approval signal
    {
        let mut inner = state_ref.lock();
        inner.approval_signals.remove(&plan.task_id);
    }
    } // end of approval block

    // Re-read decomposition in case user modified it during approval
    let decomposition = {
        let inner = state_ref.lock();
        inner.orchestration_plans.get(&plan.task_id)
            .and_then(|p| p.decomposition.clone())
            .ok_or_else(|| "Decomposition lost during approval".to_string())?
    };
    plan.decomposition = Some(decomposition.clone());
    plan.phase = OrchestrationPhase::Executing;

    // === Phase 2: Execute (workers with question routing) ===

    // For non-interactive (single-shot) masters, the master process has already
    // exited after Phase 1. Clean it up so its tool slot is free for workers.
    // Interactive masters (Claude) stay alive for question routing.
    if !use_interactive {
        let _ = kill_process(state_ref, &master_task_id).await;
    }

    // Build sub-tasks from decomposition. Task assignment messages were already
    // sent during approval phase, so we only build internal state here.
    plan.sub_tasks.clear();
    let mut task_channels: Vec<(String, String, String)> = Vec::new(); // (sub_task_id, agent, prompt)

    for sub_def in &decomposition.tasks {
        let sub_task_id = uuid::Uuid::new_v4().to_string();

        plan.sub_tasks.push(crate::router::orchestrator::SubTask {
            id: sub_task_id.clone(),
            prompt: sub_def.prompt.clone(),
            assigned_agent: sub_def.agent.clone(),
            status: "pending".to_string(),
            parent_task_id: plan.task_id.clone(),
            depends_on: sub_def.depends_on.clone(),
        });

        task_channels.push((sub_task_id, sub_def.agent.clone(), sub_def.prompt.clone()));
    }

    // Build DAG from decomposition tasks.
    // Use LLM-provided IDs when ALL tasks have them; fall back to index-based
    // "t1, t2..." when any task is missing an ID (avoids partial-ID chaos).
    let all_have_ids = decomposition.tasks.iter().all(|def| def.id.is_some());
    let dag_nodes: Vec<DagNode> = decomposition.tasks.iter().enumerate().map(|(i, def)| {
        DagNode {
            id: if all_have_ids {
                def.id.clone().unwrap_or_else(|| format!("t{}", i + 1))
            } else {
                format!("t{}", i + 1)
            },
            depends_on: def.depends_on.clone(),
        }
    }).collect();

    // Build a map from dag_id (t1, t2...) to task_channels index
    let dag_id_to_idx: std::collections::HashMap<String, usize> = dag_nodes.iter().enumerate()
        .map(|(i, n)| (n.id.clone(), i))
        .collect();

    let waves = match topological_waves(&dag_nodes) {
        Ok(w) => w,
        Err(e) => {
            // DAG error — fall back to single wave (all tasks in parallel)
            emit_orch(&on_event, "info", serde_json::json!({
                "message": format!("DAG warning: {}. Running all tasks in one wave.", e)
            }));
            vec![dag_nodes.iter().map(|n| n.id.clone()).collect()]
        }
    };

    // Now send Phase 2 message — frontend handler transitions pending tasks to running
    emit_orch(&on_event, "phase_changed", serde_json::json!({
        "phase": "executing",
        "detail": format!("{} sub-tasks in {} wave(s)", decomposition.tasks.len(), waves.len()),
        "task_count": decomposition.tasks.len(),
        "wave_count": waves.len()
    }));

    let mut worker_task_ids: Vec<(String, String)> = Vec::new(); // (process_task_id, agent)
    let mut failed_dag_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

    for (wave_idx, wave_ids) in waves.iter().enumerate() {
        emit_orch(&on_event, "wave_progress", serde_json::json!({
            "current": wave_idx + 1,
            "total": waves.len(),
            "task_count": wave_ids.len()
        }));

        let mut wave_task_ids: Vec<(String, String, String)> = Vec::new(); // (process_task_id, agent, dag_id)

        // Dispatch tasks in this wave
        for dag_id in wave_ids {
            // Check if any dependency failed — skip this task if so
            let idx = match dag_id_to_idx.get(dag_id) {
                Some(&i) => i,
                None => continue,
            };
            let (sub_id, agent, sub_prompt) = &task_channels[idx];
            let dag_node = &dag_nodes[idx];

            let has_failed_dep = dag_node.depends_on.iter().any(|dep| failed_dag_ids.contains(dep));
            if has_failed_dep {
                emit_orch(&on_event, "task_skipped", serde_json::json!({
                    "dag_id": dag_id, "reason": "dependency_failed"
                }));
                failed_dag_ids.insert(dag_id.clone());
                continue;
            }

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
                    worker_task_ids.push((task_id.clone(), agent.clone()));
                    wave_task_ids.push((task_id, agent.clone(), dag_id.clone()));
                }
                Err(e) => {
                    let error_detail = format!("Failed to dispatch task '{}' to {}: {}", dag_id, agent, e);
                    debug!("[orchestrator] {}", error_detail);
                    emit_messenger(&app_handle, MessengerMessage::system(
                        &plan.task_id,
                        error_detail.clone(),
                        MessageType::TaskFailed,
                    ));
                    emit_orch(&on_event, "dispatch_error", serde_json::json!({
                        "dag_id": dag_id, "agent": agent, "error": e.to_string()
                    }));
                    // Also emit as task_failed so the frontend can show the error on the task card
                    emit_orch(&on_event, "task_failed", serde_json::json!({
                        "dag_id": dag_id,
                        "exit_code": -1,
                        "summary": format!("Dispatch failed: {}", e),
                        "agent": agent,
                        "failure_reason": e.to_string()
                    }));
                    failed_dag_ids.insert(dag_id.clone());
                }
            }
        }

        // Wait for all tasks in this wave to complete (with retry/fallback)
        let retry_config = RetryConfig::default();
        let available_agents: Vec<&str> = decomposition.tasks.iter()
            .map(|t| t.agent.as_str())
            .collect::<std::collections::HashSet<&str>>()
            .into_iter()
            .collect();

        for (task_id, agent, dag_id) in &wave_task_ids {
            let mut current_task_id = task_id.clone();
            let mut current_agent = agent.clone();
            let original_agent = agent.clone();
            let mut attempt = 0u32;
            let mut last_exit_code;
            let mut last_output_summary;
            let mut failure_reason: Option<String> = None;

            loop {
                let worker_adapter = get_adapter(&current_agent)?;

                let exit_code = match timeout(
                    worker_timeout,
                    wait_for_worker_with_questions(
                        state_ref,
                        &current_task_id,
                        &current_agent,
                        worker_adapter.as_ref(),
                        &master_task_id,
                        adapter.as_ref(),
                        &plan.task_id,
                        &app_handle,
                        &on_event,
                    ),
                ).await {
                    Ok(code) => code,
                    Err(_) => {
                        let _ = kill_process(state_ref, &current_task_id).await;
                        emit_orch(&on_event, "worker_timeout", serde_json::json!({
                            "dag_id": dag_id, "timeout_minutes": app_config.worker_timeout_minutes
                        }));
                        -1 // treat as failure
                    }
                };

                last_exit_code = exit_code;
                last_output_summary = get_process_output_summary(&current_task_id, state_ref);

                if exit_code == 0 {
                    // Success!
                    break;
                }

                failure_reason = Some(truncate(&last_output_summary, 200).to_string());

                // Check if failure was due to rate limiting
                let was_rate_limited = {
                    let state_guard = state_ref.lock();
                    if let Some(entry) = state_guard.processes.get(&current_task_id) {
                        let rl_adapter = get_adapter(&current_agent)?;
                        entry.output_lines.iter().any(|line| rl_adapter.detect_rate_limit(line).is_some())
                    } else {
                        false
                    }
                };

                if was_rate_limited {
                    let rate_limit_delay = 30_000u64; // 30 seconds
                    emit_orch(&on_event, "rate_limited", serde_json::json!({
                        "dag_id": dag_id, "wait_seconds": 30
                    }));
                    tokio::time::sleep(Duration::from_millis(rate_limit_delay)).await;
                }

                // Try retry with same agent
                if should_retry(attempt, &retry_config) {
                    attempt += 1;
                    let delay = retry_delay_ms(attempt - 1, &retry_config);
                    emit_orch(&on_event, "task_retrying", serde_json::json!({
                        "dag_id": dag_id, "attempt": attempt,
                        "max_retries": retry_config.max_retries, "delay_ms": delay
                    }));

                    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;

                    // Re-dispatch same task to same agent
                    let idx = match dag_id_to_idx.get(dag_id.as_str()) {
                        Some(&i) => i,
                        None => break,
                    };
                    let (sub_id, _, sub_prompt) = &task_channels[idx];

                    match super::router::dispatch_task(
                        sub_prompt.clone(),
                        project_dir.clone(),
                        current_agent.clone(),
                        Some(sub_id.clone()),
                        on_event.clone(),
                        state.clone(),
                        context_store.clone(),
                    ).await {
                        Ok(new_task_id) => {
                            current_task_id = new_task_id;
                            continue;
                        }
                        Err(e) => {
                            emit_orch(&on_event, "dispatch_error", serde_json::json!({
                                "dag_id": dag_id, "error": e.to_string(), "context": "retry"
                            }));
                            break;
                        }
                    }
                }

                // Retries exhausted — try fallback agent
                if let Some(fallback) = select_fallback_agent(&current_agent, &available_agents) {
                    emit_orch(&on_event, "task_fallback", serde_json::json!({
                        "dag_id": dag_id, "from_agent": current_agent, "to_agent": &fallback
                    }));
                    current_agent = fallback;
                    attempt = 0; // Reset attempt counter for new agent

                    let idx = match dag_id_to_idx.get(dag_id.as_str()) {
                        Some(&i) => i,
                        None => break,
                    };
                    let (sub_id, _, sub_prompt) = &task_channels[idx];

                    match super::router::dispatch_task(
                        sub_prompt.clone(),
                        project_dir.clone(),
                        current_agent.clone(),
                        Some(sub_id.clone()),
                        on_event.clone(),
                        state.clone(),
                        context_store.clone(),
                    ).await {
                        Ok(new_task_id) => {
                            current_task_id = new_task_id;
                            continue;
                        }
                        Err(e) => {
                            emit_orch(&on_event, "dispatch_error", serde_json::json!({
                                "dag_id": dag_id, "error": e.to_string(), "context": "fallback"
                            }));
                            break;
                        }
                    }
                }

                // No fallback available
                break;
            }

            let final_agent_changed = current_agent != original_agent;
            let worker_result = WorkerResult {
                task_id: current_task_id.clone(),
                agent: current_agent.clone(),
                exit_code: last_exit_code,
                output_summary: last_output_summary.clone(),
                retry_count: attempt,
                original_agent: if final_agent_changed { Some(original_agent.clone()) } else { None },
                failure_reason: if last_exit_code != 0 { failure_reason.clone() } else { None },
            };
            plan.worker_results.push(worker_result);

            // Record task outcome for historical performance tracking
            if let Some(&idx) = dag_id_to_idx.get(dag_id.as_str()) {
                let (_, _, ref sub_prompt) = task_channels[idx];
                let task_type = infer_task_type(sub_prompt);
                let _ = context_store.record_task_outcome(
                    &current_agent,
                    &task_type,
                    last_exit_code == 0,
                    0, // duration approximation not yet implemented
                );
            }

            if last_exit_code != 0 {
                failed_dag_ids.insert(dag_id.clone());
            }

            let msg_type = if last_exit_code == 0 { MessageType::TaskCompleted } else { MessageType::TaskFailed };
            let summary_len = if last_exit_code == 0 { 200 } else { 500 }; // Show more detail on failure
            emit_messenger(&app_handle, MessengerMessage::agent(
                &plan.task_id,
                &current_agent,
                format!("{} (exit {}): {}",
                    if last_exit_code == 0 { "Completed" } else { "Failed" },
                    last_exit_code,
                    truncate(&last_output_summary, summary_len),
                ),
                msg_type,
            ));
            emit_orch(&on_event, if last_exit_code == 0 { "task_completed" } else { "task_failed" },
                serde_json::json!({
                    "dag_id": dag_id,
                    "exit_code": last_exit_code,
                    "summary": truncate(&last_output_summary, 500),
                    "agent": current_agent,
                    "failure_reason": failure_reason.as_deref().unwrap_or("")
                })
            );
        }
    }

    // If ALL tasks failed or were skipped, fail the orchestration
    if !plan.worker_results.iter().any(|r| r.exit_code == 0) && !plan.worker_results.is_empty() {
        let failure_summary = plan.worker_results.iter()
            .filter(|r| r.exit_code != 0)
            .map(|r| format!("[{}] exit {}: {}", r.agent, r.exit_code, truncate(&r.output_summary, 100)))
            .collect::<Vec<_>>()
            .join("\n");
        let _ = kill_process(state_ref, &master_task_id).await;
        update_plan_phase(state_ref, &plan.task_id, OrchestrationPhase::Failed)?;
        plan.phase = OrchestrationPhase::Failed;
        emit_orch(&on_event, "decomposition_failed", serde_json::json!({
            "error": format!("All worker tasks failed:\n{}", failure_summary)
        }));
        emit_messenger(&app_handle, MessengerMessage::system(
            &plan.task_id,
            format!("All worker tasks failed:\n{}", failure_summary),
            MessageType::TaskFailed,
        ));
        // Schedule plan cleanup after configured delay
        let cleanup_state = state_ref.clone();
        let cleanup_plan_id = plan.task_id.clone();
        let cleanup_delay_inner = cleanup_delay;
        tokio::spawn(async move {
            tokio::time::sleep(cleanup_delay_inner).await;
            { let mut guard = cleanup_state.lock();
                guard.orchestration_plans.remove(&cleanup_plan_id);
            }
        });
        return Ok(plan);
    }

    // Update plan with final worker results
    {
        let mut inner = state_ref.lock();
        if let Some(p) = inner.orchestration_plans.get_mut(&plan.task_id) {
            p.worker_results = plan.worker_results.clone();
            p.sub_tasks = plan.sub_tasks.clone();
        }
    }

    // === Phase 3: Review (new single-shot process) ===
    // The master process from Phase 1 exits after EOF, so we spawn a fresh process.
    emit_orch(&on_event, "phase_changed", serde_json::json!({
        "phase": "reviewing", "detail": "Master reviewing results"
    }));
    plan.phase = OrchestrationPhase::Reviewing;
    update_plan_phase(state_ref, &plan.task_id, OrchestrationPhase::Reviewing)?;

    let review_prompt = Orchestrator::build_review_prompt(&prompt, &plan.worker_results);

    // Spawn a new single-shot process for review using -p flag
    let review_tool_command = adapter.build_command(&review_prompt, &project_dir, &api_key);

    if let Err(e) = process::manager::acquire_tool_slot(state_ref, &config.master_agent) {
        // Clean up master + workers before propagating error
        let _ = kill_process(state_ref, &master_task_id).await;
        for (wid, _) in &worker_task_ids {
            let _ = kill_process(state_ref, wid).await;
        }
        return Err(e);
    }

    let review_task_id = match process::manager::spawn_interactive(
        review_tool_command,
        &format!("Review: {}", truncate(&prompt, 60)),
        &config.master_agent,
        on_event.clone(),
        state_ref,
    ).await {
        Ok(id) => {
            process::manager::release_tool_slot(state_ref, &config.master_agent);
            id
        }
        Err(e) => {
            process::manager::release_tool_slot(state_ref, &config.master_agent);
            let _ = kill_process(state_ref, &master_task_id).await;
            for (wid, _) in &worker_task_ids {
                let _ = kill_process(state_ref, wid).await;
            }
            return Err(e);
        }
    };

    // Wait for review process to complete (single-shot with -p exits on its own)
    let review_lines = match timeout(
        master_timeout,
        wait_for_turn_complete(state_ref, &review_task_id, adapter.as_ref()),
    ).await {
        Ok(result) => result,
        Err(_) => {
            let _ = kill_process(state_ref, &review_task_id).await;
            emit_orch(&on_event, "review_timeout", serde_json::json!({
                "timeout_minutes": app_config.master_timeout_minutes
            }));
            Err("Review agent timed out".to_string())
        }
    };

    match review_lines {
        Ok(lines) => {
            let review_text = adapter.extract_result(&lines)
                .unwrap_or_else(|| lines.join("\n"));
            emit_messenger(&app_handle, MessengerMessage::agent(
                &plan.task_id,
                &config.master_agent,
                format!("Review complete:\n{}", truncate(&review_text, 500)),
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

    // Clean up the review process (single-shot, should already be exited)
    let _ = kill_process(state_ref, &review_task_id).await;

    // Clean up worker processes (should already be exited)
    for (wid, _) in &worker_task_ids {
        let _ = kill_process(state_ref, wid).await;
    }

    // Clean up master process — Phase 1 master may still be alive for interactive
    // agents (Claude). We kill it now since orchestration is complete.
    let _ = kill_process(state_ref, &master_task_id).await;

    plan.phase = OrchestrationPhase::Completed;
    update_plan_phase(state_ref, &plan.task_id, OrchestrationPhase::Completed)?;
    emit_messenger(&app_handle, MessengerMessage::system(
        &plan.task_id,
        "Orchestration completed".to_string(),
        MessageType::TaskCompleted,
    ));

    // Schedule plan cleanup after configured delay
    let cleanup_state = state_ref.clone();
    let cleanup_plan_id = plan.task_id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(cleanup_delay).await;
        { let mut guard = cleanup_state.lock();
            guard.orchestration_plans.remove(&cleanup_plan_id);
        }
    });

    Ok(plan)
}

// ---------------------------------------------------------------------------
// Worker monitoring with question routing
// ---------------------------------------------------------------------------

/// Wait for a worker to complete while monitoring its output for questions.
/// When a question is detected, it is routed to the master agent. If the master
/// responds with `{"ask_user": "..."}`, the orchestration pauses for user input.
async fn wait_for_worker_with_questions(
    state: &AppState,
    worker_task_id: &str,
    worker_agent: &str,
    worker_adapter: &dyn ToolAdapter,
    master_task_id: &str,
    master_adapter: &dyn ToolAdapter,
    plan_id: &str,
    app_handle: &AppHandle,
    on_event: &Channel<OutputEvent>,
) -> i32 {
    let mut lines_seen = 0;

    // Clone receivers while holding lock, then drop lock
    let (mut line_rx, mut completion_rx) = {
        let s = state.lock();
        match s.processes.get(worker_task_id) {
            Some(entry) => (entry.line_count_rx.clone(), entry.completion_rx.clone()),
            None => return -1,
        }
    };

    loop {
        // Wait for either new lines or process completion
        tokio::select! {
            res = line_rx.changed() => {
                if res.is_err() { break; }
            }
            res = completion_rx.changed() => {
                if res.is_err() || *completion_rx.borrow() {
                    // Process exited — check final status
                    let s = state.lock();
                    return match s.processes.get(worker_task_id) {
                        Some(entry) => match &entry.status {
                            ProcessStatus::Completed(code) => *code,
                            _ => -1,
                        },
                        None => -1,
                    };
                }
            }
        }

        let (current_lines, status) = {
            let s = state.lock();
            match s.processes.get(worker_task_id) {
                Some(entry) => {
                    if entry.output_lines.len() > lines_seen {
                        (entry.output_lines[lines_seen..].to_vec(), entry.status.clone())
                    } else {
                        continue;
                    }
                }
                None => return -1,
            }
        };

        // Check new lines for questions
        for line in current_lines.iter() {
            if let Some(question) = worker_adapter.detect_question(line) {
                // Route question to master
                emit_orch(on_event, "question", serde_json::json!({
                    "agent": worker_agent, "content": question.content, "plan_id": plan_id
                }));

                let relay_prompt = Orchestrator::build_question_relay_prompt(
                    worker_agent,
                    &question.content,
                );

                // Check if master process is still alive before attempting to relay.
                // When decomposition uses single-shot mode (use_interactive=false),
                // the master is killed before Phase 2 starts, so question routing
                // to master won't work. Log the question and skip the relay.
                let master_alive = {
                    let s = state.lock();
                    s.processes.contains_key(master_task_id)
                };

                if !master_alive {
                    log::warn!(
                        "[orchestrator] Worker '{}' asked a question but master process is dead (single-shot mode). \
                         Question logged but cannot be relayed: {}",
                        worker_agent, question.content
                    );
                    continue;
                }

                if let Err(e) = process::manager::send_to_process(state, master_task_id, &relay_prompt) {
                    on_event.send(OutputEvent::Stderr(format!(
                        "[orchestrator] Failed to relay question to master: {}", e
                    ))).ok();
                    continue;
                }

                // Wait for master's response
                match wait_for_turn_complete(state, master_task_id, master_adapter).await {
                    Ok(master_lines) => {
                        let response = master_adapter.extract_result(&master_lines)
                            .unwrap_or_else(|| master_lines.last().cloned().unwrap_or_default());

                        // Check if master wants to ask the user
                        if let Ok(ask_user) = serde_json::from_str::<AskUserResponse>(&response) {
                            // Emit QuestionForUser and set phase to WaitingForInput
                            emit_messenger(app_handle, MessengerMessage::system(
                                plan_id,
                                ask_user.ask_user.clone(),
                                MessageType::QuestionForUser,
                            ));

                            update_plan_phase(state, plan_id, OrchestrationPhase::WaitingForInput).ok();

                            // Store pending question in queue
                            {
                                let mut inner = state.lock();
                                inner.question_queue.push(PendingQuestion {
                                    question,
                                    worker_task_id: worker_task_id.to_string(),
                                    plan_id: plan_id.to_string(),
                                });
                            }

                            // Wait for the user to answer (watch-channel based, no polling)
                            let mut q_rx = {
                                let mut inner = state.lock();
                                let (tx, rx) = tokio::sync::watch::channel(false);
                                inner.question_signals.insert(plan_id.to_string(), tx);
                                rx
                            };
                            loop {
                                if q_rx.changed().await.is_err() {
                                    return -1; // Signal dropped
                                }
                                let phase = {
                                    let inner = state.lock();
                                    inner.orchestration_plans.get(plan_id)
                                        .map(|p| p.phase.clone())
                                };
                                match phase {
                                    Some(OrchestrationPhase::Executing) => break,
                                    Some(OrchestrationPhase::Failed) => return -1,
                                    None => return -1,
                                    _ => {}
                                }
                            }
                            // Clean up question signal
                            state.lock().question_signals.remove(plan_id);
                        } else {
                            // Master answered directly — send answer to worker's stdin
                            emit_orch(on_event, "question_answered", serde_json::json!({
                                "agent": worker_agent
                            }));
                            let _ = process::manager::send_to_process(
                                state,
                                worker_task_id,
                                &response,
                            );
                        }
                    }
                    Err(e) => {
                        on_event.send(OutputEvent::Stderr(format!(
                            "[orchestrator] Master failed to respond to question: {}", e
                        ))).ok();
                    }
                }
            }
        }
        lines_seen += current_lines.len();

        // Check if worker is done
        match status {
            ProcessStatus::Completed(code) => return code,
            ProcessStatus::Failed(_) => return -1,
            _ => {}
        }
    }

    // Channel closed — check final status
    let s = state.lock();
    match s.processes.get(worker_task_id) {
        Some(entry) => match &entry.status {
            ProcessStatus::Completed(code) => *code,
            _ => -1,
        },
        None => -1,
    }
}

// ===========================================================================
// approve_orchestration command
// ===========================================================================

/// Approve the decomposed task list and start Phase 2 execution.
/// Optionally accepts modified tasks (agent reassignments, removals).
#[tauri::command]
#[specta::specta]
pub async fn approve_orchestration(
    state: tauri::State<'_, AppState>,
    plan_id: String,
    modified_tasks: Option<Vec<crate::router::orchestrator::SubTaskDef>>,
) -> Result<(), String> {
    let state_ref: &AppState = &state;
    let mut inner = state_ref.lock();
    let plan = inner.orchestration_plans.get_mut(&plan_id)
        .ok_or_else(|| format!("No orchestration plan found for: {}", plan_id))?;

    if plan.phase != OrchestrationPhase::AwaitingApproval {
        return Err(format!("Plan is not awaiting approval (current phase: {:?})", plan.phase));
    }

    // Apply modifications if provided
    if let Some(tasks) = modified_tasks {
        if let Some(ref mut decomp) = plan.decomposition {
            decomp.tasks = tasks;
        }
    }

    plan.phase = OrchestrationPhase::Executing;

    // Signal the orchestrator to wake up (replaces polling)
    if let Some(tx) = inner.approval_signals.get(&plan_id) {
        let _ = tx.send(true);
    }

    Ok(())
}

// ===========================================================================
// clear_orchestration_context command
// ===========================================================================

/// Clear orchestration context: back up master's context to context.md,
/// kill all agent processes, and remove the plan.
#[tauri::command]
#[specta::specta]
pub async fn clear_orchestration_context(
    state: tauri::State<'_, AppState>,
    app_handle: AppHandle,
    plan_id: String,
    project_dir: String,
) -> Result<String, String> {
    let state_ref: &AppState = &state;

    // Get master process id and agent from plan
    let (master_task_id, master_agent) = {
        let inner = state_ref.lock();
        let plan = inner.orchestration_plans.get(&plan_id)
            .ok_or_else(|| format!("No orchestration plan found for: {}", plan_id))?;
        let master_id = plan.master_process_id.clone()
            .ok_or("No master process in plan")?;
        (master_id, plan.master_agent.clone())
    };

    let adapter = get_adapter(&master_agent)?;

    // Send context backup prompt to master
    let backup_prompt = Orchestrator::build_context_backup_prompt();
    process::manager::send_to_process(state_ref, &master_task_id, &backup_prompt)?;

    emit_messenger(&app_handle, MessengerMessage::system(
        &plan_id,
        "Requesting context backup from master...".to_string(),
        MessageType::ContextBackup,
    ));

    // Wait for response with 30s timeout
    let context_result = tokio::time::timeout(
        tokio::time::Duration::from_secs(30),
        wait_for_turn_complete(state_ref, &master_task_id, adapter.as_ref()),
    ).await
    .map_err(|_| "Context backup timed out after 30s".to_string())?
    .map_err(|e| format!("Context backup failed: {}", e))?;

    // Extract result and try to parse {"context_backup": "..."}
    let result_text = adapter.extract_result(&context_result)
        .unwrap_or_else(|| context_result.join("\n"));

    let context_content = if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&result_text) {
        if let Some(backup) = parsed.get("context_backup").and_then(|v| v.as_str()) {
            backup.to_string()
        } else {
            // Use raw result if no JSON structure
            result_text
        }
    } else {
        result_text
    };

    // Write to <project_dir>/context.md
    let context_path = std::path::Path::new(&project_dir).join("context.md");
    tokio::fs::write(&context_path, &context_content)
        .await
        .map_err(|e| format!("Failed to write context.md: {}", e))?;

    // Kill only processes belonging to this orchestration plan (not ALL processes)
    let process_ids: Vec<String> = {
        let inner = state_ref.lock();
        let mut ids = Vec::new();
        if let Some(plan) = inner.orchestration_plans.get(&plan_id) {
            // Include the master process
            if let Some(ref mid) = plan.master_process_id {
                ids.push(mid.clone());
            }
            // Include all sub-task worker processes
            for sub_task in &plan.sub_tasks {
                ids.push(sub_task.id.clone());
            }
        }
        ids
    };

    for pid in &process_ids {
        let _ = kill_process(state_ref, pid).await;
    }

    // Remove plan from state and clear its questions from the queue
    {
        let mut inner = state_ref.lock();
        inner.orchestration_plans.remove(&plan_id);
        inner.question_queue.retain(|q| q.plan_id != plan_id);
    }

    emit_messenger(&app_handle, MessengerMessage::system(
        &plan_id,
        format!("Context backed up to {}", context_path.display()),
        MessageType::ContextBackup,
    ));

    Ok(context_path.to_string_lossy().to_string())
}

// ===========================================================================
// answer_user_question command
// ===========================================================================

/// Answer a question from the master agent that was relayed to the user.
/// Sends the user's answer to the master's stdin and resumes execution.
#[tauri::command]
#[specta::specta]
pub async fn answer_user_question(
    state: tauri::State<'_, AppState>,
    app_handle: AppHandle,
    plan_id: String,
    answer: String,
) -> Result<(), String> {
    let state_ref: &AppState = &state;

    // Get master process id from plan
    let master_task_id = {
        let inner = state_ref.lock();
        let plan = inner.orchestration_plans.get(&plan_id)
            .ok_or_else(|| format!("No orchestration plan found for: {}", plan_id))?;
        plan.master_process_id.clone()
            .ok_or("No master process in plan")?
    };

    // Send the user's answer to master's stdin
    let answer_text = format!("The user answered: {}", answer);
    process::manager::send_to_process(state_ref, &master_task_id, &answer_text)?;

    emit_messenger(&app_handle, MessengerMessage::system(
        &plan_id,
        format!("User answered: {}", truncate(&answer, 200)),
        MessageType::UserAnswer,
    ));

    // Update phase back to Executing
    update_plan_phase(state_ref, &plan_id, OrchestrationPhase::Executing)?;

    // Signal question watcher to wake up
    {
        let inner = state_ref.lock();
        if let Some(tx) = inner.question_signals.get(&plan_id) {
            let _ = tx.send(true);
        }
    }

    Ok(())
}

// ===========================================================================
// get_agent_context_info command (unchanged)
// ===========================================================================

/// Get context/token usage information for agents involved in a task.
#[tauri::command]
#[specta::specta]
pub async fn get_agent_context_info(
    task_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AgentContextInfo>, String> {
    let inner = state.lock();

    let plan = inner
        .orchestration_plans
        .get(&task_id)
        .ok_or_else(|| format!("No orchestration plan found for task_id: {}", task_id))?;

    let mut infos: Vec<AgentContextInfo> = Vec::new();

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

    Ok(infos)
}

// ===========================================================================
// approve_decomposition / reject_decomposition commands
// ===========================================================================

/// Approve the decomposed task list (optionally modified) and start execution.
#[tauri::command]
#[specta::specta]
pub async fn approve_decomposition(
    plan_id: String,
    modified_tasks: Vec<crate::router::orchestrator::SubTaskDef>,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<(), String> {
    let mut state = state.lock();
    let plan = state
        .orchestration_plans
        .get_mut(&plan_id)
        .ok_or_else(|| "Plan not found".to_string())?;

    // Update decomposition with modified tasks
    plan.decomposition = Some(crate::router::orchestrator::DecompositionResult {
        tasks: modified_tasks,
    });
    plan.phase = crate::router::orchestrator::OrchestrationPhase::Executing;

    Ok(())
}

/// Reject the decomposition and send feedback to the master for re-decomposition.
#[tauri::command]
#[specta::specta]
pub async fn reject_decomposition(
    plan_id: String,
    feedback: String,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<(), String> {
    let mut state = state.lock();
    let plan = state
        .orchestration_plans
        .get_mut(&plan_id)
        .ok_or_else(|| "Plan not found".to_string())?;

    plan.phase = crate::router::orchestrator::OrchestrationPhase::Decomposing;

    // Send feedback to master via stdin if master process is alive
    if let Some(master_id) = &plan.master_process_id {
        let master_id = master_id.clone();
        if let Some(entry) = state.processes.get(&master_id) {
            if let Some(tx) = &entry.stdin_tx {
                let prompt = format!(
                    "The user rejected your task decomposition with this feedback: {}\n\nPlease re-decompose the task addressing the user's concerns. Return the updated JSON task list.",
                    feedback
                );
                tx.send(prompt).map_err(|_| "Master process is no longer running — cannot send feedback".to_string())?;
            } else {
                return Err("Master process has no stdin channel".to_string());
            }
        } else {
            return Err("Master process not found — it may have exited".to_string());
        }
    } else {
        return Err("No master process associated with this plan".to_string());
    }

    Ok(())
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_adapter_valid() {
        let adapter = get_adapter("claude").unwrap();
        assert_eq!(adapter.name(), "Claude Code");
        let adapter = get_adapter("gemini").unwrap();
        assert_eq!(adapter.name(), "Gemini CLI");
        let adapter = get_adapter("codex").unwrap();
        assert_eq!(adapter.name(), "Codex CLI");
    }

    #[test]
    fn test_get_adapter_unknown() {
        let result = get_adapter("unknown");
        assert!(result.is_err());
        match result {
            Err(e) => assert!(e.contains("Unknown agent")),
            Ok(_) => panic!("Expected error for unknown agent"),
        }
    }

    #[test]
    fn test_parse_decomposition_json_direct() {
        let json = r#"{"tasks": [{"agent": "claude", "prompt": "fix bug", "description": "Fix the auth bug"}]}"#;
        let result = parse_decomposition_json(json).unwrap();
        assert_eq!(result.tasks.len(), 1);
        assert_eq!(result.tasks[0].agent, "claude");
    }

    #[test]
    fn test_parse_decomposition_json_markdown_fence() {
        let output = "Here is the plan:\n```json\n{\"tasks\": [{\"agent\": \"gemini\", \"prompt\": \"test\", \"description\": \"testing\"}]}\n```\nDone.";
        let result = parse_decomposition_json(output).unwrap();
        assert_eq!(result.tasks.len(), 1);
        assert_eq!(result.tasks[0].agent, "gemini");
    }

    #[test]
    fn test_parse_decomposition_json_embedded() {
        let output = "I will decompose this: {\"tasks\": [{\"agent\": \"codex\", \"prompt\": \"refactor\", \"description\": \"do it\"}]} hope that works.";
        let result = parse_decomposition_json(output).unwrap();
        assert_eq!(result.tasks.len(), 1);
    }

    #[test]
    fn test_parse_decomposition_json_invalid() {
        assert!(parse_decomposition_json("no json here").is_none());
        assert!(parse_decomposition_json("").is_none());
    }

    #[test]
    fn test_truncate_short() {
        assert_eq!(truncate("hello", 10), "hello");
    }

    #[test]
    fn test_truncate_long() {
        let result = truncate("hello world this is a long string", 10);
        assert!(result.ends_with("..."));
        assert!(result.len() <= 14); // 10 chars + "..."
    }

    #[test]
    fn test_parse_decomposition_from_output_empty() {
        let adapter = crate::adapters::claude::ClaudeAdapter;
        let result = parse_decomposition_from_output(&[], &adapter);
        assert!(result.is_none());
    }

    #[test]
    fn test_parse_decomposition_from_output_with_json_line() {
        let adapter = crate::adapters::claude::ClaudeAdapter;
        let lines = vec![
            "thinking...".to_string(),
            r#"{"tasks": [{"agent": "claude", "prompt": "fix", "description": "fix it"}]}"#.to_string(),
        ];
        let result = parse_decomposition_from_output(&lines, &adapter);
        assert!(result.is_some());
        assert_eq!(result.unwrap().tasks.len(), 1);
    }

    // === Integration tests: adapter extract_result + cross-module flows ===

    #[test]
    fn test_adapter_extract_result_claude() {
        use crate::adapters::ToolAdapter;
        let adapter = crate::adapters::claude::ClaudeAdapter;
        let lines = vec![
            r#"{"type":"result","result":"answer text here","is_error":false}"#.to_string(),
        ];
        let result = adapter.extract_result(&lines);
        assert!(result.is_some());
        assert_eq!(result.unwrap(), "answer text here");
    }

    #[test]
    fn test_adapter_extract_result_gemini() {
        use crate::adapters::ToolAdapter;
        let adapter = crate::adapters::gemini::GeminiAdapter;
        let lines = vec![
            r#"{"type":"result","response":"gemini answer","is_error":false}"#.to_string(),
        ];
        let result = adapter.extract_result(&lines);
        assert!(result.is_some());
        assert_eq!(result.unwrap(), "gemini answer");
    }

    #[test]
    fn test_adapter_extract_result_codex() {
        use crate::adapters::ToolAdapter;
        let adapter = crate::adapters::codex::CodexAdapter;
        let lines = vec![
            r#"{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"codex answer"}}"#.to_string(),
            r#"{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}"#.to_string(),
        ];
        let result = adapter.extract_result(&lines);
        assert!(result.is_some());
        assert_eq!(result.unwrap(), "codex answer");
    }

    #[test]
    fn test_adapter_extract_result_empty_lines() {
        use crate::adapters::ToolAdapter;
        let adapter = crate::adapters::claude::ClaudeAdapter;
        let lines: Vec<String> = vec![];
        assert!(adapter.extract_result(&lines).is_none());
    }

    #[test]
    fn test_all_adapters_resolve() {
        assert!(get_adapter("claude").is_ok());
        assert!(get_adapter("gemini").is_ok());
        assert!(get_adapter("codex").is_ok());
        assert!(get_adapter("gpt").is_err());
    }

    #[test]
    fn test_parse_multi_task_decomposition() {
        let json = r#"{"tasks": [
            {"agent": "claude", "prompt": "fix auth", "description": "Fix authentication"},
            {"agent": "gemini", "prompt": "add tests", "description": "Add unit tests"},
            {"agent": "codex", "prompt": "refactor db", "description": "Refactor database layer"}
        ]}"#;
        let result = parse_decomposition_json(json).unwrap();
        assert_eq!(result.tasks.len(), 3);
        assert_eq!(result.tasks[0].agent, "claude");
        assert_eq!(result.tasks[1].agent, "gemini");
        assert_eq!(result.tasks[2].agent, "codex");
    }

    #[test]
    fn test_truncate_edge_cases() {
        assert_eq!(truncate("", 10), "");
        assert_eq!(truncate("ab", 2), "ab");
        assert_eq!(truncate("abc", 2), "ab...");
    }

    // === New parsing strategy tests ===

    #[test]
    fn test_parse_decomposition_json_sub_tasks_key() {
        let json = r#"{"sub_tasks": [{"agent": "claude", "prompt": "fix bug", "description": "Fix the auth bug"}]}"#;
        let result = parse_decomposition_json(json).unwrap();
        assert_eq!(result.tasks.len(), 1);
        assert_eq!(result.tasks[0].agent, "claude");
    }

    #[test]
    fn test_parse_decomposition_json_subtasks_key() {
        let json = r#"{"subtasks": [{"agent": "gemini", "prompt": "test", "description": "Add tests"}]}"#;
        let result = parse_decomposition_json(json).unwrap();
        assert_eq!(result.tasks.len(), 1);
        assert_eq!(result.tasks[0].agent, "gemini");
    }

    #[test]
    fn test_parse_decomposition_json_plain_fence() {
        let output = "Here is the plan:\n```\n{\"tasks\": [{\"agent\": \"codex\", \"prompt\": \"refactor\", \"description\": \"do it\"}]}\n```\nDone.";
        let result = parse_decomposition_json(output).unwrap();
        assert_eq!(result.tasks.len(), 1);
        assert_eq!(result.tasks[0].agent, "codex");
    }

    #[test]
    fn test_parse_decomposition_json_bare_array() {
        // Strategy 5: bare JSON array without wrapping object
        let output = r#"Here are the tasks: [{"agent": "claude", "prompt": "fix auth", "description": "Fix auth"}, {"agent": "gemini", "prompt": "add tests", "description": "Tests"}]"#;
        let result = parse_decomposition_json(output).unwrap();
        assert_eq!(result.tasks.len(), 2);
        assert_eq!(result.tasks[0].agent, "claude");
        assert_eq!(result.tasks[1].agent, "gemini");
    }

    #[test]
    fn test_parse_decomposition_json_tasks_key_scan() {
        // Strategy 4: natural language around JSON with "tasks" key
        let output = r#"Sure! I've analyzed the task and here's my decomposition:

The task can be broken into the following sub-tasks:
{"tasks": [{"agent": "claude", "prompt": "implement feature", "description": "Implement the feature"}, {"agent": "gemini", "prompt": "write tests", "description": "Write tests"}]}

Let me know if you need any changes!"#;
        let result = parse_decomposition_json(output).unwrap();
        assert_eq!(result.tasks.len(), 2);
    }

    #[test]
    fn test_parse_decomposition_json_nested_braces() {
        // Ensure brace matching handles nested JSON in prompts
        let json = r#"{"tasks": [{"agent": "claude", "prompt": "Create a config like {\"key\": \"value\"}", "description": "Config task"}]}"#;
        let result = parse_decomposition_json(json).unwrap();
        assert_eq!(result.tasks.len(), 1);
    }

    #[test]
    fn test_find_matching_brace() {
        assert_eq!(find_matching_brace("{}"), Some(1));
        assert_eq!(find_matching_brace("{\"a\": {\"b\": 1}}"), Some(14));
        assert_eq!(find_matching_brace("{\"a\": \"}\"}"), Some(9));
        assert_eq!(find_matching_brace("{unclosed"), None);
    }

    #[test]
    fn test_find_matching_bracket() {
        assert_eq!(find_matching_bracket("[]"), Some(1));
        assert_eq!(find_matching_bracket("[1, [2, 3]]"), Some(10));
        assert_eq!(find_matching_bracket("[\"]\"]"), Some(4));
        assert_eq!(find_matching_bracket("[unclosed"), None);
    }

    #[test]
    fn test_try_parse_decomposition_empty_tasks() {
        // Empty tasks array should return None
        let json = r#"{"tasks": []}"#;
        assert!(try_parse_decomposition(json).is_none());
    }

    #[test]
    fn test_try_parse_decomposition_alternative_keys_with_data() {
        let json = r#"{"sub_tasks": [{"agent": "claude", "prompt": "work", "description": "do work"}]}"#;
        let result = try_parse_decomposition(json).unwrap();
        assert_eq!(result.tasks.len(), 1);
        assert_eq!(result.tasks[0].agent, "claude");
    }

    // === normalize_agent_name tests ===

    #[test]
    fn test_normalize_agent_name_standard_names() {
        assert_eq!(normalize_agent_name("claude"), "claude");
        assert_eq!(normalize_agent_name("gemini"), "gemini");
        assert_eq!(normalize_agent_name("codex"), "codex");
    }

    #[test]
    fn test_normalize_agent_name_variations() {
        assert_eq!(normalize_agent_name("claude code"), "claude");
        assert_eq!(normalize_agent_name("Claude Code"), "claude");
        assert_eq!(normalize_agent_name("claude-code"), "claude");
        assert_eq!(normalize_agent_name("claude_code"), "claude");
        assert_eq!(normalize_agent_name("gemini cli"), "gemini");
        assert_eq!(normalize_agent_name("gemini-cli"), "gemini");
        assert_eq!(normalize_agent_name("Gemini"), "gemini");
        assert_eq!(normalize_agent_name("codex cli"), "codex");
        assert_eq!(normalize_agent_name("codex-cli"), "codex");
        assert_eq!(normalize_agent_name("openai"), "codex");
    }

    #[test]
    fn test_normalize_agent_name_placeholders() {
        assert_eq!(normalize_agent_name("<agent_name>"), "claude");
        assert_eq!(normalize_agent_name("<Agent>"), "claude");
    }

    #[test]
    fn test_normalize_agent_name_unknown() {
        // Unknown names fall back to claude with a warn log
        assert_eq!(normalize_agent_name("gpt-4"), "claude");
        assert_eq!(normalize_agent_name("cursor"), "claude");
    }

    #[test]
    fn test_normalize_agent_name_empty() {
        assert_eq!(normalize_agent_name(""), "claude");
    }

    #[test]
    fn test_normalize_agent_name_whitespace() {
        assert_eq!(normalize_agent_name("  claude  "), "claude");
        assert_eq!(normalize_agent_name("\tgemini\n"), "gemini");
    }
}
