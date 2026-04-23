//! Domain models mapped to the Phase 2 schema.
//!
//! The DB uses TEXT columns for enums (so we can grep them and keep migrations
//! simple) and ISO 8601 strings for timestamps. Conversions between Rust enums
//! and their on-disk string spelling live here so the rest of the module can
//! stay typed.

#![allow(dead_code)]

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::ipc::{AgentKind, RunStatus, SubtaskState};

use super::error::{StorageError, StorageResult};

/// Current UTC timestamp as an ISO 8601 / RFC 3339 string. Callers that need
/// determinism in tests can construct strings themselves.
pub fn now_iso8601() -> String {
    Utc::now().to_rfc3339()
}

/// Input for `Storage::insert_run`. The caller supplies the run id (usually a
/// UUID) so it can be threaded into events before the DB write completes.
#[derive(Debug, Clone)]
pub struct NewRun {
    pub id: String,
    pub task: String,
    pub repo_path: String,
    pub master_agent: AgentKind,
    pub status: RunStatus,
    pub started_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Run {
    pub id: String,
    pub task: String,
    pub repo_path: String,
    pub master_agent: AgentKind,
    pub status: RunStatus,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NewSubtask {
    pub id: String,
    pub run_id: String,
    pub title: String,
    pub why: Option<String>,
    pub assigned_worker: AgentKind,
    pub state: SubtaskState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Subtask {
    pub id: String,
    pub run_id: String,
    pub title: String,
    pub why: Option<String>,
    pub assigned_worker: AgentKind,
    pub state: SubtaskState,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SubtaskLog {
    pub id: i64,
    pub subtask_id: String,
    pub line: String,
    pub created_at: String,
}

// --- Enum ↔ TEXT mappings -------------------------------------------------
//
// Keep these in sync with the frontend Zod schemas. The strings here are what
// ends up on disk — don't change them without a new migration.

pub(super) fn agent_kind_to_str(k: AgentKind) -> &'static str {
    match k {
        AgentKind::Claude => "claude",
        AgentKind::Codex => "codex",
        AgentKind::Gemini => "gemini",
    }
}

pub(super) fn agent_kind_from_str(s: &str) -> StorageResult<AgentKind> {
    match s {
        "claude" => Ok(AgentKind::Claude),
        "codex" => Ok(AgentKind::Codex),
        "gemini" => Ok(AgentKind::Gemini),
        other => Err(StorageError::Invalid(format!("unknown agent kind: {other}"))),
    }
}

pub(super) fn run_status_to_str(s: RunStatus) -> &'static str {
    match s {
        RunStatus::Idle => "idle",
        RunStatus::Planning => "planning",
        RunStatus::AwaitingApproval => "awaiting-approval",
        RunStatus::Running => "running",
        RunStatus::Merging => "merging",
        RunStatus::Done => "done",
        RunStatus::Rejected => "rejected",
        RunStatus::Failed => "failed",
        RunStatus::Cancelled => "cancelled",
        RunStatus::AwaitingHumanFix => "awaiting-human-fix",
    }
}

pub(super) fn run_status_from_str(s: &str) -> StorageResult<RunStatus> {
    match s {
        "idle" => Ok(RunStatus::Idle),
        "planning" => Ok(RunStatus::Planning),
        "awaiting-approval" => Ok(RunStatus::AwaitingApproval),
        "running" => Ok(RunStatus::Running),
        "merging" => Ok(RunStatus::Merging),
        "done" => Ok(RunStatus::Done),
        "rejected" => Ok(RunStatus::Rejected),
        "failed" => Ok(RunStatus::Failed),
        "cancelled" => Ok(RunStatus::Cancelled),
        "awaiting-human-fix" => Ok(RunStatus::AwaitingHumanFix),
        other => Err(StorageError::Invalid(format!("unknown run status: {other}"))),
    }
}

pub(super) fn subtask_state_to_str(s: SubtaskState) -> &'static str {
    match s {
        SubtaskState::Proposed => "proposed",
        SubtaskState::Waiting => "waiting",
        SubtaskState::Running => "running",
        SubtaskState::Retrying => "retrying",
        SubtaskState::Done => "done",
        SubtaskState::Failed => "failed",
        SubtaskState::Skipped => "skipped",
        SubtaskState::Cancelled => "cancelled",
    }
}

pub(super) fn subtask_state_from_str(s: &str) -> StorageResult<SubtaskState> {
    match s {
        "proposed" => Ok(SubtaskState::Proposed),
        "waiting" => Ok(SubtaskState::Waiting),
        "running" => Ok(SubtaskState::Running),
        "retrying" => Ok(SubtaskState::Retrying),
        "done" => Ok(SubtaskState::Done),
        "failed" => Ok(SubtaskState::Failed),
        "skipped" => Ok(SubtaskState::Skipped),
        "cancelled" => Ok(SubtaskState::Cancelled),
        other => Err(StorageError::Invalid(format!(
            "unknown subtask state: {other}"
        ))),
    }
}
