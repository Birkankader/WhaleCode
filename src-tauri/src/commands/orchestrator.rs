use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter};

use crate::adapters::{AskUserResponse, ToolAdapter};
use crate::context::store::ContextStore;
use crate::ipc::events::OutputEvent;
use crate::messenger::models::{MessengerMessage, MessageType};
use crate::process;
use crate::router::orchestrator::{
    AgentContextInfo, DecompositionResult, Orchestrator, OrchestratorConfig,
    OrchestrationPlan, OrchestrationPhase, PendingQuestion, WorkerResult,
};
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

/// Polls the process's output_lines and checks each new line with
/// `adapter.is_turn_complete()`. Returns all output lines accumulated so far.
///
/// Exits early if the process dies or completes (EOF).
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
            ProcessStatus::Failed(ref e) => return Err(format!("Process died: {}", e)),
            ProcessStatus::Completed(_) => return Ok(current_lines),
            _ => {}
        }
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

async fn kill_process(state: &AppState, task_id: &str) -> Result<(), String> {
    let pgid = {
        let inner = state.lock().map_err(|e| e.to_string())?;
        let entry = inner.processes.get(task_id)
            .ok_or_else(|| format!("Process not found: {}", task_id))?;
        entry.pgid
    };

    process::signals::graceful_kill(pgid).await;

    {
        let mut inner = state.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = inner.processes.get_mut(task_id) {
            entry.status = ProcessStatus::Failed("Cancelled".to_string());
        }
    }

    Ok(())
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

    // === Phase 1: Decompose (interactive master) ===
    on_event.send(OutputEvent::Stdout(
        "[orchestrator] Phase 1: Spawning interactive master agent...".to_string()
    )).ok();

    let adapter = get_adapter(&config.master_agent)?;
    let api_key = get_api_key(&config.master_agent)?;
    let tool_command = adapter.build_interactive_command(&project_dir, &api_key);

    // Spawn master as an interactive (long-lived) process
    let master_task_id = process::manager::spawn_interactive(
        tool_command,
        &format!("Orchestration master: {}", truncate(&prompt, 60)),
        &config.master_agent,
        on_event.clone(),
        state_ref,
    ).await?;

    // Store master_process_id in plan
    plan.master_process_id = Some(master_task_id.clone());
    {
        let mut inner = state_ref.lock().map_err(|e| e.to_string())?;
        if let Some(p) = inner.orchestration_plans.get_mut(&plan.task_id) {
            p.master_process_id = Some(master_task_id.clone());
        }
    }

    // Check for context.md in project_dir for context restore
    let context_md_path = std::path::Path::new(&project_dir).join("context.md");
    let decompose_prompt = {
        let base_prompt = Orchestrator::build_decompose_prompt(&prompt, &config.agents);
        if context_md_path.exists() {
            // Read context, delete the file, and combine with decompose prompt
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

    // Send decompose prompt to master's stdin
    on_event.send(OutputEvent::Stdout(
        "[orchestrator] Phase 1: Decomposing task via master agent...".to_string()
    )).ok();

    process::manager::send_to_process(state_ref, &master_task_id, &decompose_prompt)?;

    // Wait for master's turn to complete
    let output_lines = wait_for_turn_complete(state_ref, &master_task_id, adapter.as_ref()).await?;

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
    on_event.send(OutputEvent::Stdout(format!(
        "[orchestrator] Phase 2: Executing {} sub-tasks...",
        decomposition.tasks.len()
    ))).ok();

    // Build sub-tasks from decomposition and dispatch
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
        });

        emit_messenger(&app_handle, MessengerMessage::system(
            &plan.task_id,
            format!("Assigned to {}: {}", sub_def.agent, sub_def.description),
            MessageType::TaskAssigned,
        ));

        task_channels.push((sub_task_id, sub_def.agent.clone(), sub_def.prompt.clone()));
    }

    // Dispatch all sub-tasks sequentially.
    // NOTE: Parallel dispatch via JoinSet is blocked because tauri::State is not Send.
    // Each agent gets at most one sub-task, so sequential dispatch has minimal impact.
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

    // Wait for all workers to complete, with question routing
    for (task_id, agent) in &worker_task_ids {
        let worker_adapter = get_adapter(agent)?;

        // Monitor worker output for questions while waiting for completion
        let exit_code = wait_for_worker_with_questions(
            state_ref,
            task_id,
            agent,
            worker_adapter.as_ref(),
            &master_task_id,
            adapter.as_ref(),
            &plan.task_id,
            &app_handle,
            &on_event,
        ).await;

        let output_summary = get_process_output_summary(task_id, state_ref);

        let worker_result = WorkerResult {
            task_id: task_id.clone(),
            agent: agent.clone(),
            exit_code,
            output_summary: output_summary.clone(),
        };
        plan.worker_results.push(worker_result);

        let msg_type = if exit_code == 0 { MessageType::TaskCompleted } else { MessageType::TaskFailed };
        emit_messenger(&app_handle, MessengerMessage::agent(
            &plan.task_id,
            agent,
            format!("{} (exit {}): {}",
                if exit_code == 0 { "Completed" } else { "Failed" },
                exit_code,
                truncate(&output_summary, 200),
            ),
            msg_type,
        ));
    }

    // Update plan with final worker results
    {
        let mut inner = state_ref.lock().map_err(|e| e.to_string())?;
        if let Some(p) = inner.orchestration_plans.get_mut(&plan.task_id) {
            p.worker_results = plan.worker_results.clone();
            p.sub_tasks = plan.sub_tasks.clone();
        }
    }

    // === Phase 3: Review (same master process) ===
    on_event.send(OutputEvent::Stdout(
        "[orchestrator] Phase 3: Master reviewing results...".to_string()
    )).ok();
    plan.phase = OrchestrationPhase::Reviewing;
    update_plan_phase(state_ref, &plan.task_id, OrchestrationPhase::Reviewing)?;

    let review_prompt = Orchestrator::build_review_prompt(&prompt, &plan.worker_results);

    // Send review prompt to the still-alive master process
    process::manager::send_to_process(state_ref, &master_task_id, &review_prompt)?;

    // Wait for master's review turn to complete
    let review_lines = wait_for_turn_complete(state_ref, &master_task_id, adapter.as_ref()).await;

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

    // Mark as completed but DON'T kill the master — it stays alive for follow-up
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

    loop {
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

        let (current_lines, status) = {
            let s = match state.lock() {
                Ok(s) => s,
                Err(_) => return -1,
            };
            match s.processes.get(worker_task_id) {
                Some(entry) => (entry.output_lines.clone(), entry.status.clone()),
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

    // Remove plan from state and clear question queue
    {
        let mut inner = state_ref.lock().map_err(|e| e.to_string())?;
        inner.orchestration_plans.remove(&plan_id);
        inner.question_queue.clear();
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
        let status = if let Some(proc) = inner.processes.get(&sub_task.id) {
            match &proc.status {
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
            input_tokens: None,
            output_tokens: None,
            total_tokens: None,
            cost_usd: None,
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
            r#"{"type":"result","response":"codex answer","is_error":false}"#.to_string(),
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
