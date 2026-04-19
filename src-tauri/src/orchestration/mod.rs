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

use crate::ipc::{
    AgentKind, RecoveryEntry, RunId, RunStatus, SubtaskData, SubtaskDraft, SubtaskId, SubtaskPatch,
    SubtaskState,
};
use crate::settings::SettingsStore;
use crate::storage::models::{NewRun, NewSubtask};
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
pub use lifecycle::{ApplyDecision, ApprovalDecision};
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

/// How long to wait for the user to apply or discard the aggregated
/// diff before auto-discarding. Matches [`APPROVAL_TIMEOUT`] — same
/// "user walked away" semantics, same budget.
pub const APPLY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30 * 60);

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
    #[error("subtask {0} not found")]
    SubtaskNotFound(SubtaskId),
    #[error("subtask {subtask_id} is in state {state:?}, expected {expected}")]
    WrongSubtaskState {
        subtask_id: SubtaskId,
        state: SubtaskState,
        expected: &'static str,
    },
    #[error("invalid edit: {0}")]
    InvalidEdit(String),
    #[error("subtask {0} has dependents in the plan; remove them first")]
    HasDependents(SubtaskId),
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
    /// Pending apply/discard channels. Created just before the merge
    /// phase starts; `apply_run` / `discard_run` take and `send()` on
    /// the sender. Same drop semantics as `approval_senders`.
    pub(crate) apply_senders: Arc<Mutex<HashMap<RunId, oneshot::Sender<ApplyDecision>>>>,
    pub(crate) max_concurrent_workers: usize,
    /// How long the merge phase waits on the apply/discard decision
    /// before auto-discarding. Defaults to [`APPLY_TIMEOUT`]; tests
    /// override this so the timeout path is observable in seconds.
    pub(crate) apply_timeout: std::time::Duration,
    /// Runs that were non-terminal when the app last exited.
    /// Populated by [`recover_active_runs`] at boot, consumed once
    /// by the frontend via the `consume_recovery_report` IPC so a
    /// heads-up banner can acknowledge the sweep. Drained on read
    /// (read-once semantics) — a second boot without new recovery
    /// work returns an empty Vec.
    pub(crate) recovery_report: Arc<Mutex<Vec<RecoveryEntry>>>,
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
            apply_senders: Arc::new(Mutex::new(HashMap::new())),
            max_concurrent_workers: MAX_CONCURRENT_WORKERS,
            apply_timeout: APPLY_TIMEOUT,
            recovery_report: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Test-only knob: shrink the apply-decision timeout so the
    /// auto-discard path is reachable without actually sleeping for
    /// 30 minutes. Not exposed outside the crate.
    #[cfg(test)]
    pub(crate) fn set_apply_timeout(&mut self, d: std::time::Duration) {
        self.apply_timeout = d;
    }

    /// Sweep storage + disk for runs that were active when the app
    /// last exited. Each is marked `Failed` with a crash-recovery
    /// error message; its worktree directory is pruned; its shared
    /// notes file is cleared. Returns the number of runs recovered.
    ///
    /// Contract: boot must not fail on recovery errors. A dead or
    /// moved repo, a dropped SD card, a permissions glitch — we log
    /// and carry on. Full state-restore-and-resume is out of scope for
    /// Phase 2 (see phase-2-spec.md); this only prevents silent disk
    /// accumulation and stale `Running` rows across restarts.
    pub async fn recover_active_runs(&self) -> usize {
        let active = match self.storage.list_active_runs().await {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[orchestrator] recovery: list_active_runs failed: {e}");
                return 0;
            }
        };
        let count = active.len();
        let mut entries: Vec<RecoveryEntry> = Vec::with_capacity(count);
        for run in active {
            let now = chrono::Utc::now();
            let err_msg = "App restarted while run was active";
            if let Err(e) = self
                .storage
                .finish_run(&run.id, RunStatus::Failed, now, Some(err_msg))
                .await
            {
                eprintln!("[orchestrator] recovery: finish_run({}) failed: {e}", run.id);
            }
            let repo_path = PathBuf::from(&run.repo_path);
            match crate::worktree::WorktreeManager::new(repo_path.clone()).await {
                Ok(mgr) => {
                    if let Err(e) = mgr.cleanup_orphans_on_startup().await {
                        eprintln!(
                            "[orchestrator] recovery: cleanup_orphans_on_startup({}) failed: {e}",
                            run.repo_path
                        );
                    }
                }
                Err(e) => {
                    // Dead repo, moved directory, detached HEAD — log
                    // and move on. Nothing we can clean anyway.
                    eprintln!(
                        "[orchestrator] recovery: WorktreeManager::new({}) failed: {e}",
                        run.repo_path
                    );
                }
            }
            // SharedNotes::new is infallible (doesn't touch disk until
            // init/append/clear); clear is idempotent wrt missing file.
            let notes = notes::SharedNotes::new(&repo_path);
            if let Err(e) = notes.clear().await {
                eprintln!(
                    "[orchestrator] recovery: notes.clear({}) failed: {e}",
                    run.repo_path
                );
            }
            entries.push(RecoveryEntry {
                task: run.task,
                repo_path: run.repo_path,
            });
        }
        // Stash for the frontend's boot-time banner. If the frontend
        // never asks (e.g. headless test), the entries sit harmlessly
        // until the process exits.
        *self.recovery_report.lock().await = entries;
        count
    }

    /// Drain the boot-time recovery report. Read-once: the second
    /// call returns an empty Vec. Wired to the `consume_recovery_report`
    /// IPC command so the frontend can render a heads-up banner
    /// exactly once per app launch.
    pub async fn consume_recovery_report(&self) -> Vec<RecoveryEntry> {
        let mut guard = self.recovery_report.lock().await;
        std::mem::take(&mut *guard)
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
    ///
    /// INVARIANT: `submit_task` emits no `run:*` events before
    /// returning `RunId`. The frontend relies on this to avoid a race
    /// between the IPC response and event-subscription attach — see
    /// `src/lib/runSubscription.ts` for the consuming side. The first
    /// event (`StatusChanged{Planning}`) is emitted from the spawned
    /// `run_lifecycle` task after a `yield_now().await`, so the
    /// scheduler has a chance to complete this function's return
    /// before any event hits the wire. Enforced by the test
    /// `submit_task_emits_nothing_before_returning_run_id`.
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

        // NOTE: the initial `StatusChanged{Planning}` emit lives at the
        // top of `run_lifecycle`. See the invariant comment above — do
        // not emit from this function.

        let (approval_tx, approval_rx) = oneshot::channel();
        self.approval_senders
            .lock()
            .await
            .insert(run_id.clone(), approval_tx);

        let (apply_tx, apply_rx) = oneshot::channel();
        self.apply_senders
            .lock()
            .await
            .insert(run_id.clone(), apply_tx);

        let deps = LifecycleDeps {
            storage: self.storage.clone(),
            event_sink: self.event_sink.clone(),
            registry: self.registry.clone(),
            approval_senders: self.approval_senders.clone(),
            apply_senders: self.apply_senders.clone(),
            apply_timeout: self.apply_timeout,
        };
        let runs_map = self.runs.clone();
        let approval_senders = self.approval_senders.clone();
        let apply_senders = self.apply_senders.clone();
        let task_run_id = run_id.clone();
        tokio::spawn(async move {
            run_lifecycle(deps, run_arc, master, approval_rx, apply_rx).await;
            // Lifecycle is finished (whatever the outcome); remove
            // from the active map so lookups surface None. The
            // sender maps may or may not still contain entries
            // depending on how we exited — drop them too for good
            // measure.
            runs_map.lock().await.remove(&task_run_id);
            approval_senders.lock().await.remove(&task_run_id);
            apply_senders.lock().await.remove(&task_run_id);
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

    /// User clicked Apply on the aggregated diff. The lifecycle is
    /// parked in `Merging`; we send `Apply` to its waiter so it starts
    /// the merge. Errors surface `RunNotFound` (no such in-flight run)
    /// or `WrongState` (run moved past Merging before the click
    /// landed — e.g. timed out into auto-discard).
    pub async fn apply_run(&self, run_id: &RunId) -> Result<(), OrchestratorError> {
        let sender = self
            .apply_senders
            .lock()
            .await
            .remove(run_id)
            .ok_or_else(|| OrchestratorError::RunNotFound(run_id.clone()))?;
        sender
            .send(ApplyDecision::Apply)
            .map_err(|_| OrchestratorError::WrongState {
                run_id: run_id.clone(),
                state: RunStatus::Merging,
                expected: "merging",
            })?;
        Ok(())
    }

    /// User clicked Discard on the aggregated diff. Same plumbing as
    /// [`apply_run`]; lifecycle cleans up worktrees and finalizes to
    /// Rejected without merging.
    pub async fn discard_run(&self, run_id: &RunId) -> Result<(), OrchestratorError> {
        let sender = self
            .apply_senders
            .lock()
            .await
            .remove(run_id)
            .ok_or_else(|| OrchestratorError::RunNotFound(run_id.clone()))?;
        sender
            .send(ApplyDecision::Discard)
            .map_err(|_| OrchestratorError::WrongState {
                run_id: run_id.clone(),
                state: RunStatus::Merging,
                expected: "merging",
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

    // -- Phase 3 edit commands ------------------------------------------
    //
    // Locking discipline: each of the three methods acquires the run's
    // write lock, validates the status + subtask state, mutates the
    // in-memory runtime + SQLite row, snapshots the new subtask list,
    // releases the lock, and emits `SubtasksProposed`. That means a
    // concurrent `approve_subtasks` sees a fully-consistent plan — the
    // oneshot sender stays valid until it's taken, and the approval
    // path doesn't touch the runtime until after the lifecycle task
    // wakes up. If `approve_subtasks` wins the race first, subsequent
    // edits trip [`OrchestratorError::WrongState`] because the lifecycle
    // task flips status off `AwaitingApproval` on its next tick.

    /// Update the editable fields of a proposed subtask. The run must
    /// be `AwaitingApproval` and the subtask `Proposed`; any other
    /// state is a [`WrongState`] / [`WrongSubtaskState`] error. The
    /// subtask's dependency list is not exposed for editing in
    /// Phase 3 (Q1 deferral) — see [`SubtaskPatch`].
    pub async fn update_subtask(
        &self,
        run_id: &RunId,
        subtask_id: &SubtaskId,
        patch: SubtaskPatch,
    ) -> Result<(), OrchestratorError> {
        // Validate `assigned_worker` against the registry *before*
        // taking the lock. `registry.available()` probes the detector,
        // which can be slow (PATH walks, version spawns); we don't want
        // to hold the run lock for that.
        let available: Vec<AgentKind> = self.registry.available().await;
        validate_patch(&patch, &available)?;

        let run_arc = self
            .get_run(run_id)
            .await
            .ok_or_else(|| OrchestratorError::RunNotFound(run_id.clone()))?;

        let (storage_op, emit) = {
            let mut guard = run_arc.write().await;
            if guard.status != RunStatus::AwaitingApproval {
                return Err(OrchestratorError::WrongState {
                    run_id: run_id.clone(),
                    state: guard.status,
                    expected: "awaiting-approval",
                });
            }
            let sub = guard
                .find_subtask_mut(subtask_id)
                .ok_or_else(|| OrchestratorError::SubtaskNotFound(subtask_id.clone()))?;
            if sub.state != SubtaskState::Proposed {
                return Err(OrchestratorError::WrongSubtaskState {
                    subtask_id: subtask_id.clone(),
                    state: sub.state,
                    expected: "proposed",
                });
            }
            // Apply the patch to the runtime row. `title`, `why`, and
            // `assigned_worker` mirror their `SubtaskPatch` counterparts;
            // absent fields pass through unchanged.
            if let Some(new_title) = patch.title.as_ref() {
                sub.data.title = new_title.trim().to_string();
            }
            if let Some(new_why) = patch.why.as_ref() {
                sub.data.why = new_why.clone();
            }
            if let Some(new_worker) = patch.assigned_worker {
                sub.data.assigned_worker = new_worker;
            }
            let title = sub.data.title.clone();
            // Empty string on the wire means "clear to None" — see the
            // doc on [`SubtaskPatch::why`].
            let why_for_storage: Option<String> = Some(sub.data.why.clone()).filter(|w| !w.is_empty());
            let worker = sub.data.assigned_worker;
            let sub_id = sub.id.clone();
            let proposed: Vec<SubtaskData> =
                guard.subtasks.iter().map(SubtaskRuntime::to_data).collect();
            (
                (sub_id, title, why_for_storage, worker),
                RunEvent::SubtasksProposed {
                    run_id: run_id.clone(),
                    subtasks: proposed,
                },
            )
        };

        let (sub_id, title, why, worker) = storage_op;
        self.storage
            .update_subtask_fields(&sub_id, &title, why.as_deref(), worker)
            .await
            .map_err(|e| OrchestratorError::Storage(e.to_string()))?;
        self.event_sink.emit(emit).await;
        Ok(())
    }

    /// Append a user-drafted subtask to the pending plan. The run must
    /// be `AwaitingApproval`. Returns the server-coined ulid so the
    /// frontend can address the new row (e.g. immediately open it for
    /// editing again).
    pub async fn add_subtask(
        &self,
        run_id: &RunId,
        draft: SubtaskDraft,
    ) -> Result<SubtaskId, OrchestratorError> {
        let available: Vec<AgentKind> = self.registry.available().await;
        validate_draft(&draft, &available)?;

        let run_arc = self
            .get_run(run_id)
            .await
            .ok_or_else(|| OrchestratorError::RunNotFound(run_id.clone()))?;

        let new_id = ulid::Ulid::new().to_string();
        let new_title = draft.title.trim().to_string();
        let new_why = draft.why.clone().unwrap_or_default();
        let new_worker = draft.assigned_worker;

        let (emit_payload, new_subtask_row) = {
            let mut guard = run_arc.write().await;
            if guard.status != RunStatus::AwaitingApproval {
                return Err(OrchestratorError::WrongState {
                    run_id: run_id.clone(),
                    state: guard.status,
                    expected: "awaiting-approval",
                });
            }
            let runtime = SubtaskRuntime::new(
                new_id.clone(),
                crate::agents::PlannedSubtask {
                    title: new_title.clone(),
                    why: new_why.clone(),
                    assigned_worker: new_worker,
                    dependencies: vec![],
                },
                // Phase 3 Q1: user-added subtasks never depend on
                // anything — always a leaf.
                vec![],
            );
            guard.subtasks.push(runtime);
            let proposed: Vec<SubtaskData> =
                guard.subtasks.iter().map(SubtaskRuntime::to_data).collect();
            let row = NewSubtask {
                id: new_id.clone(),
                run_id: guard.id.clone(),
                title: new_title,
                why: Some(new_why).filter(|w| !w.is_empty()),
                assigned_worker: new_worker,
                state: SubtaskState::Proposed,
            };
            (
                RunEvent::SubtasksProposed {
                    run_id: run_id.clone(),
                    subtasks: proposed,
                },
                row,
            )
        };

        self.storage
            .insert_user_added_subtask(&new_subtask_row)
            .await
            .map_err(|e| OrchestratorError::Storage(e.to_string()))?;
        self.event_sink.emit(emit_payload).await;
        Ok(new_id)
    }

    /// Remove a proposed subtask from the pending plan. Rejects if
    /// another `Proposed` subtask declares it as a dependency —
    /// requiring the user to remove dependents first keeps the DAG
    /// consistent without asking the orchestrator to invent a new
    /// topology.
    pub async fn remove_subtask(
        &self,
        run_id: &RunId,
        subtask_id: &SubtaskId,
    ) -> Result<(), OrchestratorError> {
        let run_arc = self
            .get_run(run_id)
            .await
            .ok_or_else(|| OrchestratorError::RunNotFound(run_id.clone()))?;

        let emit = {
            let mut guard = run_arc.write().await;
            if guard.status != RunStatus::AwaitingApproval {
                return Err(OrchestratorError::WrongState {
                    run_id: run_id.clone(),
                    state: guard.status,
                    expected: "awaiting-approval",
                });
            }
            let pos = guard
                .subtasks
                .iter()
                .position(|s| &s.id == subtask_id)
                .ok_or_else(|| OrchestratorError::SubtaskNotFound(subtask_id.clone()))?;
            if guard.subtasks[pos].state != SubtaskState::Proposed {
                return Err(OrchestratorError::WrongSubtaskState {
                    subtask_id: subtask_id.clone(),
                    state: guard.subtasks[pos].state,
                    expected: "proposed",
                });
            }
            if guard
                .subtasks
                .iter()
                .any(|s| s.state == SubtaskState::Proposed && s.dependency_ids.contains(subtask_id))
            {
                return Err(OrchestratorError::HasDependents(subtask_id.clone()));
            }
            guard.subtasks.remove(pos);
            let proposed: Vec<SubtaskData> =
                guard.subtasks.iter().map(SubtaskRuntime::to_data).collect();
            RunEvent::SubtasksProposed {
                run_id: run_id.clone(),
                subtasks: proposed,
            }
        };

        self.storage
            .delete_subtask(subtask_id)
            .await
            .map_err(|e| OrchestratorError::Storage(e.to_string()))?;
        self.event_sink.emit(emit).await;
        Ok(())
    }
}

/// Shared validation for [`SubtaskPatch`] and [`SubtaskDraft`] — the
/// rules are the same on both, and pulling them out keeps the public
/// methods focused on locking and side-effects.
fn validate_patch(
    patch: &SubtaskPatch,
    available_workers: &[AgentKind],
) -> Result<(), OrchestratorError> {
    if let Some(title) = patch.title.as_ref() {
        if title.trim().is_empty() {
            return Err(OrchestratorError::InvalidEdit("title must not be empty".into()));
        }
    }
    if let Some(worker) = patch.assigned_worker {
        if !available_workers.contains(&worker) {
            return Err(OrchestratorError::InvalidEdit(format!(
                "assigned worker {worker:?} is not available",
            )));
        }
    }
    Ok(())
}

fn validate_draft(
    draft: &SubtaskDraft,
    available_workers: &[AgentKind],
) -> Result<(), OrchestratorError> {
    if draft.title.trim().is_empty() {
        return Err(OrchestratorError::InvalidEdit("title must not be empty".into()));
    }
    if !available_workers.contains(&draft.assigned_worker) {
        return Err(OrchestratorError::InvalidEdit(format!(
            "assigned worker {:?} is not available",
            draft.assigned_worker,
        )));
    }
    Ok(())
}

#[cfg(test)]
mod init_tests {
    use super::*;
    use crate::detection::Detector;
    use crate::orchestration::events::RecordingEventSink;
    use crate::storage::models::NewRun;
    use chrono::Utc;
    use tempfile::TempDir;
    use tokio::process::Command as TokioCommand;

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

    /// Orchestrator + in-memory Storage + recording sink, plus a real
    /// git repo in a `TempDir` so worktree ops work. Returns the repo
    /// path so tests can seed disk state before calling recovery.
    async fn make_with_repo() -> (Orchestrator, Arc<Storage>, TempDir, PathBuf) {
        let repo = tempfile::tempdir().unwrap();
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
        let registry = Arc::new(DefaultAgentRegistry::new(Arc::new(Detector::new(
            settings.clone(),
        ))));
        let orch = Orchestrator::new(settings, storage.clone(), sink, registry);
        let repo_path = repo.path().to_path_buf();
        (orch, storage, repo, repo_path)
    }

    async fn seed_active_run(
        storage: &Storage,
        id: &str,
        repo_path: &str,
        status: RunStatus,
    ) {
        storage
            .insert_run(&NewRun {
                id: id.into(),
                task: "seeded".into(),
                repo_path: repo_path.into(),
                master_agent: AgentKind::Claude,
                status,
                started_at: Utc::now(),
            })
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn new_orchestrator_starts_empty() {
        let orch = make().await;
        assert_eq!(orch.active_run_count().await, 0);
        assert!(orch.get_run(&"nope".into()).await.is_none());
    }

    #[tokio::test]
    async fn recover_active_runs_marks_failed_and_cleans_disk() {
        let (orch, storage, _repo, repo_path) = make_with_repo().await;
        seed_active_run(
            &storage,
            "01RUNNING",
            &repo_path.to_string_lossy(),
            RunStatus::Running,
        )
        .await;

        // Simulate a crashed run's residue: an orphan worktree dir and
        // a shared-notes file.
        let wt_dir = repo_path.join(".whalecode-worktrees").join("01RUNNING").join("sub1");
        tokio::fs::create_dir_all(&wt_dir).await.unwrap();
        tokio::fs::write(wt_dir.join("marker"), "x").await.unwrap();
        let notes_dir = repo_path.join(".whalecode");
        tokio::fs::create_dir_all(&notes_dir).await.unwrap();
        let notes_file = notes_dir.join("notes.md");
        tokio::fs::write(&notes_file, "stale notes\n").await.unwrap();

        let recovered = orch.recover_active_runs().await;
        assert_eq!(recovered, 1);

        let row = storage.get_run("01RUNNING").await.unwrap().unwrap();
        assert_eq!(row.status, RunStatus::Failed);
        assert_eq!(
            row.error.as_deref(),
            Some("App restarted while run was active")
        );
        assert!(row.finished_at.is_some());
        assert!(
            !repo_path.join(".whalecode-worktrees").exists(),
            "worktrees dir should be swept by recovery"
        );
        assert!(!notes_file.exists(), "notes file should be cleared");
    }

    #[tokio::test]
    async fn recover_tolerates_dead_repo_path() {
        // No repo on disk — the path in `repo_path` doesn't exist.
        let settings = Arc::new(SettingsStore::load_at(PathBuf::from(
            "/tmp/whalecode-settings-never-written.json",
        )));
        let storage = Arc::new(Storage::in_memory().await.unwrap());
        let sink = Arc::new(RecordingEventSink::default());
        let registry = Arc::new(DefaultAgentRegistry::new(Arc::new(Detector::new(
            settings.clone(),
        ))));
        let orch = Orchestrator::new(settings, storage.clone(), sink, registry);

        seed_active_run(
            &storage,
            "01DEADPATH",
            "/nonexistent/path/that/does/not/exist",
            RunStatus::Merging,
        )
        .await;

        // Must not panic or propagate error.
        let recovered = orch.recover_active_runs().await;
        assert_eq!(recovered, 1);

        let row = storage.get_run("01DEADPATH").await.unwrap().unwrap();
        assert_eq!(row.status, RunStatus::Failed);
        assert_eq!(
            row.error.as_deref(),
            Some("App restarted while run was active")
        );
    }

    #[tokio::test]
    async fn recover_handles_multiple_active_runs_in_same_repo() {
        let (orch, storage, _repo, repo_path) = make_with_repo().await;
        let repo_str = repo_path.to_string_lossy().to_string();
        seed_active_run(&storage, "01PLANNING", &repo_str, RunStatus::Planning).await;
        seed_active_run(&storage, "02AWAITING", &repo_str, RunStatus::AwaitingApproval).await;
        seed_active_run(&storage, "03MERGING", &repo_str, RunStatus::Merging).await;

        // Orphan worktree from one of them.
        let wt = repo_path.join(".whalecode-worktrees").join("03MERGING").join("sub1");
        tokio::fs::create_dir_all(&wt).await.unwrap();

        let recovered = orch.recover_active_runs().await;
        assert_eq!(recovered, 3);

        for id in ["01PLANNING", "02AWAITING", "03MERGING"] {
            let row = storage.get_run(id).await.unwrap().unwrap();
            assert_eq!(row.status, RunStatus::Failed, "{id} should be Failed");
        }
        // Cleanup ran (idempotent across repeated calls for the same repo).
        assert!(!repo_path.join(".whalecode-worktrees").exists());
    }

    #[tokio::test]
    async fn recovery_report_is_populated_and_drained_once() {
        // Frontend UX hook: on boot we want to tell the user their
        // previous run was interrupted. This test pins the contract
        // `consume_recovery_report` drains the stash so a subsequent
        // call (or second listener) won't re-show the banner.
        let (orch, storage, _repo, repo_path) = make_with_repo().await;
        let repo_str = repo_path.to_string_lossy().to_string();
        seed_active_run(&storage, "01CRASHED", &repo_str, RunStatus::Running).await;
        // Task field we seeded above is "seeded"; assert against it.

        assert!(
            orch.consume_recovery_report().await.is_empty(),
            "report is empty before recovery runs"
        );

        let recovered = orch.recover_active_runs().await;
        assert_eq!(recovered, 1);

        let report = orch.consume_recovery_report().await;
        assert_eq!(report.len(), 1);
        assert_eq!(report[0].task, "seeded");
        assert_eq!(report[0].repo_path, repo_str);

        // Read-once: a second consume must return empty.
        let again = orch.consume_recovery_report().await;
        assert!(again.is_empty(), "second consume drains to empty");
    }
}
