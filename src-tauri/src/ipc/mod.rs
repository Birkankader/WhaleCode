//! Tauri IPC layer: typed wire contract between the React frontend and the
//! Rust backend. Commands are invoked from the frontend; events flow the
//! other way. The shapes here are mirrored by hand in `src/lib/ipc.ts`
//! (Zod schemas) — keep the two in sync when editing either side.
//!
//! Phase 2 step 1: the commands are stubs. They log the call, emit any
//! obvious events (e.g. `run:status_changed`), and return placeholder data.
//! Real orchestration lands in step 8.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub mod commands;
pub mod events;

pub type RunId = String;
pub type SubtaskId = String;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum AgentKind {
    Claude,
    Codex,
    Gemini,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum AgentStatus {
    Available {
        version: String,
        #[serde(rename = "binaryPath")]
        binary_path: PathBuf,
    },
    Broken {
        #[serde(rename = "binaryPath")]
        binary_path: PathBuf,
        error: String,
    },
    NotInstalled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDetectionResult {
    pub claude: AgentStatus,
    pub codex: AgentStatus,
    pub gemini: AgentStatus,
    pub recommended_master: Option<AgentKind>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RunStatus {
    Idle,
    Planning,
    AwaitingApproval,
    Running,
    Merging,
    Done,
    Rejected,
    Failed,
    Cancelled,
}

// SubtaskState / SubtaskData / FileDiff / RunSummary are scaffolding for the
// orchestrator (step 8). They travel across IPC event payloads; the command
// stubs in step 1 don't construct them yet.
//
// Phase 3 adds `Retrying` — the transient state a subtask enters between
// Layer-1 failure and its second attempt. No frontend bridge behaviour
// until Step 3a wires `START_RETRY` / `RETRY_SUCCESS` / `RETRY_FAIL` in
// `eventsForSubtaskState`; for now the variant is declared and the store
// treats it as a no-op.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SubtaskState {
    Proposed,
    Waiting,
    Running,
    Retrying,
    Done,
    Failed,
    Skipped,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtaskData {
    pub id: SubtaskId,
    pub title: String,
    pub why: Option<String>,
    pub assigned_worker: AgentKind,
    pub dependencies: Vec<SubtaskId>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub additions: u32,
    pub deletions: u32,
}

/// What the frontend sees on `run:completed`. Intentionally lean:
/// Phase 6 adds cost tracking, Phase 3 will add retry stats.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub run_id: RunId,
    /// Subtasks that actually ran (approved minus cascade-skipped).
    pub subtask_count: u32,
    /// Unique file paths touched by the merged result.
    pub files_changed: u32,
    /// Wall-clock `finished_at - started_at` in whole seconds.
    pub duration_secs: u64,
    /// One commit per merged subtask (from `MergeResult::commits_created`).
    pub commits_created: u32,
}

/// Partial update for a proposed subtask. Every field is independently
/// optional — absent / JSON `null` on the wire means "leave this field
/// alone". For [`Self::why`], `Some(s)` where `s` is empty is treated
/// as "clear to `None`" by the orchestrator; this matches the Phase 3
/// edit-row UI, which has a single textbox that turns empty on
/// clearing.
///
/// Phase 3 Q1 deferral: dependencies are not exposed here. The
/// original subtask keeps whatever dep list the master assigned;
/// user edits cannot reshape the DAG.
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubtaskPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub why: Option<String>,
    #[serde(default)]
    pub assigned_worker: Option<AgentKind>,
}

/// Full definition for a user-added subtask. The orchestrator
/// allocates the id server-side (so the frontend doesn't have to
/// coin ULIDs) and returns it alongside the re-emitted plan.
///
/// Same Phase 3 Q1 deferral as [`SubtaskPatch`]: no dependencies —
/// a user-added subtask is always a leaf in the DAG.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubtaskDraft {
    pub title: String,
    #[serde(default)]
    pub why: Option<String>,
    pub assigned_worker: AgentKind,
}

/// One entry in the boot-time recovery report: a run that was
/// non-terminal when the app last exited. The backend marks it
/// `Failed` and sweeps worktrees before populating this; the
/// frontend reads it once on startup to show a heads-up banner.
/// Intentionally minimal — `task` and `repo_path` are enough to
/// identify which run the user lost.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryEntry {
    pub task: String,
    pub repo_path: String,
}

