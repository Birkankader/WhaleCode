//! Integration tests for the orchestrator lifecycle.
//!
//! The tests substitute a [`ScriptedRegistry`] + [`ScriptedAgent`]
//! pair for the production detection path. Each scripted agent has
//! canned return values for `plan` / `execute` / `summarize` and
//! never touches a subprocess, so tests run in milliseconds.
//!
//! Each test uses its own tempdir as the repo root and a fresh
//! in-memory SQLite. No external processes, no shared state.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use tempfile::TempDir;
use tokio::process::Command as TokioCommand;
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;

use super::*;
use crate::agents::{
    AgentError, AgentImpl, ExecutionResult, Plan, PlannedSubtask, PlanningContext,
};
use crate::ipc::{AgentKind, RunStatus, SubtaskState};
use crate::orchestration::events::{EventSink, RecordingEventSink, RunEvent};
use crate::orchestration::registry::{AgentRegistry, RegistryError};
use crate::settings::SettingsStore;
use crate::storage::models::Subtask;
use crate::storage::Storage;

// -- Scripted agent ---------------------------------------------------

/// A canned [`AgentImpl`] for tests. Constructed with a builder:
/// `ScriptedAgent::new().with_plan(...).with_execute_result(...)`.
/// Calling a method without the corresponding canned value panics —
/// tests should not reach that code path.
#[derive(Clone)]
struct ScriptedAgent {
    kind: AgentKind,
    plan_outcome: Arc<Mutex<Option<Result<Plan, AgentError>>>>,
    plan_delay: Duration,
}

impl ScriptedAgent {
    fn new(kind: AgentKind) -> Self {
        Self {
            kind,
            plan_outcome: Arc::new(Mutex::new(None)),
            plan_delay: Duration::from_millis(0),
        }
    }

    async fn with_plan(self, outcome: Result<Plan, AgentError>) -> Self {
        *self.plan_outcome.lock().await = Some(outcome);
        self
    }

    /// Inject an artificial delay in `plan()` so tests can observe
    /// cancel-during-planning deterministically.
    fn with_plan_delay(mut self, d: Duration) -> Self {
        self.plan_delay = d;
        self
    }
}

#[async_trait]
impl AgentImpl for ScriptedAgent {
    fn kind(&self) -> AgentKind {
        self.kind
    }
    fn version(&self) -> &str {
        "scripted-0.0.0"
    }

    async fn plan(
        &self,
        _task: &str,
        _context: PlanningContext,
        cancel: CancellationToken,
    ) -> Result<Plan, AgentError> {
        if !self.plan_delay.is_zero() {
            tokio::select! {
                _ = tokio::time::sleep(self.plan_delay) => {},
                _ = cancel.cancelled() => return Err(AgentError::Cancelled),
            }
        }
        self.plan_outcome
            .lock()
            .await
            .take()
            .expect("ScriptedAgent::plan called without with_plan()")
    }

    async fn execute(
        &self,
        _subtask: &Subtask,
        _worktree_path: &Path,
        _shared_notes: &str,
        _log_tx: mpsc::Sender<String>,
        _cancel: CancellationToken,
    ) -> Result<ExecutionResult, AgentError> {
        panic!("ScriptedAgent::execute not supported in 8b tests");
    }

    async fn summarize(
        &self,
        _prompt: &str,
        _cancel: CancellationToken,
    ) -> Result<String, AgentError> {
        panic!("ScriptedAgent::summarize not supported in 8b tests");
    }
}

struct ScriptedRegistry {
    agent: Arc<ScriptedAgent>,
    workers: Vec<AgentKind>,
}

impl ScriptedRegistry {
    fn new(agent: ScriptedAgent, workers: Vec<AgentKind>) -> Self {
        Self {
            agent: Arc::new(agent),
            workers,
        }
    }
}

#[async_trait]
impl AgentRegistry for ScriptedRegistry {
    async fn get(&self, _kind: AgentKind) -> Result<Arc<dyn AgentImpl>, RegistryError> {
        Ok(self.agent.clone())
    }
    async fn available(&self) -> Vec<AgentKind> {
        self.workers.clone()
    }
}

// -- Test harness -----------------------------------------------------

struct Harness {
    orch: Orchestrator,
    sink: Arc<RecordingEventSink>,
    _repo: TempDir,
    repo_path: PathBuf,
    storage: Arc<Storage>,
}

impl Harness {
    async fn new(agent: ScriptedAgent) -> Self {
        let repo = tempfile::tempdir().unwrap();
        // Initialize a real git repo so WorktreeManager::new succeeds.
        for args in [
            vec!["init", "--initial-branch=main"],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "user.name", "Test"],
        ] {
            TokioCommand::new("git")
                .args(&args)
                .current_dir(repo.path())
                .output()
                .await
                .unwrap();
        }
        // A commit so HEAD resolves.
        tokio::fs::write(repo.path().join("seed.txt"), "x").await.unwrap();
        TokioCommand::new("git")
            .args(["add", "."])
            .current_dir(repo.path())
            .output()
            .await
            .unwrap();
        TokioCommand::new("git")
            .args(["commit", "-m", "seed"])
            .current_dir(repo.path())
            .output()
            .await
            .unwrap();

