use std::collections::HashMap;
use std::sync::Mutex;

pub type TaskId = String;

#[derive(Debug)]
pub struct TaskInfo {
    pub description: String,
}

#[derive(Default)]
pub struct AppStateInner {
    pub tasks: HashMap<TaskId, TaskInfo>,
    // Phase 2: add Vec<Child> process_registry here for zombie cleanup
}

pub type AppState = Mutex<AppStateInner>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_state_initializes_empty() {
        let state = AppState::default();
        let inner = state.lock().unwrap();
        assert_eq!(inner.tasks.len(), 0);
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
