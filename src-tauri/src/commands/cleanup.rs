use crate::router::orchestrator::OrchestrationPhase;
use crate::state::{AppState, ProcessStatus};

/// Remove completed/failed processes older than 30 seconds from state.
#[tauri::command]
#[specta::specta]
pub async fn cleanup_completed_processes(
    state: tauri::State<'_, AppState>,
) -> Result<u32, String> {
    let mut inner = state.lock().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().timestamp_millis();
    let thirty_sec_ms = 30 * 1000;

    let stale_ids: Vec<String> = inner
        .processes
        .iter()
        .filter(|(_, entry)| {
            matches!(
                entry.status,
                ProcessStatus::Completed(_) | ProcessStatus::Failed(_)
            ) && (now - entry.started_at) > thirty_sec_ms
        })
        .map(|(id, _)| id.clone())
        .collect();

    let count = stale_ids.len() as u32;
    for id in &stale_ids {
        inner.processes.remove(id);
    }

    // Also clean up completed orchestration plans
    let stale_plan_ids: Vec<String> = inner
        .orchestration_plans
        .iter()
        .filter(|(_, plan)| {
            matches!(
                plan.phase,
                OrchestrationPhase::Completed | OrchestrationPhase::Failed
            )
        })
        .map(|(id, _)| id.clone())
        .collect();
    for id in &stale_plan_ids {
        inner.orchestration_plans.remove(id);
    }

    Ok(count + stale_plan_ids.len() as u32)
}
