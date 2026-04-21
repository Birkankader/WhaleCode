//! Event payloads emitted from backend → frontend. Each event has a stable
//! string name (the `EVENT_*` constants) that the frontend subscribes to via
//! `listen()`. Payload structs derive `Serialize` with `rename_all =
//! "camelCase"` so JS consumers see idiomatic `runId`, `subtaskId`, etc.
//!
//! Prefer the `emit_*` helpers over calling `app.emit(...)` directly at
//! call sites — they keep event names and payload types tied together.

// Most of the emit helpers and their payload structs are scaffolding for the
// orchestrator (step 8). `emit_status_changed` is already wired through
// `submit_task`; the rest land when the orchestrator arrives.
#![allow(dead_code)]

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::{FileDiff, RunId, RunStatus, RunSummary, SubtaskData, SubtaskId, SubtaskState};

pub const EVENT_STATUS_CHANGED: &str = "run:status_changed";
pub const EVENT_MASTER_LOG: &str = "run:master_log";
pub const EVENT_SUBTASKS_PROPOSED: &str = "run:subtasks_proposed";
pub const EVENT_SUBTASK_STATE_CHANGED: &str = "run:subtask_state_changed";
pub const EVENT_SUBTASK_LOG: &str = "run:subtask_log";
pub const EVENT_DIFF_READY: &str = "run:diff_ready";
/// Phase 3.5 Item 6: emitted once per done subtask during the Apply
/// pre-merge diff collection pass. Gives the UI per-worker file-count
/// chips + a click-to-inspect popover *before* the aggregate
/// `DiffReady` flattens everything to the final node. Payload is the
/// same `FileDiff` shape the aggregate uses, scoped to one subtask.
pub const EVENT_SUBTASK_DIFF: &str = "run:subtask_diff";
pub const EVENT_COMPLETED: &str = "run:completed";
/// Phase 4 Step 2: fires immediately after the terminal
/// [`EVENT_STATUS_CHANGED`]`(Done)` on a successful Apply. Carries the
/// post-merge commit SHA, the base branch name, the aggregate file
/// count, and a per-worker breakdown so the bottom-right overlay can
/// render its body without a second IPC round-trip. Re-projects data
/// already produced by the merge phase — no new orchestration logic.
pub const EVENT_APPLY_SUMMARY: &str = "run:apply_summary";
pub const EVENT_FAILED: &str = "run:failed";
pub const EVENT_MERGE_CONFLICT: &str = "run:merge_conflict";
pub const EVENT_BASE_BRANCH_DIRTY: &str = "run:base_branch_dirty";
/// A subtask burned its Layer-1 retry budget; the master is being
/// re-invoked to produce a replacement plan for it. Emitted *before*
/// the master call so the frontend can flip the master chip to
/// thinking + surface a "replanning" pill on the affected subtask.
pub const EVENT_REPLAN_STARTED: &str = "run:replan_started";
/// Layer-3 escalation: the run hit the end of the retry ladder (either
/// two replans already burned on this lineage, or the master returned
/// an empty replan meaning "infeasible"). The frontend shows the
/// human-in-the-loop prompt and transitions the run to `Failed`.
pub const EVENT_HUMAN_ESCALATION: &str = "run:human_escalation";
/// Phase 3 Step 7: a plan pass (initial or replan) was auto-approved
/// on behalf of the user because `Settings::auto_approve` is on. The
/// frontend shows a subtle "Auto-approved N subtasks" banner so the
/// user isn't blindsided by work starting immediately.
pub const EVENT_AUTO_APPROVED: &str = "run:auto_approved";
/// Phase 3 Step 7: auto-approve was about to approve a plan pass but
/// the run-lifetime ceiling
/// (`Settings::max_subtasks_per_auto_approved_run`) would be exceeded,
/// so the lifecycle falls back to manual approval for this and every
/// subsequent plan pass in the run. Emitted once per run. The frontend
/// surfaces this through the existing approval sheet with a "Auto-
/// approve paused" hint.
pub const EVENT_AUTO_APPROVE_SUSPENDED: &str = "run:auto_approve_suspended";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusChanged {
    pub run_id: RunId,
    pub status: RunStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterLog {
    pub run_id: RunId,
    pub line: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtasksProposed {
    pub run_id: RunId,
    pub subtasks: Vec<SubtaskData>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtaskStateChanged {
    pub run_id: RunId,
    pub subtask_id: SubtaskId,
    pub state: SubtaskState,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtaskLog {
    pub run_id: RunId,
    pub subtask_id: SubtaskId,
    pub line: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffReady {
    pub run_id: RunId,
    pub files: Vec<FileDiff>,
}

/// Per-subtask file diff, emitted once per done subtask during the Apply
/// pre-merge diff pass. The aggregate [`DiffReady`] still fires after;
/// this event is *additive* so the UI can light up per-worker chips
/// incrementally while the lifecycle iterates done subtasks.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtaskDiff {
    pub run_id: RunId,
    pub subtask_id: SubtaskId,
    pub files: Vec<FileDiff>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Completed {
    pub run_id: RunId,
    pub summary: RunSummary,
}

/// Phase 4 Step 2 wire payload for [`EVENT_APPLY_SUMMARY`]. Emitted
/// once per successful Apply, immediately after the terminal
/// `StatusChanged(Done)`. The frontend shows a sticky bottom-right
/// overlay that renders these fields verbatim; the graph stays
/// mounted until the user dismisses the overlay or submits a new
/// task.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApplySummary {
    pub run_id: RunId,
    /// Full 40-char head SHA of `branch` after the merge. The
    /// overlay truncates to the first 7 chars for display and
    /// offers a "Copy SHA" button that copies the full value.
    pub commit_sha: String,
    /// The base branch the run merged into — i.e. the branch that
    /// now points at `commit_sha`. Captured from
    /// `WorktreeManager::base_branch` at Apply time.
    pub branch: String,
    /// Total unique files changed across the merged commits.
    /// Mirrors `RunSummary::files_changed`; duplicated here so the
    /// overlay can render without looking at two payloads.
    pub files_changed: u32,
    /// Per-worker attribution — one entry per `Done` subtask that
    /// contributed to the merge, in plan order. Used by the
    /// overlay's attribution rows; clicking a row pans the graph
    /// to the matching worker node.
    pub per_worker: Vec<ApplySummaryPerWorker>,
}

/// One entry in [`ApplySummary::per_worker`]. Kept tiny on purpose —
/// the frontend already has the subtask title from
/// `SubtasksProposed`; the overlay just needs the id to look it up
/// and the count to render the "N files" chip.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApplySummaryPerWorker {
    pub subtask_id: SubtaskId,
    pub files_changed: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failed {
    pub run_id: RunId,
    pub error: String,
}

/// A merge triggered by `apply_run` hit a conflict on one or more files.
/// The run stays in `Merging` state and worktrees are intact, so the
/// user can inspect the conflict before choosing discard.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeConflict {
    pub run_id: RunId,
    pub files: Vec<PathBuf>,
}

/// Apply attempted but the user's base-branch working tree has tracked
/// uncommitted changes — `git merge` would refuse to overwrite them, so
/// we bail *before* the merge. The run stays in `Merging`, worktrees
/// and branches are intact, and the user can commit / stash then retry.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseBranchDirty {
    pub run_id: RunId,
    pub files: Vec<PathBuf>,
}

/// Layer-2 replan just kicked off. The dispatcher escalated because a
/// subtask exhausted its Layer-1 retry budget; the master is now being
/// asked for a replacement plan. The frontend uses this to set the
/// master chip to thinking and highlight `failed_subtask_id` with a
/// "replanning" marker.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplanStarted {
    pub run_id: RunId,
    pub failed_subtask_id: SubtaskId,
}

/// Layer-3 escalation — the retry ladder is out of budget (either
/// two replans already burned on this lineage, or the master replied
/// with an empty plan). `reason` is a short human-readable sentence
/// the UI surfaces verbatim. `suggested_action` (optional) is the
/// master's suggestion for what a human should try; empty on the
/// lineage-cap branch because no plan was produced.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanEscalation {
    pub run_id: RunId,
    pub subtask_id: SubtaskId,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_action: Option<String>,
}

