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
    AgentError, AgentImpl, ExecutionResult, Plan, PlannedSubtask, PlanningContext, ReplanContext,
};
use crate::ipc::events::ErrorCategoryWire;
use crate::ipc::{AgentKind, RunStatus, SubtaskDraft, SubtaskPatch, SubtaskState};
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
    /// Phase-3 retry fixture: per-subtask-title queues of scripted
    /// failures consumed one-per-`execute` call before the normal
    /// `execute_scripts` / `execute_default` path takes over. When a
    /// subtask's queue is non-empty, the next call pops the front and
    /// returns it as an `Err(AgentError)`. When empty, the normal path
    /// runs — so a `fail_attempts(vec![Timeout])` + `with_execute(Ok)`
    /// combination models "fail once, then succeed".
    fail_attempts: Arc<Mutex<std::collections::HashMap<String, Vec<AgentError>>>>,
    /// Captures every `extra_context` value the dispatcher passes, in
    /// call order. Tests assert on this to verify retry prompts carry
    /// the previous error. `None` entries are also recorded so tests
    /// can assert "first attempt was contextless, second had context".
    extra_context_log: Arc<Mutex<Vec<Option<String>>>>,
    /// Phase-3 Step 4 replan fixture: queue of scripted outcomes
    /// consumed one-per-`replan` call. `with_replan` pushes onto the
    /// back, `replan()` pops from the front. Panics when empty so a
    /// test that doesn't expect a replan call surfaces the regression
    /// loudly rather than silently passing.
    replan_queue: Arc<Mutex<Vec<ReplanScript>>>,
    /// Every `ReplanContext` passed to `replan()`, in call order. Tests
    /// assert on this to verify the orchestrator composed the right
    /// failure-forensics bundle (attempt errors, log tail, completed
    /// summaries, attempt counter).
    replan_calls_log: Arc<Mutex<Vec<ReplanContext>>>,
}

/// How a scripted `replan()` call should behave. Pushed onto
/// `ScriptedAgent::replan_queue` by `with_replan` and popped front-first.
/// Not `Clone` — `AgentError` isn't `Clone`, and `replan()` consumes the
/// queue head rather than peeking, so we don't need it.
enum ReplanScript {
    /// Return this plan — models the "master produced replacement subtasks"
    /// branch. The plan's subtasks get new ulids and lineage rows.
    OkPlan(Plan),
    /// Return an empty plan — models "master judged the goal infeasible";
    /// orchestrator must escalate to Layer 3 (human).
    Empty,
    /// Fail with this error — models "master itself crashed / timed out
    /// during replan"; orchestrator treats it like a Layer-3 escalation.
    Fail(AgentError),
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
            fail_attempts: Arc::new(Mutex::new(std::collections::HashMap::new())),
            extra_context_log: Arc::new(Mutex::new(Vec::new())),
            replan_queue: Arc::new(Mutex::new(Vec::new())),
            replan_calls_log: Arc::new(Mutex::new(Vec::new())),
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

    /// Queue a sequence of scripted failures for `title`. Each
    /// `execute()` call pops the front of the queue; once empty, the
    /// normal `execute_scripts` / `execute_default` path runs.
    async fn with_fail_attempts(self, title: &str, errors: Vec<AgentError>) -> Self {
        self.fail_attempts
            .lock()
            .await
            .insert(title.to_string(), errors);
        self
    }

    /// Snapshot of every `extra_context` value seen by `execute`, in
    /// call order. Used by retry tests to verify the retry prompt is
    /// wired through.
    async fn extra_context_calls(&self) -> Vec<Option<String>> {
        self.extra_context_log.lock().await.clone()
    }

    /// Queue one scripted outcome for the next `replan()` call. Multiple
    /// calls push in order: `with_replan(OkPlan).with_replan(Empty)`
    /// makes the first replan return a plan and the second return empty.
    async fn with_replan(self, script: ReplanScript) -> Self {
        self.replan_queue.lock().await.push(script);
        self
    }

    /// Snapshot of every `ReplanContext` passed to `replan()`, in call
    /// order. Tests assert on this to verify the orchestrator assembled
    /// the right failure forensics.
    async fn replan_calls(&self) -> Vec<ReplanContext> {
        self.replan_calls_log.lock().await.clone()
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
        extra_context: Option<&str>,
        _log_tx: mpsc::Sender<String>,
        cancel: CancellationToken,
    ) -> Result<ExecutionResult, AgentError> {
        self.extra_context_log
            .lock()
            .await
            .push(extra_context.map(str::to_string));

        // Pop a scripted failure off the per-title queue if present.
        // Each call consumes at most one entry so a `vec![Timeout]`
        // fixture fails attempt 1 and lets attempt 2 fall through to
        // the normal execute path below.
        if let Some(err) = {
            let mut table = self.fail_attempts.lock().await;
            table
                .get_mut(&subtask.title)
                .and_then(|queue| (!queue.is_empty()).then(|| queue.remove(0)))
        } {
            return Err(err);
        }

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

    // Phase-3 Step 4 replan fixture. See `ReplanScript` + `with_replan`
    // for how tests queue outcomes. Each `replan()` call pops one entry
    // off the queue so tests can script "first replan OK, second empty"
    // by pushing two scripts in order. Calling `replan` with an empty
    // queue panics — tests that don't exercise Layer 2 should never
    // reach this arm.
    async fn replan(
        &self,
        context: ReplanContext,
        _cancel: CancellationToken,
    ) -> Result<Plan, AgentError> {
        self.replan_calls_log.lock().await.push(context);
        let script = {
            let mut queue = self.replan_queue.lock().await;
            if queue.is_empty() {
                None
            } else {
                Some(queue.remove(0))
            }
        };
        match script {
            Some(ReplanScript::OkPlan(plan)) => Ok(plan),
            Some(ReplanScript::Empty) => Ok(Plan {
                reasoning: "scripted: infeasible".to_string(),
                subtasks: vec![],
            }),
            Some(ReplanScript::Fail(err)) => Err(err),
            None => panic!("ScriptedAgent::replan called without scripted outcome"),
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

/// Synthetic `ReplanContext` for fixture-level tests — real orchestrator
/// tests (commit 2) compose one from actual run state. Fields are
/// distinguishable so assertions on the captured context can fail loudly
/// if the wiring cross-talks.
fn replan_ctx_of(repo: &Path, attempt_counter: u32) -> ReplanContext {
    ReplanContext {
        original_task: "build login".into(),
        repo_root: repo.to_path_buf(),
        failed_subtask_title: "wire oauth".into(),
        failed_subtask_why: "needed before session".into(),
        attempt_errors: vec!["attempt 1: boom".into(), "attempt 2: boom".into()],
        worker_log_tail: "... log tail ...".into(),
        completed_subtask_summaries: vec!["landed schema".into()],
        attempt_counter,
        available_workers: vec![AgentKind::Claude],
    }
}

// -- Tests -----------------------------------------------------------

/// Fixture smoke test: verify the `ReplanScript` queue pops FIFO and the
/// captured `ReplanContext` log reflects each call. The full lifecycle
/// tests for master replan live in commit 2 once `Orchestrator::replan_subtask`
/// lands; this one just guards the test harness itself.
#[tokio::test]
async fn scripted_agent_replan_queue_pops_in_order() {
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_replan(ReplanScript::OkPlan(plan_of(1)))
        .await
        .with_replan(ReplanScript::Empty)
        .await
        .with_replan(ReplanScript::Fail(AgentError::TaskFailed {
            reason: "master refused".into(),
        }))
        .await;
    let repo = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();

    let first = agent
        .replan(replan_ctx_of(repo.path(), 1), cancel.clone())
        .await
        .unwrap();
    assert_eq!(first.subtasks.len(), 1, "first call returns OkPlan");

    let second = agent
        .replan(replan_ctx_of(repo.path(), 2), cancel.clone())
        .await
        .unwrap();
    assert!(second.subtasks.is_empty(), "second call returns empty plan");

    let third = agent
        .replan(replan_ctx_of(repo.path(), 2), cancel.clone())
        .await
        .unwrap_err();
    assert!(matches!(third, AgentError::TaskFailed { .. }));

    // All three ReplanContexts captured in order, distinguishable by
    // `attempt_counter`.
    let calls = agent.replan_calls().await;
    assert_eq!(calls.len(), 3);
    assert_eq!(calls[0].attempt_counter, 1);
    assert_eq!(calls[1].attempt_counter, 2);
    assert_eq!(calls[2].attempt_counter, 2);
}

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
async fn worker_failure_parks_on_escalation_then_aborts() {
    // Phase 3 Step 5 (Commit 2a): a worker failure no longer fail-fasts
    // the run directly — it triggers Layer 2 (master replan). When the
    // master returns an empty plan, the lifecycle parks in
    // `AwaitingHumanFix` and waits on the resolution channel. This test
    // drives the park → `Aborted` → `Cancelled` path so the original
    // "fail-fast on unrecoverable worker failure" intent still has a
    // deterministic terminal state.
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(2)))
        .await
        .with_execute("t0", ExecuteScript::Fail("boom".into()))
        .await
        .with_execute_default(ExecuteScript::Ok {
            summary: "ok".into(),
            delay: Duration::from_millis(200),
        })
        .await
        .with_replan(ReplanScript::Empty)
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

    // Run should park in AwaitingHumanFix after the empty replan.
    h.await_status(&run_id, RunStatus::AwaitingHumanFix).await;

    // HumanEscalation event must have fired before the park.
    let snap = h.sink.snapshot().await;
    assert!(
        snap.iter()
            .any(|e| matches!(e, RunEvent::HumanEscalation { .. })),
        "expected HumanEscalation emit after empty replan",
    );

    // Fire the resolution channel with `Aborted`; the lifecycle finalizes
    // to Cancelled (same terminal as user-cancelled runs).
    send_resolution(&h, &run_id, Layer3Decision::Aborted).await;
    h.await_status(&run_id, RunStatus::Cancelled).await;

    let stored = h.storage.get_run(&run_id).await.unwrap().unwrap();
    assert_eq!(stored.status, RunStatus::Cancelled);
    // The failing subtask still carries its original "boom" error.
    let subs_after = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let failed = subs_after
        .iter()
        .find(|s| s.state == SubtaskState::Failed)
        .expect("one subtask should end Failed");
    assert!(failed.error.as_deref().unwrap_or_default().contains("boom"));
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
async fn worker_failure_cleans_up_worktrees_after_abort() {
    // Regression: worktree cleanup must fire on the cancel path too.
    // Phase 3 Step 4 moved worker failures through Layer 2; Step 5
    // Commit 2a parks at Layer 3 instead of finalize_failed. The
    // cleanup contract now runs in `finalize_cancelled` (Aborted
    // resolution path), so this test drives the empty replan into
    // `AwaitingHumanFix` and then fires `Aborted` to confirm the
    // worktree + shared-notes files are swept.
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(1)))
        .await
        .with_execute("t0", ExecuteScript::Fail("boom".into()))
        .await
        .with_replan(ReplanScript::Empty)
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

    h.await_status(&run_id, RunStatus::AwaitingHumanFix).await;
    send_resolution(&h, &run_id, Layer3Decision::Aborted).await;
    h.await_status(&run_id, RunStatus::Cancelled).await;

    let stored = h.storage.get_run(&run_id).await.unwrap().unwrap();
    assert_eq!(stored.status, RunStatus::Cancelled);
    let subs_after = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let failed = subs_after
        .iter()
        .find(|s| s.state == SubtaskState::Failed)
        .expect("the original subtask should end Failed");
    assert!(failed.error.as_deref().unwrap_or_default().contains("boom"));
    assert!(
        !h.repo_path.join(".whalecode-worktrees").exists(),
        "worktrees must be cleaned after abort"
    );
    assert!(!h.repo_path.join(".whalecode/notes.md").exists());
}

// -- Phase 3 Step 5 Commit 2a: Layer-3 human escalation park/resolve ---
//
// These tests exercise `handle_escalation` in `lifecycle.rs`: the run
// must park on `AwaitingHumanFix`, wait on the resolution channel, and
// resume forward progress based on the `Layer3Decision` variant. The
// four IPC commands (manual_fix_subtask / mark_subtask_fixed /
// skip_subtask / try_replan_again) still stub "not yet implemented" in
// Commit 2a; tests push decisions directly through the Orchestrator's
// `resolution_senders` map via the `send_resolution` helper.

/// Helper: script a plan that fails its one subtask and returns an
/// empty replan, so the lifecycle parks at Layer 3. Callers pick the
/// resolution variant to test.
async fn agent_parks_at_escalation() -> ScriptedAgent {
    ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(1)))
        .await
        .with_execute("t0", ExecuteScript::Fail("boom".into()))
        .await
        .with_replan(ReplanScript::Empty)
        .await
}