        let settings = Arc::new(SettingsStore::load_at(repo.path().join("settings.json")));
        let storage = Arc::new(Storage::in_memory().await.unwrap());
        let sink = Arc::new(RecordingEventSink::default());
        let registry = Arc::new(ScriptedRegistry::new(
            agent,
            vec![AgentKind::Claude, AgentKind::Codex],
        ));
        let orch = Orchestrator::new(
            settings,
            storage.clone(),
            sink.clone() as Arc<dyn EventSink>,
            registry,
        );
        // macOS /var → /private/var symlink; canonicalize so
        // assertions against `repo_path` match what the orchestrator
        // sees after `WorktreeManager` normalizes it.
        let repo_path = repo.path().canonicalize().unwrap();
        Self {
            orch,
            sink,
            _repo: repo,
            repo_path,
            storage,
        }
    }

    /// Wait for a specific terminal event. Bounded so a bug doesn't
    /// hang the test forever — each arm has its own 3s window.
    async fn await_status(&self, run_id: &RunId, target: RunStatus) {
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            let snap = self.sink.snapshot().await;
            if snap.iter().any(|e| {
                matches!(e,
                    RunEvent::StatusChanged { run_id: r, status }
                    if r == run_id && *status == target
                )
            }) {
                return;
            }
            if std::time::Instant::now() >= deadline {
                panic!(
                    "timed out waiting for StatusChanged({:?}) on {}. Events: {:#?}",
                    target, run_id, snap
                );
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

fn plan_of(n: usize) -> Plan {
    Plan {
        reasoning: "because tests".into(),
        subtasks: (0..n)
            .map(|i| PlannedSubtask {
                title: format!("t{i}"),
                why: format!("why {i}"),
                assigned_worker: AgentKind::Claude,
                dependencies: vec![],
            })
            .collect(),
    }
}

// -- Tests -----------------------------------------------------------

#[tokio::test]
async fn submit_then_reject_walks_through_rejected() {
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(2)))
        .await;
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("add login".into(), h.repo_path.clone())
        .await
        .unwrap();

    h.await_status(&run_id, RunStatus::AwaitingApproval).await;

    // Proposed subtasks landed in SQLite.
    let stored = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    assert_eq!(stored.len(), 2);
    assert!(stored.iter().all(|s| s.state == SubtaskState::Proposed));

    // Notes file exists with the task header.
    let notes_path = h.repo_path.join(".whalecode/notes.md");
    assert!(notes_path.exists());

    h.orch.reject_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Rejected).await;

    // Run is no longer active.
    assert!(h.orch.get_run(&run_id).await.is_none());
    // SQLite reflects the final status.
    let stored = h.storage.get_run(&run_id).await.unwrap().unwrap();
    assert_eq!(stored.status, RunStatus::Rejected);
    assert!(stored.finished_at.is_some());
    // Notes were cleaned up.
    assert!(!notes_path.exists());
}

#[tokio::test]
async fn reject_unknown_run_is_run_not_found() {
    let agent = ScriptedAgent::new(AgentKind::Claude);
    let h = Harness::new(agent).await;
    let err = h.orch.reject_run(&"nope".to_string()).await.unwrap_err();
    assert!(matches!(err, OrchestratorError::RunNotFound(_)));
}

#[tokio::test]
async fn planning_failure_transitions_to_failed() {
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Err(AgentError::TaskFailed {
            reason: "model refused".into(),
        }))
        .await;
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("do the thing".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::Failed).await;

    let stored = h.storage.get_run(&run_id).await.unwrap().unwrap();
    assert_eq!(stored.status, RunStatus::Failed);
    assert!(stored.error.as_deref().unwrap_or_default().contains("model refused"));
    assert!(h.orch.get_run(&run_id).await.is_none());
}

#[tokio::test]
async fn cancel_during_planning_transitions_to_cancelled() {
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(1)))
        .await
        .with_plan_delay(Duration::from_secs(60));
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("slow task".into(), h.repo_path.clone())
        .await
        .unwrap();

    // Give the spawn a moment to reach plan().
    tokio::time::sleep(Duration::from_millis(50)).await;
    h.orch.cancel_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Cancelled).await;

    let stored = h.storage.get_run(&run_id).await.unwrap().unwrap();
    assert_eq!(stored.status, RunStatus::Cancelled);
    assert!(h.orch.get_run(&run_id).await.is_none());
}

#[tokio::test]
async fn cancel_unknown_run_is_noop() {
    let agent = ScriptedAgent::new(AgentKind::Claude);
    let h = Harness::new(agent).await;
    // No panic, no error.
    h.orch.cancel_run(&"ghost".to_string()).await.unwrap();
}

#[tokio::test]
async fn subtasks_proposed_event_carries_plan_data() {
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(3)))
        .await;
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("multi".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;

    let proposed = h
        .sink
        .snapshot()
        .await
        .into_iter()
        .find_map(|e| match e {
            RunEvent::SubtasksProposed { run_id: r, subtasks } if r == run_id => Some(subtasks),
            _ => None,
        })
        .expect("SubtasksProposed event missing");
    assert_eq!(proposed.len(), 3);
    for (i, s) in proposed.iter().enumerate() {
        assert_eq!(s.title, format!("t{i}"));
        assert_eq!(s.assigned_worker, AgentKind::Claude);
        assert!(s.dependencies.is_empty());
    }

    // Clean up.
    h.orch.reject_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Rejected).await;
}
