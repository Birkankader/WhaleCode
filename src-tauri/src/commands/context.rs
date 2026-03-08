use serde::Serialize;
use specta::Type;

use crate::context::models::FileChangeRecord;
use crate::context::queries;
use crate::context::store::ContextStore;

/// A context event with its associated file paths, suitable for IPC return.
#[derive(Debug, Clone, Serialize, Type)]
pub struct ContextEventWithFiles {
    pub id: i32,
    pub task_id: String,
    pub tool_name: String,
    pub event_type: String,
    pub prompt: Option<String>,
    pub summary: Option<String>,
    pub project_dir: String,
    pub metadata: Option<String>,
    pub duration_ms: Option<u32>,
    pub cost_usd: Option<f64>,
    pub created_at: String,
    pub files: Vec<String>,
}

/// Record a task completion event with file changes.
#[tauri::command]
#[specta::specta]
pub fn record_task_completion_cmd(
    task_id: String,
    tool_name: String,
    event_type: String,
    prompt: Option<String>,
    summary: Option<String>,
    project_dir: String,
    duration_ms: Option<u32>,
    cost_usd: Option<f64>,
    files_json: String,
    store: tauri::State<'_, ContextStore>,
) -> Result<i32, String> {
    let files: Vec<(String, String)> =
        serde_json::from_str(&files_json).map_err(|e| format!("Invalid files_json: {}", e))?;

    store
        .with_conn(|conn| {
            queries::record_task_completion(
                conn,
                &task_id,
                &tool_name,
                &event_type,
                prompt.as_deref(),
                summary.as_deref(),
                &project_dir,
                duration_ms.map(|d| d as u64),
                cost_usd,
                &files,
            )
        })
        .map(|id| id as i32)
}

/// Get recent file changes for a project.
#[tauri::command]
#[specta::specta]
pub fn get_recent_changes(
    project_dir: String,
    limit: u32,
    store: tauri::State<'_, ContextStore>,
) -> Result<Vec<FileChangeRecord>, String> {
    store.with_conn(|conn| queries::get_recent_file_changes(conn, &project_dir, limit))
}

/// Get a summary of recent context events with their file paths.
#[tauri::command]
#[specta::specta]
pub fn get_context_summary(
    project_dir: String,
    limit: u32,
    store: tauri::State<'_, ContextStore>,
) -> Result<Vec<ContextEventWithFiles>, String> {
    let events =
        store.with_conn(|conn| queries::get_recent_events(conn, &project_dir, limit))?;

    let result: Vec<ContextEventWithFiles> = events
        .into_iter()
        .map(|(event, files)| ContextEventWithFiles {
            id: event.id as i32,
            task_id: event.task_id,
            tool_name: event.tool_name,
            event_type: event.event_type,
            prompt: event.prompt,
            summary: event.summary,
            project_dir: event.project_dir,
            metadata: event.metadata,
            duration_ms: event.duration_ms.map(|d| d as u32),
            cost_usd: event.cost_usd,
            created_at: event.created_at,
            files,
        })
        .collect();

    Ok(result)
}
