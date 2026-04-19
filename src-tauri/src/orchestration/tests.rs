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
    /// Write `files` (path relative to worktree → content) into the
    /// worktree and succeed, leaving the tree dirty. The dispatcher's
    /// auto-commit step is what turns these writes into real commits
    /// the merge phase can walk — this is deliberate: prod CLI agents
    /// don't self-commit either, so the test scaffold must not cheat.
    /// If the auto-commit logic regresses (0-files bug), the merge
    /// tests in this file break instead of silently passing.
    OkWrite {
        summary: String,
        files: Vec<(PathBuf, String)>,
    },
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
            ExecuteScript::OkWrite { summary, files } => {
                // Write files but leave them uncommitted. The dispatcher's
                // auto-commit is responsible for turning these writes into
                // a real commit on the worktree branch. Matches prod
                // behavior: real CLI agents typically don't commit their
                // own work either.
                for (rel, content) in &files {
                    let abs = _worktree_path.join(rel);
                    if let Some(parent) = abs.parent() {
                        tokio::fs::create_dir_all(parent).await.map_err(|e| {
                            AgentError::TaskFailed {
                                reason: format!("mkdir {}: {e}", parent.display()),
                            }
                        })?;
                    }
                    tokio::fs::write(&abs, content).await.map_err(|e| {
                        AgentError::TaskFailed {
                            reason: format!("write {}: {e}", abs.display()),
                        }
                    })?;
                }
                Ok(ExecutionResult {
                    summary,
                    files_changed: files.iter().map(|(p, _)| p.clone()).collect(),
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
        Self::new_with_apply_timeout(agent, None).await
    }

    async fn new_with_apply_timeout(
        agent: ScriptedAgent,
        apply_timeout: Option<Duration>,
    ) -> Self {
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
        let mut orch = Orchestrator::new(
            settings,
            storage.clone(),
            sink.clone() as Arc<dyn EventSink>,
            registry,
        );
        if let Some(t) = apply_timeout {
            orch.set_apply_timeout(t);
        }
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
    // 6 independent subtasks, each sleeping 250ms. Cap is 4 (constant
    // in mod.rs). Probe should observe a peak of at most 4. Delay is
    // generous because the full suite spawns git subprocesses on every
    // merge-phase test — if the scheduler is starved the probe can see
    // serialized execution otherwise.
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
                    delay: Duration::from_millis(250),
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
async fn cancel_during_running_cleans_up_worktrees() {
    // Regression: finalize_cancelled must tear down the worktrees the
    // dispatcher created between approval and cancel. Before the fix
    // these leaked on disk silently.
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(2)))
        .await
        .with_execute_default(ExecuteScript::Block)
        .await;
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("cancel-during-running".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let ids: Vec<SubtaskId> = subs.iter().map(|s| s.id.clone()).collect();
    h.orch.approve_subtasks(&run_id, ids).await.unwrap();
    h.await_status(&run_id, RunStatus::Running).await;

    // Let the dispatcher spawn at least one worker so a worktree is
    // actually on disk — otherwise the assertion below is a tautology.
    let wt_dir = h.repo_path.join(".whalecode-worktrees");
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while !wt_dir.exists() && std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(wt_dir.exists(), "dispatcher should have created a worktree");

    h.orch.cancel_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Cancelled).await;

    assert!(!wt_dir.exists(), "worktrees must be cleaned after cancel");
    assert!(!h.repo_path.join(".whalecode/notes.md").exists());
}

#[tokio::test]
async fn worker_failure_cleans_up_worktrees() {
    // Regression: finalize_failed must tear down worktrees the
    // dispatcher created for the failing (and any in-flight) subtask.
    // Before the fix these leaked on disk.
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(1)))
        .await
        .with_execute("t0", ExecuteScript::Fail("boom".into()))
        .await;
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("worker-fail".into(), h.repo_path.clone())
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
    assert!(
        !h.repo_path.join(".whalecode-worktrees").exists(),
        "worktrees must be cleaned after worker failure"
    );
    assert!(!h.repo_path.join(".whalecode/notes.md").exists());
}

