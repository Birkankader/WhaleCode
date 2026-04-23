//! `RunEvent` is the orchestrator's internal event vocabulary. One
//! enum so the orchestrator can emit events with a single method call
//! regardless of how they reach the frontend; the [`EventSink`] trait
//! is what turns those enum values into either Tauri emits (prod) or
//! an in-memory `Vec` (tests).
//!
//! Contract with `ipc::events`:
//! - The wire-level payload structs and event names live in
//!   `ipc::events` — they're what the frontend subscribes to. Each
//!   variant here maps 1:1 to one of those structs and one of those
//!   event names. The enum exists so tests can assert on structured
//!   values without spinning up a Tauri runtime; `TauriEventSink`
//!   converts back to the wire shapes the frontend already knows.
//! - Don't add fields to a variant here without updating the matching
//!   `ipc::events` struct, otherwise prod loses the info in transit.
//!
//! Emission failures (Tauri channel down, runtime torn down) are
//! logged but never propagated — the orchestrator's state machine
//! must not hang on a dead frontend.

use std::path::PathBuf;

use async_trait::async_trait;
use tauri::AppHandle;

use crate::ipc::events as wire;
use crate::ipc::events::ErrorCategoryWire;
use crate::ipc::{FileDiff, RunId, RunStatus, RunSummary, SubtaskData, SubtaskId, SubtaskState};

/// Structured events the orchestrator emits during a run. Each is
/// fire-and-forget: the sink is expected to swallow transport
/// errors so the state machine never blocks on IPC.
#[derive(Debug, Clone)]
pub enum RunEvent {
    StatusChanged {
        run_id: RunId,
        status: RunStatus,
    },
    MasterLog {
        run_id: RunId,
        line: String,
    },
    SubtasksProposed {
        run_id: RunId,
        subtasks: Vec<SubtaskData>,
    },
    SubtaskStateChanged {
        run_id: RunId,
        subtask_id: SubtaskId,
        state: SubtaskState,
        /// Phase 4 Step 5. Set only on `Failed` transitions whose
        /// origin is an [`crate::agents::AgentError`] the dispatcher
        /// can classify. `None` for non-failure transitions and for
        /// failures whose source is a setup error / panic string
        /// (those still emit `Failed`, but without a category chip).
        error_category: Option<ErrorCategoryWire>,
    },
    SubtaskLog {
        run_id: RunId,
        subtask_id: SubtaskId,
        line: String,
    },
    DiffReady {
        run_id: RunId,
        files: Vec<FileDiff>,
    },
    /// Phase 3.5 Item 6: per-subtask file diff emitted during the
    /// Apply pre-merge pass, once per done subtask. The aggregate
    /// `DiffReady` still follows; this event is the per-worker
    /// breakdown the UI needs for the file-count chip and popover.
    SubtaskDiff {
        run_id: RunId,
        subtask_id: SubtaskId,
        files: Vec<FileDiff>,
    },
    Completed {
        run_id: RunId,
        summary: RunSummary,
    },
    /// Phase 4 Step 2: emitted once per successful Apply, *after* the
    /// terminal `StatusChanged(Done)`. Carries the re-projected merge
    /// outputs (commit SHA, base branch, aggregate + per-worker file
    /// counts) that the bottom-right overlay renders. Ordering
    /// invariant: `DiffReady → Completed → StatusChanged(Done) →
    /// ApplySummary`.
    ApplySummary {
        run_id: RunId,
        commit_sha: String,
        branch: String,
        files_changed: u32,
        per_worker: Vec<(SubtaskId, u32)>,
    },
    Failed {
        run_id: RunId,
        error: String,
    },
    MergeConflict {
        run_id: RunId,
        files: Vec<PathBuf>,
    },
    /// Base-branch working tree has tracked modifications at Apply
    /// time. Distinct from `MergeConflict` (which is a three-way-merge
    /// failure from worker branches colliding with each other): this
    /// fires *before* any merge is attempted, because `git merge`
    /// would refuse to overwrite user WIP. The run stays in
    /// `Merging`; the user commits or stashes and retries Apply.
    BaseBranchDirty {
        run_id: RunId,
        files: Vec<PathBuf>,
    },
    /// Layer-2 replan just started: dispatcher escalated a failed
    /// subtask and the master is being re-invoked. Emitted *before*
    /// the master call so the UI can flip the master chip to thinking.
    ReplanStarted {
        run_id: RunId,
        failed_subtask_id: SubtaskId,
    },
    /// Layer-3 escalation — retry ladder is exhausted. Either the
    /// failed subtask's lineage already burned two replans, or the
    /// master returned an empty replan (infeasible). `subtask_id` is
    /// the failing subtask the human needs to look at. `reason` is a
    /// human-readable one-sentence summary; `suggested_action`, when
    /// present, is the master's proposal for what to try next.
    HumanEscalation {
        run_id: RunId,
        subtask_id: SubtaskId,
        reason: String,
        suggested_action: Option<String>,
    },
    /// Phase 3 Step 7: `Settings::auto_approve` was on and the
    /// lifecycle synthesized an approval for a plan pass instead of
    /// waiting on the approval sheet. `subtask_ids` is the set of
    /// subtasks actually dispatched — the wire shape mirrors
    /// `ApprovalDecision::Approve { subtask_ids }`.
    AutoApproved {
        run_id: RunId,
        subtask_ids: Vec<SubtaskId>,
    },
    /// Phase 3 Step 7: auto-approve wanted to synthesize an approval
    /// but doing so would push the run past
    /// `Settings::max_subtasks_per_auto_approved_run`. The lifecycle
    /// falls back to manual approval for this pass and stays manual
    /// for the rest of the run. Emitted once per run. `reason`
    /// distinguishes "ceiling hit" from future reasons (safety gate,
    /// toggle flipped off mid-run).
    AutoApproveSuspended {
        run_id: RunId,
        reason: String,
    },
    /// Phase 5 Step 2: `stash_and_retry_apply` captured the dirty base
    /// branch into git stash. Emitted *before* the subsequent
    /// `ApplyDecision::Apply` is sent, so the UI sees the new stash
    /// reference even if the retry runs into a merge conflict and the
    /// run stays in `Merging`.
    StashCreated {
        run_id: RunId,
        stash_ref: String,
    },
    /// Phase 5 Step 2: `pop_stash` applied cleanly; the run no longer
    /// holds the stash ref. Lets the "stash still held" post-apply
    /// reminder dismiss itself.
    StashPopped {
        run_id: RunId,
        stash_ref: String,
    },
    /// Phase 5 Step 2: `pop_stash` either conflicted on apply (stash
    /// still in place) or the ref was missing. UI renders a pinned
    /// banner with the ref so the user can resolve + drop manually.
    StashPopFailed {
        run_id: RunId,
        stash_ref: String,
        kind: crate::ipc::events::StashPopFailureKind,
        error: String,
    },
}

