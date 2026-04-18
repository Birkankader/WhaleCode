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

/// How `execute()` should behave for a specific subtask title.
#[derive(Clone)]
enum ExecuteScript {
    /// Succeed after `delay`, with this summary.
    Ok { summary: String, delay: Duration },
    /// Fail synchronously with this error string.
    Fail(String),
    /// Block on `cancel` forever; only returns [`AgentError::Cancelled`]
    /// when the token fires. For cancel-mid-dispatch tests.
    Block,
}

/// Tracks how many scripted `execute()` calls are in flight at once.
/// Tests that care about parallelism read `max` after the run ends.
#[derive(Debug, Default)]
struct ConcurrencyProbe {
    current: std::sync::atomic::AtomicUsize,
    max: std::sync::atomic::AtomicUsize,
}

impl ConcurrencyProbe {
    fn enter(&self) {
        use std::sync::atomic::Ordering;
        let n = self.current.fetch_add(1, Ordering::SeqCst) + 1;
        // Classic compare-and-swap hillclimb to keep `max` at the peak
        // without a lock.
        let mut cur_max = self.max.load(Ordering::SeqCst);
        while n > cur_max {
            match self.max.compare_exchange(
                cur_max,
                n,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => break,
                Err(observed) => cur_max = observed,
            }
        }
    }
    fn exit(&self) {
        self.current
            .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
    fn peak(&self) -> usize {
        self.max.load(std::sync::atomic::Ordering::SeqCst)
    }
}

/// A canned [`AgentImpl`] for tests. Constructed with a builder:
/// `ScriptedAgent::new().with_plan(...).with_execute(...)`.
/// Calling a method without the corresponding canned value panics —
/// tests should not reach that code path.
#[derive(Clone)]
struct ScriptedAgent {
    kind: AgentKind,
    plan_outcome: Arc<Mutex<Option<Result<Plan, AgentError>>>>,
    plan_delay: Duration,
    /// Per-subtask-title execute scripts.
    execute_scripts: Arc<Mutex<std::collections::HashMap<String, ExecuteScript>>>,
    /// Default script when the title isn't found in `execute_scripts`.
    /// `None` means panic on unknown title.
    execute_default: Arc<Mutex<Option<ExecuteScript>>>,
    /// Optional concurrency observer — when set, `execute` enters/exits
    /// on every call so tests can assert the cap.
    concurrency: Arc<Mutex<Option<Arc<ConcurrencyProbe>>>>,
    /// Canned `summarize()` return. If `None`, `summarize` panics.
    summarize_outcome: Arc<Mutex<Option<Result<String, AgentError>>>>,
}

impl ScriptedAgent {
    fn new(kind: AgentKind) -> Self {
        Self {
            kind,
            plan_outcome: Arc::new(Mutex::new(None)),
            plan_delay: Duration::from_millis(0),
            execute_scripts: Arc::new(Mutex::new(std::collections::HashMap::new())),
            execute_default: Arc::new(Mutex::new(None)),
            concurrency: Arc::new(Mutex::new(None)),
            summarize_outcome: Arc::new(Mutex::new(None)),
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

    async fn with_execute(self, title: &str, script: ExecuteScript) -> Self {
        self.execute_scripts
            .lock()
            .await
            .insert(title.to_string(), script);
        self
    }

    async fn with_execute_default(self, script: ExecuteScript) -> Self {
        *self.execute_default.lock().await = Some(script);
        self
    }

    async fn with_concurrency_probe(self, probe: Arc<ConcurrencyProbe>) -> Self {
        *self.concurrency.lock().await = Some(probe);
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
        subtask: &Subtask,
        _worktree_path: &Path,
        _shared_notes: &str,
        _log_tx: mpsc::Sender<String>,
        cancel: CancellationToken,
    ) -> Result<ExecutionResult, AgentError> {
        let script = {
            let table = self.execute_scripts.lock().await;
            table.get(&subtask.title).cloned()
        };
        let script = match script {
            Some(s) => s,
            None => self
                .execute_default
                .lock()
                .await
                .clone()
                .unwrap_or_else(|| panic!("no execute script for {}", subtask.title)),
        };

        let probe = self.concurrency.lock().await.clone();
        if let Some(p) = &probe {
            p.enter();
        }
        struct Guard(Option<Arc<ConcurrencyProbe>>);
        impl Drop for Guard {
            fn drop(&mut self) {
                if let Some(p) = self.0.take() {
                    p.exit();
                }
            }
        }
        let _g = Guard(probe);

        match script {
            ExecuteScript::Ok { summary, delay } => {
                if !delay.is_zero() {
                    tokio::select! {
                        _ = tokio::time::sleep(delay) => {}
                        _ = cancel.cancelled() => return Err(AgentError::Cancelled),
                    }
                }
                Ok(ExecutionResult {
                    summary,
                    files_changed: vec![],
                })
            }
            ExecuteScript::Fail(msg) => Err(AgentError::TaskFailed { reason: msg }),
            ExecuteScript::Block => {
                cancel.cancelled().await;
                Err(AgentError::Cancelled)
            }
        }
    }

    async fn summarize(
        &self,
        _prompt: &str,
        _cancel: CancellationToken,
    ) -> Result<String, AgentError> {
        self.summarize_outcome
            .lock()
            .await
            .take()
            .expect("ScriptedAgent::summarize called without scripted outcome")
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

// -- 8c: dispatcher tests ---------------------------------------------
//
// These tests use the scripted agent's `execute()` script. The
// approval path is driven through the public Orchestrator API so
// we're exercising the full lifecycle, not just the dispatcher in
// isolation.

fn plan_with_deps(subtasks: &[(&str, &[usize])]) -> Plan {
    Plan {
        reasoning: "because tests".into(),
        subtasks: subtasks
            .iter()
            .map(|(title, deps)| PlannedSubtask {
                title: (*title).into(),
                why: format!("why {title}"),
                assigned_worker: AgentKind::Claude,
                dependencies: deps.to_vec(),
            })
            .collect(),
    }
}

/// Wait for the storage to reflect a final state for every proposed
/// subtask AND for the run itself to be terminal (or Merging). Each
/// sub-check has its own 5s bound.
async fn await_all_subtasks_terminal(h: &Harness, run_id: &RunId) {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let subs = h.storage.list_subtasks_for_run(run_id).await.unwrap();
        if !subs.is_empty()
            && subs.iter().all(|s| {
                matches!(
                    s.state,
                    SubtaskState::Done | SubtaskState::Failed | SubtaskState::Skipped
                )
            })
        {
            return;
        }
        if std::time::Instant::now() >= deadline {
            panic!("subtasks not all terminal: {subs:#?}");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn approve_all_dispatches_and_reaches_merging() {
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(2)))
        .await
        .with_execute(
            "t0",
            ExecuteScript::Ok {
                summary: "did t0".into(),
                delay: Duration::from_millis(0),
            },
        )
        .await
        .with_execute(
            "t1",
            ExecuteScript::Ok {
                summary: "did t1".into(),
                delay: Duration::from_millis(0),
            },
        )
        .await;
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("two tasks".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;

    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let ids: Vec<SubtaskId> = subs.iter().map(|s| s.id.clone()).collect();
    h.orch.approve_subtasks(&run_id, ids).await.unwrap();

    h.await_status(&run_id, RunStatus::Merging).await;
    await_all_subtasks_terminal(&h, &run_id).await;

    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    for s in &subs {
        assert_eq!(s.state, SubtaskState::Done, "subtask {} not Done", s.title);
        assert!(s.started_at.is_some());
        assert!(s.finished_at.is_some());
    }
}

#[tokio::test]
async fn dispatcher_respects_dependency_order() {
    // t0 sleeps 100ms; t1 depends on t0. t1 must not start until
    // t0 finishes.
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_with_deps(&[("t0", &[]), ("t1", &[0])])))
        .await
        .with_execute(
            "t0",
            ExecuteScript::Ok {
                summary: "t0 done".into(),
                delay: Duration::from_millis(100),
            },
        )
        .await
        .with_execute(
            "t1",
            ExecuteScript::Ok {
                summary: "t1 done".into(),
                delay: Duration::from_millis(0),
            },
        )
        .await;
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("ordered".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let ids: Vec<SubtaskId> = subs.iter().map(|s| s.id.clone()).collect();
    h.orch.approve_subtasks(&run_id, ids).await.unwrap();
    h.await_status(&run_id, RunStatus::Merging).await;

    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let t0 = subs.iter().find(|s| s.title == "t0").unwrap();
    let t1 = subs.iter().find(|s| s.title == "t1").unwrap();
    let t0_finished = chrono::DateTime::parse_from_rfc3339(t0.finished_at.as_ref().unwrap())
        .unwrap();
    let t1_started = chrono::DateTime::parse_from_rfc3339(t1.started_at.as_ref().unwrap())
        .unwrap();
    assert!(
        t1_started >= t0_finished,
        "t1 started at {t1_started} before t0 finished at {t0_finished}"
    );
}

#[tokio::test]
async fn dispatcher_respects_concurrency_cap() {
    // 6 independent subtasks, each sleeping 50ms. Cap is 4 (constant
    // in mod.rs). Probe should observe a peak of at most 4.
    let probe = Arc::new(ConcurrencyProbe::default());
    let empty: &[usize] = &[];
    let titles: Vec<(&str, &[usize])> = vec![
        ("t0", empty),
        ("t1", empty),
        ("t2", empty),
        ("t3", empty),
        ("t4", empty),
        ("t5", empty),
    ];
    let mut agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_with_deps(&titles)))
        .await
        .with_concurrency_probe(probe.clone())
        .await;
    for (t, _) in &titles {
        agent = agent
            .with_execute(
                t,
                ExecuteScript::Ok {
                    summary: format!("{t} done"),
                    delay: Duration::from_millis(50),
                },
            )
            .await;
    }
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("fanout".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let ids: Vec<SubtaskId> = subs.iter().map(|s| s.id.clone()).collect();
    h.orch.approve_subtasks(&run_id, ids).await.unwrap();
    h.await_status(&run_id, RunStatus::Merging).await;

    assert!(
        probe.peak() <= MAX_CONCURRENT_WORKERS,
        "peak concurrency {} exceeded cap {}",
        probe.peak(),
        MAX_CONCURRENT_WORKERS
    );
    // Sanity: we really did run them all in parallel, not one at a time.
    assert!(
        probe.peak() >= 2,
        "expected parallel dispatch, peak was {}",
        probe.peak()
    );
}

#[tokio::test]
async fn worker_failure_fails_the_run_fast() {
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(2)))
        .await
        .with_execute("t0", ExecuteScript::Fail("boom".into()))
        .await
        .with_execute_default(ExecuteScript::Ok {
            summary: "ok".into(),
            delay: Duration::from_millis(200),
        })
        .await;
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("failing".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let ids: Vec<SubtaskId> = subs.iter().map(|s| s.id.clone()).collect();
    h.orch.approve_subtasks(&run_id, ids).await.unwrap();

    h.await_status(&run_id, RunStatus::Failed).await;
    let stored = h.storage.get_run(&run_id).await.unwrap().unwrap();
    assert_eq!(stored.status, RunStatus::Failed);
    assert!(stored.error.as_deref().unwrap_or_default().contains("boom"));
}

#[tokio::test]
async fn cancel_during_dispatch_transitions_to_cancelled() {
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(2)))
        .await
        .with_execute_default(ExecuteScript::Block)
        .await;
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("cancel-me".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let ids: Vec<SubtaskId> = subs.iter().map(|s| s.id.clone()).collect();
    h.orch.approve_subtasks(&run_id, ids).await.unwrap();
    h.await_status(&run_id, RunStatus::Running).await;

    // Give the dispatcher a moment to spawn workers.
    tokio::time::sleep(Duration::from_millis(80)).await;
    h.orch.cancel_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Cancelled).await;

    let stored = h.storage.get_run(&run_id).await.unwrap().unwrap();
    assert_eq!(stored.status, RunStatus::Cancelled);
}

#[tokio::test]
async fn unapproved_parent_cascades_skip_to_children() {
    // t0 unapproved → Skipped. t1 depends on t0 → should cascade to
    // Skipped even though it was approved.
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_with_deps(&[("t0", &[]), ("t1", &[0])])))
        .await
        .with_execute(
            "t1",
            ExecuteScript::Ok {
                summary: "should not run".into(),
                delay: Duration::from_millis(0),
            },
        )
        .await;
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("cascade".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let t1_id = subs
        .iter()
        .find(|s| s.title == "t1")
        .map(|s| s.id.clone())
        .unwrap();
    h.orch
        .approve_subtasks(&run_id, vec![t1_id])
        .await
        .unwrap();

    h.await_status(&run_id, RunStatus::Merging).await;
    await_all_subtasks_terminal(&h, &run_id).await;

    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    for s in &subs {
        assert_eq!(
            s.state,
            SubtaskState::Skipped,
            "{} should have been skipped",
            s.title
        );
    }
}
