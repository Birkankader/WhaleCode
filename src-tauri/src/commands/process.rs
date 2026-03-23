use tauri::ipc::Channel;

use crate::ipc::events::OutputEvent;
use crate::process;
use crate::state::AppState;

#[tauri::command]
#[specta::specta]
pub async fn spawn_process(
    cmd: String,
    args: Vec<String>,
    cwd: String,
    on_event: Channel<OutputEvent>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    process::manager::spawn(&cmd, &args, &cwd, on_event, state).await
}

#[tauri::command]
#[specta::specta]
pub async fn cancel_process(
    task_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    process::manager::cancel(&task_id, state).await
}

#[tauri::command]
#[specta::specta]
pub fn pause_process(
    task_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    process::manager::pause(&task_id, state)
}

#[tauri::command]
#[specta::specta]
pub fn resume_process(
    task_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    process::manager::resume(&task_id, state)
}

/// Returns a list of currently running process task IDs.
/// Frontend uses this to reconcile its task state with backend reality.
#[tauri::command]
#[specta::specta]
pub fn get_running_processes(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let inner = state.lock();
    let running: Vec<String> = inner
        .processes
        .iter()
        .filter(|(_, entry)| matches!(entry.status, crate::state::ProcessStatus::Running))
        .map(|(id, _)| id.clone())
        .collect();
    Ok(running)
}
