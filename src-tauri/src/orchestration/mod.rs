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
    AgentKind, RecoveryEntry, RunId, RunStatus, SubtaskDraft, SubtaskId, SubtaskPatch,
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
pub use lifecycle::{ApplyDecision, ApprovalDecision, Layer3Decision};
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
    /// Phase 3 Step 7: integration seam. Threaded into every
    /// per-run `LifecycleDeps`; the dispatcher consults it on
    /// worker-level actions Phase 7 will police. Today unconditionally
    /// permits, so holding a single shared instance is free.
    pub(crate) safety_gate: Arc<crate::safety::SafetyGate>,
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
    /// Pending Layer-3 resolution channels. Populated by the lifecycle
    /// the moment it parks the run in `AwaitingHumanFix`; consumed by
    /// the four escalation IPC commands (`manual_fix_subtask` /
    /// `mark_subtask_fixed` / `skip_subtask` / `try_replan_again`).
    /// If a `ReplanRequested` resolution re-escalates (master returns
    /// another empty plan), the lifecycle reinstalls a fresh sender
    /// here for the next park. On lifecycle exit the map entry is
    /// dropped alongside `approval_senders` and `apply_senders`.
    pub(crate) resolution_senders: Arc<Mutex<HashMap<RunId, oneshot::Sender<Layer3Decision>>>>,
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
    /// Phase 5 Step 2: stash entries captured by
    /// `stash_and_retry_apply`. Keyed by run id + stores the
    /// immutable SHA returned by `git rev-parse stash@{0}` at push
    /// time, plus the repo_root needed to run `git stash pop` after
    /// the run's in-memory state has been torn down (Done /
    /// Rejected / Cancelled clear the runs map but the stash itself
    /// lives in the user's git repo and is still poppable). Cleared
    /// on successful pop or on Missing; persists across conflict so
    /// the user can resolve manually.
    pub(crate) stashes: Arc<Mutex<HashMap<RunId, StashEntry>>>,
}

