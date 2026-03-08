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
                                .map(|t| format!("  - {} -> {}", t.agent, t.description))
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
                        "Decomposition failed -- falling back to single-agent dispatch".to_string(),
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

    // Wait for all workers to complete
    for (task_id, agent) in &worker_task_ids {
        let result = wait_for_process_completion(task_id, state.clone()).await;
        let output_summary = get_process_output_summary(task_id, &state);

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
        MessageType::TaskCompleted,
    ));

    Ok(plan)
}

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

// -- Helper functions --

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
    let exit_code = wait_for_process_completion(&task_id, state.clone()).await;
    let output = get_process_output_summary(&task_id, &state);

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
            let inner = match state.lock() {
                Ok(inner) => inner,
                Err(_) => return -1,
            };
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
fn get_process_output_summary(task_id: &str, state: &tauri::State<'_, AppState>) -> String {
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