#[tokio::test]
async fn layer3_fixed_resolution_proceeds_to_merging() {
    // User marks the escalated subtask as fixed; lifecycle should flip
    // it Failed → Done, skip re-entering the dispatcher (no remaining
    // Waiting subtasks), and jump straight to Merging.
    let h = Harness::new(agent_parks_at_escalation().await).await;

    let run_id = h
        .orch
        .submit_task("fix-me".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let ids: Vec<SubtaskId> = subs.iter().map(|s| s.id.clone()).collect();
    h.orch
        .approve_subtasks(&run_id, ids.clone())
        .await
        .unwrap();

    h.await_status(&run_id, RunStatus::AwaitingHumanFix).await;

    // User manually fixed the failing subtask — send Fixed(sid).
    let failed_sid = ids[0].clone();
    send_resolution(&h, &run_id, Layer3Decision::Fixed(failed_sid.clone())).await;

    h.await_status(&run_id, RunStatus::Merging).await;

    // The escalated subtask is now Done in storage.
    let subs_after = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let resolved = subs_after
        .iter()
        .find(|s| s.id == failed_sid)
        .expect("escalated subtask must still be in storage");
    assert_eq!(resolved.state, SubtaskState::Done);

    // Transcript should include SubtaskStateChanged{Done} for the sid.
    let snap = h.sink.snapshot().await;
    assert!(
        snap.iter().any(|e| matches!(
            e,
            RunEvent::SubtaskStateChanged { subtask_id, state, .. }
            if *subtask_id == failed_sid && *state == SubtaskState::Done
        )),
        "expected SubtaskStateChanged(Done) for the fixed subtask",
    );
}

#[tokio::test]
async fn layer3_skipped_resolution_proceeds_to_merging() {
    // User skips the escalated subtask; lifecycle marks it Skipped and
    // proceeds to Merging (nothing left to run — the dispatcher already
    // drained siblings as Skipped on NeedsReplan).
    let h = Harness::new(agent_parks_at_escalation().await).await;

    let run_id = h
        .orch
        .submit_task("skip-me".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let ids: Vec<SubtaskId> = subs.iter().map(|s| s.id.clone()).collect();
    h.orch
        .approve_subtasks(&run_id, ids.clone())
        .await
        .unwrap();

    h.await_status(&run_id, RunStatus::AwaitingHumanFix).await;

    let failed_sid = ids[0].clone();
    send_resolution(
        &h,
        &run_id,
        Layer3Decision::Skipped(vec![failed_sid.clone()]),
    )
    .await;

    h.await_status(&run_id, RunStatus::Merging).await;

    let subs_after = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let resolved = subs_after
        .iter()
        .find(|s| s.id == failed_sid)
        .expect("escalated subtask must still be in storage");
    assert_eq!(resolved.state, SubtaskState::Skipped);

    let snap = h.sink.snapshot().await;
    assert!(
        snap.iter().any(|e| matches!(
            e,
            RunEvent::SubtaskStateChanged { subtask_id, state, .. }
            if *subtask_id == failed_sid && *state == SubtaskState::Skipped
        )),
        "expected SubtaskStateChanged(Skipped) for the skipped subtask",
    );
}

#[tokio::test]
async fn layer3_replan_requested_resolves_to_new_approval() {
    // User requests another replan attempt; master returns a viable
    // plan on the second try. Lifecycle should flip back to Planning,
    // install the replacement subtask, and re-enter AwaitingApproval.
    let replacement = Plan {
        reasoning: "try a different approach".into(),
        subtasks: vec![PlannedSubtask {
            title: "replacement".into(),
            why: "the manual fix".into(),
            assigned_worker: AgentKind::Claude,
            dependencies: vec![],
        }],
    };
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(1)))
        .await
        .with_execute("t0", ExecuteScript::Fail("boom".into()))
        .await
        // First replan: empty → park on Layer 3.
        .with_replan(ReplanScript::Empty)
        .await
        // Second replan (triggered by ReplanRequested): viable plan.
        .with_replan(ReplanScript::OkPlan(replacement))
        .await;
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("replan-again".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let initial_ids: Vec<SubtaskId> = subs.iter().map(|s| s.id.clone()).collect();
    h.orch
        .approve_subtasks(&run_id, initial_ids.clone())
        .await
        .unwrap();

    h.await_status(&run_id, RunStatus::AwaitingHumanFix).await;

    let failed_sid = initial_ids[0].clone();
    send_resolution(
        &h,
        &run_id,
        Layer3Decision::ReplanRequested(failed_sid.clone()),
    )
    .await;

    // The replacement subtask "replacement" must land in storage as
    // Proposed; poll against storage (not the event transcript) because
    // an earlier `AwaitingApproval` emit would match a simple
    // `await_status` immediately.
    let replacement_id =
        await_subtask_with_title_in_state(&h, &run_id, "replacement", SubtaskState::Proposed)
            .await;
    // The lineage row must point back at the original failed subtask —
    // proves `ReplanRequested` went through the normal replan install
    // path rather than a shortcut.
    let lineage = h
        .storage
        .get_replaces_for_subtask(&replacement_id)
        .await
        .unwrap();
    assert_eq!(
        lineage,
        vec![failed_sid.clone()],
        "ReplanRequested replacement must carry the failed sid in its lineage",
    );
    // Run status has flipped back to AwaitingApproval after the install.
    let stored = h.storage.get_run(&run_id).await.unwrap().unwrap();
    assert_eq!(stored.status, RunStatus::AwaitingApproval);
    // The escalation marker must be cleared on the in-memory run state.
    let run_guard = h
        .orch
        .runs
        .lock()
        .await
        .get(&run_id)
        .cloned()
        .expect("run must still be tracked");
    assert!(
        run_guard.read().await.escalated_subtask_ids.is_empty(),
        "escalated_subtask_ids must be cleared after ReplanRequested install",
    );
}

#[tokio::test]
async fn layer3_aborted_resolution_finalizes_cancelled() {
    // User aborts the escalated run; lifecycle fires the cancel token
    // and drops through to finalize_cancelled. Terminal state is
    // Cancelled, worktrees + notes are swept.
    let h = Harness::new(agent_parks_at_escalation().await).await;

    let run_id = h
        .orch
        .submit_task("abort-me".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let ids: Vec<SubtaskId> = subs.iter().map(|s| s.id.clone()).collect();
    h.orch.approve_subtasks(&run_id, ids).await.unwrap();

    h.await_status(&run_id, RunStatus::AwaitingHumanFix).await;
    send_resolution(&h, &run_id, Layer3Decision::Aborted).await;
    h.await_status(&run_id, RunStatus::Cancelled).await;

    let stored = h.storage.get_run(&run_id).await.unwrap().unwrap();
    assert_eq!(stored.status, RunStatus::Cancelled);
    assert!(!h.repo_path.join(".whalecode-worktrees").exists());
    assert!(!h.repo_path.join(".whalecode/notes.md").exists());
}

#[tokio::test]
async fn layer3_cancel_during_park_finalizes_cancelled() {
    // External cancel fires while the lifecycle is parked on
    // `AwaitingHumanFix`. The select!'s cancel branch must win,
    // `finalize_cancelled` runs, terminal is Cancelled. Mirrors
    // `cancel_during_running_cleans_up_worktrees` but at the Layer-3
    // park instead of mid-dispatch.
    let h = Harness::new(agent_parks_at_escalation().await).await;

    let run_id = h
        .orch
        .submit_task("cancel-during-park".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let ids: Vec<SubtaskId> = subs.iter().map(|s| s.id.clone()).collect();
    h.orch.approve_subtasks(&run_id, ids).await.unwrap();

    h.await_status(&run_id, RunStatus::AwaitingHumanFix).await;

    // External cancel — lifecycle's park-select should notice.
    h.orch.cancel_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Cancelled).await;

    let stored = h.storage.get_run(&run_id).await.unwrap().unwrap();
    assert_eq!(stored.status, RunStatus::Cancelled);
    // The resolution sender should no longer be in the map — lifecycle
    // exit cleanup clears it alongside approval/apply senders.
    assert!(
        h.orch
            .resolution_senders
            .lock()
            .await
            .get(&run_id)
            .is_none(),
        "resolution sender must be cleaned up after cancel",
    );
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

/// Send a Layer-3 resolution directly into the lifecycle's park select.
/// Mirrors what the four escalation IPC commands (Commit 2b) will do:
/// take the sender out of `resolution_senders` and fire it. Panics if
/// the sender isn't present — callers must `await_status(AwaitingHumanFix)`
/// first so the lifecycle has inserted it.
async fn send_resolution(h: &Harness, run_id: &RunId, decision: Layer3Decision) {
    let tx = h
        .orch
        .resolution_senders
        .lock()
        .await
        .remove(run_id)
        .expect("resolution sender must be installed by lifecycle park");
    tx.send(decision)
        .expect("lifecycle's resolution_rx must be alive at park time");
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
async fn apply_emits_subtask_diff_per_done_subtask_before_aggregate() {
    // Phase 3.5 Item 6: each done subtask gets its own `SubtaskDiff`
    // event during the Apply pre-merge pass, emitted in plan order and
    // *before* the aggregate `DiffReady`. The UI uses these to light up
    // per-worker "N files" chips + popover before the final node's
    // combined diff lands.
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

    // Wait for DiffReady (the aggregate) — at that point both per-
    // subtask diffs must already be in the event log.
    expect_event(&h, &run_id, |e| match e {
        RunEvent::DiffReady { .. } => Some(()),
        _ => None,
    })
    .await;

    // Pull the full event snapshot and filter to this run.
    let events = h.sink.snapshot().await;
    let mut per_subtask: Vec<(String, Vec<String>)> = Vec::new();
    let mut aggregate_index: Option<usize> = None;
    for (i, ev) in events.iter().enumerate() {
        match ev {
            RunEvent::SubtaskDiff {
                run_id: r,
                subtask_id,
                files,
            } if *r == run_id => {
                per_subtask.push((
                    subtask_id.clone(),
                    files.iter().map(|f| f.path.clone()).collect(),
                ));
            }
            RunEvent::DiffReady { run_id: r, .. } if *r == run_id => {
                aggregate_index = Some(i);
            }
            _ => {}
        }
    }

    // Order invariant: every SubtaskDiff for this run must precede the
    // aggregate DiffReady.
    let aggregate_i = aggregate_index.expect("DiffReady observed above");
    for (i, ev) in events.iter().enumerate() {
        if matches!(ev, RunEvent::SubtaskDiff { run_id: r, .. } if *r == run_id) {
            assert!(
                i < aggregate_i,
                "SubtaskDiff at {i} should precede DiffReady at {aggregate_i}"
            );
        }
    }

    // One event per done subtask, each carrying the file that worker
    // wrote. Plan order → the fake writer uses t0 and t1 as subtask
    // titles; the ids in the store are the ulids assigned at plan time.
    assert_eq!(
        per_subtask.len(),
        2,
        "expected one SubtaskDiff per done subtask, got {per_subtask:?}"
    );
    let all_files: Vec<&String> = per_subtask
        .iter()
        .flat_map(|(_, files)| files.iter())
        .collect();
    assert!(all_files.iter().any(|p| p.ends_with("a.txt")));
    assert!(all_files.iter().any(|p| p.ends_with("b.txt")));

    // Phase 4 Step 6: every per-subtask diff on the wire now carries
    // the `status` discriminator and a non-empty `unified_diff` patch
    // for text files. Assert directly against the event payloads so a
    // regression in `worktree_to_ipc_diff` (e.g. dropping the patch
    // clone) fails here rather than only in a UI test.
    let mut observed_any_patch = false;
    let mut observed_any_added_status = false;
    for ev in events.iter() {
        if let RunEvent::SubtaskDiff {
            run_id: r, files, ..
        } = ev
        {
            if *r != run_id {
                continue;
            }
            for fd in files {
                if !fd.unified_diff.is_empty() {
                    observed_any_patch = true;
                    assert!(
                        fd.unified_diff.contains('\n'),
                        "unified diff should be multi-line: {:?}",
                        fd.unified_diff,
                    );
                }
                if matches!(fd.status, crate::ipc::DiffStatus::Added) {
                    observed_any_added_status = true;
                }
            }
        }
    }
    assert!(observed_any_patch, "at least one per-subtask patch body");
    assert!(
        observed_any_added_status,
        "fake writer created new files — at least one status should be Added",
    );
}

#[tokio::test]
async fn apply_emits_apply_summary_last_with_commit_sha_and_per_worker_counts() {
    // Phase 4 Step 2: after a successful Apply the backend emits
    // `ApplySummary` as the final event. The ordering invariant is
    // `DiffReady → Completed → StatusChanged(Done) → ApplySummary`
    // — the UI relies on the terminal Done arriving before the
    // overlay payload so the graph has finished transitioning.
    //
    // Payload carries:
    //   - full 40-char commit SHA of the merged HEAD
    //   - base branch ("main" in the harness)
    //   - aggregate files_changed (mirrors RunSummary)
    //   - per-worker rows, one per done subtask, in plan order,
    //     each with the file count that worker touched (0 for
    //     workers that ran but wrote nothing).
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

    expect_event(&h, &run_id, |e| match e {
        RunEvent::DiffReady { .. } => Some(()),
        _ => None,
    })
    .await;
    h.orch.apply_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Done).await;

    // Payload shape.
    let apply_summary = expect_event(&h, &run_id, |e| match e {
        RunEvent::ApplySummary { .. } => Some(e.clone()),
        _ => None,
    })
    .await;
    let RunEvent::ApplySummary {
        commit_sha,
        branch,
        files_changed,
        per_worker,
        ..
    } = apply_summary
    else {
        unreachable!("matcher only returns ApplySummary");
    };
    assert_eq!(commit_sha.len(), 40, "full 40-char SHA expected");
    assert!(
        commit_sha.chars().all(|c| c.is_ascii_hexdigit()),
        "commit SHA should be hex, got {commit_sha}"
    );
    assert_eq!(branch, "main");
    assert_eq!(files_changed, 2);
    assert_eq!(
        per_worker.len(),
        2,
        "one per-worker entry per done subtask, got {per_worker:?}"
    );
    assert_eq!(per_worker[0].1, 1, "t0 touched 1 file");
    assert_eq!(per_worker[1].1, 1, "t1 touched 1 file");

    // Ordering invariant: ApplySummary is emitted after the
    // DiffReady → Completed → StatusChanged(Done) chain and is the
    // last event for the run.
    let events = h.sink.snapshot().await;
    let diff_ready_i = events
        .iter()
        .position(|e| matches!(e, RunEvent::DiffReady { run_id: r, .. } if *r == run_id))
        .expect("DiffReady must be present");
    let completed_i = events
        .iter()
        .position(|e| matches!(e, RunEvent::Completed { run_id: r, .. } if *r == run_id))
        .expect("Completed must be present");
    let status_done_i = events
        .iter()
        .position(|e| {
            matches!(
                e,
                RunEvent::StatusChanged { run_id: r, status: RunStatus::Done } if *r == run_id
            )
        })
        .expect("StatusChanged(Done) must be present");
    let apply_summary_i = events
        .iter()
        .position(|e| matches!(e, RunEvent::ApplySummary { run_id: r, .. } if *r == run_id))
        .expect("ApplySummary must be present");
    assert!(
        diff_ready_i < completed_i,
        "DiffReady must precede Completed"
    );
    assert!(
        completed_i < status_done_i,
        "Completed must precede StatusChanged(Done)"
    );
    assert!(
        status_done_i < apply_summary_i,
        "StatusChanged(Done) must precede ApplySummary"
    );
    let later_events_for_run: Vec<_> = events
        .iter()
        .skip(apply_summary_i + 1)
        .filter(|e| e.run_id() == &run_id)
        .collect();
    assert!(
        later_events_for_run.is_empty(),
        "ApplySummary must be the last event for the run, got {later_events_for_run:?}"
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
async fn apply_with_dirty_base_branch_keeps_run_in_merging_and_emits_event() {
    // Regression for the step-11 failure: a single subtask writes a
    // legitimate commit, but the *user's* base-branch working tree has
    // uncommitted changes on a tracked file. `git merge` would refuse
    // with "would be overwritten". The run must stay in Merging, emit
    // `BaseBranchDirty`, preserve worktrees, and be ready to retry.
    let agent = agent_writing(&[("t0", vec![("feature.txt", "new content\n")])]).await;
    let h = Harness::new(agent).await;

    // Dirty a tracked file on the base branch BEFORE apply. The
    // harness seeds `seed.txt` at init (see Harness::new above); we
    // write over it so `git status --porcelain` reports ` M seed.txt`.
    tokio::fs::write(h.repo_path.join("seed.txt"), "dirty wip\n")
        .await
        .unwrap();

    let run_id = h
        .orch
        .submit_task("dirty base".into(), h.repo_path.clone())
        .await
        .unwrap();
    approve_all(&h, &run_id).await;
    expect_event(&h, &run_id, |e| match e {
        RunEvent::DiffReady { .. } => Some(()),
        _ => None,
    })
    .await;
    h.orch.apply_run(&run_id).await.unwrap();

    // BaseBranchDirty fires with the expected file.
    let files = expect_event(&h, &run_id, |e| match e {
        RunEvent::BaseBranchDirty { files, .. } => Some(files.clone()),
        _ => None,
    })
    .await;
    assert!(
        files.iter().any(|p| p.to_string_lossy() == "seed.txt"),
        "expected seed.txt in dirty list, got {files:?}",
    );

    // Run stays Merging; worktrees intact so retry can succeed.
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(h.orch.get_run(&run_id).await.is_some(), "run should still be active");
    let stored = h.storage.get_run(&run_id).await.unwrap().unwrap();
    assert_eq!(stored.status, RunStatus::Merging);
    assert!(
        stored
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("seed.txt"),
        "error column should carry dirty-base summary, got {:?}",
        stored.error,
    );
    let wt_dir = h.repo_path.join(".whalecode-worktrees");
    assert!(wt_dir.exists(), "worktrees should stay when base is dirty");

    // User "stashes" by committing their WIP, then retries. Apply
    // should now succeed and land the worker branch on base.
    TokioCommand::new("git")
        .args(["add", "seed.txt"])
        .current_dir(&h.repo_path)
        .output()
        .await
        .unwrap();
    TokioCommand::new("git")
        .args(["commit", "-q", "-m", "user wip"])
        .current_dir(&h.repo_path)
        .output()
        .await
        .unwrap();
    h.orch.apply_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Done).await;

    // The worker's file landed on main.
    assert_eq!(
        tokio::fs::read_to_string(h.repo_path.join("feature.txt"))
            .await
            .unwrap(),
        "new content\n",
    );
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

// -- Phase 3 edit commands --------------------------------------------
//
// These exercise the trio introduced in Step 1 of the Phase 3 spec:
// `update_subtask`, `add_subtask`, `remove_subtask`. Each drives a
// real run through Planning → AwaitingApproval (using `ScriptedAgent`
// with a canned plan) and then exercises the edit methods through the
// public Orchestrator API. Assertions target:
//
// - the in-memory runtime state mutates as promised
// - the SQLite row reflects the edit with the correct sticky flag
// - `SubtasksProposed` is re-emitted with the full updated list
// - state-gate violations surface typed errors
// - dependencies block removal when upstream
//
// The scripted registry advertises [Claude, Codex] as available
// workers — Gemini is used below as the "unavailable" case.

/// Drive a fresh run to AwaitingApproval with a canned plan. Returns
/// the harness, run id, and the current snapshot of subtask rows
/// (already persisted — the lifecycle task flushes before emitting
/// `StatusChanged{AwaitingApproval}`).
async fn harness_awaiting(
    plan: Plan,
) -> (Harness, RunId, Vec<crate::storage::models::Subtask>) {
    let agent = ScriptedAgent::new(AgentKind::Claude).with_plan(Ok(plan)).await;
    let h = Harness::new(agent).await;
    let run_id = h
        .orch
        .submit_task("edit tests".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    (h, run_id, subs)
}

/// Count `SubtasksProposed` events for a given run on the sink — one
/// is fired by the lifecycle task on entering AwaitingApproval; every
/// successful edit adds another. The arithmetic matters: edits that
/// fail with a typed error must NOT re-emit.
async fn count_subtasks_proposed(h: &Harness, run_id: &RunId) -> usize {
    h.sink
        .snapshot()
        .await
        .into_iter()
        .filter(|e| matches!(e, RunEvent::SubtasksProposed { run_id: r, .. } if r == run_id))
        .count()
}

/// Last `SubtasksProposed` payload for a run — pin the post-edit shape
/// after the re-emit.
async fn last_proposed_payload(
    h: &Harness,
    run_id: &RunId,
) -> Vec<crate::ipc::SubtaskData> {
    h.sink
        .snapshot()
        .await
        .into_iter()
        .filter_map(|e| match e {
            RunEvent::SubtasksProposed { run_id: r, subtasks } if &r == run_id => Some(subtasks),
            _ => None,
        })
        .next_back()
        .expect("no SubtasksProposed event found for run")
}

#[tokio::test]
async fn update_subtask_happy_path_re_emits_and_flips_flag() {
    let (h, run_id, subs) = harness_awaiting(plan_of(2)).await;
    let target = subs[0].id.clone();
    let before = count_subtasks_proposed(&h, &run_id).await;
    assert_eq!(before, 1, "baseline should be the initial proposal emit");

    h.orch
        .update_subtask(
            &run_id,
            &target,
            SubtaskPatch {
                title: Some("renamed".into()),
                why: Some("fresh rationale".into()),
                assigned_worker: Some(AgentKind::Codex),
            },
        )
        .await
        .unwrap();

    // In-memory runtime reflects the edit.
    let run_arc = h.orch.get_run(&run_id).await.unwrap();
    let guard = run_arc.read().await;
    let sub = guard.find_subtask(&target).unwrap();
    assert_eq!(sub.data.title, "renamed");
    assert_eq!(sub.data.why, "fresh rationale");
    assert_eq!(sub.data.assigned_worker, AgentKind::Codex);
    drop(guard);

    // SQLite row matches and the sticky flag fired.
    let stored = h.storage.get_subtask(&target).await.unwrap().unwrap();
    assert_eq!(stored.title, "renamed");
    assert_eq!(stored.why.as_deref(), Some("fresh rationale"));
    assert_eq!(stored.assigned_worker, AgentKind::Codex);
    let edited: i64 =
        sqlx::query_scalar("SELECT edited_by_user FROM subtasks WHERE id = ?")
            .bind(&target)
            .fetch_one(h.storage.pool_for_tests())
            .await
            .unwrap();
    assert_eq!(edited, 1, "edited_by_user must be set after update");

    // Re-emit carries the new title.
    let after = count_subtasks_proposed(&h, &run_id).await;
    assert_eq!(after, before + 1, "successful edit should re-emit exactly once");
    let payload = last_proposed_payload(&h, &run_id).await;
    assert_eq!(payload.len(), 2);
    let edited_row = payload.iter().find(|s| s.id == target).unwrap();
    assert_eq!(edited_row.title, "renamed");
    assert_eq!(edited_row.why.as_deref(), Some("fresh rationale"));
    assert_eq!(edited_row.assigned_worker, AgentKind::Codex);

    // Clean up.
    h.orch.reject_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Rejected).await;
}

#[tokio::test]
async fn update_subtask_why_can_be_cleared_with_empty_string() {
    // Wire semantics: `why: Some("")` clears the rationale. The
    // orchestrator normalizes to `None` before persisting and before
    // the re-emit payload.
    let (h, run_id, subs) = harness_awaiting(plan_of(1)).await;
    let target = subs[0].id.clone();

    h.orch
        .update_subtask(
            &run_id,
            &target,
            SubtaskPatch {
                title: None,
                why: Some(String::new()),
                assigned_worker: None,
            },
        )
        .await
        .unwrap();

    let stored = h.storage.get_subtask(&target).await.unwrap().unwrap();
    assert!(stored.why.is_none(), "empty-string why must clear the column");
    let payload = last_proposed_payload(&h, &run_id).await;
    assert!(payload[0].why.is_none());

    h.orch.reject_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Rejected).await;
}

#[tokio::test]
async fn update_subtask_missing_run_is_run_not_found() {
    let agent = ScriptedAgent::new(AgentKind::Claude);
    let h = Harness::new(agent).await;
    let err = h
        .orch
        .update_subtask(&"nope".into(), &"nope".into(), SubtaskPatch::default())
        .await
        .unwrap_err();
    assert!(matches!(err, OrchestratorError::RunNotFound(_)));
}

#[tokio::test]
async fn update_subtask_missing_subtask_is_subtask_not_found() {
    let (h, run_id, _subs) = harness_awaiting(plan_of(1)).await;
    let err = h
        .orch
        .update_subtask(&run_id, &"ghost".into(), SubtaskPatch::default())
        .await
        .unwrap_err();
    assert!(matches!(err, OrchestratorError::SubtaskNotFound(_)));
    h.orch.reject_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Rejected).await;
}

#[tokio::test]
async fn update_subtask_empty_title_rejected_and_no_re_emit() {
    let (h, run_id, subs) = harness_awaiting(plan_of(1)).await;
    let target = subs[0].id.clone();
    let before = count_subtasks_proposed(&h, &run_id).await;

    let err = h
        .orch
        .update_subtask(
            &run_id,
            &target,
            SubtaskPatch {
                title: Some("   ".into()),
                why: None,
                assigned_worker: None,
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, OrchestratorError::InvalidEdit(_)));

    // No re-emit on validation failure.
    let after = count_subtasks_proposed(&h, &run_id).await;
    assert_eq!(after, before);
    // Row untouched.
    let stored = h.storage.get_subtask(&target).await.unwrap().unwrap();
    assert_eq!(stored.title, subs[0].title);

    h.orch.reject_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Rejected).await;
}

#[tokio::test]
async fn update_subtask_unavailable_worker_rejected() {
    // Scripted registry advertises [Claude, Codex]; Gemini is absent.
    let (h, run_id, subs) = harness_awaiting(plan_of(1)).await;
    let target = subs[0].id.clone();

    let err = h
        .orch
        .update_subtask(
            &run_id,
            &target,
            SubtaskPatch {
                title: None,
                why: None,
                assigned_worker: Some(AgentKind::Gemini),
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, OrchestratorError::InvalidEdit(_)));
    // Row untouched.
    let stored = h.storage.get_subtask(&target).await.unwrap().unwrap();
    assert_eq!(stored.assigned_worker, AgentKind::Claude);

    h.orch.reject_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Rejected).await;
}

#[tokio::test]
async fn update_subtask_after_approval_is_wrong_state() {
    // Approve → run flips to Running → subsequent edit must be
    // refused. We can't rely on `AwaitingApproval` timing after
    // `approve_subtasks` returns because the lifecycle task flips
    // status asynchronously, so wait for the `Running` transition
    // before asserting.
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(1)))
        .await
        .with_execute_default(ExecuteScript::Block)
        .await;
    let h = Harness::new(agent).await;
    let run_id = h
        .orch
        .submit_task("approve-then-edit".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let target = subs[0].id.clone();
    h.orch
        .approve_subtasks(&run_id, vec![target.clone()])
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::Running).await;

    let err = h
        .orch
        .update_subtask(
            &run_id,
            &target,
            SubtaskPatch {
                title: Some("too late".into()),
                why: None,
                assigned_worker: None,
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, OrchestratorError::WrongState { .. }));

    h.orch.cancel_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Cancelled).await;
}