// -- 8d: merge / apply / discard / cancel paths ------------------------
//
// These tests drive the run through to Merging and then exercise
// apply/discard/cancel/timeout. Each uses `ExecuteScript::OkWrite` so
// every subtask has a real branch with real commits for `merge_all` to
// walk. Assertions target terminal storage state, event transcript, and
// on-disk cleanup.

/// Approve every proposed subtask, then wait for Merging. Waits for
/// AwaitingApproval first so we query storage after the lifecycle task
/// has persisted the subtasks.
async fn approve_all(h: &Harness, run_id: &RunId) {
    h.await_status(run_id, RunStatus::AwaitingApproval).await;
    let subs = h.storage.list_subtasks_for_run(run_id).await.unwrap();
    let ids: Vec<SubtaskId> = subs.iter().map(|s| s.id.clone()).collect();
    h.orch.approve_subtasks(run_id, ids).await.unwrap();
    h.await_status(run_id, RunStatus::Merging).await;
}

/// Build a scripted agent whose execute for `title` writes `files`
/// into the worktree and commits.
async fn agent_writing(specs: &[(&str, Vec<(&str, &str)>)]) -> ScriptedAgent {
    let titles: Vec<(&str, &[usize])> = specs.iter().map(|(t, _)| (*t, &[][..])).collect();
    let mut agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_with_deps(&titles)))
        .await;
    for (title, files) in specs {
        agent = agent
            .with_execute(
                title,
                ExecuteScript::OkWrite {
                    summary: format!("{title} done"),
                    files: files
                        .iter()
                        .map(|(p, c)| (PathBuf::from(*p), (*c).to_string()))
                        .collect(),
                },
            )
            .await;
    }
    agent
}