/// Phase 5 Step 2: one entry in the Orchestrator's stash registry.
/// Lives outside the per-run `Run` struct so pop works after the run
/// has been torn down (Done / Rejected / Cancelled).
#[derive(Debug, Clone)]
pub(crate) struct StashEntry {
    pub stash_ref: String,
    pub repo_root: PathBuf,
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
            safety_gate: Arc::new(crate::safety::SafetyGate::new()),
            runs: Arc::new(Mutex::new(HashMap::new())),
            approval_senders: Arc::new(Mutex::new(HashMap::new())),
            apply_senders: Arc::new(Mutex::new(HashMap::new())),
            resolution_senders: Arc::new(Mutex::new(HashMap::new())),
            max_concurrent_workers: MAX_CONCURRENT_WORKERS,
            apply_timeout: APPLY_TIMEOUT,
            stashes: Arc::new(Mutex::new(HashMap::new())),
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
            settings: self.settings.clone(),
            safety_gate: self.safety_gate.clone(),
            approval_senders: self.approval_senders.clone(),
            apply_senders: self.apply_senders.clone(),
            resolution_senders: self.resolution_senders.clone(),
            apply_timeout: self.apply_timeout,
        };
        let runs_map = self.runs.clone();
        let approval_senders = self.approval_senders.clone();
        let apply_senders = self.apply_senders.clone();
        let resolution_senders = self.resolution_senders.clone();
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
            resolution_senders.lock().await.remove(&task_run_id);
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

    /// Phase 5 Step 3: retry a merge that just conflicted. Semantic
    /// alias for [`Self::apply_run`] — the lifecycle has already
    /// reinstalled a fresh `ApplyDecision` oneshot on the
    /// `MergeConflict` branch (see `lifecycle.rs` merge_phase Retry
    /// path), so sending `Apply` here re-enters the merge attempt
    /// with whatever resolutions the user just landed on the base
    /// branch. Rejects with `WrongState` if the oneshot was already
    /// consumed (e.g. a raced `discard_run` / `cancel_run`) — this
    /// is the "stale conflict" fall-through the UI renders as a
    /// toast.
    pub async fn retry_apply(&self, run_id: &RunId) -> Result<(), OrchestratorError> {
        self.apply_run(run_id).await
    }

    /// Phase 5 Step 2: stash the dirty base-branch working tree, then
    /// retry Apply. Composition of `git stash push -u` + the existing
    /// `apply_run` oneshot send — no new merge plumbing.
    ///
    /// Preconditions:
    /// - Run must be `Merging` (an apply oneshot is installed). Any
    ///   other status returns `WrongState`.
    /// - Run must not already hold a stash ref; double-stash would
    ///   orphan the first one. Returns `InvalidEdit` if set.
    ///
    /// Steps, in order, with locking discipline matching the rest of
    /// the module (no `await` inside the write lock):
    /// 1. Acquire read lock to snapshot `repo_root` + confirm no
    ///    existing `stash_ref`.
    /// 2. Release lock; run `git stash push -u -m …` (long I/O).
    /// 3. Re-acquire write lock; record `stash_ref` on the run if the
    ///    push produced one.
    /// 4. Emit `StashCreated`.
    /// 5. Remove the apply sender from the map and send
    ///    `ApplyDecision::Apply`. If the sender is gone (raced
    ///    `discard_run`), return `WrongState` — the stash was saved
    ///    and the user can pop it manually via `pop_stash` once the
    ///    next run starts, but we fail loud rather than silently drop
    ///    the retry.
    pub async fn stash_and_retry_apply(
        &self,
        run_id: &RunId,
    ) -> Result<(), OrchestratorError> {
        let run_arc = self
            .get_run(run_id)
            .await
            .ok_or_else(|| OrchestratorError::RunNotFound(run_id.clone()))?;
        let repo_root = {
            let guard = run_arc.read().await;
            if guard.status != RunStatus::Merging {
                return Err(OrchestratorError::WrongState {
                    run_id: run_id.clone(),
                    state: guard.status,
                    expected: "merging",
                });
            }
            guard.repo_root.clone()
        };
        if self.stashes.lock().await.contains_key(run_id) {
            return Err(OrchestratorError::InvalidEdit(
                "run already holds a stash ref; pop it before stashing again".to_string(),
            ));
        }

        let message = format!("whalecode: before apply {}", run_id);
        let outcome = crate::worktree::git::stash_push(&repo_root, &message)
            .await
            .map_err(|e| OrchestratorError::InvalidEdit(format!("git stash push: {e}")))?;

        let stash_ref_opt = match outcome {
            crate::worktree::git::StashPushOutcome::Created { stash_ref } => Some(stash_ref),
            crate::worktree::git::StashPushOutcome::NothingToStash => None,
        };

        if let Some(stash_ref) = stash_ref_opt.clone() {
            self.stashes.lock().await.insert(
                run_id.clone(),
                StashEntry {
                    stash_ref: stash_ref.clone(),
                    repo_root: repo_root.clone(),
                },
            );
            self.event_sink
                .emit(RunEvent::StashCreated {
                    run_id: run_id.clone(),
                    stash_ref,
                })
                .await;
        }

        // Take the apply sender and send Apply. Mirrors `apply_run`'s
        // shape so the lifecycle's merge loop sees exactly one click.
        let sender = self
            .apply_senders
            .lock()
            .await
            .remove(run_id)
            .ok_or_else(|| OrchestratorError::WrongState {
                run_id: run_id.clone(),
                state: RunStatus::Merging,
                expected: "merging",
            })?;
        sender
            .send(ApplyDecision::Apply)
            .map_err(|_| OrchestratorError::WrongState {
                run_id: run_id.clone(),
                state: RunStatus::Merging,
                expected: "merging",
            })?;
        Ok(())
    }

    /// Phase 5 Step 2: pop the stash recorded by
    /// [`Self::stash_and_retry_apply`]. User-initiated — we do not
    /// auto-pop after Apply because the stash may conflict with the
    /// just-applied diffs and the user should see the state before
    /// deciding.
    ///
    /// Three outcomes:
    /// - Applied → emit `StashPopped`, clear the ref on the run.
    /// - Conflict → emit `StashPopFailed { kind: conflict }`, leave
    ///   the ref in place; user resolves in their editor and runs
    ///   `git stash drop` manually.
    /// - Missing → emit `StashPopFailed { kind: missing }`, clear the
    ///   ref (nothing to pop).
    ///
    /// Rejects with `InvalidEdit` when the run has no `stash_ref`
    /// recorded. Run status is *not* validated — pop is meaningful
    /// post-Done / post-Rejected too, as long as the run's in-memory
    /// state still carries the ref.
    pub async fn pop_stash(&self, run_id: &RunId) -> Result<(), OrchestratorError> {
        let entry = self
            .stashes
            .lock()
            .await
            .get(run_id)
            .cloned()
            .ok_or_else(|| {
                OrchestratorError::InvalidEdit("no stash recorded for this run".to_string())
            })?;

        let outcome = crate::worktree::git::stash_pop(&entry.repo_root, &entry.stash_ref)
            .await
            .map_err(|e| OrchestratorError::InvalidEdit(format!("git stash pop: {e}")))?;

        match outcome {
            crate::worktree::git::StashPopOutcome::Applied => {
                self.stashes.lock().await.remove(run_id);
                self.event_sink
                    .emit(RunEvent::StashPopped {
                        run_id: run_id.clone(),
                        stash_ref: entry.stash_ref,
                    })
                    .await;
                Ok(())
            }
            crate::worktree::git::StashPopOutcome::Conflicted => {
                // Keep the registry entry; user resolves + drops manually.
                self.event_sink
                    .emit(RunEvent::StashPopFailed {
                        run_id: run_id.clone(),
                        stash_ref: entry.stash_ref,
                        kind: crate::ipc::events::StashPopFailureKind::Conflict,
                        error:
                            "stash pop produced conflicts; resolve in your editor and run \
                             `git stash drop` when done"
                                .to_string(),
                    })
                    .await;
                Ok(())
            }
            crate::worktree::git::StashPopOutcome::Missing => {
                self.stashes.lock().await.remove(run_id);
                self.event_sink
                    .emit(RunEvent::StashPopFailed {
                        run_id: run_id.clone(),
                        stash_ref: entry.stash_ref,
                        kind: crate::ipc::events::StashPopFailureKind::Missing,
                        error: "stash ref was missing; nothing to pop".to_string(),
                    })
                    .await;
                Ok(())
            }
        }
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

    /// Phase 5 Step 1: user-initiated per-worker stop.
    ///
    /// Sets `manual_cancel = true` on the subtask's runtime row and
    /// fires its per-subtask `cancel_token`. The dispatcher's worker
    /// task is listening on that token via `tokio::select!`; on fire
    /// the worker's subprocess is killed via the existing process-group
    /// path in `agents/process.rs`. When the dispatcher observes the
    /// exit, the `manual_cancel` flag routes the outcome through
    /// `WorkerOutcome::UserCancelled` (Phase 5 addition) — bypassing
    /// Layer 1 retry, Layer 2 replan, and Layer 3 escalation entirely.
    /// Dependents cascade to `Skipped` via the existing cascade path.
    ///
    /// Rejects with `WrongSubtaskState` when the subtask is not in
    /// Running / Retrying / Waiting. Proposed / Done / Failed / Skipped
    /// / Cancelled all return an error the UI surfaces as a toast:
    /// "cannot stop a subtask that has already reached a terminal
    /// state" (Failed during an in-flight Layer 2 replan lands in this
    /// branch naturally — spec Step 1 "Stop during an active Layer 2
    /// replan fails gracefully").
    ///
    /// Idempotency: firing an already-cancelled token a second time
    /// is a no-op in tokio; the method returns `Ok(())` on the second
    /// call only if the subtask is still in a cancellable state,
    /// otherwise `WrongSubtaskState`.
    pub async fn cancel_subtask(
        &self,
        run_id: &RunId,
        subtask_id: &SubtaskId,
    ) -> Result<(), OrchestratorError> {
        let run_arc = self
            .get_run(run_id)
            .await
            .ok_or_else(|| OrchestratorError::RunNotFound(run_id.clone()))?;
        let (token, wake) = {
            let mut guard = run_arc.write().await;
            let wake = guard.subtask_cancel_wake.clone();
            let sub = guard
                .find_subtask_mut(subtask_id)
                .ok_or_else(|| OrchestratorError::SubtaskNotFound(subtask_id.clone()))?;
            if !matches!(
                sub.state,
                SubtaskState::Running | SubtaskState::Retrying | SubtaskState::Waiting
            ) {
                return Err(OrchestratorError::WrongSubtaskState {
                    subtask_id: subtask_id.clone(),
                    state: sub.state,
                    expected: "running | retrying | waiting",
                });
            }
            sub.manual_cancel = true;
            (sub.cancel_token.clone(), wake)
        };
        token.cancel();
        // Wake the dispatcher for the Waiting-state case (no worker
        // running to observe the token). Idempotent — extra wakes are
        // no-ops when the main loop is already awake.
        wake.notify_one();
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

        let (storage_op, snapshot) = {
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
            let snap: Vec<SubtaskRuntime> = guard.subtasks.clone();
            ((sub_id, title, why_for_storage, worker), snap)
        };

        let (sub_id, title, why, worker) = storage_op;
        self.storage
            .update_subtask_fields(&sub_id, &title, why.as_deref(), worker)
            .await
            .map_err(|e| OrchestratorError::Storage(e.to_string()))?;
        let subtasks =
            crate::orchestration::lifecycle::build_subtasks_wire(&self.storage, &snapshot).await;
        self.event_sink
            .emit(RunEvent::SubtasksProposed {
                run_id: run_id.clone(),
                subtasks,
            })
            .await;
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

        let (snapshot, new_subtask_row) = {
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
            let snap: Vec<SubtaskRuntime> = guard.subtasks.clone();
            let row = NewSubtask {
                id: new_id.clone(),
                run_id: guard.id.clone(),
                title: new_title,
                why: Some(new_why).filter(|w| !w.is_empty()),
                assigned_worker: new_worker,
                state: SubtaskState::Proposed,
            };
            (snap, row)
        };

        self.storage
            .insert_user_added_subtask(&new_subtask_row)
            .await
            .map_err(|e| OrchestratorError::Storage(e.to_string()))?;
        let subtasks =
            crate::orchestration::lifecycle::build_subtasks_wire(&self.storage, &snapshot).await;
        self.event_sink
            .emit(RunEvent::SubtasksProposed {
                run_id: run_id.clone(),
                subtasks,
            })
            .await;
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

        let snapshot: Vec<SubtaskRuntime> = {
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
            guard.subtasks.clone()
        };

        self.storage
            .delete_subtask(subtask_id)
            .await
            .map_err(|e| OrchestratorError::Storage(e.to_string()))?;
        let subtasks =
            crate::orchestration::lifecycle::build_subtasks_wire(&self.storage, &snapshot).await;
        self.event_sink
            .emit(RunEvent::SubtasksProposed {
                run_id: run_id.clone(),
                subtasks,
            })
            .await;
        Ok(())
    }

    // -- Phase 3 Step 5 Layer-3 escalation commands ---------------------
    //
    // The lifecycle parks on a per-run `resolution_senders` oneshot
    // when a replan exhausts (or the master returns infeasible). Each
    // of these four commands does the same three-part dance:
    //   1. Validate: the run exists, is in `AwaitingHumanFix`, and the
    //      `subtask_id` matches the escalated target (so mis-routed
    //      clicks on already-terminal subtasks don't steal the
    //      resolution channel).
    //   2. Take: atomically remove the resolution sender from the
    //      shared map (preventing double-resolve) and `send()` the
    //      appropriate `Layer3Decision` variant on it. The lifecycle's
    //      `tokio::select!` unparks and handles the decision.
    //   3. Return: any extra data the frontend needs (the
    //      [`EditorResult`] tier, the [`SkipResult`] cascade count).
    //
    // `manual_fix_subtask` is the odd one out — it doesn't resolve
    // the escalation (the user may open the editor, edit, and then
    // *not* click "mark fixed"). It just exposes the fallback-chain
    // tier that succeeded so the status line can render correctly.

    /// Open the escalated subtask's worktree in the user's editor.
    /// Returns the [`crate::editor::EditorResult`] tier that actually
    /// succeeded so the frontend can render "Opened in VS Code" vs
    /// "Copied path to clipboard". Does NOT resolve the park — the
    /// user opens the editor, makes changes, then calls
    /// [`Self::mark_subtask_fixed`] (or `skip_subtask` / `cancel_run`)
    /// to end the park.
    pub async fn manual_fix_subtask(
        &self,
        run_id: &RunId,
        subtask_id: &SubtaskId,
    ) -> Result<crate::editor::EditorResult, OrchestratorError> {
        let run_arc = self
            .get_run(run_id)
            .await
            .ok_or_else(|| OrchestratorError::RunNotFound(run_id.clone()))?;
        let worktree_path = {
            let guard = run_arc.read().await;
            if guard.status != RunStatus::AwaitingHumanFix {
                return Err(OrchestratorError::WrongState {
                    run_id: run_id.clone(),
                    state: guard.status,
                    expected: "awaiting-human-fix",
                });
            }
            if !guard.escalated_subtask_ids.contains(subtask_id) {
                return Err(OrchestratorError::InvalidEdit(format!(
                    "subtask {subtask_id} is not the escalated target for run {run_id}"
                )));
            }
            let sub = guard
                .find_subtask(subtask_id)
                .ok_or_else(|| OrchestratorError::SubtaskNotFound(subtask_id.clone()))?;
            sub.worktree_path.clone().ok_or_else(|| {
                OrchestratorError::InvalidEdit(format!(
                    "subtask {subtask_id} has no worktree to open"
                ))
            })?
        };

        let configured: Option<String> = self
            .settings
            .snapshot()
            .ok()
            .and_then(|s| s.editor)
            .filter(|e| !e.trim().is_empty());
        Ok(crate::editor::open_in_editor(
            &worktree_path,
            configured.as_deref(),
        ))
    }

    /// Phase 4 Step 4: resolve a subtask's worktree path for the
    /// frontend's WorktreeActions menu (Reveal / Copy path / Open
    /// terminal). Unlike [`Self::manual_fix_subtask`], this does NOT
    /// require the run to be in `AwaitingHumanFix` — a completed or
    /// cancelled run is still inspectable, and the Layer 3 escalation
    /// gate is orthogonal to per-worker worktree exposure.
    ///
    /// Backend gate (defense in depth; the frontend also gates the
    /// menu's visibility on derived state):
    ///
    ///   - The subtask must exist.
    ///   - It must not be in [`SubtaskState::Proposed`] or
    ///     [`SubtaskState::Waiting`] — both mean the worker never
    ///     started, so there's nothing to reveal. These are the only
    ///     states where `worktree_path` is definitionally `None`, but
    ///     we reject them explicitly so the error message is specific.
    ///   - `worktree_path` must be `Some` (the dispatcher stamps this
    ///     when it flips a subtask to `Running`).
    ///
    /// Notes:
    ///
    ///   - `Running` / `Retrying` are accepted by the backend but the
    ///     frontend hides the menu in those states. Accepting them
    ///     here avoids a race where a subtask flips out of `Running`
    ///     the moment the user clicks a menu item; the stricter
    ///     "no live workers" rule lives in the UI gate, where it
    ///     belongs (the user can't click what isn't rendered).
    ///   - `Cancelled` runs clean up worktrees in the lifecycle
    ///     terminal path; this method doesn't stat the path, so the
    ///     reveal / terminal spawn may fail naturally on a gone
    ///     directory. The frontend surfaces that as a toast.
    ///
    /// The CLAUDE.md "never expose worktree paths" rule has an
    /// explicit carve-out for this method — see the project-rules
    /// note landed with Phase 4 Step 4.
    pub async fn subtask_worktree_path_for_inspection(
        &self,
        run_id: &RunId,
        subtask_id: &SubtaskId,
    ) -> Result<std::path::PathBuf, OrchestratorError> {
        let run_arc = self
            .get_run(run_id)
            .await
            .ok_or_else(|| OrchestratorError::RunNotFound(run_id.clone()))?;
        let guard = run_arc.read().await;
        let sub = guard
            .find_subtask(subtask_id)
            .ok_or_else(|| OrchestratorError::SubtaskNotFound(subtask_id.clone()))?;
        if matches!(sub.state, SubtaskState::Proposed | SubtaskState::Waiting) {
            return Err(OrchestratorError::WrongSubtaskState {
                subtask_id: subtask_id.clone(),
                state: sub.state,
                expected: "any post-start state",
            });
        }
        sub.worktree_path.clone().ok_or_else(|| {
            OrchestratorError::InvalidEdit(format!(
                "subtask {subtask_id} has no worktree on disk"
            ))
        })
    }

    /// User finished editing by hand and confirmed the subtask is
    /// green. Sends [`Layer3Decision::Fixed`] to the lifecycle, which
    /// auto-commits any changes, flips the subtask to `Done`, and
    /// re-enters the dispatcher so previously-Waiting dependents can
    /// run.
    pub async fn mark_subtask_fixed(
        &self,
        run_id: &RunId,
        subtask_id: &SubtaskId,
    ) -> Result<(), OrchestratorError> {
        self.resolve_escalation(run_id, subtask_id, |sid| {
            Layer3Decision::Fixed(sid)
        })
        .await
        .map(|_| ())
    }

    /// Skip the escalated subtask and every still-Waiting subtask that
    /// transitively depends on it. Returns the full cascade so the
    /// frontend can render a "Skipped N subtasks" toast. The lifecycle
    /// flips each to `Skipped` and re-enters the dispatcher, which
    /// observes every remaining subtask is terminal and proceeds to
    /// Merging.
    pub async fn skip_subtask(
        &self,
        run_id: &RunId,
        subtask_id: &SubtaskId,
    ) -> Result<crate::ipc::SkipResult, OrchestratorError> {
        let run_arc = self
            .get_run(run_id)
            .await
            .ok_or_else(|| OrchestratorError::RunNotFound(run_id.clone()))?;
        let cascade: Vec<SubtaskId> = {
            let guard = run_arc.read().await;
            if guard.status != RunStatus::AwaitingHumanFix {
                return Err(OrchestratorError::WrongState {
                    run_id: run_id.clone(),
                    state: guard.status,
                    expected: "awaiting-human-fix",
                });
            }
            if !guard.escalated_subtask_ids.contains(subtask_id) {
                return Err(OrchestratorError::InvalidEdit(format!(
                    "subtask {subtask_id} is not the escalated target for run {run_id}"
                )));
            }
            compute_skip_cascade(&guard.subtasks, subtask_id)
        };

        let sender = self
            .resolution_senders
            .lock()
            .await
            .remove(run_id)
            .ok_or_else(|| OrchestratorError::WrongState {
                run_id: run_id.clone(),
                state: RunStatus::AwaitingHumanFix,
                expected: "awaiting-human-fix",
            })?;
        sender
            .send(Layer3Decision::Skipped(cascade.clone()))
            .map_err(|_| OrchestratorError::WrongState {
                run_id: run_id.clone(),
                state: RunStatus::AwaitingHumanFix,
                expected: "awaiting-human-fix",
            })?;

        Ok(crate::ipc::SkipResult {
            skipped_count: cascade.len() as u32,
            skipped_ids: cascade,
        })
    }

    /// Ask the master for one more replan. Only legal when the failed
    /// subtask's lineage hasn't burned the two-replan budget — the
    /// frontend hides the button once the cap is reached, but the
    /// backend double-checks via `count_replans_in_lineage` so a stale
    /// UI can't sneak a third replan through.
    pub async fn try_replan_again(
        &self,
        run_id: &RunId,
        subtask_id: &SubtaskId,
    ) -> Result<(), OrchestratorError> {
        let run_arc = self
            .get_run(run_id)
            .await
            .ok_or_else(|| OrchestratorError::RunNotFound(run_id.clone()))?;
        {
            let guard = run_arc.read().await;
            if guard.status != RunStatus::AwaitingHumanFix {
                return Err(OrchestratorError::WrongState {
                    run_id: run_id.clone(),
                    state: guard.status,
                    expected: "awaiting-human-fix",
                });
            }
            if !guard.escalated_subtask_ids.contains(subtask_id) {
                return Err(OrchestratorError::InvalidEdit(format!(
                    "subtask {subtask_id} is not the escalated target for run {run_id}"
                )));
            }
        }

        let prior_replans = self
            .storage
            .count_replans_in_lineage(subtask_id)
            .await
            .map_err(|e| OrchestratorError::Storage(e.to_string()))?;
        if prior_replans >= lifecycle::REPLAN_LINEAGE_CAP {
            return Err(OrchestratorError::InvalidEdit(format!(
                "replan budget exhausted ({prior_replans} replans already fired); cannot request another"
            )));
        }

        let sender = self
            .resolution_senders
            .lock()
            .await
            .remove(run_id)
            .ok_or_else(|| OrchestratorError::WrongState {
                run_id: run_id.clone(),
                state: RunStatus::AwaitingHumanFix,
                expected: "awaiting-human-fix",
            })?;
        sender
            .send(Layer3Decision::ReplanRequested(subtask_id.clone()))
            .map_err(|_| OrchestratorError::WrongState {
                run_id: run_id.clone(),
                state: RunStatus::AwaitingHumanFix,
                expected: "awaiting-human-fix",
            })?;
        Ok(())
    }

    /// Shared validate-and-send path for `mark_subtask_fixed`.
    /// `skip_subtask` and `try_replan_again` have extra payload /
    /// extra validation so they call the same lock + sender dance
    /// inline rather than squeeze through this helper.
    async fn resolve_escalation(
        &self,
        run_id: &RunId,
        subtask_id: &SubtaskId,
        make_decision: impl FnOnce(SubtaskId) -> Layer3Decision,
    ) -> Result<(), OrchestratorError> {
        let run_arc = self
            .get_run(run_id)
            .await
            .ok_or_else(|| OrchestratorError::RunNotFound(run_id.clone()))?;
        {
            let guard = run_arc.read().await;
            if guard.status != RunStatus::AwaitingHumanFix {
                return Err(OrchestratorError::WrongState {
                    run_id: run_id.clone(),
                    state: guard.status,
                    expected: "awaiting-human-fix",
                });
            }
            if !guard.escalated_subtask_ids.contains(subtask_id) {
                return Err(OrchestratorError::InvalidEdit(format!(
                    "subtask {subtask_id} is not the escalated target for run {run_id}"
                )));
            }
        }

        let sender = self
            .resolution_senders
            .lock()
            .await
            .remove(run_id)
            .ok_or_else(|| OrchestratorError::WrongState {
                run_id: run_id.clone(),
                state: RunStatus::AwaitingHumanFix,
                expected: "awaiting-human-fix",
            })?;
        sender
            .send(make_decision(subtask_id.clone()))
            .map_err(|_| OrchestratorError::WrongState {
                run_id: run_id.clone(),
                state: RunStatus::AwaitingHumanFix,
                expected: "awaiting-human-fix",
            })?;
        Ok(())
    }
}

