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
pub const EVENT_COMPLETED: &str = "run:completed";
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Completed {
    pub run_id: RunId,
    pub summary: RunSummary,
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

pub fn emit_completed(app: &AppHandle, payload: &Completed) -> tauri::Result<()> {
    app.emit(EVENT_COMPLETED, payload)
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
}
