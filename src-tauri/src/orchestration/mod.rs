//! Run orchestration: the single owner of every in-flight run's state.
//!
//! External callers never mutate a [`Run`] directly. IPC commands
//! ([`crate::ipc::commands`]) forward to methods on [`Orchestrator`],
//! which dispatches into a per-run tokio task. Each task drives the
//! state machine end-to-end: planning → approval → execute → merge →
//! cleanup, with cooperative cancellation at every `.await`.
//!
//! Layout:
//! - `events` — internal event enum + [`EventSink`] trait so tests
//!   can observe without a Tauri runtime.
//! - `context` — builds the [`crate::agents::PlanningContext`] from
//!   the target repo (directory tree, instruction files, git log).
//! - `notes` — `SharedNotes` file: init + append + consolidate.
//! - `registry` — maps [`AgentKind`] to a concrete adapter.
//! - `run` — in-memory per-run state ([`Run`], [`SubtaskRuntime`]).
//! - `lifecycle` — the per-run tokio task that drives the state
//!   machine end-to-end.

#![allow(dead_code)] // Dispatcher / lifecycle methods land in 8c-8e.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::{oneshot, Mutex, RwLock};

use crate::ipc::{AgentKind, RunId, RunStatus, SubtaskId};
use crate::settings::SettingsStore;
use crate::storage::models::NewRun;
use crate::storage::Storage;

pub mod context;
pub mod dispatcher;
pub mod events;
pub mod lifecycle;
pub mod notes;
pub mod registry;
pub mod run;

#[cfg(test)]
mod tests;

#[allow(unused_imports)]
pub use events::{EventSink, RunEvent, TauriEventSink};
pub use lifecycle::ApprovalDecision;
#[allow(unused_imports)]
pub use registry::{AgentRegistry, DefaultAgentRegistry, RegistryError};
#[allow(unused_imports)]
pub use run::{Run, SubtaskRuntime};

use lifecycle::{new_run_id, run_lifecycle, LifecycleDeps};
use notes::SharedNotes;
use run::Run as RunState;

/// Maximum worker tasks permitted to run concurrently within a single
/// run. Keeps CPU, subprocess, and API-rate pressure bounded.
pub const MAX_CONCURRENT_WORKERS: usize = 4;

/// How long to wait for the user to approve or reject a plan before
/// auto-rejecting.
pub const APPROVAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// Errors the orchestrator surfaces to IPC command callers. Each
/// carries a human-readable message so the frontend can show an
/// error banner without translating.
#[derive(Debug, thiserror::Error)]
pub enum OrchestratorError {
    #[error("run {0} not found")]
    RunNotFound(RunId),
    #[error("run {run_id} is in state {state:?}, expected {expected}")]
    WrongState {
        run_id: RunId,
        state: RunStatus,
        expected: &'static str,
    },
    #[error("agent unavailable: {0}")]
    AgentUnavailable(String),
    #[error("storage: {0}")]
    Storage(String),
    #[error("worktree: {0}")]
    Worktree(String),
}

impl From<OrchestratorError> for String {
    fn from(e: OrchestratorError) -> String {
        e.to_string()
    }
}

/// Single owner of all in-flight runs.
pub struct Orchestrator {
    pub(crate) settings: Arc<SettingsStore>,
    pub(crate) storage: Arc<Storage>,
    pub(crate) event_sink: Arc<dyn EventSink>,
    pub(crate) registry: Arc<dyn AgentRegistry>,
    pub(crate) runs: Arc<Mutex<HashMap<RunId, Arc<RwLock<RunState>>>>>,
    /// Pending approval channels. `submit_task` inserts; `approve_subtasks`
    /// or `reject_run` take and `send()` on the sender, then drop the
    /// entry. If `cancel_run` fires first, the entry is dropped by
    /// the lifecycle task's own cleanup — the sender just stops being
    /// reachable without ever having fired.
    pub(crate) approval_senders: Arc<Mutex<HashMap<RunId, oneshot::Sender<ApprovalDecision>>>>,
    pub(crate) max_concurrent_workers: usize,
}

impl Orchestrator {
    pub fn new(
        settings: Arc<SettingsStore>,
        storage: Arc<Storage>,
        event_sink: Arc<dyn EventSink>,
        registry: Arc<dyn AgentRegistry>,
    ) -> Self {
        Self {
            settings,
            storage,
            event_sink,
            registry,
            runs: Arc::new(Mutex::new(HashMap::new())),
            approval_senders: Arc::new(Mutex::new(HashMap::new())),
            max_concurrent_workers: MAX_CONCURRENT_WORKERS,
        }
    }

    // -- Read APIs -------------------------------------------------------

    pub async fn get_run(&self, id: &RunId) -> Option<Arc<RwLock<RunState>>> {
        self.runs.lock().await.get(id).cloned()
    }

    pub async fn active_run_count(&self) -> usize {
        self.runs.lock().await.len()
    }

    // -- Lifecycle commands ---------------------------------------------