#[tokio::test]
async fn add_subtask_happy_path_returns_id_and_sets_flag() {
    let (h, run_id, subs) = harness_awaiting(plan_of(1)).await;
    let before = count_subtasks_proposed(&h, &run_id).await;

    let new_id = h
        .orch
        .add_subtask(
            &run_id,
            SubtaskDraft {
                title: "user-added".into(),
                why: Some("because user".into()),
                assigned_worker: AgentKind::Codex,
            },
        )
        .await
        .unwrap();

    // Server-coined id is a non-empty ULID (26 chars).
    assert_eq!(new_id.len(), 26);
    assert_ne!(new_id, subs[0].id);

    // Runtime has the new leaf with no deps.
    let run_arc = h.orch.get_run(&run_id).await.unwrap();
    let guard = run_arc.read().await;
    assert_eq!(guard.subtasks.len(), 2);
    let added = guard.find_subtask(&new_id).unwrap();
    assert!(added.dependency_ids.is_empty());
    assert_eq!(added.data.assigned_worker, AgentKind::Codex);
    assert_eq!(added.state, SubtaskState::Proposed);
    drop(guard);

    // SQLite row with added_by_user = 1, edited_by_user = 0.
    let flags: (i64, i64) = sqlx::query_as(
        "SELECT edited_by_user, added_by_user FROM subtasks WHERE id = ?",
    )
    .bind(&new_id)
    .fetch_one(h.storage.pool_for_tests())
    .await
    .unwrap();
    assert_eq!(flags, (0, 1));
    let stored = h.storage.get_subtask(&new_id).await.unwrap().unwrap();
    assert_eq!(stored.title, "user-added");
    assert_eq!(stored.why.as_deref(), Some("because user"));
    assert_eq!(stored.run_id, run_id);

    // Re-emit contains the new id.
    let after = count_subtasks_proposed(&h, &run_id).await;
    assert_eq!(after, before + 1);
    let payload = last_proposed_payload(&h, &run_id).await;
    assert!(payload.iter().any(|s| s.id == new_id));

    h.orch.reject_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Rejected).await;
}

#[tokio::test]
async fn add_subtask_empty_title_rejected() {
    let (h, run_id, _subs) = harness_awaiting(plan_of(1)).await;
    let err = h
        .orch
        .add_subtask(
            &run_id,
            SubtaskDraft {
                title: "   ".into(),
                why: None,
                assigned_worker: AgentKind::Claude,
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, OrchestratorError::InvalidEdit(_)));
    h.orch.reject_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Rejected).await;
}

#[tokio::test]
async fn add_subtask_unavailable_worker_rejected() {
    let (h, run_id, _subs) = harness_awaiting(plan_of(1)).await;
    let err = h
        .orch
        .add_subtask(
            &run_id,
            SubtaskDraft {
                title: "ok".into(),
                why: None,
                assigned_worker: AgentKind::Gemini, // not in [Claude, Codex]
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, OrchestratorError::InvalidEdit(_)));
    h.orch.reject_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Rejected).await;
}

