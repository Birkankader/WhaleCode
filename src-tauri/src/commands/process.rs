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