/// Breadth-first cascade of a skip decision: starting from the
/// escalated subtask, collect every still-eligible (Waiting or
/// Proposed) subtask that transitively depends on it. Already-terminal
/// subtasks (Done, Failed, Skipped) are omitted — they don't need to
/// be re-flipped and cluttering `SkipResult` with them would mislead
/// the confirmation toast's count.
///
/// The traversal starts with the escalated subtask itself (which is
/// always included in the output even if it's already Failed) so
/// `SkipResult.skipped_count` matches what the user expects: "the
/// one I clicked + its dependents".
pub(crate) fn compute_skip_cascade(
    subtasks: &[SubtaskRuntime],
    origin: &SubtaskId,
) -> Vec<SubtaskId> {
    let mut result: Vec<SubtaskId> = Vec::new();
    let mut queue: std::collections::VecDeque<SubtaskId> = std::collections::VecDeque::new();
    let mut seen: std::collections::HashSet<SubtaskId> = std::collections::HashSet::new();
    queue.push_back(origin.clone());
    seen.insert(origin.clone());

    while let Some(current) = queue.pop_front() {
        result.push(current.clone());
        for s in subtasks {
            if !matches!(s.state, SubtaskState::Waiting | SubtaskState::Proposed) {
                continue;
            }
            if !s.dependency_ids.contains(&current) {
                continue;
            }
            if seen.insert(s.id.clone()) {
                queue.push_back(s.id.clone());
            }
        }
    }

    result
}