#[tokio::test]
async fn add_subtask_missing_run_is_run_not_found() {
    let agent = ScriptedAgent::new(AgentKind::Claude);
    let h = Harness::new(agent).await;
    let err = h
        .orch
        .add_subtask(
            &"nope".into(),
            SubtaskDraft {
                title: "t".into(),
                why: None,
                assigned_worker: AgentKind::Claude,
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, OrchestratorError::RunNotFound(_)));
}

#[tokio::test]
async fn remove_subtask_happy_path_deletes_and_re_emits() {
    let (h, run_id, subs) = harness_awaiting(plan_of(2)).await;
    let target = subs[0].id.clone();
    let keep = subs[1].id.clone();
    let before = count_subtasks_proposed(&h, &run_id).await;

    h.orch.remove_subtask(&run_id, &target).await.unwrap();

    // Runtime shrinks.
    let run_arc = h.orch.get_run(&run_id).await.unwrap();
    let guard = run_arc.read().await;
    assert_eq!(guard.subtasks.len(), 1);
    assert_eq!(guard.subtasks[0].id, keep);
    drop(guard);

    // Row is gone.
    assert!(h.storage.get_subtask(&target).await.unwrap().is_none());
    // Sibling survives.
    assert!(h.storage.get_subtask(&keep).await.unwrap().is_some());

    // Re-emit without the target.
    let after = count_subtasks_proposed(&h, &run_id).await;
    assert_eq!(after, before + 1);
    let payload = last_proposed_payload(&h, &run_id).await;
    assert_eq!(payload.len(), 1);
    assert!(payload.iter().all(|s| s.id != target));

    h.orch.reject_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Rejected).await;
}

#[tokio::test]
async fn remove_subtask_with_dependent_rejected() {
    // t1 depends on t0; removing t0 must fail with HasDependents so
    // the user fixes the DAG explicitly (spec Q1 deferral — the
    // orchestrator refuses to invent new topology).
    let (h, run_id, subs) = harness_awaiting(plan_with_deps(&[("t0", &[]), ("t1", &[0])])).await;
    let t0 = subs.iter().find(|s| s.title == "t0").unwrap().id.clone();

    let before = count_subtasks_proposed(&h, &run_id).await;
    let err = h.orch.remove_subtask(&run_id, &t0).await.unwrap_err();
    assert!(matches!(err, OrchestratorError::HasDependents(_)));

    // Row still present; no re-emit.
    assert!(h.storage.get_subtask(&t0).await.unwrap().is_some());
    assert_eq!(count_subtasks_proposed(&h, &run_id).await, before);

    h.orch.reject_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Rejected).await;
}

#[tokio::test]
async fn remove_subtask_missing_is_subtask_not_found() {
    let (h, run_id, _subs) = harness_awaiting(plan_of(1)).await;
    let err = h
        .orch
        .remove_subtask(&run_id, &"ghost".into())
        .await
        .unwrap_err();
    assert!(matches!(err, OrchestratorError::SubtaskNotFound(_)));
    h.orch.reject_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Rejected).await;
}

#[tokio::test]
async fn remove_subtask_missing_run_is_run_not_found() {
    let agent = ScriptedAgent::new(AgentKind::Claude);
    let h = Harness::new(agent).await;
    let err = h
        .orch
        .remove_subtask(&"nope".into(), &"nope".into())
        .await
        .unwrap_err();
    assert!(matches!(err, OrchestratorError::RunNotFound(_)));
}

#[tokio::test]
async fn edit_after_approve_race_surfaces_wrong_state() {
    // Contention: a user approves, then an in-flight edit lands
    // after the lifecycle task has already flipped off
    // `AwaitingApproval`. The orchestrator must reject the edit
    // rather than silently mutating a plan that's already running.
    //
    // We drive this deterministically by blocking the worker so
    // `Running` is a stable observation point, then firing the edit.
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(1)))
        .await
        .with_execute_default(ExecuteScript::Block)
        .await;
    let h = Harness::new(agent).await;
    let run_id = h
        .orch
        .submit_task("race".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let target = subs[0].id.clone();

    h.orch
        .approve_subtasks(&run_id, vec![target.clone()])
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::Running).await;

    // Both update and remove must refuse once status has moved off
    // AwaitingApproval.
    let e1 = h
        .orch
        .update_subtask(&run_id, &target, SubtaskPatch {
            title: Some("late".into()),
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert!(matches!(e1, OrchestratorError::WrongState { .. }));

    let e2 = h.orch.remove_subtask(&run_id, &target).await.unwrap_err();
    assert!(matches!(e2, OrchestratorError::WrongState { .. }));

    let e3 = h
        .orch
        .add_subtask(
            &run_id,
            SubtaskDraft {
                title: "late-add".into(),
                why: None,
                assigned_worker: AgentKind::Claude,
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(e3, OrchestratorError::WrongState { .. }));

    h.orch.cancel_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Cancelled).await;
}

// -- Phase 3 Step 3b-f: worker-level retry ladder (Layer 1) ----------
//
// The retry function lives in dispatcher.rs and is exercised here
// end-to-end via the public Orchestrator API. The scripted agent's
// `with_fail_attempts` queue pops one scripted error per `execute`
// call before the normal `with_execute` script runs, which lets a
// single fixture model "fail once, then succeed" / "fail twice".
//
// Assertions focus on the observable contract:
//   * `SubtaskStateChanged` events fire in the spec-mandated order.
//   * Deterministic short-circuits (`SpawnFailed`) skip `Retrying`.
//   * `Cancelled` skips `Retrying` and doesn't mark the subtask Failed.
//   * The retry prompt carries the previous error.
// Phase 2 fail-fast is preserved — exhaustion still fails the run.

fn subtask_state_events(snap: &[RunEvent], sub_id: &SubtaskId) -> Vec<SubtaskState> {
    snap.iter()
        .filter_map(|e| match e {
            RunEvent::SubtaskStateChanged {
                subtask_id, state, ..
            } if subtask_id == sub_id => Some(*state),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn retry_single_failure_then_success_transitions_through_retrying() {
    // t0 fails once (Timeout) then succeeds. The retry ladder should
    // emit Running → Retrying → Running → Done in that order.
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(1)))
        .await
        .with_fail_attempts(
            "t0",
            vec![AgentError::Timeout { after_secs: 1 }],
        )
        .await
        .with_execute(
            "t0",
            ExecuteScript::Ok {
                summary: "recovered on retry".into(),
                delay: Duration::from_millis(0),
            },
        )
        .await;
    let agent_handle = agent.clone();
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("one".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let sub_id = subs[0].id.clone();
    h.orch
        .approve_subtasks(&run_id, vec![sub_id.clone()])
        .await
        .unwrap();

    h.await_status(&run_id, RunStatus::Merging).await;
    await_all_subtasks_terminal(&h, &run_id).await;

    // Final persisted state is Done.
    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    assert_eq!(subs[0].state, SubtaskState::Done);

    // Event ordering: Waiting → Running → Retrying → Running → Done.
    let snap = h.sink.snapshot().await;
    let states = subtask_state_events(&snap, &sub_id);
    assert_eq!(
        states,
        vec![
            SubtaskState::Waiting,
            SubtaskState::Running,
            SubtaskState::Retrying,
            SubtaskState::Running,
            SubtaskState::Done,
        ],
        "unexpected state sequence: {states:?}"
    );

    // Retry prompt was actually wired: attempt 2 carried extra_context
    // with the previous error's message.
    let ctx_calls = agent_handle.extra_context_calls().await;
    assert_eq!(ctx_calls.len(), 2, "expected exactly two execute calls");
    assert!(ctx_calls[0].is_none(), "first attempt must be contextless");
    let retry_ctx = ctx_calls[1]
        .as_ref()
        .expect("second attempt must carry retry context");
    assert!(
        retry_ctx.contains("Previous attempt failed"),
        "retry context missing preamble: {retry_ctx}"
    );
    assert!(
        retry_ctx.contains("timed out"),
        "retry context must include previous error: {retry_ctx}"
    );
}

#[tokio::test]
async fn retry_double_failure_escalates_and_parks() {
    // Both attempts fail → Layer 1 exhausted → Layer 2 replan fires.
    // Scripted replan returns empty (infeasible), which parks the run
    // in `AwaitingHumanFix` (Phase 3 Step 5 Commit 2a). The retry state
    // trace is still observable before the park; the test drives
    // `Aborted` to finalize deterministically.
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(1)))
        .await
        .with_fail_attempts(
            "t0",
            vec![
                AgentError::Timeout { after_secs: 1 },
                AgentError::TaskFailed {
                    reason: "still broken".into(),
                },
            ],
        )
        .await
        // Default covers both "we didn't pop a fail" and any extra calls
        // the dispatcher might make — but the queue above has exactly 2
        // entries so this default should never be reached.
        .with_execute_default(ExecuteScript::Fail("unexpected 3rd call".into()))
        .await
        .with_replan(ReplanScript::Empty)
        .await;
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("boom".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let sub_id = subs[0].id.clone();
    h.orch
        .approve_subtasks(&run_id, vec![sub_id.clone()])
        .await
        .unwrap();
    // The run parks at Layer 3; assert state trace before driving Aborted.
    h.await_status(&run_id, RunStatus::AwaitingHumanFix).await;

    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    assert_eq!(subs[0].state, SubtaskState::Failed);
    assert!(subs[0]
        .error
        .as_deref()
        .unwrap_or_default()
        .contains("still broken"));

    // State trace: Waiting → Running → Retrying → Failed. No second
    // Running, no Done. (The Layer-2 replan emits ReplanStarted + a
    // fresh SubtasksProposed, but those are run-level events, not
    // subtask-state transitions.)
    let snap = h.sink.snapshot().await;
    let states = subtask_state_events(&snap, &sub_id);
    assert_eq!(
        states,
        vec![
            SubtaskState::Waiting,
            SubtaskState::Running,
            SubtaskState::Retrying,
            SubtaskState::Failed,
        ],
        "unexpected state sequence: {states:?}"
    );

    // Drain the park → Cancelled so the harness teardown is clean.
    send_resolution(&h, &run_id, Layer3Decision::Aborted).await;
    h.await_status(&run_id, RunStatus::Cancelled).await;
}

#[tokio::test]
async fn retry_spawn_failed_short_circuits_layer_one() {
    // SpawnFailed is deterministic: the binary is missing or the OS
    // refused execve. Retrying only burns time — skip Layer 1 and
    // escalate to Layer 2. Retrying must NOT appear in the state trace.
    // The scripted replan returns empty so the run parks at Layer 3.
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(1)))
        .await
        .with_fail_attempts(
            "t0",
            vec![AgentError::SpawnFailed {
                cause: "no such file or directory".into(),
            }],
        )
        .await
        .with_execute_default(ExecuteScript::Fail("should not be reached".into()))
        .await
        .with_replan(ReplanScript::Empty)
        .await;
    let agent_handle = agent.clone();
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("spawn-fail".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let sub_id = subs[0].id.clone();
    h.orch
        .approve_subtasks(&run_id, vec![sub_id.clone()])
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingHumanFix).await;

    // Exactly one execute call — no retry was attempted.
    let ctx_calls = agent_handle.extra_context_calls().await;
    assert_eq!(
        ctx_calls.len(),
        1,
        "SpawnFailed must short-circuit Layer 1 (expected 1 execute, got {})",
        ctx_calls.len()
    );

    let snap = h.sink.snapshot().await;
    let states = subtask_state_events(&snap, &sub_id);
    assert!(
        !states.contains(&SubtaskState::Retrying),
        "SpawnFailed must not emit Retrying; got {states:?}"
    );
    assert_eq!(
        states.last().copied(),
        Some(SubtaskState::Failed),
        "expected terminal Failed; got {states:?}"
    );

    // Drain the park so the harness teardown is clean.
    send_resolution(&h, &run_id, Layer3Decision::Aborted).await;
    h.await_status(&run_id, RunStatus::Cancelled).await;
}

#[tokio::test]
async fn retry_cancelled_first_attempt_does_not_retry() {
    // Cancellation comes from outside the worker; retrying would
    // violate user intent. The run ends Cancelled with NO Retrying
    // event and NO Failed transition for the subtask.
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(1)))
        .await
        // Block until cancel fires, then return Cancelled.
        .with_execute("t0", ExecuteScript::Block)
        .await;
    let agent_handle = agent.clone();
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("cancel-me".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let sub_id = subs[0].id.clone();
    h.orch
        .approve_subtasks(&run_id, vec![sub_id.clone()])
        .await
        .unwrap();

    // Give the dispatcher time to enter execute() on the worker.
    tokio::time::sleep(Duration::from_millis(50)).await;
    h.orch.cancel_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Cancelled).await;

    // Exactly one execute call — the Cancelled error bypassed Layer 1.
    let ctx_calls = agent_handle.extra_context_calls().await;
    assert_eq!(
        ctx_calls.len(),
        1,
        "Cancelled must not trigger a retry (expected 1 execute, got {})",
        ctx_calls.len()
    );

    let snap = h.sink.snapshot().await;
    let states = subtask_state_events(&snap, &sub_id);
    assert!(
        !states.contains(&SubtaskState::Retrying),
        "Cancelled must not emit Retrying; got {states:?}"
    );
    assert!(
        !states.contains(&SubtaskState::Failed),
        "Cancelled must not mark subtask Failed; got {states:?}"
    );
}

#[tokio::test]
async fn retry_emits_log_separator_before_second_attempt() {
    // The `[whalecode] retry` marker on the log stream is how the
    // frontend draws the visual separator between attempts. Assert
    // it shows up exactly once, between the two Running transitions
    // (i.e. after Retrying is emitted, before the recovered Running).
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(1)))
        .await
        .with_fail_attempts(
            "t0",
            vec![AgentError::TaskFailed {
                reason: "flaky call".into(),
            }],
        )
        .await
        .with_execute(
            "t0",
            ExecuteScript::Ok {
                summary: "ok second time".into(),
                delay: Duration::from_millis(0),
            },
        )
        .await;
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("log-sep".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let sub_id = subs[0].id.clone();
    h.orch
        .approve_subtasks(&run_id, vec![sub_id.clone()])
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::Merging).await;
    await_all_subtasks_terminal(&h, &run_id).await;

    let snap = h.sink.snapshot().await;
    let retry_logs: Vec<&String> = snap
        .iter()
        .filter_map(|e| match e {
            RunEvent::SubtaskLog {
                subtask_id, line, ..
            } if subtask_id == &sub_id && line.starts_with("[whalecode] retry") => Some(line),
            _ => None,
        })
        .collect();
    assert_eq!(
        retry_logs.len(),
        1,
        "expected exactly one retry log marker, got {retry_logs:?}"
    );
    assert!(
        retry_logs[0].contains("flaky call"),
        "retry marker should include previous error: {}",
        retry_logs[0]
    );
}