/// Extract a single event matching the closure, `panic!`-ing with the
/// full transcript if none is present. Used to hunt for DiffReady /
/// Completed payloads.
async fn expect_event<F, T>(h: &Harness, run_id: &RunId, matcher: F) -> T
where
    F: Fn(&RunEvent) -> Option<T>,
{
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        let snap = h.sink.snapshot().await;
        if let Some(found) = snap
            .iter()
            .filter(|e| e.run_id() == run_id)
            .find_map(&matcher)
        {
            return found;
        }
        if std::time::Instant::now() >= deadline {
            panic!("event not found on {run_id}. Transcript: {snap:#?}");
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn apply_happy_path_reaches_done_with_summary() {
    let agent = agent_writing(&[
        ("t0", vec![("a.txt", "hello\n")]),
        ("t1", vec![("b.txt", "world\n")]),
    ])
    .await;
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("two writes".into(), h.repo_path.clone())
        .await
        .unwrap();
    approve_all(&h, &run_id).await;

    // Apply once DiffReady has been emitted.
    expect_event(&h, &run_id, |e| match e {
        RunEvent::DiffReady { files, .. } => Some(files.clone()),
        _ => None,
    })
    .await;
    h.orch.apply_run(&run_id).await.unwrap();

    h.await_status(&run_id, RunStatus::Done).await;

    // Completed event payload.
    let summary = expect_event(&h, &run_id, |e| match e {
        RunEvent::Completed { summary, .. } => Some(summary.clone()),
        _ => None,
    })
    .await;
    assert_eq!(summary.subtask_count, 2);
    assert_eq!(summary.commits_created, 2);
    assert_eq!(summary.files_changed, 2);

    // Storage terminal state.
    let stored = h.storage.get_run(&run_id).await.unwrap().unwrap();
    assert_eq!(stored.status, RunStatus::Done);
    assert!(stored.finished_at.is_some());
    assert!(stored.error.is_none());

    // Worktrees cleaned up.
    let wt_dir = h.repo_path.join(".whalecode-worktrees");
    assert!(!wt_dir.exists(), "worktrees dir should be gone after Done");
    // Notes file gone.
    assert!(!h.repo_path.join(".whalecode/notes.md").exists());
    // Active runs map cleared.
    assert!(h.orch.get_run(&run_id).await.is_none());

    // Base branch actually contains the merged content.
    assert_eq!(
        tokio::fs::read_to_string(h.repo_path.join("a.txt"))
            .await
            .unwrap(),
        "hello\n"
    );
    assert_eq!(
        tokio::fs::read_to_string(h.repo_path.join("b.txt"))
            .await
            .unwrap(),
        "world\n"
    );
}

#[tokio::test]
async fn apply_conflict_keeps_run_in_merging_and_emits_merge_conflict() {
    // Two subtasks write the SAME file with DIFFERENT content →
    // merge of the second branch conflicts.
    let agent = agent_writing(&[
        ("t0", vec![("shared.txt", "line-from-t0\n")]),
        ("t1", vec![("shared.txt", "line-from-t1\n")]),
    ])
    .await;
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("conflict".into(), h.repo_path.clone())
        .await
        .unwrap();
    approve_all(&h, &run_id).await;
    expect_event(&h, &run_id, |e| match e {
        RunEvent::DiffReady { .. } => Some(()),
        _ => None,
    })
    .await;
    h.orch.apply_run(&run_id).await.unwrap();

    // MergeConflict event fires.
    let files = expect_event(&h, &run_id, |e| match e {
        RunEvent::MergeConflict { files, .. } => Some(files.clone()),
        _ => None,
    })
    .await;
    assert!(files.iter().any(|p| p.to_string_lossy() == "shared.txt"));

    // Run is NOT terminal — stays in Merging, awaiting the user's next
    // click. Give the lifecycle a beat to settle before asserting.
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(h.orch.get_run(&run_id).await.is_some(), "run should still be active");
    let stored = h.storage.get_run(&run_id).await.unwrap().unwrap();
    assert_eq!(stored.status, RunStatus::Merging);
    // Conflict summary persisted on the `error` column (dual-purpose
    // for Merging-with-conflict, documented on Storage::update_run_error).
    assert!(
        stored
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("shared.txt"),
        "error column should carry conflict summary, got {:?}",
        stored.error
    );

    // Worktrees preserved so the user can inspect.
    let wt_dir = h.repo_path.join(".whalecode-worktrees");
    assert!(wt_dir.exists(), "worktrees should stay on conflict");

    // Clean up: discard to let the task shut down.
    h.orch.discard_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Rejected).await;
}

#[tokio::test]
async fn discard_after_conflict_reaches_rejected_and_cleans_up() {
    let agent = agent_writing(&[
        ("t0", vec![("shared.txt", "a\n")]),
        ("t1", vec![("shared.txt", "b\n")]),
    ])
    .await;
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("conflict then discard".into(), h.repo_path.clone())
        .await
        .unwrap();
    approve_all(&h, &run_id).await;
    expect_event(&h, &run_id, |e| match e {
        RunEvent::DiffReady { .. } => Some(()),
        _ => None,
    })
    .await;
    h.orch.apply_run(&run_id).await.unwrap();
    expect_event(&h, &run_id, |e| match e {
        RunEvent::MergeConflict { .. } => Some(()),
        _ => None,
    })
    .await;

    // Now discard. The merge phase reinstalled a fresh oneshot after
    // the conflict, so this click lands cleanly.
    h.orch.discard_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Rejected).await;

    let stored = h.storage.get_run(&run_id).await.unwrap().unwrap();
    assert_eq!(stored.status, RunStatus::Rejected);
    let wt_dir = h.repo_path.join(".whalecode-worktrees");
    assert!(!wt_dir.exists(), "worktrees should be cleaned on discard");
    assert!(!h.repo_path.join(".whalecode/notes.md").exists());
}