#[cfg(test)]
mod cascade_tests {
    use super::*;
    use crate::agents::PlannedSubtask;

    /// Build a `SubtaskRuntime` fixture. The `state` controls whether
    /// the cascade BFS will follow edges into this node (only Waiting
    /// and Proposed nodes are eligible).
    fn rt(id: &str, deps: &[&str], state: SubtaskState) -> SubtaskRuntime {
        let mut s = SubtaskRuntime::new(
            id.into(),
            PlannedSubtask {
                title: id.into(),
                why: String::new(),
                assigned_worker: AgentKind::Claude,
                dependencies: vec![],
            },
            deps.iter().map(|d| (*d).into()).collect(),
        );
        s.state = state;
        s
    }

    #[test]
    fn cascade_is_just_origin_when_no_dependents() {
        let subs = vec![
            rt("a", &[], SubtaskState::Failed),
            rt("b", &[], SubtaskState::Waiting),
        ];
        let out = compute_skip_cascade(&subs, &"a".into());
        assert_eq!(out, vec!["a"]);
    }

    #[test]
    fn cascade_walks_a_linear_chain() {
        // a ← b ← c, a is failed, b + c are Waiting.
        let subs = vec![
            rt("a", &[], SubtaskState::Failed),
            rt("b", &["a"], SubtaskState::Waiting),
            rt("c", &["b"], SubtaskState::Waiting),
        ];
        let out = compute_skip_cascade(&subs, &"a".into());
        assert_eq!(out, vec!["a", "b", "c"]);
    }