impl RunEvent {
    /// The `run_id` field. Useful for logs, dispatching, and tests that
    /// want to filter events by run without pattern-matching every
    /// variant.
    pub fn run_id(&self) -> &RunId {
        match self {
            RunEvent::StatusChanged { run_id, .. }
            | RunEvent::MasterLog { run_id, .. }
            | RunEvent::SubtasksProposed { run_id, .. }
            | RunEvent::SubtaskStateChanged { run_id, .. }
            | RunEvent::SubtaskLog { run_id, .. }
            | RunEvent::DiffReady { run_id, .. }
            | RunEvent::SubtaskDiff { run_id, .. }
            | RunEvent::Completed { run_id, .. }
            | RunEvent::ApplySummary { run_id, .. }
            | RunEvent::Failed { run_id, .. }
            | RunEvent::MergeConflict { run_id, .. }
            | RunEvent::BaseBranchDirty { run_id, .. }
            | RunEvent::ReplanStarted { run_id, .. }
            | RunEvent::HumanEscalation { run_id, .. }
            | RunEvent::AutoApproved { run_id, .. }
            | RunEvent::AutoApproveSuspended { run_id, .. }
            | RunEvent::StashCreated { run_id, .. }
            | RunEvent::StashPopped { run_id, .. }
            | RunEvent::StashPopFailed { run_id, .. } => run_id,
        }
    }
}

/// Sink the orchestrator pushes events into. The production impl
/// forwards to Tauri; tests collect into a `Vec`.
///
/// `emit` is async so the Tauri impl can drop onto a runtime if a
/// future sink turns synchronous Tauri emits into anything that
/// awaits — today they don't, but pinning this signature now keeps
/// the trait stable.
#[async_trait]
pub trait EventSink: Send + Sync {
    async fn emit(&self, event: RunEvent);
}

/// Production sink: forwards each variant through the matching
/// `ipc::events::emit_*` helper. On transport failure we log and
/// move on — a dead frontend channel must not stall orchestration.
pub struct TauriEventSink {
    app: AppHandle,
}

impl TauriEventSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