#[tokio::test]
async fn discard_before_merge_reaches_rejected() {
    let agent = agent_writing(&[("t0", vec![("a.txt", "a\n")])]).await;
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("discard no merge".into(), h.repo_path.clone())
        .await
        .unwrap();
    approve_all(&h, &run_id).await;
    expect_event(&h, &run_id, |e| match e {
        RunEvent::DiffReady { .. } => Some(()),
        _ => None,
    })
    .await;

    // Never call apply. Go straight to discard.
    h.orch.discard_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Rejected).await;

    let stored = h.storage.get_run(&run_id).await.unwrap().unwrap();
    assert_eq!(stored.status, RunStatus::Rejected);
    assert!(!h.repo_path.join(".whalecode-worktrees").exists());
}

#[tokio::test]
async fn cancel_while_awaiting_apply_decision_reaches_cancelled() {
    let agent = agent_writing(&[("t0", vec![("a.txt", "a\n")])]).await;
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("cancel in merging".into(), h.repo_path.clone())
        .await
        .unwrap();
    approve_all(&h, &run_id).await;
    expect_event(&h, &run_id, |e| match e {
        RunEvent::DiffReady { .. } => Some(()),
        _ => None,
    })
    .await;

    h.orch.cancel_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Cancelled).await;

    let stored = h.storage.get_run(&run_id).await.unwrap().unwrap();
    assert_eq!(stored.status, RunStatus::Cancelled);
    assert!(!h.repo_path.join(".whalecode-worktrees").exists());
}

#[tokio::test]
async fn cancel_after_apply_click_still_reaches_cancelled() {
    // Cancel fires after apply_run but merge_all is tiny so it
    // generally completes first — we check the run_id disappears from
    // the active map in either Cancelled or Done form. Per spec, once
    // merge_all finishes we check the cancel token and route to
    // Cancelled. This test accepts either terminal status as valid;
    // the important invariant is the run finalizes and cleanup runs.
    let agent = agent_writing(&[("t0", vec![("a.txt", "a\n")])]).await;
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("cancel during merge".into(), h.repo_path.clone())
        .await
        .unwrap();
    approve_all(&h, &run_id).await;
    expect_event(&h, &run_id, |e| match e {
        RunEvent::DiffReady { .. } => Some(()),
        _ => None,
    })
    .await;

    // Fire cancel and apply back-to-back. cancel_run is a no-op on an
    // already-terminal run, so even if apply wins the race we still
    // land in a valid terminal state.
    h.orch.apply_run(&run_id).await.unwrap();
    h.orch.cancel_run(&run_id).await.unwrap();

    // Wait for *any* terminal state.
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        let stored = h.storage.get_run(&run_id).await.unwrap().unwrap();
        if matches!(
            stored.status,
            RunStatus::Cancelled | RunStatus::Done | RunStatus::Rejected
        ) {
            // Cleanup ran.
            assert!(!h.repo_path.join(".whalecode-worktrees").exists());
            return;
        }
        if std::time::Instant::now() >= deadline {
            panic!("run did not finalize, last status {:?}", stored.status);
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn apply_timeout_auto_discards_to_rejected() {
    let agent = agent_writing(&[("t0", vec![("a.txt", "a\n")])]).await;
    // 200ms timeout — long enough to dispatch + merge-phase setup,
    // short enough to observe.
    let h = Harness::new_with_apply_timeout(agent, Some(Duration::from_millis(200))).await;

    let run_id = h
        .orch
        .submit_task("timeout".into(), h.repo_path.clone())
        .await
        .unwrap();
    approve_all(&h, &run_id).await;
    expect_event(&h, &run_id, |e| match e {
        RunEvent::DiffReady { .. } => Some(()),
        _ => None,
    })
    .await;

    // Don't click. Wait for auto-discard → Rejected.
    h.await_status(&run_id, RunStatus::Rejected).await;
    let stored = h.storage.get_run(&run_id).await.unwrap().unwrap();
    assert_eq!(stored.status, RunStatus::Rejected);
    assert!(!h.repo_path.join(".whalecode-worktrees").exists());
}

#[tokio::test]
async fn diff_ready_deduplicates_paths_last_write_wins() {
    // Two subtasks both touch `shared.txt`, but t1 depends on t0, so
    // t1's branch is built on top of t0 (no conflict). DiffReady should
    // list `shared.txt` exactly once.
    let mut agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_with_deps(&[("t0", &[]), ("t1", &[0])])))
        .await;
    agent = agent
        .with_execute(
            "t0",
            ExecuteScript::OkWrite {
                summary: "t0".into(),
                files: vec![(PathBuf::from("shared.txt"), "v0\n".into())],
            },
        )
        .await
        .with_execute(
            "t1",
            ExecuteScript::OkWrite {
                summary: "t1".into(),
                files: vec![(PathBuf::from("shared.txt"), "v1\n".into())],
            },
        )
        .await;
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("dedup".into(), h.repo_path.clone())
        .await
        .unwrap();
    approve_all(&h, &run_id).await;

    let files = expect_event(&h, &run_id, |e| match e {
        RunEvent::DiffReady { files, .. } => Some(files.clone()),
        _ => None,
    })
    .await;
    let shared_entries: Vec<_> = files.iter().filter(|f| f.path == "shared.txt").collect();
    assert_eq!(
        shared_entries.len(),
        1,
        "shared.txt must appear exactly once after dedup, got {files:#?}"
    );

    // Clean up.
    h.orch.discard_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Rejected).await;
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