    #[test]
    fn cascade_dedupes_diamond() {
        // a ← b, a ← c, b ← d, c ← d — d is reachable via both b and c.
        let subs = vec![
            rt("a", &[], SubtaskState::Failed),
            rt("b", &["a"], SubtaskState::Waiting),
            rt("c", &["a"], SubtaskState::Waiting),
            rt("d", &["b", "c"], SubtaskState::Waiting),
        ];
        let mut out = compute_skip_cascade(&subs, &"a".into());
        out.sort();
        assert_eq!(out, vec!["a", "b", "c", "d"]);
    }

    #[test]
    fn cascade_stops_at_already_terminal_nodes() {
        // b is Done already; its descendants shouldn't be walked.
        let subs = vec![
            rt("a", &[], SubtaskState::Failed),
            rt("b", &["a"], SubtaskState::Done),
            rt("c", &["b"], SubtaskState::Waiting),
        ];
        let out = compute_skip_cascade(&subs, &"a".into());
        // `b` is terminal so it's skipped from the cascade; `c`
        // depends only on `b`, not `a`, so it never enters.
        assert_eq!(out, vec!["a"]);
    }

    #[test]
    fn cascade_includes_proposed_dependents() {
        // Not strictly a production path today (escalation targets are
        // post-Proposed) but confirming the BFS treats Proposed the
        // same as Waiting so the helper is safe to reuse.
        let subs = vec![
            rt("a", &[], SubtaskState::Failed),
            rt("b", &["a"], SubtaskState::Proposed),
        ];
        let out = compute_skip_cascade(&subs, &"a".into());
        assert_eq!(out, vec!["a", "b"]);
    }

