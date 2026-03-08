use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;
use specta::Type;

use crate::prompt::models::PromptContext;

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
    pub stdin_tx: Option<tokio::sync::mpsc::UnboundedSender<String>>,
    pub output_lines: Vec<String>,
    /// Signals when the process exits. Clone the receiver, drop the lock, then await.
    pub completion_rx: tokio::sync::watch::Receiver<bool>,
}

/// Cache TTL in seconds (5 minutes).
const CACHE_TTL_SECS: u64 = 300;

/// Maximum number of tasks before cache invalidation.
const CACHE_MAX_TASKS: u32 = 3;

/// Session-level cache for prompt context to avoid redundant SQLite queries
/// on rapid task dispatches.
pub struct CachedPromptContext {
    pub context: PromptContext,
    pub project_dir: String,
    pub cached_at: Instant,
    pub tasks_since_cache: u32,
}

impl CachedPromptContext {
    /// Check whether this cache entry is still valid for the given project directory.
    ///
    /// Invalid when:
    /// - Elapsed time exceeds TTL (300 seconds)
    /// - Task count since cache >= MAX_TASKS (3)
    /// - Project directory differs
    pub fn is_valid(&self, project_dir: &str) -> bool {
        if self.project_dir != project_dir {
            return false;
        }
        if self.cached_at.elapsed().as_secs() > CACHE_TTL_SECS {
            return false;
        }
        if self.tasks_since_cache >= CACHE_MAX_TASKS {
            return false;
        }
        true
    }
}

#[derive(Default)]
pub struct AppStateInner {
    pub tasks: HashMap<TaskId, TaskInfo>,
    pub processes: HashMap<TaskId, ProcessEntry>,
    pub orchestration_plans: HashMap<TaskId, crate::router::orchestrator::OrchestrationPlan>,
    pub cached_prompt_context: Option<CachedPromptContext>,
}

pub type AppState = Arc<Mutex<AppStateInner>>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prompt::models::PromptContext;

    fn make_context() -> PromptContext {
        PromptContext {
            recent_events: vec![],
            project_dir: "/test/project".to_string(),
        }
    }

    #[test]
    fn app_state_initializes_empty() {
        let state = AppState::default();
        let inner = state.lock().unwrap();
        assert_eq!(inner.tasks.len(), 0);
        assert_eq!(inner.processes.len(), 0);
        assert!(inner.cached_prompt_context.is_none());
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

    #[test]
    fn cached_prompt_context_valid_within_ttl_and_task_count() {
        let cache = CachedPromptContext {
            context: make_context(),
            project_dir: "/test/project".to_string(),
            cached_at: Instant::now(),
            tasks_since_cache: 0,
        };
        assert!(cache.is_valid("/test/project"));
    }

    #[test]
    fn cached_prompt_context_invalid_after_ttl() {
        let cache = CachedPromptContext {
            context: make_context(),
            project_dir: "/test/project".to_string(),
            // Simulate expired cache by using an Instant far in the past
            cached_at: Instant::now() - std::time::Duration::from_secs(301),
            tasks_since_cache: 0,
        };
        assert!(!cache.is_valid("/test/project"));
    }

    #[test]
    fn cached_prompt_context_invalid_after_max_tasks() {
        let cache = CachedPromptContext {
            context: make_context(),
            project_dir: "/test/project".to_string(),
            cached_at: Instant::now(),
            tasks_since_cache: 3,
        };
        assert!(!cache.is_valid("/test/project"));
    }

    #[test]
    fn cached_prompt_context_invalid_different_project_dir() {
        let cache = CachedPromptContext {
            context: make_context(),
            project_dir: "/test/project".to_string(),
            cached_at: Instant::now(),
            tasks_since_cache: 0,
        };
        assert!(!cache.is_valid("/other/project"));
    }
}