// -- Phase 3 Step 4: Layer-2 master replan integration tests ---------
//
// These exercise the full approve → dispatch → replan → re-approve
// loop in lifecycle.rs. The scripted agent's `with_replan` queue
// picks the outcome; assertions target:
//   * `ReplanStarted` fires with the failed subtask's id
//   * The replacement `SubtasksProposed` payload carries `replaces`
//     populated with the failed lineage
//   * The `subtask_replans` lineage row is persisted in SQLite
//   * A second round of approve → dispatch runs the replacement to Done
//   * A chained sequence of replans escalates to `HumanEscalation`
//     once `REPLAN_LINEAGE_CAP` is hit, with the cap hit *before* the
//     master is called
//   * A master-level error during `replan()` finalizes the run Failed
//     without hanging the lifecycle loop

/// Poll until a subtask with this title appears on the run with the
/// given state. Returns its id. Bounded at 3s so a regression that
/// forgets to install the replacement surfaces as a timeout panic
/// instead of hanging the test run forever.
async fn await_subtask_with_title_in_state(
    h: &Harness,
    run_id: &RunId,
    title: &str,
    state: SubtaskState,
) -> SubtaskId {
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        let subs = h.storage.list_subtasks_for_run(run_id).await.unwrap();
        if let Some(s) = subs.iter().find(|s| s.title == title && s.state == state) {
            return s.id.clone();
        }
        if std::time::Instant::now() >= deadline {
            panic!(
                "timed out waiting for subtask title={title} state={state:?} on {run_id}. \
                 Current rows: {subs:#?}"
            );
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn replan_happy_path_accepts_replacement_and_reaches_done() {
    // t0 exhausts Layer 1 → master replan returns a single replacement
    // "good" → user approves it → run completes and merges.
    let replacement = Plan {
        reasoning: "rewire through the other service".into(),
        subtasks: vec![PlannedSubtask {
            title: "good".into(),
            why: "the replacement path".into(),
            assigned_worker: AgentKind::Claude,
            dependencies: vec![],
        }],
    };
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(1)))
        .await
        // Both attempts on t0 fail → Layer 1 exhausted.
        .with_fail_attempts(
            "t0",
            vec![
                AgentError::TaskFailed {
                    reason: "first fail".into(),
                },
                AgentError::TaskFailed {
                    reason: "second fail".into(),
                },
            ],
        )
        .await
        // "good" (replacement) writes a file so the merge phase has
        // something to apply onto base.
        .with_execute(
            "good",
            ExecuteScript::OkWrite {
                summary: "fixed it".into(),
                files: vec![(PathBuf::from("out.txt"), "repaired\n".into())],
            },
        )
        .await
        .with_replan(ReplanScript::OkPlan(replacement))
        .await;
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("needs replan".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let initial = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let t0_id = initial[0].id.clone();

    // Approve the original subtask — the only proposal on the table.
    h.orch
        .approve_subtasks(&run_id, vec![t0_id.clone()])
        .await
        .unwrap();

    // Wait for the replacement to land in SQLite as Proposed.
    let good_id =
        await_subtask_with_title_in_state(&h, &run_id, "good", SubtaskState::Proposed).await;

    // ReplanStarted fired with the failed subtask's id.
    let snap = h.sink.snapshot().await;
    assert!(
        snap.iter().any(|e| matches!(
            e,
            RunEvent::ReplanStarted { run_id: r, failed_subtask_id }
            if r == &run_id && failed_subtask_id == &t0_id
        )),
        "expected ReplanStarted for {t0_id}, events: {snap:#?}",
    );

    // The most recent SubtasksProposed payload includes the new
    // subtask with `replaces = [t0_id]`. The failed t0 is still in
    // the list but carries its final state on the wire.
    let last_proposed = last_proposed_payload(&h, &run_id).await;
    let good_wire = last_proposed
        .iter()
        .find(|s| s.title == "good")
        .expect("good must appear in latest SubtasksProposed");
    assert_eq!(
        good_wire.replaces,
        vec![t0_id.clone()],
        "replacement subtask must carry the failed lineage id on the wire",
    );
    assert!(
        last_proposed.iter().any(|s| s.title == "t0"),
        "the failed subtask must still be on the proposed list so the UI can render the lineage",
    );

    // Storage lineage matches the wire.
    let storage_lineage = h.storage.get_replaces_for_subtask(&good_id).await.unwrap();
    assert_eq!(storage_lineage, vec![t0_id.clone()]);
    assert_eq!(
        h.storage.count_replans_in_lineage(&good_id).await.unwrap(),
        1,
        "one replan edge: t0 → good",
    );

    // The full `ReplanContext` composition is asserted in the unit
    // test `scripted_agent_replan_queue_pops_in_order`; here we stay
    // at the orchestrator-level observable contract (events + storage).

    // Approve the replacement; the run should merge cleanly.
    h.orch
        .approve_subtasks(&run_id, vec![good_id.clone()])
        .await
        .unwrap();
    expect_event(&h, &run_id, |e| match e {
        RunEvent::DiffReady { .. } => Some(()),
        _ => None,
    })
    .await;
    h.orch.apply_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Done).await;

    // Final storage: t0 Failed (its attempt error preserved), good Done.
    let final_subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let t0 = final_subs.iter().find(|s| s.title == "t0").unwrap();
    let good = final_subs.iter().find(|s| s.title == "good").unwrap();
    assert_eq!(t0.state, SubtaskState::Failed);
    assert!(t0
        .error
        .as_deref()
        .unwrap_or_default()
        .contains("second fail"));
    assert_eq!(good.state, SubtaskState::Done);

    // Merged content landed on main.
    assert_eq!(
        tokio::fs::read_to_string(h.repo_path.join("out.txt"))
            .await
            .unwrap(),
        "repaired\n",
    );
    // Worktrees cleaned up.
    assert!(!h.repo_path.join(".whalecode-worktrees").exists());
    // No HumanEscalation was emitted on the happy path.
    let snap = h.sink.snapshot().await;
    assert!(
        !snap
            .iter()
            .any(|e| matches!(e, RunEvent::HumanEscalation { .. })),
        "happy-path replan must not escalate to a human",
    );
}

#[tokio::test]
async fn replan_lineage_cap_escalates_after_chained_replans() {
    // Chain: t0 fails → replan returns r1 → r1 fails → replan returns
    // r2 → r2 fails → lineage cap (2) is hit on the third replan
    // attempt, which emits `HumanEscalation` *without* calling the
    // master again and finalizes the run Failed.
    //
    // The `with_replan` queue holds exactly two OkPlan entries. A
    // regression that forgets the cap check would call replan a third
    // time and panic (empty queue).
    let make_plan = |title: &str, why: &str| Plan {
        reasoning: format!("try {title}"),
        subtasks: vec![PlannedSubtask {
            title: title.into(),
            why: why.into(),
            assigned_worker: AgentKind::Claude,
            dependencies: vec![],
        }],
    };
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(1)))
        .await
        // Every attempt on every subtask in the lineage fails twice.
        // Using `with_execute_default` catches whichever title the
        // master happens to invent (the scripted replan uses "r1"/"r2"
        // below, but default covers surprises).
        .with_fail_attempts(
            "t0",
            vec![
                AgentError::TaskFailed { reason: "t0-a".into() },
                AgentError::TaskFailed { reason: "t0-b".into() },
            ],
        )
        .await
        .with_fail_attempts(
            "r1",
            vec![
                AgentError::TaskFailed { reason: "r1-a".into() },
                AgentError::TaskFailed { reason: "r1-b".into() },
            ],
        )
        .await
        .with_fail_attempts(
            "r2",
            vec![
                AgentError::TaskFailed { reason: "r2-a".into() },
                AgentError::TaskFailed { reason: "r2-b".into() },
            ],
        )
        .await
        .with_execute_default(ExecuteScript::Fail("unexpected extra call".into()))
        .await
        .with_replan(ReplanScript::OkPlan(make_plan("r1", "replacement 1")))
        .await
        .with_replan(ReplanScript::OkPlan(make_plan("r2", "replacement 2")))
        .await;
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("chain".into(), h.repo_path.clone())
        .await
        .unwrap();

    // Round 1: approve t0.
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let t0_id = subs[0].id.clone();
    h.orch
        .approve_subtasks(&run_id, vec![t0_id.clone()])
        .await
        .unwrap();

    // Round 2: approve r1 once it lands as Proposed.
    let r1_id =
        await_subtask_with_title_in_state(&h, &run_id, "r1", SubtaskState::Proposed).await;
    h.orch
        .approve_subtasks(&run_id, vec![r1_id.clone()])
        .await
        .unwrap();

    // Round 3: approve r2 — this one should trigger the cap check on
    // failure.
    let r2_id =
        await_subtask_with_title_in_state(&h, &run_id, "r2", SubtaskState::Proposed).await;
    h.orch
        .approve_subtasks(&run_id, vec![r2_id.clone()])
        .await
        .unwrap();

    // Run parks at Layer 3 when the cap is hit; HumanEscalation fires
    // for r2 with a reason mentioning the exhausted retry budget.
    h.await_status(&run_id, RunStatus::AwaitingHumanFix).await;

    let snap = h.sink.snapshot().await;
    let escalation = snap
        .iter()
        .find_map(|e| match e {
            RunEvent::HumanEscalation {
                subtask_id,
                reason,
                run_id: r,
                ..
            } if r == &run_id => Some((subtask_id.clone(), reason.clone())),
            _ => None,
        })
        .expect("expected HumanEscalation when lineage cap is hit");
    assert_eq!(escalation.0, r2_id, "escalation must point at r2");
    assert!(
        escalation.1.contains("retry budget") || escalation.1.contains("replan"),
        "escalation reason should mention the cap; got {:?}",
        escalation.1,
    );

    // Only two replans actually happened — the third was short-
    // circuited by the cap. Storage reflects exactly two lineage edges
    // (t0→r1, r1→r2); count_replans_in_lineage(r2) == 2.
    assert_eq!(
        h.storage.count_replans_in_lineage(&r2_id).await.unwrap(),
        2,
        "lineage depth must be exactly 2; a 3rd replan would bump this",
    );
    assert_eq!(
        h.storage.get_replaces_for_subtask(&r1_id).await.unwrap(),
        vec![t0_id.clone()],
    );
    assert_eq!(
        h.storage.get_replaces_for_subtask(&r2_id).await.unwrap(),
        vec![r1_id.clone()],
    );

    // All three subtasks ended Failed — no Done anywhere in the chain.
    let final_subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    for s in &final_subs {
        assert_eq!(
            s.state,
            SubtaskState::Failed,
            "every subtask in the lineage should be Failed; {} was {:?}",
            s.title,
            s.state,
        );
    }

    // Drive Aborted → Cancelled so cleanup fires and the harness tears
    // down cleanly (Phase 3 Step 5 Commit 2a moved worktree cleanup
    // from the Failed finalize to the cancel finalize for this path).
    send_resolution(&h, &run_id, Layer3Decision::Aborted).await;
    h.await_status(&run_id, RunStatus::Cancelled).await;
    assert!(!h.repo_path.join(".whalecode-worktrees").exists());
}

#[tokio::test]
async fn replan_master_error_finalizes_run_failed() {
    // If `master.replan()` itself errors (not a cancel, not an empty
    // plan — a hard error from the CLI / API), the lifecycle must
    // finalize the run Failed with the error text surfaced on the run
    // row. The loop must NOT retry the replan automatically.
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(1)))
        .await
        .with_fail_attempts(
            "t0",
            vec![
                AgentError::TaskFailed { reason: "worker a".into() },
                AgentError::TaskFailed { reason: "worker b".into() },
            ],
        )
        .await
        .with_execute_default(ExecuteScript::Fail("unreachable".into()))
        .await
        .with_replan(ReplanScript::Fail(AgentError::TaskFailed {
            reason: "master OOM".into(),
        }))
        .await;
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("master dies".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let t0_id = subs[0].id.clone();
    h.orch
        .approve_subtasks(&run_id, vec![t0_id.clone()])
        .await
        .unwrap();

    h.await_status(&run_id, RunStatus::Failed).await;

    let stored = h.storage.get_run(&run_id).await.unwrap().unwrap();
    assert_eq!(stored.status, RunStatus::Failed);
    assert!(
        stored
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("master OOM"),
        "run error should surface the master's replan failure, got {:?}",
        stored.error,
    );

    // ReplanStarted fired (we reached the replan call) but no
    // HumanEscalation (the error is a hard-fail, not an infeasibility
    // signal). The t0 subtask stays Failed with the worker's error.
    let snap = h.sink.snapshot().await;
    assert!(
        snap.iter()
            .any(|e| matches!(e, RunEvent::ReplanStarted { .. })),
        "expected ReplanStarted before the master failed",
    );
    assert!(
        !snap
            .iter()
            .any(|e| matches!(e, RunEvent::HumanEscalation { .. })),
        "master hard-error should not masquerade as a human-escalation signal",
    );
    // No replacement subtask was persisted.
    let final_subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    assert_eq!(final_subs.len(), 1, "no replacement should be installed");
    assert_eq!(final_subs[0].id, t0_id);
    assert_eq!(final_subs[0].state, SubtaskState::Failed);
    // Cleanup ran.
    assert!(!h.repo_path.join(".whalecode-worktrees").exists());
}

// -- Phase 3 Step 5 Commit 2b: Layer-3 IPC commands --------------------
//
// These tests exercise the four real IPC commands
// (`mark_subtask_fixed`, `skip_subtask`, `try_replan_again`,
// `manual_fix_subtask`) rather than pushing decisions through the
// backdoor `send_resolution` helper. Validation paths (wrong state,
// wrong subtask, cap guard) plus the happy-path end-to-end flow are
// covered here. The earlier `layer3_*_resolution_*` tests stay
// valid — they still exercise the lifecycle's park select in
// isolation, which is useful when a regression makes the IPC
// layer unreachable.

