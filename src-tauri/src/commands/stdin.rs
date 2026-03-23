use crate::state::AppState;

/// Send text to a running process's stdin.
#[tauri::command]
#[specta::specta]
pub async fn send_to_process(
    task_id: String,
    text: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let inner = state.lock();
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
