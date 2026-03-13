use crate::fs_explorer::{list, models::*, read, write};

#[tauri::command]
#[specta::specta]
pub async fn list_directory(
    project_dir: String,
    relative_path: String,
) -> Result<Vec<FsEntry>, String> {
    let base = super::expand_tilde(&project_dir);
    tokio::task::spawn_blocking(move || list::list_dir(&base, &relative_path))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
#[specta::specta]
pub async fn read_file(
    project_dir: String,
    relative_path: String,
) -> Result<FileContent, String> {
    let base = super::expand_tilde(&project_dir);
    tokio::task::spawn_blocking(move || read::read_file_content(&base, &relative_path))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
#[specta::specta]
pub async fn write_file(
    project_dir: String,
    relative_path: String,
    content: String,
) -> Result<u32, String> {
    let base = super::expand_tilde(&project_dir);
    tokio::task::spawn_blocking(move || write::write_file_content(&base, &relative_path, &content))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}