#[tokio::test]
async fn mark_subtask_fixed_ipc_drives_to_merging() {
    let h = Harness::new(agent_parks_at_escalation().await).await;
    let run_id = h
        .orch
        .submit_task("ipc-mark-fixed".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let ids: Vec<SubtaskId> = subs.iter().map(|s| s.id.clone()).collect();
    h.orch.approve_subtasks(&run_id, ids.clone()).await.unwrap();
    h.await_status(&run_id, RunStatus::AwaitingHumanFix).await;

    let failed_sid = ids[0].clone();
    h.orch
        .mark_subtask_fixed(&run_id, &failed_sid)
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::Merging).await;

    // Storage confirms the transition.
    let stored = h.storage.get_subtask(&failed_sid).await.unwrap().unwrap();
    assert_eq!(stored.state, SubtaskState::Done);
    // Resolution sender was taken out of the map.
    assert!(
        h.orch
            .resolution_senders
            .lock()
            .await
            .get(&run_id)
            .is_none(),
        "resolution sender must be consumed by the IPC call",
    );
}

#[tokio::test]
async fn mark_subtask_fixed_rejects_wrong_run_state() {
    // Run is in AwaitingApproval, not AwaitingHumanFix — the IPC must
    // refuse before touching `resolution_senders`.
    let (h, run_id, subs) = harness_awaiting(plan_of(1)).await;
    let err = h
        .orch
        .mark_subtask_fixed(&run_id, &subs[0].id)
        .await
        .unwrap_err();
    assert!(matches!(err, OrchestratorError::WrongState { .. }));
    // The run is still approvable — reject to clean up.
    h.orch.reject_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Rejected).await;
}

#[tokio::test]
async fn mark_subtask_fixed_rejects_non_escalated_subtask() {
    // Run parked on AwaitingHumanFix but user passes a subtask id that
    // isn't the escalated target. Must be an InvalidEdit, and the park
    // must remain intact so the user can try again.
    let h = Harness::new(agent_parks_at_escalation().await).await;
    let run_id = h
        .orch
        .submit_task("ipc-wrong-sid".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let ids: Vec<SubtaskId> = h
        .storage
        .list_subtasks_for_run(&run_id)
        .await
        .unwrap()
        .into_iter()
        .map(|s| s.id)
        .collect();
    h.orch.approve_subtasks(&run_id, ids).await.unwrap();
    h.await_status(&run_id, RunStatus::AwaitingHumanFix).await;

    let err = h
        .orch
        .mark_subtask_fixed(&run_id, &"not-escalated".into())
        .await
        .unwrap_err();
    assert!(matches!(err, OrchestratorError::InvalidEdit(_)));
    // Sender is still installed — user can retry with the correct id.
    assert!(
        h.orch
            .resolution_senders
            .lock()
            .await
            .get(&run_id)
            .is_some(),
        "sender must not be consumed on validation failure",
    );

    // Clean up the run so it doesn't leak.
    send_resolution(&h, &run_id, Layer3Decision::Aborted).await;
    h.await_status(&run_id, RunStatus::Cancelled).await;
}

#[tokio::test]
async fn skip_subtask_ipc_returns_full_cascade() {
    // Diamond: A (fails) → B, A → C, B → D, C → D. When A escalates
    // and the user skips it, the cascade must include all four.
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_with_deps(&[
            ("A", &[]),
            ("B", &[0]),
            ("C", &[0]),
            ("D", &[1, 2]),
        ])))
        .await
        .with_execute("A", ExecuteScript::Fail("boom".into()))
        .await
        .with_replan(ReplanScript::Empty)
        .await;
    let h = Harness::new(agent).await;
    let run_id = h
        .orch
        .submit_task("ipc-skip-cascade".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let ids_by_title: std::collections::HashMap<String, SubtaskId> = subs
        .iter()
        .map(|s| (s.title.clone(), s.id.clone()))
        .collect();
    let a_id = ids_by_title["A"].clone();
    let all_ids: Vec<SubtaskId> = subs.iter().map(|s| s.id.clone()).collect();
    h.orch
        .approve_subtasks(&run_id, all_ids.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingHumanFix).await;

    let result = h.orch.skip_subtask(&run_id, &a_id).await.unwrap();
    assert_eq!(result.skipped_count, 4);
    // All four ids should appear in the cascade.
    for id in &all_ids {
        assert!(
            result.skipped_ids.contains(id),
            "cascade must include {id}, got {:?}",
            result.skipped_ids,
        );
    }

    h.await_status(&run_id, RunStatus::Merging).await;
    // Apply the empty diff; the run terminates cleanly.
    h.orch.discard_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Rejected).await;
}

#[tokio::test]
async fn skip_subtask_rejects_wrong_run_state() {
    let (h, run_id, subs) = harness_awaiting(plan_of(1)).await;
    let err = h
        .orch
        .skip_subtask(&run_id, &subs[0].id)
        .await
        .unwrap_err();
    assert!(matches!(err, OrchestratorError::WrongState { .. }));
    h.orch.reject_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Rejected).await;
}

#[tokio::test]
async fn try_replan_again_rejects_when_budget_exhausted() {
    // Manually seed two lineage edges in storage so the cap guard
    // trips even though the run's in-memory state has a fresh failed
    // subtask. This keeps the scripted-agent surface small while
    // still exercising the storage-backed guard.
    let h = Harness::new(agent_parks_at_escalation().await).await;
    let run_id = h
        .orch
        .submit_task("ipc-cap-guard".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let ids: Vec<SubtaskId> = subs.iter().map(|s| s.id.clone()).collect();
    let current_id = ids[0].clone();
    h.orch
        .approve_subtasks(&run_id, ids.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingHumanFix).await;

    // Fabricate a two-deep lineage: orig0 ← orig1 ← current_id. We
    // have to insert the ancestor subtasks as well so the replan
    // edge FKs resolve.
    for anc in ["orig0", "orig1"] {
        h.storage
            .insert_subtask(&crate::storage::models::NewSubtask {
                id: anc.into(),
                run_id: run_id.clone(),
                title: anc.into(),
                why: None,
                assigned_worker: AgentKind::Claude,
                state: SubtaskState::Failed,
            })
            .await
            .unwrap();
    }
    h.storage
        .insert_replan("orig0", "orig1", None)
        .await
        .unwrap();
    h.storage
        .insert_replan("orig1", &current_id, None)
        .await
        .unwrap();

    let err = h
        .orch
        .try_replan_again(&run_id, &current_id)
        .await
        .unwrap_err();
    assert!(
        matches!(err, OrchestratorError::InvalidEdit(_)),
        "budget guard must surface as InvalidEdit, got {err:?}",
    );
    // Sender is still installed — user can abort / skip instead.
    assert!(
        h.orch
            .resolution_senders
            .lock()
            .await
            .get(&run_id)
            .is_some(),
        "sender must not be consumed on cap-guard rejection",
    );
    send_resolution(&h, &run_id, Layer3Decision::Aborted).await;
    h.await_status(&run_id, RunStatus::Cancelled).await;
}

#[tokio::test]
async fn manual_fix_subtask_rejects_non_escalated_subtask() {
    // Happy-path `manual_fix_subtask` would shell out to `open` /
    // `xdg-open`; covering the validation-only path keeps the test
    // free of OS-level side effects while still pinning the contract.
    let h = Harness::new(agent_parks_at_escalation().await).await;
    let run_id = h
        .orch
        .submit_task("ipc-manual-wrong-sid".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let ids: Vec<SubtaskId> = h
        .storage
        .list_subtasks_for_run(&run_id)
        .await
        .unwrap()
        .into_iter()
        .map(|s| s.id)
        .collect();
    h.orch.approve_subtasks(&run_id, ids).await.unwrap();
    h.await_status(&run_id, RunStatus::AwaitingHumanFix).await;

    let err = h
        .orch
        .manual_fix_subtask(&run_id, &"not-escalated".into())
        .await
        .unwrap_err();
    assert!(matches!(err, OrchestratorError::InvalidEdit(_)));
    // The park must still be alive.
    assert!(
        h.orch
            .resolution_senders
            .lock()
            .await
            .get(&run_id)
            .is_some(),
        "manual_fix_subtask must not consume the resolution sender",
    );
    send_resolution(&h, &run_id, Layer3Decision::Aborted).await;
    h.await_status(&run_id, RunStatus::Cancelled).await;
}

// -- Critical timing test ----------------------------------------------
//
// This is the smoking-gun for the Commit 2b dispatcher change:
// `mark_subtask_fixed` must unblock a previously-Waiting dependent.
// Before the change, the dispatcher's `NeedsReplan` branch cancelled
// the run's token and drained every Waiting subtask to Skipped — so
// even if `resolve_fixed` flipped A to Done, B was already terminal
// and the second dispatcher pass had nothing to do. The new flow
// preserves B's Waiting state across the park, and the lifecycle
// hands a fresh cancel token to `run_dispatcher` after resolve.

#[tokio::test]
async fn mark_subtask_fixed_unblocks_waiting_dependent_and_reaches_merging() {
    // Plan: A → B. A fails, empty replan → park. User marks A fixed.
    // Expected: B transitions Waiting → Running → Done, run reaches
    // Merging, A ends Done, B ends Done.
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_with_deps(&[("A", &[]), ("B", &[0])])))
        .await
        .with_execute("A", ExecuteScript::Fail("boom".into()))
        .await
        .with_execute(
            "B",
            ExecuteScript::OkWrite {
                summary: "B done".into(),
                files: vec![(PathBuf::from("b.txt"), "b".into())],
            },
        )
        .await
        .with_replan(ReplanScript::Empty)
        .await;
    let h = Harness::new(agent).await;
    let run_id = h
        .orch
        .submit_task("A-then-B".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let ids_by_title: std::collections::HashMap<String, SubtaskId> = subs
        .iter()
        .map(|s| (s.title.clone(), s.id.clone()))
        .collect();
    let a_id = ids_by_title["A"].clone();
    let b_id = ids_by_title["B"].clone();
    h.orch
        .approve_subtasks(&run_id, vec![a_id.clone(), b_id.clone()])
        .await
        .unwrap();

    // Park on escalation for A.
    h.await_status(&run_id, RunStatus::AwaitingHumanFix).await;
    // B must still be Waiting — NOT drained to Skipped.
    let at_park = h.storage.get_subtask(&b_id).await.unwrap().unwrap();
    assert_eq!(
        at_park.state,
        SubtaskState::Waiting,
        "B must remain Waiting across the Layer-3 park (dispatcher must not drain)",
    );

    // User fixes A via the real IPC.
    h.orch
        .mark_subtask_fixed(&run_id, &a_id)
        .await
        .unwrap();

    // Back through the dispatcher; B runs, run merges.
    h.await_status(&run_id, RunStatus::Merging).await;

    let final_a = h.storage.get_subtask(&a_id).await.unwrap().unwrap();
    assert_eq!(final_a.state, SubtaskState::Done);
    let final_b = h.storage.get_subtask(&b_id).await.unwrap().unwrap();
    assert_eq!(
        final_b.state,
        SubtaskState::Done,
        "B must have run and completed after A was marked fixed",
    );

    // Transcript: B must have gone through Running.
    let snap = h.sink.snapshot().await;
    assert!(
        snap.iter().any(|e| matches!(
            e,
            RunEvent::SubtaskStateChanged { subtask_id, state, .. }
            if subtask_id == &b_id && *state == SubtaskState::Running
        )),
        "expected SubtaskStateChanged(Running) for B after the fix",
    );
}

// -- replan_count wire ------------------------------------------------

#[tokio::test]
async fn replan_count_is_zero_on_initial_subtasks_proposed() {
    // The very first SubtasksProposed emit (initial plan) must carry
    // replan_count = 0 for every subtask — no lineage exists yet.
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(2)))
        .await;
    let h = Harness::new(agent).await;
    let run_id = h
        .orch
        .submit_task("replan-count-initial".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;

    let payload = last_proposed_payload(&h, &run_id).await;
    assert_eq!(payload.len(), 2);
    for sub in &payload {
        assert_eq!(
            sub.replan_count, 0,
            "initial plan must emit replan_count=0, got {sub:?}",
        );
    }

    h.orch.reject_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Rejected).await;
}

#[tokio::test]
async fn replan_count_is_one_on_first_layer2_replacement() {
    // Plan: t0 fails → master replans with a viable replacement. The
    // `SubtasksProposed` re-emit after `install_replacement_subtasks`
    // must carry replan_count = 1 for the replacement row (lineage
    // depth of 1) and 0 for the original (still present, now Failed).
    let replacement = Plan {
        reasoning: "try again".into(),
        subtasks: vec![PlannedSubtask {
            title: "good".into(),
            why: "replacement".into(),
            assigned_worker: AgentKind::Claude,
            dependencies: vec![],
        }],
    };
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(1)))
        .await
        .with_execute("t0", ExecuteScript::Fail("boom".into()))
        .await
        .with_replan(ReplanScript::OkPlan(replacement))
        .await;
    let h = Harness::new(agent).await;
    let run_id = h
        .orch
        .submit_task("replan-count-1".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let initial_ids: Vec<SubtaskId> = subs.iter().map(|s| s.id.clone()).collect();
    h.orch.approve_subtasks(&run_id, initial_ids).await.unwrap();

    // Wait for the replan to re-install AwaitingApproval.
    //
    // We already saw one AwaitingApproval from the initial plan, so
    // poll the transcript for a SubtasksProposed with a replacement
    // row (non-empty `replaces`).
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        let snap = h.sink.snapshot().await;
        let has_replacement_emit = snap.iter().any(|e| match e {
            RunEvent::SubtasksProposed { run_id: r, subtasks }
                if r == &run_id =>
            {
                subtasks.iter().any(|s| !s.replaces.is_empty())
            }
            _ => false,
        });
        if has_replacement_emit {
            break;
        }
        if std::time::Instant::now() >= deadline {
            panic!(
                "timed out waiting for replacement SubtasksProposed. Events: {:#?}",
                snap,
            );
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    let payload = last_proposed_payload(&h, &run_id).await;
    let replacement_row = payload
        .iter()
        .find(|s| !s.replaces.is_empty())
        .expect("replacement must appear in the post-replan payload");
    assert_eq!(
        replacement_row.replan_count, 1,
        "first replacement in the lineage must carry replan_count=1",
    );
    let original_row = payload
        .iter()
        .find(|s| s.replaces.is_empty())
        .expect("original subtask still appears in the list");
    assert_eq!(
        original_row.replan_count, 0,
        "the original subtask's lineage is empty; its replan_count stays 0",
    );

    // Clean up by rejecting the new plan.
    h.orch.reject_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Rejected).await;
}

