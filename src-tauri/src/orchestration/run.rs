//! In-memory state for a single run, mutated only through the
//! orchestrator.
//!
//! [`Run`] is the single source of truth for a run's lifecycle. Every
//! IPC command (approve, reject, apply, discard, cancel) ends in a
//! mutation here; every event emitted to the frontend is derived from
//! this state. SQLite is the *durable* copy — updated after each
//! transition — but reads inside the orchestrator never round-trip
//! through the DB. That keeps the hot path cheap and avoids
//! recursively holding a DB connection while also holding the run
//! lock.
//!
//! Locking discipline: the orchestrator wraps `Run` in
//! `Arc<RwLock<Run>>`. Long-running work (master planning, worker
//! execution, merge) must **not** happen while the write lock is
//! held. The pattern is: acquire, clone what you need (or pull out
//! Arc'd subfields), drop, do the work, acquire again to record the
//! result. `SubtaskRuntime` is intentionally cheap to clone so
//! dispatcher loops can snapshot the vec without contention.
//!
//! Derived helpers (`add_subtask`, `mark_subtask_running`, etc.) keep
//! mutation shapes consistent and centralize the "also update
//! timestamps" bookkeeping the dispatcher would otherwise duplicate.

use std::path::PathBuf;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use tokio_util::sync::CancellationToken;

use crate::agents::PlannedSubtask;
use crate::ipc::{AgentKind, RunId, RunStatus, SubtaskData, SubtaskId, SubtaskState};
use crate::orchestration::notes::SharedNotes;
use crate::worktree::WorktreeManager;

/// Runtime state for one subtask. Starts at [`SubtaskState::Proposed`]
/// (what the master returned, shown to the user in the approval
/// sheet) and walks through Waiting → Running → Done/Failed/Skipped.
#[derive(Debug, Clone)]
pub struct SubtaskRuntime {
    pub id: SubtaskId,
    pub data: PlannedSubtask,
    /// Ids (not indices) of the subtasks this one depends on. The
    /// orchestrator flattens `PlannedSubtask::dependencies` (indices
    /// into the master's original array) into ids at plan-acceptance
    /// time so the dispatcher doesn't need to carry the index map.
    pub dependency_ids: Vec<SubtaskId>,
    pub state: SubtaskState,
    pub worktree_path: Option<PathBuf>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    /// Present only when `state == Failed`. Rendered into events and
    /// persisted to SQLite.
    pub error: Option<String>,
    /// Subtask ids this one replaces. Empty for subtasks produced by
    /// the initial plan; a single-entry vec for subtasks the master
    /// produced as Layer-2 replacements. The lifecycle stamps this at
    /// insertion time and also persists an edge to `subtask_replans`.
    pub replaces: Vec<SubtaskId>,
}

impl SubtaskRuntime {
    /// Construct from the master's output. Ids are assigned by the
    /// orchestrator (ULID-per-subtask is fine; indices would be
    /// unstable across retries).
    pub fn new(id: SubtaskId, data: PlannedSubtask, dependency_ids: Vec<SubtaskId>) -> Self {
        Self {
            id,
            data,
            dependency_ids,
            state: SubtaskState::Proposed,
            worktree_path: None,
            started_at: None,
            finished_at: None,
            error: None,
            replaces: Vec::new(),
        }
    }

    /// Same as [`Self::new`] but records the ids this subtask replaces.
    /// Callers should pass a single-entry vec (the failed subtask's id)
    /// when inserting Layer-2 replacements; multi-replace is reserved
    /// for a future where one replan collapses several siblings into
    /// one.
    pub fn new_replacement(
        id: SubtaskId,
        data: PlannedSubtask,
        dependency_ids: Vec<SubtaskId>,
        replaces: Vec<SubtaskId>,
    ) -> Self {
        let mut s = Self::new(id, data, dependency_ids);
        s.replaces = replaces;
        s
    }

    /// `true` if the subtask has reached a terminal state (can't
    /// change further in this run). The dispatcher's exit predicate
    /// is "every subtask is terminal".
    pub fn is_terminal(&self) -> bool {
        matches!(
            self.state,
            SubtaskState::Done | SubtaskState::Failed | SubtaskState::Skipped
        )
    }

    /// `true` if the subtask counts as "satisfied" for dependency
    /// resolution. Done counts; failed/skipped dependents need to be
    /// handled by the dispatcher (skip the dependent, or fail-fast
    /// the whole run).
    pub fn is_done(&self) -> bool {
        matches!(self.state, SubtaskState::Done)
    }

    pub fn mark_running(&mut self, worktree_path: PathBuf) {
        self.state = SubtaskState::Running;
        self.worktree_path = Some(worktree_path);
        if self.started_at.is_none() {
            self.started_at = Some(Utc::now());
        }
    }

    pub fn mark_done(&mut self) {
        self.state = SubtaskState::Done;
        self.finished_at = Some(Utc::now());
    }

    pub fn mark_failed(&mut self, error: impl Into<String>) {
        self.state = SubtaskState::Failed;
        self.finished_at = Some(Utc::now());
        self.error = Some(error.into());
    }

    pub fn mark_skipped(&mut self) {
        self.state = SubtaskState::Skipped;
        self.finished_at = Some(Utc::now());
    }

