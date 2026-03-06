use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use specta::Type;

pub type TaskId = String;

#[derive(Debug)]
pub struct TaskInfo {
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Type)]
pub enum ProcessStatus {
    Running,
    Paused,
    Completed(i32),
    Failed(String),
}

#[derive(Debug)]
pub struct ProcessEntry {
    pub pgid: i32,
    pub status: ProcessStatus,
    pub tool_name: String,
    pub task_description: String,
    pub started_at: i64,
}

#[derive(Default)]
pub struct AppStateInner {
    pub tasks: HashMap<TaskId, TaskInfo>,
    pub processes: HashMap<TaskId, ProcessEntry>,
}

pub type AppState = Arc<Mutex<AppStateInner>>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_state_initializes_empty() {
        let state = AppState::default();
        let inner = state.lock().unwrap();
        assert_eq!(inner.tasks.len(), 0);
        assert_eq!(inner.processes.len(), 0);
    }

    #[test]
    fn app_state_insert_and_count() {
        let state = AppState::default();
        {
            let mut inner = state.lock().unwrap();
            inner.tasks.insert(
                "task-1".to_string(),
                TaskInfo {
                    description: "test".to_string(),
                },
            );
        }
        let inner = state.lock().unwrap();
        assert_eq!(inner.tasks.len(), 1);
    }
}