/// Enforces the `submit_task` no-emit-before-return invariant.
///
/// The frontend attaches its `RunSubscription` after it receives the
/// `RunId` from `submit_task`. If any event fires during the sync body
/// of `submit_task`, the frontend misses it. This test runs on a
/// current-thread runtime so the spawned `run_lifecycle` cannot start
/// until we explicitly yield; that lets us assert exact event counts
/// at the moment `submit_task.await` returns.
///
/// A regression here means someone added an emit inside `submit_task`
/// — move it into `run_lifecycle` (or a task spawned from there), past
/// the `yield_now().await` at the top of that function.
#[tokio::test(flavor = "current_thread")]
async fn submit_task_emits_nothing_before_returning_run_id() {
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(1)))
        .await
        // Keep planning hanging so the test window only observes the
        // pre-plan events (StatusChanged{Planning} + the first
        // MasterLog). Cancel on the way out.
        .with_plan_delay(Duration::from_secs(60));
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("check invariant".into(), h.repo_path.clone())
        .await
        .unwrap();

    // IMMEDIATE assertion: `submit_task` has returned, but the spawned
    // lifecycle task hasn't been polled yet (current-thread runtime,
    // no explicit yield between here and the submit_task above). The
    // sink must be empty.
    let immediate = h.sink.snapshot().await;
    assert!(
        immediate.is_empty(),
        "submit_task emitted {} event(s) before returning RunId — the \
         attach-before-first-event invariant is broken. Events: {:#?}",
        immediate.len(),
        immediate
    );

    // Now let the lifecycle task run. Its first act is
    // `yield_now().await` followed by `emit StatusChanged{Planning}`.
    // `await_status` polls with sleeps, giving the scheduler room.
    h.await_status(&run_id, RunStatus::Planning).await;

    // The very first event on the sink must be StatusChanged{Planning}
    // for this run — nothing else is allowed to slip in front of it.
    let snap = h.sink.snapshot().await;
    assert!(
        !snap.is_empty(),
        "no events after awaiting Planning transition"
    );
    match &snap[0] {
        RunEvent::StatusChanged {
            run_id: r,
            status: RunStatus::Planning,
        } => {
            assert_eq!(r, &run_id);
        }
        other => panic!(
            "first event should be StatusChanged{{Planning}}, got {:#?}. Full: {:#?}",
            other, snap
        ),
    }

    // Clean up the pending run so the harness doesn't leave a 60-second
    // planner hanging after the test body returns.
    h.orch.cancel_run(&run_id).await.ok();
}
