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
}

// SubtaskState / SubtaskData / FileDiff / RunSummary are scaffolding for the
// orchestrator (step 8). They travel across IPC event payloads; the command
// stubs in step 1 don't construct them yet.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SubtaskState {
    Proposed,
    Waiting,
    Running,
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

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub run_id: RunId,
    pub subtasks_total: u32,
    pub subtasks_done: u32,
    pub subtasks_failed: u32,
    pub files_changed: u32,
}

