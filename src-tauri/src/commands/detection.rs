use crate::detection::models::DetectedAgent;
use crate::detection::scanner;

#[tauri::command]
#[specta::specta]
pub async fn detect_agents() -> Result<Vec<DetectedAgent>, String> {
    Ok(scanner::detect_all_agents().await)
}