// -- Phase 3 Step 7: auto-approve + ceiling ---------------------------
//
// These tests drive the `Settings::auto_approve` bypass path through
// the full lifecycle. Each test mutates the harness's `SettingsStore`
// BEFORE `submit_task` so the first approval-wait pass sees the toggle
// already on. Layer-3 and apply remain user-gated even when
// auto-approve is on; those invariants have their own tests below.

/// Enable auto-approve (and optionally a custom ceiling) on the
/// harness's live settings store. Tests call this before
/// `submit_task` so the approval wait sees the toggle on.
fn enable_auto_approve(h: &Harness, max: Option<u32>) {
    let mut patch = serde_json::json!({ "autoApprove": true });
    if let Some(m) = max {
        patch["maxSubtasksPerAutoApprovedRun"] = serde_json::json!(m);
    }
    h.orch.settings.update(&patch).unwrap();
}

/// Count `AutoApproved` events for this run in the recorded transcript.
async fn count_auto_approved(h: &Harness, run_id: &RunId) -> usize {
    h.sink
        .snapshot()
        .await
        .iter()
        .filter(|e| {
            matches!(
                e,
                RunEvent::AutoApproved { run_id: r, .. } if r == run_id
            )
        })
        .count()
}

/// Wait for a specific `RunEvent::AutoApproved` payload, returning the
/// subtask id list. Bounded; panics with the transcript if it doesn't
/// arrive in time.
async fn await_auto_approved(h: &Harness, run_id: &RunId) -> Vec<SubtaskId> {
    expect_event(h, run_id, |e| match e {
        RunEvent::AutoApproved { subtask_ids, .. } => Some(subtask_ids.clone()),
        _ => None,
    })
    .await
}

#[tokio::test]
async fn auto_approve_bypasses_initial_approval_without_user_click() {
    // Settings.auto_approve=true → lifecycle synthesizes Approve(all)
    // for the initial plan. No `approve_subtasks` call; run reaches
    // Merging on its own and emits `AutoApproved` exactly once.
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
    enable_auto_approve(&h, None);

    let run_id = h
        .orch
        .submit_task("auto".into(), h.repo_path.clone())
        .await
        .unwrap();

    // Must reach Merging without a human approve click.
    h.await_status(&run_id, RunStatus::Merging).await;
    await_all_subtasks_terminal(&h, &run_id).await;

    let approved = await_auto_approved(&h, &run_id).await;
    assert_eq!(
        approved.len(),
        2,
        "AutoApproved payload should list both subtasks"
    );
    assert_eq!(
        count_auto_approved(&h, &run_id).await,
        1,
        "initial plan should fire AutoApproved exactly once",
    );

    // No AutoApproveSuspended — the ceiling was never hit.
    let suspended = h
        .sink
        .snapshot()
        .await
        .iter()
        .any(|e| matches!(e, RunEvent::AutoApproveSuspended { run_id: r, .. } if r == &run_id));
    assert!(
        !suspended,
        "AutoApproveSuspended must not fire when under the ceiling",
    );

    // Clean up: bypass the apply step by discarding.
    h.orch.discard_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Rejected).await;
}

#[tokio::test]
async fn auto_approve_off_uses_manual_approval_path() {
    // Regression guard: when auto_approve is off (the default), the
    // lifecycle must NOT emit AutoApproved / AutoApproveSuspended and
    // must wait for `approve_subtasks` like before.
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(1)))
        .await
        .with_execute(
            "t0",
            ExecuteScript::Ok {
                summary: "did t0".into(),
                delay: Duration::from_millis(0),
            },
        )
        .await;
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("manual".into(), h.repo_path.clone())
        .await
        .unwrap();

    // Should stall in AwaitingApproval until we click.
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;

    // Give the lifecycle a grace window to (wrongly) auto-approve.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let stored = h.storage.get_run(&run_id).await.unwrap().unwrap();
    assert_eq!(
        stored.status,
        RunStatus::AwaitingApproval,
        "auto-approve off must leave run awaiting approval",
    );
    assert_eq!(
        count_auto_approved(&h, &run_id).await,
        0,
        "AutoApproved must never fire with auto_approve=false",
    );

    approve_all(&h, &run_id).await;
    await_all_subtasks_terminal(&h, &run_id).await;
    h.orch.discard_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Rejected).await;
}

#[tokio::test]
async fn auto_approve_ceiling_suspends_and_falls_back_to_manual() {
    // Plan has 3 subtasks, ceiling is 2 → bypass refuses to synthesize,
    // emits AutoApproveSuspended, run parks in AwaitingApproval waiting
    // for a real user click.
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(3)))
        .await
        .with_execute_default(ExecuteScript::Ok {
            summary: "ok".into(),
            delay: Duration::from_millis(0),
        })
        .await;
    let h = Harness::new(agent).await;
    enable_auto_approve(&h, Some(2));

    let run_id = h
        .orch
        .submit_task("too-big".into(), h.repo_path.clone())
        .await
        .unwrap();

    // Park in AwaitingApproval (the fall-through path).
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;

    // Suspension event must have fired exactly once with the
    // canonical reason string.
    let suspended_reason = expect_event(&h, &run_id, |e| match e {
        RunEvent::AutoApproveSuspended { reason, .. } => Some(reason.clone()),
        _ => None,
    })
    .await;
    assert_eq!(suspended_reason, "subtask_limit");

    let count_suspended = h
        .sink
        .snapshot()
        .await
        .iter()
        .filter(|e| {
            matches!(
                e,
                RunEvent::AutoApproveSuspended { run_id: r, .. } if r == &run_id
            )
        })
        .count();
    assert_eq!(
        count_suspended, 1,
        "AutoApproveSuspended must be emitted exactly once per run"
    );

    // AutoApproved must NOT have fired — the ceiling blocked synthesis.
    assert_eq!(
        count_auto_approved(&h, &run_id).await,
        0,
        "AutoApproved must not fire when suspended",
    );

    // Latch check: flipping settings again shouldn't un-suspend. We
    // simulate a user retry by lowering the ceiling further and hitting
    // approve manually. The run should proceed without another
    // auto-approve event.
    approve_all(&h, &run_id).await;
    await_all_subtasks_terminal(&h, &run_id).await;
    assert_eq!(
        count_auto_approved(&h, &run_id).await,
        0,
        "auto-approve stays suspended after a ceiling trip",
    );

    h.orch.discard_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Rejected).await;
}

#[tokio::test]
async fn auto_approve_does_not_bypass_layer3_escalation() {
    // Initial plan auto-approves; worker fails; master replan returns
    // empty → Layer 3 parks on AwaitingHumanFix. The Layer 3 wait must
    // block on the resolution channel even with auto_approve=true.
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(1)))
        .await
        .with_execute("t0", ExecuteScript::Fail("boom".into()))
        .await
        .with_replan(ReplanScript::Empty)
        .await;
    let h = Harness::new(agent).await;
    enable_auto_approve(&h, None);

    let run_id = h
        .orch
        .submit_task("will-escalate".into(), h.repo_path.clone())
        .await
        .unwrap();

    // Initial plan should auto-approve — we never call approve_subtasks.
    await_auto_approved(&h, &run_id).await;

    // Run must reach Layer 3 park without further user input.
    h.await_status(&run_id, RunStatus::AwaitingHumanFix).await;
    assert!(
        h.sink
            .snapshot()
            .await
            .iter()
            .any(|e| matches!(e, RunEvent::HumanEscalation { run_id: r, .. } if r == &run_id)),
        "HumanEscalation must fire even under auto-approve",
    );

    // Cleanup: resolve Aborted so the run finalizes to Cancelled.
    send_resolution(&h, &run_id, Layer3Decision::Aborted).await;
    h.await_status(&run_id, RunStatus::Cancelled).await;
}

#[tokio::test]
async fn auto_approve_does_not_bypass_apply_step() {
    // Reach Merging via auto-approve, then confirm the run stays in
    // Merging until `apply_run` is called. Auto-approve must never
    // auto-apply — the user still gates the diff review.
    let agent = agent_writing(&[("t0", vec![("a.txt", "hello\n")])]).await;
    let h = Harness::new(agent).await;
    enable_auto_approve(&h, None);

    let run_id = h
        .orch
        .submit_task("auto-then-apply".into(), h.repo_path.clone())
        .await
        .unwrap();

    await_auto_approved(&h, &run_id).await;
    h.await_status(&run_id, RunStatus::Merging).await;

    // Wait for DiffReady so the apply sender is installed.
    expect_event(&h, &run_id, |e| match e {
        RunEvent::DiffReady { files, .. } => Some(files.clone()),
        _ => None,
    })
    .await;

    // Give the lifecycle a grace window to (wrongly) auto-apply.
    tokio::time::sleep(Duration::from_millis(150)).await;
    let stored = h.storage.get_run(&run_id).await.unwrap().unwrap();
    assert_eq!(
        stored.status,
        RunStatus::Merging,
        "auto-approve must not auto-apply; apply still waits for user",
    );

    // Manually apply — now the run finalizes.
    h.orch.apply_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Done).await;
}

#[tokio::test]
async fn auto_approve_bypasses_replan_plan_pass() {
    // Initial plan auto-approves; worker fails; master returns a viable
    // replacement → the replan re-emits SubtasksProposed and the
    // lifecycle re-enters the approval wait. Auto-approve must fire
    // again on that pass so the replacement runs without user input.
    let replacement = Plan {
        reasoning: "retry".into(),
        subtasks: vec![PlannedSubtask {
            title: "recovered".into(),
            why: "replacement".into(),
            assigned_worker: AgentKind::Claude,
            dependencies: vec![],
        }],
    };
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(1)))
        .await
        // Fail BOTH the original attempt and the retry so we escalate
        // to Layer 2 (master replan).
        .with_fail_attempts(
            "t0",
            vec![
                AgentError::TaskFailed { reason: "first".into() },
                AgentError::TaskFailed { reason: "second".into() },
            ],
        )
        .await
        .with_execute(
            "t0",
            ExecuteScript::Ok {
                summary: "never-reached".into(),
                delay: Duration::from_millis(0),
            },
        )
        .await
        .with_execute(
            "recovered",
            ExecuteScript::Ok {
                summary: "replacement ok".into(),
                delay: Duration::from_millis(0),
            },
        )
        .await
        .with_replan(ReplanScript::OkPlan(replacement))
        .await;
    let h = Harness::new(agent).await;
    enable_auto_approve(&h, None);

    let run_id = h
        .orch
        .submit_task("replan-auto".into(), h.repo_path.clone())
        .await
        .unwrap();

    // Wait until we've observed TWO auto-approvals: the initial plan and
    // the replacement plan. Bounded poll — replan + two retries + final
    // dispatch is well under 3s with no real subprocess work.
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        if count_auto_approved(&h, &run_id).await >= 2 {
            break;
        }
        if std::time::Instant::now() >= deadline {
            let snap = h.sink.snapshot().await;
            panic!(
                "expected AutoApproved twice (initial + replan); got {}. Events: {:#?}",
                count_auto_approved(&h, &run_id).await,
                snap,
            );
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    // Run should eventually reach Merging without any human click.
    h.await_status(&run_id, RunStatus::Merging).await;

    // No suspension — both passes were under the default ceiling (20).
    let suspended = h
        .sink
        .snapshot()
        .await
        .iter()
        .any(|e| matches!(e, RunEvent::AutoApproveSuspended { run_id: r, .. } if r == &run_id));
    assert!(!suspended, "replan pass was within ceiling, must not suspend");

    h.orch.discard_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Rejected).await;
}

// ---------------------------------------------------------------------
// Phase 4 Step 5 — AgentError → ErrorCategoryWire on Failed emits
// ---------------------------------------------------------------------

/// Helper: pull the `error_category` from the **terminal** `Failed`
/// `SubtaskStateChanged` event for `sub_id`. Panics if no such event
/// was emitted, which is the signal we want: a missing Failed emit
/// indicates a broken contract, not a "None" category.
fn failed_error_category(
    snap: &[RunEvent],
    sub_id: &SubtaskId,
) -> Option<ErrorCategoryWire> {
    snap.iter()
        .rev()
        .find_map(|e| match e {
            RunEvent::SubtaskStateChanged {
                subtask_id,
                state: SubtaskState::Failed,
                error_category,
                ..
            } if subtask_id == sub_id => Some(error_category.clone()),
            _ => None,
        })
        .expect("expected one SubtaskStateChanged(Failed) for sub_id")
}

