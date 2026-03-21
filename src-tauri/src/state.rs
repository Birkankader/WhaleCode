use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use parking_lot::Mutex;
use std::time::Instant;

use serde::Serialize;
use specta::Type;

use crate::prompt::models::PromptContext;

pub type TaskId = String;

// Fields are set during task creation and used for display/tracking.
#[allow(dead_code)]
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
    /// Signals new line count — subscribers can detect new output without polling.
    pub line_count_rx: tokio::sync::watch::Receiver<usize>,
    /// Token usage stats extracted from NDJSON result events
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub cost_usd: Option<f64>,
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
    pub question_queue: Vec<crate::router::orchestrator::PendingQuestion>,
    /// Tools that have been reserved for dispatch but not yet spawned.
    /// Prevents TOCTOU races where two rapid dispatch calls for the same
    /// tool both pass the "no running process" check before either spawns.
    pub reserved_tools: HashSet<String>,
    /// Watch channels for approval notifications. Keyed by plan_id.
    /// Sender side: approval command sends `true` to wake the orchestrator.
    /// Receiver side: orchestrator awaits instead of polling.
    pub approval_signals: HashMap<String, tokio::sync::watch::Sender<bool>>,
    /// Watch channels for question-answered notifications. Keyed by plan_id.
    pub question_signals: HashMap<String, tokio::sync::watch::Sender<bool>>,
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
        let inner = state.lock();
        assert_eq!(inner.tasks.len(), 0);
        assert_eq!(inner.processes.len(), 0);
        assert!(inner.cached_prompt_context.is_none());
    }

    #[test]
    fn app_state_insert_and_count() {
        let state = AppState::default();
        {
            let mut inner = state.lock();
            inner.tasks.insert(
                "task-1".to_string(),
                TaskInfo {
                    description: "test".to_string(),
                },
            );
        }
        let inner = state.lock();
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

    #[test]
    fn reserved_tools_starts_empty() {
        let state = AppState::default();
        let inner = state.lock();
        assert!(inner.reserved_tools.is_empty());
    }

    #[test]
    fn reserved_tools_insert_and_check() {
        let state = AppState::default();
        let mut inner = state.lock();

        // First insert succeeds
        assert!(inner.reserved_tools.insert("claude".to_string()));
        // Duplicate insert returns false (already reserved)
        assert!(!inner.reserved_tools.insert("claude".to_string()));
        // Different tool succeeds
        assert!(inner.reserved_tools.insert("gemini".to_string()));
    }

    #[test]
    fn reserved_tools_remove_allows_re_reservation() {
        let state = AppState::default();
        let mut inner = state.lock();

        inner.reserved_tools.insert("claude".to_string());
        inner.reserved_tools.remove("claude");

        // After removal, can reserve again
        assert!(inner.reserved_tools.insert("claude".to_string()));
    }

    #[test]
    fn reserved_tools_independent_of_processes() {
        let state = AppState::default();
        let mut inner = state.lock();

        // Reservation exists even with no matching process
        inner.reserved_tools.insert("claude".to_string());
        assert!(inner.reserved_tools.contains("claude"));
        assert!(inner.processes.is_empty());

        // Process exists without reservation
        inner.reserved_tools.remove("claude");
        let (_tx, rx) = tokio::sync::watch::channel(false);
        let (_ltx, lrx) = tokio::sync::watch::channel(0usize);
        inner.processes.insert(
            "task-1".to_string(),
            ProcessEntry {
                pgid: 1234,
                status: ProcessStatus::Running,
                tool_name: "claude".to_string(),
                task_description: "test".to_string(),
                started_at: 0,
                stdin_tx: None,
                output_lines: vec![],
                completion_rx: rx,
                line_count_rx: lrx,
                input_tokens: None,
                output_tokens: None,
                total_tokens: None,
                cost_usd: None,
            },
        );
        assert!(!inner.reserved_tools.contains("claude"));
    }
}