    #[test]
    fn cascade_ignores_siblings_that_dont_depend_on_origin() {
        // `b` and `c` are both Waiting, but only `b` depends on `a`.
        let subs = vec![
            rt("a", &[], SubtaskState::Failed),
            rt("b", &["a"], SubtaskState::Waiting),
            rt("c", &[], SubtaskState::Waiting),
        ];
        let out = compute_skip_cascade(&subs, &"a".into());
        assert_eq!(out, vec!["a", "b"]);
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
    async fn recover_sweeps_awaiting_human_fix_runs() {
        // Phase 3 Step 5 Commit 2a: a crash while a run was parked on
        // Layer-3 human escalation must not leave a stale
        // `awaiting-human-fix` row. The resolution channel is ephemeral
        // in-memory state — after a crash the lifecycle task is gone,
        // so the only honest move is to finalize the run Failed and
        // let the user start over.
        let (orch, storage, _repo, repo_path) = make_with_repo().await;
        seed_active_run(
            &storage,
            "01PARKED",
            &repo_path.to_string_lossy(),
            RunStatus::AwaitingHumanFix,
        )
        .await;

        let recovered = orch.recover_active_runs().await;
        assert_eq!(
            recovered, 1,
            "AwaitingHumanFix rows must be swept by recovery"
        );

        let row = storage.get_run("01PARKED").await.unwrap().unwrap();
        assert_eq!(row.status, RunStatus::Failed);
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