#[async_trait]
impl EventSink for TauriEventSink {
    async fn emit(&self, event: RunEvent) {
        let result = match event {
            RunEvent::StatusChanged { run_id, status } => {
                wire::emit_status_changed(&self.app, &wire::StatusChanged { run_id, status })
            }
            RunEvent::MasterLog { run_id, line } => {
                wire::emit_master_log(&self.app, &wire::MasterLog { run_id, line })
            }
            RunEvent::SubtasksProposed { run_id, subtasks } => wire::emit_subtasks_proposed(
                &self.app,
                &wire::SubtasksProposed { run_id, subtasks },
            ),
            RunEvent::SubtaskStateChanged {
                run_id,
                subtask_id,
                state,
                error_category,
            } => wire::emit_subtask_state_changed(
                &self.app,
                &wire::SubtaskStateChanged {
                    run_id,
                    subtask_id,
                    state,
                    error_category,
                },
            ),
            RunEvent::SubtaskLog {
                run_id,
                subtask_id,
                line,
            } => wire::emit_subtask_log(
                &self.app,
                &wire::SubtaskLog {
                    run_id,
                    subtask_id,
                    line,
                },
            ),
            RunEvent::DiffReady { run_id, files } => {
                wire::emit_diff_ready(&self.app, &wire::DiffReady { run_id, files })
            }
            RunEvent::SubtaskDiff {
                run_id,
                subtask_id,
                files,
            } => wire::emit_subtask_diff(
                &self.app,
                &wire::SubtaskDiff {
                    run_id,
                    subtask_id,
                    files,
                },
            ),
            RunEvent::Completed { run_id, summary } => {
                wire::emit_completed(&self.app, &wire::Completed { run_id, summary })
            }
            RunEvent::ApplySummary {
                run_id,
                commit_sha,
                branch,
                files_changed,
                per_worker,
            } => wire::emit_apply_summary(
                &self.app,
                &wire::ApplySummary {
                    run_id,
                    commit_sha,
                    branch,
                    files_changed,
                    per_worker: per_worker
                        .into_iter()
                        .map(|(subtask_id, files_changed)| wire::ApplySummaryPerWorker {
                            subtask_id,
                            files_changed,
                        })
                        .collect(),
                },
            ),
            RunEvent::Failed { run_id, error } => {
                wire::emit_failed(&self.app, &wire::Failed { run_id, error })
            }
            RunEvent::MergeConflict { run_id, files } => {
                wire::emit_merge_conflict(&self.app, &wire::MergeConflict { run_id, files })
            }
            RunEvent::BaseBranchDirty { run_id, files } => {
                wire::emit_base_branch_dirty(&self.app, &wire::BaseBranchDirty { run_id, files })
            }
            RunEvent::ReplanStarted {
                run_id,
                failed_subtask_id,
            } => wire::emit_replan_started(
                &self.app,
                &wire::ReplanStarted {
                    run_id,
                    failed_subtask_id,
                },
            ),
            RunEvent::HumanEscalation {
                run_id,
                subtask_id,
                reason,
                suggested_action,
            } => wire::emit_human_escalation(
                &self.app,
                &wire::HumanEscalation {
                    run_id,
                    subtask_id,
                    reason,
                    suggested_action,
                },
            ),
            RunEvent::AutoApproved { run_id, subtask_ids } => wire::emit_auto_approved(
                &self.app,
                &wire::AutoApproved { run_id, subtask_ids },
            ),
            RunEvent::AutoApproveSuspended { run_id, reason } => {
                wire::emit_auto_approve_suspended(
                    &self.app,
                    &wire::AutoApproveSuspended { run_id, reason },
                )
            }
            RunEvent::StashCreated { run_id, stash_ref } => {
                wire::emit_stash_created(&self.app, &wire::StashCreated { run_id, stash_ref })
            }
            RunEvent::StashPopped { run_id, stash_ref } => {
                wire::emit_stash_popped(&self.app, &wire::StashPopped { run_id, stash_ref })
            }
            RunEvent::StashPopFailed {
                run_id,
                stash_ref,
                kind,
                error,
            } => wire::emit_stash_pop_failed(
                &self.app,
                &wire::StashPopFailed {
                    run_id,
                    stash_ref,
                    kind,
                    error,
                },
            ),
        };
        if let Err(e) = result {
            eprintln!("[orchestrator] event emit failed: {e}");
        }
    }
}

/// Test-only sink that accumulates events. Construct with `default()`;
/// call `snapshot()` to read without consuming the collector.
#[cfg(test)]
#[derive(Default)]
pub struct RecordingEventSink {
    events: tokio::sync::Mutex<Vec<RunEvent>>,
}

#[cfg(test)]
impl RecordingEventSink {
    pub async fn snapshot(&self) -> Vec<RunEvent> {
        self.events.lock().await.clone()
    }
}

#[cfg(test)]
#[async_trait]
impl EventSink for RecordingEventSink {
    async fn emit(&self, event: RunEvent) {
        self.events.lock().await.push(event);
    }
}