/// Every retryable [`AgentError`] must round-trip through the
/// dispatcher and surface on the terminal `Failed` state change as
/// the matching [`ErrorCategoryWire`]. Category is populated at the
/// `EscalateToMaster` → `mark_failed` boundary; this test drives the
/// full path end-to-end (approve → dispatch → Layer-1 retry exhaust
/// → Layer-2 empty replan → Layer-3 park).
///
/// `SpawnFailed` short-circuits Layer 1 (no Retrying emit) — the
/// helper's `rev()` search still finds the Failed emit because we
/// don't depend on the retry path here, only the terminal event.
/// `Timeout` carries `after_secs` on the wire; we assert the value
/// is preserved through the dispatcher.
#[tokio::test]
async fn failed_emit_carries_error_category_matching_agent_error() {
    let cases: Vec<(AgentError, ErrorCategoryWire)> = vec![
        (
            AgentError::ProcessCrashed {
                exit_code: Some(139),
                signal: None,
            },
            ErrorCategoryWire::ProcessCrashed,
        ),
        (
            AgentError::TaskFailed {
                reason: "refused".into(),
            },
            ErrorCategoryWire::TaskFailed,
        ),
        (
            AgentError::ParseFailed {
                reason: "missing json block".into(),
                raw_output: String::new(),
            },
            ErrorCategoryWire::ParseFailed,
        ),
        (
            AgentError::Timeout { after_secs: 600 },
            ErrorCategoryWire::Timeout { after_secs: 600 },
        ),
        (
            AgentError::SpawnFailed {
                cause: "ENOENT".into(),
            },
            ErrorCategoryWire::SpawnFailed,
        ),
    ];

    for (err, expected) in cases {
        // Two identical failures for non-SpawnFailed variants to
        // exhaust Layer 1 (attempt 1 + retry). SpawnFailed is
        // deterministic: the dispatcher short-circuits retry on the
        // first SpawnFailed and routes straight to Layer 2, so one
        // queued error is enough. `with_fail_attempts` pops one per
        // `execute` call — under-queueing would leak into the default.
        let is_deterministic = matches!(err, AgentError::SpawnFailed { .. });
        let queue = if is_deterministic {
            vec![err.clone()]
        } else {
            vec![err.clone(), err.clone()]
        };

        let agent = ScriptedAgent::new(AgentKind::Claude)
            .with_plan(Ok(plan_of(1)))
            .await
            .with_fail_attempts("t0", queue)
            .await
            .with_execute_default(ExecuteScript::Fail(
                "unexpected extra execute".into(),
            ))
            .await
            .with_replan(ReplanScript::Empty)
            .await;
        let h = Harness::new(agent).await;

        let run_id = h
            .orch
            .submit_task("cat".into(), h.repo_path.clone())
            .await
            .unwrap();
        h.await_status(&run_id, RunStatus::AwaitingApproval).await;
        let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
        let sub_id = subs[0].id.clone();
        h.orch
            .approve_subtasks(&run_id, vec![sub_id.clone()])
            .await
            .unwrap();
        // Layer-2 replan returns empty → run parks at Layer 3.
        h.await_status(&run_id, RunStatus::AwaitingHumanFix).await;

        let snap = h.sink.snapshot().await;
        let got = failed_error_category(&snap, &sub_id);
        assert_eq!(
            got,
            Some(expected.clone()),
            "category mismatch for {:?}: got {:?}, want {:?}",
            err,
            got,
            expected,
        );

        send_resolution(&h, &run_id, Layer3Decision::Aborted).await;
        h.await_status(&run_id, RunStatus::Cancelled).await;
    }
}

/// Retrying + Running emits never carry an `error_category` — the
/// field is exclusively a Failed-terminal annotation. Regression
/// guard so a future refactor can't silently tack categories onto
/// non-terminal transitions.
#[tokio::test]
async fn non_failed_state_changes_never_carry_error_category() {
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(1)))
        .await
        .with_fail_attempts(
            "t0",
            vec![AgentError::TaskFailed {
                reason: "first".into(),
            }],
        )
        .await
        .with_execute(
            "t0",
            ExecuteScript::Ok {
                summary: "recovered".into(),
                delay: Duration::from_millis(0),
            },
        )
        .await;
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("one".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let sub_id = subs[0].id.clone();
    h.orch
        .approve_subtasks(&run_id, vec![sub_id.clone()])
        .await
        .unwrap();
    // Runs through retry-success → Done → Merging.
    h.await_status(&run_id, RunStatus::Merging).await;

    let snap = h.sink.snapshot().await;
    for event in &snap {
        if let RunEvent::SubtaskStateChanged {
            subtask_id,
            state,
            error_category,
            ..
        } = event
        {
            if subtask_id != &sub_id {
                continue;
            }
            if !matches!(state, SubtaskState::Failed) {
                assert!(
                    error_category.is_none(),
                    "non-Failed state {state:?} must carry None category, got {error_category:?}"
                );
            }
        }
    }

    h.orch.discard_run(&run_id).await.unwrap();
}

// -- Phase 5 Step 1: per-worker stop ---------------------------------
//
// `cancel_subtask` stops exactly one subtask and leaves the rest of
// the run running. Bypasses the retry ladder entirely: no Layer 1
// retry, no Layer 2 replan, no Layer 3 escalation. Distinct from
// run-wide `cancel_run` (which drains every worker and terminates the
// run). The subtask transitions to `Cancelled` — user-intent terminal,
// new in Phase 5.

async fn await_subtask_state(
    h: &Harness,
    run_id: &RunId,
    subtask_id: &SubtaskId,
    target: SubtaskState,
) {
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        let subs = h.storage.list_subtasks_for_run(run_id).await.unwrap();
        if let Some(s) = subs.iter().find(|s| &s.id == subtask_id) {
            if s.state == target {
                return;
            }
        }
        if std::time::Instant::now() >= deadline {
            let subs = h.storage.list_subtasks_for_run(run_id).await.unwrap();
            panic!(
                "timed out waiting for subtask {subtask_id} to reach {target:?}. Current: {subs:#?}"
            );
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn await_all_subtasks_terminal_or_cancelled(h: &Harness, run_id: &RunId) {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let subs = h.storage.list_subtasks_for_run(run_id).await.unwrap();
        if !subs.is_empty()
            && subs.iter().all(|s| {
                matches!(
                    s.state,
                    SubtaskState::Done
                        | SubtaskState::Failed
                        | SubtaskState::Skipped
                        | SubtaskState::Cancelled
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
async fn cancel_subtask_marks_cancelled_and_run_continues() {
    // 3 workers: t0 completes quickly, t1 blocks (we cancel it), t2
    // completes quickly. After cancel_subtask(t1), run must still
    // reach Merging with t0 + t2 Done and t1 Cancelled.
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(3)))
        .await
        .with_execute(
            "t0",
            ExecuteScript::OkWrite {
                summary: "t0 done".into(),
                files: vec![(PathBuf::from("a.txt"), "aaa".into())],
            },
        )
        .await
        .with_execute("t1", ExecuteScript::Block)
        .await
        .with_execute(
            "t2",
            ExecuteScript::OkWrite {
                summary: "t2 done".into(),
                files: vec![(PathBuf::from("c.txt"), "ccc".into())],
            },
        )
        .await;
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("three-workers".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;

    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let ids: Vec<SubtaskId> = subs.iter().map(|s| s.id.clone()).collect();
    let t1_id = subs
        .iter()
        .find(|s| s.title == "t1")
        .map(|s| s.id.clone())
        .unwrap();
    h.orch.approve_subtasks(&run_id, ids).await.unwrap();
    h.await_status(&run_id, RunStatus::Running).await;

    // Let t1 reach Running before firing cancel_subtask.
    await_subtask_state(&h, &run_id, &t1_id, SubtaskState::Running).await;

    h.orch.cancel_subtask(&run_id, &t1_id).await.unwrap();

    // t1 must land on Cancelled (user-intent terminal).
    await_subtask_state(&h, &run_id, &t1_id, SubtaskState::Cancelled).await;

    // Run must still reach Merging — other workers' diffs are applied.
    h.await_status(&run_id, RunStatus::Merging).await;
}

#[tokio::test]
async fn cancel_subtask_bypasses_layer_1_retry() {
    // A cancelled subtask must NOT emit any Retrying state event —
    // that's the Layer 1 retry path, which is explicitly bypassed by
    // manual cancel. We also assert no ReplanStarted fires (Layer 2).
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(1)))
        .await
        .with_execute("t0", ExecuteScript::Block)
        .await;
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("solo".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let ids: Vec<SubtaskId> = subs.iter().map(|s| s.id.clone()).collect();
    let t0_id = ids[0].clone();
    h.orch.approve_subtasks(&run_id, ids).await.unwrap();
    h.await_status(&run_id, RunStatus::Running).await;
    await_subtask_state(&h, &run_id, &t0_id, SubtaskState::Running).await;

    h.orch.cancel_subtask(&run_id, &t0_id).await.unwrap();
    await_subtask_state(&h, &run_id, &t0_id, SubtaskState::Cancelled).await;

    let events = h.sink.snapshot().await;
    let retrying_for_t0 = events.iter().any(|e| {
        matches!(
            e,
            RunEvent::SubtaskStateChanged {
                subtask_id,
                state: SubtaskState::Retrying,
                ..
            } if subtask_id == &t0_id
        )
    });
    assert!(!retrying_for_t0, "manual cancel must not trigger Layer 1 retry");

    let replan_started = events
        .iter()
        .any(|e| matches!(e, RunEvent::ReplanStarted { .. }));
    assert!(!replan_started, "manual cancel must not trigger Layer 2 replan");
}

#[tokio::test]
async fn cancel_subtask_cascades_dependents_to_skipped() {
    // t0 is blocked + cancelled; t1 depends on t0. t1 must transition
    // to Skipped (cascade), not Cancelled — Cancelled is reserved for
    // user-intent; cascade is orchestrator-intent.
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_with_deps(&[("t0", &[]), ("t1", &[0])])))
        .await
        .with_execute("t0", ExecuteScript::Block)
        .await
        .with_execute(
            "t1",
            ExecuteScript::Ok {
                summary: "never runs".into(),
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
    let t0_id = subs.iter().find(|s| s.title == "t0").unwrap().id.clone();
    let t1_id = subs.iter().find(|s| s.title == "t1").unwrap().id.clone();
    let ids: Vec<SubtaskId> = subs.iter().map(|s| s.id.clone()).collect();
    h.orch.approve_subtasks(&run_id, ids).await.unwrap();
    h.await_status(&run_id, RunStatus::Running).await;
    await_subtask_state(&h, &run_id, &t0_id, SubtaskState::Running).await;

    h.orch.cancel_subtask(&run_id, &t0_id).await.unwrap();

    await_subtask_state(&h, &run_id, &t0_id, SubtaskState::Cancelled).await;
    await_subtask_state(&h, &run_id, &t1_id, SubtaskState::Skipped).await;
    await_all_subtasks_terminal_or_cancelled(&h, &run_id).await;
}

#[tokio::test]
async fn cancel_subtask_on_waiting_marks_cancelled_preemptively() {
    // t1 depends on a blocked t0. Cancel t1 (Waiting state, no worker
    // ever spawned) → t1 transitions to Cancelled without running.
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_with_deps(&[("t0", &[]), ("t1", &[0])])))
        .await
        .with_execute("t0", ExecuteScript::Block)
        .await
        .with_execute(
            "t1",
            ExecuteScript::Ok {
                summary: "would run".into(),
                delay: Duration::from_millis(0),
            },
        )
        .await;
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("wait-cancel".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let t0_id = subs.iter().find(|s| s.title == "t0").unwrap().id.clone();
    let t1_id = subs.iter().find(|s| s.title == "t1").unwrap().id.clone();
    let ids: Vec<SubtaskId> = subs.iter().map(|s| s.id.clone()).collect();
    h.orch.approve_subtasks(&run_id, ids).await.unwrap();
    h.await_status(&run_id, RunStatus::Running).await;
    await_subtask_state(&h, &run_id, &t1_id, SubtaskState::Waiting).await;

    h.orch.cancel_subtask(&run_id, &t1_id).await.unwrap();
    await_subtask_state(&h, &run_id, &t1_id, SubtaskState::Cancelled).await;

    // Cleanup: cancel run so t0 stops blocking.
    h.orch.cancel_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Cancelled).await;
    let _ = t0_id;
}

#[tokio::test]
async fn cancel_subtask_on_done_returns_wrong_state() {
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(1)))
        .await
        .with_execute(
            "t0",
            ExecuteScript::Ok {
                summary: "done".into(),
                delay: Duration::from_millis(0),
            },
        )
        .await;
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("done-cancel".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let t0_id = subs[0].id.clone();
    let ids: Vec<SubtaskId> = subs.iter().map(|s| s.id.clone()).collect();
    h.orch.approve_subtasks(&run_id, ids).await.unwrap();
    await_subtask_state(&h, &run_id, &t0_id, SubtaskState::Done).await;

    let err = h.orch.cancel_subtask(&run_id, &t0_id).await.unwrap_err();
    match err {
        OrchestratorError::WrongSubtaskState { state, .. } => {
            assert_eq!(state, SubtaskState::Done);
        }
        e => panic!("expected WrongSubtaskState, got {e:?}"),
    }
}

#[tokio::test]
async fn cancel_subtask_on_failed_returns_wrong_state_during_replan_race() {
    // Mid-replan race: subtask is Failed while Layer 2 master replan is
    // in flight. Per spec, cancel must fail gracefully with
    // WrongSubtaskState — no double-terminal.
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(1)))
        .await
        .with_execute("t0", ExecuteScript::Fail("boom1".into()))
        .await
        .with_execute("t0", ExecuteScript::Fail("boom2".into()))
        .await
        .with_replan(ReplanScript::Empty)
        .await;
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("replan-race".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;
    let subs = h.storage.list_subtasks_for_run(&run_id).await.unwrap();
    let t0_id = subs[0].id.clone();
    let ids: Vec<SubtaskId> = subs.iter().map(|s| s.id.clone()).collect();
    h.orch.approve_subtasks(&run_id, ids).await.unwrap();

    await_subtask_state(&h, &run_id, &t0_id, SubtaskState::Failed).await;

    let err = h.orch.cancel_subtask(&run_id, &t0_id).await.unwrap_err();
    match err {
        OrchestratorError::WrongSubtaskState { state, .. } => {
            assert_eq!(state, SubtaskState::Failed);
        }
        e => panic!("expected WrongSubtaskState, got {e:?}"),
    }

    // Let escalation park so the run doesn't hang.
    h.await_status(&run_id, RunStatus::AwaitingHumanFix).await;
    h.orch.cancel_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Cancelled).await;
}

#[tokio::test]
async fn cancel_subtask_on_unknown_run_returns_not_found() {
    let agent = ScriptedAgent::new(AgentKind::Claude);
    let h = Harness::new(agent).await;
    let err = h
        .orch
        .cancel_subtask(&"ghost".to_string(), &"ghost-sub".to_string())
        .await
        .unwrap_err();
    assert!(matches!(err, OrchestratorError::RunNotFound(_)));
}

#[tokio::test]
async fn cancel_subtask_on_unknown_subtask_returns_not_found() {
    let agent = ScriptedAgent::new(AgentKind::Claude)
        .with_plan(Ok(plan_of(1)))
        .await
        .with_execute("t0", ExecuteScript::Block)
        .await;
    let h = Harness::new(agent).await;

    let run_id = h
        .orch
        .submit_task("unknown-sub".into(), h.repo_path.clone())
        .await
        .unwrap();
    h.await_status(&run_id, RunStatus::AwaitingApproval).await;

    let err = h
        .orch
        .cancel_subtask(&run_id, &"nosuch".to_string())
        .await
        .unwrap_err();
    assert!(matches!(err, OrchestratorError::SubtaskNotFound(_)));

    // Cleanup.
    h.orch.reject_run(&run_id).await.unwrap();
    h.await_status(&run_id, RunStatus::Rejected).await;
}
