use tauri::ipc::Channel;

use crate::context::store::ContextStore;
use crate::ipc::events::OutputEvent;
use crate::router::orchestrator::{
    AgentContextInfo, Orchestrator, OrchestratorConfig, OrchestrationPlan,
};
use crate::state::{AppState, ProcessStatus};

/// Dispatch an orchestrated multi-agent task.
///
/// Creates an orchestration plan from the prompt and config, then dispatches
/// each sub-task to its assigned agent. Each sub-task gets its own worktree
/// for isolation. Returns the plan for frontend tracking.
#[tauri::command]
#[specta::specta]
pub async fn dispatch_orchestrated_task(
    prompt: String,
    project_dir: String,
    config: OrchestratorConfig,
    on_event: Channel<OutputEvent>,
    state: tauri::State<'_, AppState>,
    context_store: tauri::State<'_, ContextStore>,
) -> Result<OrchestrationPlan, String> {
    // Create the orchestration plan
    let mut plan = Orchestrator::create_plan(&prompt, &config);

    // Store the plan in app state
    {
        let mut inner = state.lock().map_err(|e| e.to_string())?;
        inner
            .orchestration_plans
            .insert(plan.task_id.clone(), plan.clone());
    }

    // Notify frontend that orchestration is starting
    on_event
        .send(OutputEvent::Stdout(format!(
            "[orchestrator] Created plan {} with {} sub-tasks",
            plan.task_id,
            plan.sub_tasks.len()
        )))
        .ok();

    // Dispatch each sub-task to its assigned agent.
    // NOTE: dispatch_task → spawn_*_task already creates a worktree per task,
    // so we pass project_dir directly (no separate worktree creation here).
    for sub_task in &mut plan.sub_tasks {
        sub_task.status = "running".to_string();

        // Dispatch the sub-task using the existing dispatch_task
        let dispatch_result = super::router::dispatch_task(
            sub_task.prompt.clone(),
            project_dir.clone(),
            sub_task.assigned_agent.clone(),
            Some(sub_task.id.clone()),
            on_event.clone(),
            state.clone(),
            context_store.clone(),
        )
        .await;

        match dispatch_result {
            Ok(task_id) => {
                on_event
                    .send(OutputEvent::Stdout(format!(
                        "[orchestrator] Dispatched sub-task {} to {} (task_id: {})",
                        sub_task.id, sub_task.assigned_agent, task_id
                    )))
                    .ok();
            }
            Err(e) => {
                sub_task.status = "failed".to_string();
                on_event
                    .send(OutputEvent::Stderr(format!(
                        "[orchestrator] Failed to dispatch sub-task {} to {}: {}",
                        sub_task.id, sub_task.assigned_agent, e
                    )))
                    .ok();
            }
        }
    }

    // Update the plan in state with the latest sub-task statuses
    {
        let mut inner = state.lock().map_err(|e| e.to_string())?;
        inner
            .orchestration_plans
            .insert(plan.task_id.clone(), plan.clone());
    }

    Ok(plan)
}

/// Get context/token usage information for agents involved in a task.
///
/// Reads from the process state to gather context info per agent
/// associated with the given orchestration plan task_id.
#[tauri::command]
#[specta::specta]
pub async fn get_agent_context_info(
    task_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AgentContextInfo>, String> {
    let inner = state.lock().map_err(|e| e.to_string())?;

    // Find the orchestration plan
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