    /// Project a runtime row onto the wire-facing
    /// [`SubtaskData`]. Used for the initial `SubtasksProposed`
    /// emit (lifecycle step) and the Phase 3 re-emit after an edit
    /// (orchestrator step). An empty `why` maps to `None` so the
    /// frontend doesn't render a zero-length reasoning block.
    ///
    /// `replan_count` defaults to 0 here because the runtime row
    /// doesn't know its lineage depth without querying storage;
    /// callers that care (the lifecycle's `SubtasksProposed` emit
    /// path) use [`Self::to_data_with_replan_count`] to overlay the
    /// storage-derived count.
    pub fn to_data(&self) -> SubtaskData {
        SubtaskData {
            id: self.id.clone(),
            title: self.data.title.clone(),
            why: Some(self.data.why.clone()).filter(|w| !w.is_empty()),
            assigned_worker: self.data.assigned_worker,
            dependencies: self.dependency_ids.clone(),
            replaces: self.replaces.clone(),
            replan_count: 0,
        }
    }

    /// Variant of [`Self::to_data`] that stamps the storage-derived
    /// `replan_count` — used by the lifecycle when emitting
    /// `SubtasksProposed` so the frontend can hide the "Try replan
    /// again" action once the lineage cap is reached.
    pub fn to_data_with_replan_count(&self, replan_count: u32) -> SubtaskData {
        let mut data = self.to_data();
        data.replan_count = replan_count;
        data
    }
}

/// Everything the orchestrator knows about one in-flight run.
///
/// The `worktree_mgr` and `notes` fields are `Arc`'d so worker tasks
/// can hold handles without keeping the run's `RwLock` open. Cloning
/// a `Run` itself isn't useful — the struct is moved into the
/// orchestrator's map and only touched through the lock.
pub struct Run {
    pub id: RunId,
    pub task: String,
    pub repo_root: PathBuf,
    pub master: AgentKind,
    pub status: RunStatus,
    pub subtasks: Vec<SubtaskRuntime>,
    pub worktree_mgr: Arc<WorktreeManager>,
    pub notes: Arc<SharedNotes>,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    /// Shared across the orchestration task and every worker task.
    /// Firing this propagates cancellation cooperatively: each worker
    /// notices on its next `tokio::select!` branch and kills its
    /// subprocess.
    pub cancel_token: CancellationToken,
    /// Subtask ids currently in Layer-3 human escalation (Phase 3 Step
    /// 5). Populated when the lifecycle parks on the resolution channel
    /// after a Layer-2 replan exhaustion / infeasibility; cleared when
    /// the user resolves the escalation (`Fixed` / `Skipped` /
    /// `ReplanRequested`) or aborts. The frontend doesn't read this
    /// directly (it drives off `RunEvent::HumanEscalation`); the field
    /// is held on the run so the backend can validate incoming IPC
    /// commands target a genuinely-escalated subtask once Commit 2b
    /// wires them up, and so crash recovery / debugging can inspect
    /// which subtask the run is parked on.
    pub escalated_subtask_ids: Vec<SubtaskId>,
}

impl Run {
    pub fn new(
        id: RunId,
        task: String,
        repo_root: PathBuf,
        master: AgentKind,
        worktree_mgr: Arc<WorktreeManager>,
        notes: Arc<SharedNotes>,
    ) -> Self {
        Self {
            id,
            task,
            repo_root,
            master,
            status: RunStatus::Planning,
            subtasks: Vec::new(),
            worktree_mgr,
            notes,
            started_at: Utc::now(),
            finished_at: None,
            cancel_token: CancellationToken::new(),
            escalated_subtask_ids: Vec::new(),
        }
    }

    pub fn find_subtask(&self, id: &SubtaskId) -> Option<&SubtaskRuntime> {
        self.subtasks.iter().find(|s| &s.id == id)
    }

    pub fn find_subtask_mut(&mut self, id: &SubtaskId) -> Option<&mut SubtaskRuntime> {
        self.subtasks.iter_mut().find(|s| &s.id == id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_planned(worker: AgentKind) -> PlannedSubtask {
        PlannedSubtask {
            title: "t".into(),
            why: "y".into(),
            assigned_worker: worker,
            dependencies: vec![],
        }
    }

    #[test]
    fn subtask_starts_proposed_with_no_timestamps() {
        let s = SubtaskRuntime::new("s1".into(), sample_planned(AgentKind::Claude), vec![]);
        assert_eq!(s.state, SubtaskState::Proposed);
        assert!(s.started_at.is_none());
        assert!(s.finished_at.is_none());
        assert!(!s.is_terminal());
        assert!(!s.is_done());
    }

    #[test]
    fn mark_running_sets_started_at_once() {
        let mut s = SubtaskRuntime::new("s1".into(), sample_planned(AgentKind::Claude), vec![]);
        s.mark_running(PathBuf::from("/tmp/wt"));
        let first = s.started_at;
        assert!(first.is_some());
        assert_eq!(s.state, SubtaskState::Running);
        // Double-mark shouldn't reset.
        s.mark_running(PathBuf::from("/tmp/other"));
        assert_eq!(s.started_at, first);
    }

    #[test]
    fn terminal_states_stamp_finished_at() {
        let mut s = SubtaskRuntime::new("s1".into(), sample_planned(AgentKind::Claude), vec![]);
        s.mark_done();
        assert!(s.is_terminal());
        assert!(s.is_done());
        assert!(s.finished_at.is_some());

        let mut f = SubtaskRuntime::new("s2".into(), sample_planned(AgentKind::Claude), vec![]);
        f.mark_failed("boom");
        assert!(f.is_terminal());
        assert!(!f.is_done());
        assert_eq!(f.error.as_deref(), Some("boom"));

        let mut sk = SubtaskRuntime::new("s3".into(), sample_planned(AgentKind::Claude), vec![]);
        sk.mark_skipped();
        assert!(sk.is_terminal());
        assert!(!sk.is_done());
    }
}
