use crate::detection::models::DetectedAgent;
use crate::detection::scanner;
use crate::detection::usage::{self, AgentUsage};

#[tauri::command]
#[specta::specta]
pub async fn detect_agents() -> Result<Vec<DetectedAgent>, String> {
    Ok(scanner::detect_all_agents().await)
}

#[tauri::command]
#[specta::specta]
pub async fn fetch_agent_usage() -> Result<Vec<AgentUsage>, String> {
    Ok(usage::fetch_all_usage().await)
}
