use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter};

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
        let inner = match state.lock() {
            Ok(inner) => inner,
            Err(_) => return -1,
        };
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
    let inner = match state.lock() {
        Ok(inner) => inner,
        Err(_) => return -1,
    };
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
    // Try adapter's extract_result first
    if let Some(result_text) = adapter.extract_result(output_lines) {
        if let Some(decomp) = parse_decomposition_json(&result_text) {
            return Some(decomp);
        }
    }

    // Fall back to scanning all output lines for JSON
    let combined = output_lines.join("\n");
    parse_decomposition_json(&combined)
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

fn update_plan_phase(
    state: &AppState,
    plan_id: &str,
    phase: OrchestrationPhase,
) -> Result<(), String> {
    let mut inner = state.lock().map_err(|e| e.to_string())?;
    if let Some(plan) = inner.orchestration_plans.get_mut(plan_id) {
        plan.phase = phase;
    }
    Ok(())
}

/// Get the last N lines of a process's output as a summary string.
fn get_process_output_summary(task_id: &str, state: &AppState) -> String {
    let inner = match state.lock() {
        Ok(inner) => inner,
        Err(_) => return String::new(),
    };
    if let Some(entry) = inner.processes.get(task_id) {
        let lines = &entry.output_lines;
        let last_20: Vec<&str> = lines.iter().rev().take(20).map(|s| s.as_str()).collect();
        last_20.into_iter().rev().collect::<Vec<_>>().join("\n")
    } else {
        String::new()
    }
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

    let mut plan = Orchestrator::create_plan(&prompt, &config);

    // Store plan
    {
        let mut inner = state_ref.lock().map_err(|e| e.to_string())?;
        inner.orchestration_plans.insert(plan.task_id.clone(), plan.clone());
    }

    // Emit messenger: orchestration started
    emit_messenger(&app_handle, MessengerMessage::system(
        &plan.task_id,
        format!("Orchestration started: \"{}\"", truncate(&prompt, 80)),
        MessageType::OrchestrationStarted,
    ));

    // === Phase 1: Decompose (master agent) ===
    on_event.send(OutputEvent::Stdout(
        "[orchestrator] Phase 1: Spawning master agent...".to_string()
    )).ok();

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

    on_event.send(OutputEvent::Stdout(
        "[orchestrator] Phase 1: Decomposing task via master agent...".to_string()
    )).ok();

    // Determine spawn strategy:
    // - Claude supports interactive mode (piped stdin + EOF triggers processing)
    // - Gemini/Codex need single-shot mode with -p flag
    let use_interactive = config.master_agent == "claude";

    let master_task_id = if use_interactive {
        // Interactive mode: spawn, pipe prompt via stdin, close stdin to trigger EOF
        let tool_command = adapter.build_interactive_command(&project_dir, &api_key);
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

        if let Err(e) = process::manager::send_to_process(state_ref, &task_id, &decompose_prompt) {
            let _ = kill_process(state_ref, &task_id).await;
            return Err(e);
        }
        if let Err(e) = process::manager::close_stdin(state_ref, &task_id) {
            let _ = kill_process(state_ref, &task_id).await;
            return Err(e);
        }
        task_id
    } else {
        // Single-shot mode: pass prompt via -p flag (works for Gemini, Codex)
        // We use spawn_interactive which accepts ToolCommand + &AppState,
        // but the command itself includes -p so it runs and exits.
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
        let mut inner = state_ref.lock().map_err(|e| e.to_string())?;
        if let Some(p) = inner.orchestration_plans.get_mut(&plan.task_id) {
            p.master_process_id = Some(master_task_id.clone());
        }
    }

    // Wait for master's turn to complete (detects result event or process exit)
    let output_lines = match wait_for_turn_complete(state_ref, &master_task_id, adapter.as_ref()).await {
        Ok(lines) => lines,
        Err(e) => {
            let _ = kill_process(state_ref, &master_task_id).await;
            return Err(e);
        }
    };

    // Extract and parse decomposition result
    let decomposition = match parse_decomposition_from_output(&output_lines, adapter.as_ref()) {
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
            result
        }
        None => {
            // Kill the master process — it's useless without a valid decomposition
            let _ = kill_process(state_ref, &master_task_id).await;
            update_plan_phase(state_ref, &plan.task_id, OrchestrationPhase::Failed)?;
            plan.phase = OrchestrationPhase::Failed;
            emit_messenger(&app_handle, MessengerMessage::system(
                &plan.task_id,
                "Decomposition failed: could not parse JSON from master agent output".to_string(),
                MessageType::TaskFailed,
            ));
            return Ok(plan);
        }
    };

    // Store decomposition
    plan.decomposition = Some(decomposition.clone());
    plan.phase = OrchestrationPhase::Executing;
    {
        let mut inner = state_ref.lock().map_err(|e| e.to_string())?;
        if let Some(p) = inner.orchestration_plans.get_mut(&plan.task_id) {
            p.decomposition = plan.decomposition.clone();
            p.phase = OrchestrationPhase::Executing;
        }
    }

    // === Phase 2: Execute (workers with question routing) ===

    // Build sub-tasks from decomposition and send assignment messages FIRST.
    // The frontend creates tasks from "Assigned to" messages, so these must
    // arrive before the "Phase 2: Executing" message which transitions them
    // from pending → running.
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

        emit_messenger(&app_handle, MessengerMessage::system(
            &plan.task_id,
            format!("Assigned to {}: {}", sub_def.agent, sub_def.description),
            MessageType::TaskAssigned,
        ));
        on_event.send(OutputEvent::Stdout(
            format!("Assigned to {}: {}", sub_def.agent, sub_def.description)
        )).ok();

        task_channels.push((sub_task_id, sub_def.agent.clone(), sub_def.prompt.clone()));
    }

    // Build DAG from decomposition tasks
    let dag_nodes: Vec<DagNode> = decomposition.tasks.iter().enumerate().map(|(i, def)| {
        DagNode {
            id: format!("t{}", i + 1),
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
            on_event.send(OutputEvent::Stdout(
                format!("[orchestrator] DAG warning: {}. Running all tasks in one wave.", e)
            )).ok();
            vec![dag_nodes.iter().map(|n| n.id.clone()).collect()]
        }
    };

    // Now send Phase 2 message — frontend handler transitions pending tasks to running
    on_event.send(OutputEvent::Stdout(format!(
        "[orchestrator] Phase 2: Executing {} sub-tasks in {} wave(s)...",
        decomposition.tasks.len(),
        waves.len(),
    ))).ok();

    let mut worker_task_ids: Vec<(String, String)> = Vec::new(); // (process_task_id, agent)
    let mut failed_dag_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

    for (wave_idx, wave_ids) in waves.iter().enumerate() {
        on_event.send(OutputEvent::Stdout(
            format!("[orchestrator] Wave {}/{}: {} task(s)", wave_idx + 1, waves.len(), wave_ids.len())
        )).ok();

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
                on_event.send(OutputEvent::Stdout(
                    format!("[orchestrator] Skipping {} (dependency failed)", dag_id)
                )).ok();
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
                    emit_messenger(&app_handle, MessengerMessage::system(
                        &plan.task_id,
                        format!("Failed to dispatch to {}: {}", agent, e),
                        MessageType::TaskFailed,
                    ));
                    on_event.send(OutputEvent::Stdout(
                        format!("[orchestrator] Failed to dispatch {}: {}", dag_id, e)
                    )).ok();
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

                let exit_code = wait_for_worker_with_questions(
                    state_ref,
                    &current_task_id,
                    &current_agent,
                    worker_adapter.as_ref(),
                    &master_task_id,
                    adapter.as_ref(),
                    &plan.task_id,
                    &app_handle,
                    &on_event,
                ).await;

                last_exit_code = exit_code;
                last_output_summary = get_process_output_summary(&current_task_id, state_ref);

                if exit_code == 0 {
                    // Success!
                    break;
                }

                failure_reason = Some(truncate(&last_output_summary, 200).to_string());

                // Try retry with same agent
                if should_retry(attempt, &retry_config) {
                    attempt += 1;
                    let delay = retry_delay_ms(attempt - 1, &retry_config);
                    on_event.send(OutputEvent::Stdout(
                        format!("[orchestrator] Retrying {} (attempt {}/{}) after {}ms...",
                            dag_id, attempt, retry_config.max_retries, delay)
                    )).ok();

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
                            on_event.send(OutputEvent::Stdout(
                                format!("[orchestrator] Retry dispatch failed for {}: {}", dag_id, e)
                            )).ok();
                            break;
                        }
                    }
                }

                // Retries exhausted — try fallback agent
                if let Some(fallback) = select_fallback_agent(&current_agent, &available_agents) {
                    on_event.send(OutputEvent::Stdout(
                        format!("[orchestrator] Falling back: {} reassigned from {} to {}",
                            dag_id, current_agent, fallback)
                    )).ok();
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
                            on_event.send(OutputEvent::Stdout(
                                format!("[orchestrator] Fallback dispatch failed for {}: {}", dag_id, e)
                            )).ok();
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

            if last_exit_code != 0 {
                failed_dag_ids.insert(dag_id.clone());
            }

            let msg_type = if last_exit_code == 0 { MessageType::TaskCompleted } else { MessageType::TaskFailed };
            emit_messenger(&app_handle, MessengerMessage::agent(
                &plan.task_id,
                &current_agent,
                format!("{} (exit {}): {}",
                    if last_exit_code == 0 { "Completed" } else { "Failed" },
                    last_exit_code,
                    truncate(&last_output_summary, 200),
                ),
                msg_type,
            ));
            on_event.send(OutputEvent::Stdout(
                format!("{} (exit {}): {}",
                    if last_exit_code == 0 { "Completed" } else { "Failed" },
                    last_exit_code,
                    truncate(&last_output_summary, 200),
                )
            )).ok();
        }
    }

    // If ALL tasks failed or were skipped, fail the orchestration
    if !plan.worker_results.iter().any(|r| r.exit_code == 0) && !plan.worker_results.is_empty() {
        let _ = kill_process(state_ref, &master_task_id).await;
        update_plan_phase(state_ref, &plan.task_id, OrchestrationPhase::Failed)?;
        plan.phase = OrchestrationPhase::Failed;
        emit_messenger(&app_handle, MessengerMessage::system(
            &plan.task_id,
            "All worker tasks failed".to_string(),
            MessageType::TaskFailed,
        ));
        return Ok(plan);
    }

    // Update plan with final worker results
    {
        let mut inner = state_ref.lock().map_err(|e| e.to_string())?;
        if let Some(p) = inner.orchestration_plans.get_mut(&plan.task_id) {
            p.worker_results = plan.worker_results.clone();
            p.sub_tasks = plan.sub_tasks.clone();
        }
    }

    // === Phase 3: Review (new single-shot process) ===
    // The master process from Phase 1 exits after EOF, so we spawn a fresh process.
    on_event.send(OutputEvent::Stdout(
        "[orchestrator] Phase 3: Master reviewing results...".to_string()
    )).ok();
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
    let review_lines = wait_for_turn_complete(state_ref, &review_task_id, adapter.as_ref()).await;

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
        let s = match state.lock() {
            Ok(s) => s,
            Err(_) => return -1,
        };
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
                    let s = match state.lock() {
                        Ok(s) => s,
                        Err(_) => return -1,
                    };
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
            let s = match state.lock() {
                Ok(s) => s,
                Err(_) => return -1,
            };
            match s.processes.get(worker_task_id) {
                Some(entry) => {
                    if entry.output_lines.len() > lines_seen {
                        (entry.output_lines.clone(), entry.status.clone())
                    } else {
                        continue;
                    }
                }
                None => return -1,
            }
        };

        // Check new lines for questions
        for line in current_lines.iter().skip(lines_seen) {
            if let Some(question) = worker_adapter.detect_question(line) {
                // Route question to master
                on_event.send(OutputEvent::Stdout(format!(
                    "[orchestrator] {} asks: {}",
                    worker_agent, question.content
                ))).ok();

                let relay_prompt = Orchestrator::build_question_relay_prompt(
                    worker_agent,
                    &question.content,
                );

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
                                let mut inner = match state.lock() {
                                    Ok(inner) => inner,
                                    Err(_) => continue,
                                };
                                inner.question_queue.push(PendingQuestion {
                                    question,
                                    worker_task_id: worker_task_id.to_string(),
                                    plan_id: plan_id.to_string(),
                                });
                            }

                            // Wait for the user to answer (phase changes back to Executing)
                            loop {
                                tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
                                let phase = {
                                    let inner = match state.lock() {
                                        Ok(inner) => inner,
                                        Err(_) => break,
                                    };
                                    inner.orchestration_plans.get(plan_id)
                                        .map(|p| p.phase.clone())
                                };
                                match phase {
                                    Some(OrchestrationPhase::Executing) => break,
                                    Some(OrchestrationPhase::Failed) => return -1,
                                    None => return -1,
                                    _ => {} // Keep waiting
                                }
                            }
                        } else {
                            // Master answered directly — send answer to worker's stdin
                            on_event.send(OutputEvent::Stdout(format!(
                                "[orchestrator] Master answered {}'s question",
                                worker_agent
                            ))).ok();
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
        lines_seen = current_lines.len();

        // Check if worker is done
        match status {
            ProcessStatus::Completed(code) => return code,
            ProcessStatus::Failed(_) => return -1,
            _ => {}
        }
    }

    // Channel closed — check final status
    let s = match state.lock() {
        Ok(s) => s,
        Err(_) => return -1,
    };
    match s.processes.get(worker_task_id) {
        Some(entry) => match &entry.status {
            ProcessStatus::Completed(code) => *code,
            _ => -1,
        },
        None => -1,
    }
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
        let inner = state_ref.lock().map_err(|e| e.to_string())?;
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

    // Kill ALL agent processes
    let process_ids: Vec<String> = {
        let inner = state_ref.lock().map_err(|e| e.to_string())?;
        inner.processes.keys().cloned().collect()
    };

    for pid in &process_ids {
        let _ = kill_process(state_ref, pid).await;
    }

    // Remove plan from state and clear its questions from the queue
    {
        let mut inner = state_ref.lock().map_err(|e| e.to_string())?;
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
        let inner = state_ref.lock().map_err(|e| e.to_string())?;
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
    let inner = state.lock().map_err(|e| e.to_string())?;

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
    let mut state = state.lock().map_err(|e| e.to_string())?;
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
    let mut state = state.lock().map_err(|e| e.to_string())?;
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
}