/// Phase 3 Step 7 wire payload for [`EVENT_AUTO_APPROVED`]. Carries the
/// list of subtask ids that were auto-approved in this plan pass so the
/// frontend can render a count without inferring it from
/// `SubtasksProposed`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoApproved {
    pub run_id: RunId,
    pub subtask_ids: Vec<SubtaskId>,
}

/// Phase 3 Step 7 wire payload for [`EVENT_AUTO_APPROVE_SUSPENDED`].
/// `reason` is a short machine-readable tag the frontend maps onto
/// localized copy: today the only value is `"subtask_limit"`; future
/// tags (safety gate denial, explicit user toggle off mid-run) slot in
/// without a new event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoApproveSuspended {
    pub run_id: RunId,
    pub reason: String,
}

pub fn emit_status_changed(app: &AppHandle, payload: &StatusChanged) -> tauri::Result<()> {
    app.emit(EVENT_STATUS_CHANGED, payload)
}

pub fn emit_master_log(app: &AppHandle, payload: &MasterLog) -> tauri::Result<()> {
    app.emit(EVENT_MASTER_LOG, payload)
}

pub fn emit_subtasks_proposed(app: &AppHandle, payload: &SubtasksProposed) -> tauri::Result<()> {
    app.emit(EVENT_SUBTASKS_PROPOSED, payload)
}

pub fn emit_subtask_state_changed(
    app: &AppHandle,
    payload: &SubtaskStateChanged,
) -> tauri::Result<()> {
    app.emit(EVENT_SUBTASK_STATE_CHANGED, payload)
}

pub fn emit_subtask_log(app: &AppHandle, payload: &SubtaskLog) -> tauri::Result<()> {
    app.emit(EVENT_SUBTASK_LOG, payload)
}

pub fn emit_diff_ready(app: &AppHandle, payload: &DiffReady) -> tauri::Result<()> {
    app.emit(EVENT_DIFF_READY, payload)
}