    /// Start a new run. Creates the `WorktreeManager` + `SharedNotes`
    /// for the target repo, persists the initial run row, and spawns
    /// the per-run tokio task. Returns as soon as the task is
    /// spawned — all heavy work happens asynchronously.
    pub async fn submit_task(
        &self,
        task: String,
        repo_path: PathBuf,
    ) -> Result<RunId, OrchestratorError> {
        let master_kind = self
            .settings
            .snapshot()
            .map(|s| s.master_agent)
            .unwrap_or(AgentKind::Claude);

        let master = self
            .registry
            .get(master_kind)
            .await
            .map_err(|e| OrchestratorError::AgentUnavailable(e.to_string()))?;

        let worktree_mgr = crate::worktree::WorktreeManager::new(repo_path.clone())
            .await
            .map_err(|e| OrchestratorError::Worktree(e.to_string()))?;
        let notes = SharedNotes::new(&repo_path);

        let run_id = new_run_id();
        let run_state = RunState::new(
            run_id.clone(),
            task.clone(),
            repo_path.clone(),
            master_kind,
            Arc::new(worktree_mgr),
            Arc::new(notes),
        );
        let started_at = run_state.started_at;

        self.storage
            .insert_run(&NewRun {
                id: run_id.clone(),
                task: task.clone(),
                repo_path: repo_path.to_string_lossy().to_string(),
                master_agent: master_kind,
                status: RunStatus::Planning,
                started_at,
            })
            .await
            .map_err(|e| OrchestratorError::Storage(e.to_string()))?;

        let run_arc = Arc::new(RwLock::new(run_state));
        self.runs
            .lock()
            .await
            .insert(run_id.clone(), run_arc.clone());

        self.event_sink
            .emit(RunEvent::StatusChanged {
                run_id: run_id.clone(),
                status: RunStatus::Planning,
            })
            .await;

        let (approval_tx, approval_rx) = oneshot::channel();
        self.approval_senders
            .lock()
            .await
            .insert(run_id.clone(), approval_tx);

        let deps = LifecycleDeps {
            storage: self.storage.clone(),
            event_sink: self.event_sink.clone(),
            registry: self.registry.clone(),
        };
        let runs_map = self.runs.clone();
        let approval_senders = self.approval_senders.clone();
        let task_run_id = run_id.clone();
        tokio::spawn(async move {
            run_lifecycle(deps, run_arc, master, approval_rx).await;
            // Lifecycle is finished (whatever the outcome); remove
            // from the active map so lookups surface None. The
            // sender map may or may not still contain an entry
            // depending on how we exited — drop it too for good
            // measure.
            runs_map.lock().await.remove(&task_run_id);
            approval_senders.lock().await.remove(&task_run_id);
        });

        Ok(run_id)
    }

    /// Approve a subset of the proposed subtasks. `subtask_ids` must
    /// be a subset of what the master proposed — unknown ids are
    /// silently ignored (logged via master channel by the lifecycle).
    pub async fn approve_subtasks(
        &self,
        run_id: &RunId,
        subtask_ids: Vec<SubtaskId>,
    ) -> Result<(), OrchestratorError> {
        let sender = self
            .approval_senders
            .lock()
            .await
            .remove(run_id)
            .ok_or_else(|| OrchestratorError::RunNotFound(run_id.clone()))?;
        // Send can fail only if the receiver was dropped (lifecycle
        // already exited). Treat that as "too late to approve".
        sender
            .send(ApprovalDecision::Approve { subtask_ids })
            .map_err(|_| OrchestratorError::WrongState {
                run_id: run_id.clone(),
                state: RunStatus::AwaitingApproval,
                expected: "awaiting-approval",
            })?;
        Ok(())
    }

    /// User-rejected plan. Clears notes, marks the run Rejected,
    /// removes from active map.
    pub async fn reject_run(&self, run_id: &RunId) -> Result<(), OrchestratorError> {
        let sender = self
            .approval_senders
            .lock()
            .await
            .remove(run_id)
            .ok_or_else(|| OrchestratorError::RunNotFound(run_id.clone()))?;
        sender
            .send(ApprovalDecision::Reject)
            .map_err(|_| OrchestratorError::WrongState {
                run_id: run_id.clone(),
                state: RunStatus::AwaitingApproval,
                expected: "awaiting-approval",
            })?;
        Ok(())
    }

    /// Fire the run's [`CancellationToken`]. The lifecycle task
    /// notices on its next `.await` branch and transitions to
    /// Cancelled. Idempotent: cancelling a missing or already-cancelled
    /// run is a no-op and returns `Ok(())` so the UI can smash the
    /// button repeatedly without error banners.
    pub async fn cancel_run(&self, run_id: &RunId) -> Result<(), OrchestratorError> {
        let Some(run_arc) = self.get_run(run_id).await else {
            return Ok(());
        };
        let token = run_arc.read().await.cancel_token.clone();
        token.cancel();
        Ok(())
    }
}

#[cfg(test)]
mod init_tests {
    use super::*;
    use crate::detection::Detector;
    use crate::orchestration::events::RecordingEventSink;

    async fn make() -> Orchestrator {
        let settings = Arc::new(SettingsStore::load_at(PathBuf::from(
            "/tmp/whalecode-settings-never-written.json",
        )));
        let storage = Arc::new(Storage::in_memory().await.unwrap());
        let sink = Arc::new(RecordingEventSink::default());
        let registry = Arc::new(DefaultAgentRegistry::new(Arc::new(Detector::new(
            settings.clone(),
        ))));
        Orchestrator::new(settings, storage, sink, registry)
    }

    #[tokio::test]
    async fn new_orchestrator_starts_empty() {
        let orch = make().await;
        assert_eq!(orch.active_run_count().await, 0);
        assert!(orch.get_run(&"nope".into()).await.is_none());
    }
}
