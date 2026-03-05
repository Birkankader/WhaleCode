use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ContextEvent {
    pub id: i64,
    pub task_id: String,
    pub tool_name: String,
    pub event_type: String,
    pub prompt: Option<String>,
    pub summary: Option<String>,
    pub project_dir: String,
    pub metadata: Option<String>,
    pub duration_ms: Option<u64>,
    pub cost_usd: Option<f64>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FileChange {
    pub id: i64,
    pub event_id: i64,
    pub file_path: String,
    pub change_type: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FileChangeRecord {
    pub file_path: String,
    pub change_type: String,
    pub tool_name: String,
    pub summary: Option<String>,
    pub created_at: String,
}