pub fn emit_subtask_diff(app: &AppHandle, payload: &SubtaskDiff) -> tauri::Result<()> {
    app.emit(EVENT_SUBTASK_DIFF, payload)
}

pub fn emit_completed(app: &AppHandle, payload: &Completed) -> tauri::Result<()> {
    app.emit(EVENT_COMPLETED, payload)
}

pub fn emit_apply_summary(app: &AppHandle, payload: &ApplySummary) -> tauri::Result<()> {
    app.emit(EVENT_APPLY_SUMMARY, payload)
}

pub fn emit_failed(app: &AppHandle, payload: &Failed) -> tauri::Result<()> {
    app.emit(EVENT_FAILED, payload)
}

pub fn emit_merge_conflict(app: &AppHandle, payload: &MergeConflict) -> tauri::Result<()> {
    app.emit(EVENT_MERGE_CONFLICT, payload)
}

pub fn emit_base_branch_dirty(
    app: &AppHandle,
    payload: &BaseBranchDirty,
) -> tauri::Result<()> {
    app.emit(EVENT_BASE_BRANCH_DIRTY, payload)
}

pub fn emit_replan_started(app: &AppHandle, payload: &ReplanStarted) -> tauri::Result<()> {
    app.emit(EVENT_REPLAN_STARTED, payload)
}

pub fn emit_human_escalation(
    app: &AppHandle,
    payload: &HumanEscalation,
) -> tauri::Result<()> {
    app.emit(EVENT_HUMAN_ESCALATION, payload)
}

pub fn emit_auto_approved(app: &AppHandle, payload: &AutoApproved) -> tauri::Result<()> {
    app.emit(EVENT_AUTO_APPROVED, payload)
}

pub fn emit_auto_approve_suspended(
    app: &AppHandle,
    payload: &AutoApproveSuspended,
) -> tauri::Result<()> {
    app.emit(EVENT_AUTO_APPROVE_SUSPENDED, payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::{AgentKind, FileDiff, RunStatus, SubtaskState};

    #[test]
    fn status_changed_serializes_camel_case() {
        let payload = StatusChanged {
            run_id: "r1".into(),
            status: RunStatus::AwaitingApproval,
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["runId"], "r1");
        assert_eq!(json["status"], "awaiting-approval");
    }

    #[test]
    fn subtask_state_changed_serializes_camel_case() {
        let payload = SubtaskStateChanged {
            run_id: "r1".into(),
            subtask_id: "s1".into(),
            state: SubtaskState::Running,
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["runId"], "r1");
        assert_eq!(json["subtaskId"], "s1");
        assert_eq!(json["state"], "running");
    }

    #[test]
    fn subtasks_proposed_embeds_camel_case_subtasks() {
        let payload = SubtasksProposed {
            run_id: "r1".into(),
            subtasks: vec![SubtaskData {
                id: "s1".into(),
                title: "t".into(),
                why: Some("because".into()),
                assigned_worker: AgentKind::Claude,
                dependencies: vec![],
                replaces: vec![],
                replan_count: 0,
            }],
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["runId"], "r1");
        assert_eq!(json["subtasks"][0]["id"], "s1");
        assert_eq!(json["subtasks"][0]["assignedWorker"], "claude");
    }

    #[test]
    fn diff_ready_includes_file_paths() {
        let payload = DiffReady {
            run_id: "r1".into(),
            files: vec![FileDiff {
                path: "src/foo.ts".into(),
                additions: 3,
                deletions: 1,
            }],
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["files"][0]["path"], "src/foo.ts");
        assert_eq!(json["files"][0]["additions"], 3);
    }

    #[test]
    fn apply_summary_serializes_camel_case_with_per_worker() {
        let payload = ApplySummary {
            run_id: "r1".into(),
            commit_sha: "abc1234def5678".into(),
            branch: "main".into(),
            files_changed: 5,
            per_worker: vec![
                ApplySummaryPerWorker {
                    subtask_id: "s1".into(),
                    files_changed: 3,
                },
                ApplySummaryPerWorker {
                    subtask_id: "s2".into(),
                    files_changed: 2,
                },
            ],
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["runId"], "r1");
        assert_eq!(json["commitSha"], "abc1234def5678");
        assert_eq!(json["branch"], "main");
        assert_eq!(json["filesChanged"], 5);
        assert_eq!(json["perWorker"][0]["subtaskId"], "s1");
        assert_eq!(json["perWorker"][0]["filesChanged"], 3);
        assert_eq!(json["perWorker"][1]["subtaskId"], "s2");
    }

    #[test]
    fn subtask_diff_serializes_camel_case() {
        let payload = SubtaskDiff {
            run_id: "r1".into(),
            subtask_id: "s1".into(),
            files: vec![FileDiff {
                path: "src/foo.ts".into(),
                additions: 5,
                deletions: 2,
            }],
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["runId"], "r1");
        assert_eq!(json["subtaskId"], "s1");
        assert_eq!(json["files"][0]["path"], "src/foo.ts");
        assert_eq!(json["files"][0]["additions"], 5);
        assert_eq!(json["files"][0]["deletions"], 2);
    }
}
