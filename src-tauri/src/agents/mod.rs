//! Agent adapter layer.
//!
//! Each CLI we drive (Claude Code, Codex, Gemini) gets one impl of
//! [`AgentImpl`]. The trait abstracts two jobs: `plan` (master role —
//! given a task and repo context, return a structured [`Plan`]) and
//! `execute` (worker role — carry out a single [`Subtask`] inside a
//! worktree, streaming log lines back via an mpsc channel).
//!
//! This module owns the shared vocabulary all three adapters speak:
//! the error taxonomy, the planning context, the plan shape, and the
//! fenced-JSON plan parser. The subprocess machinery (spawn, stream,
//! timeout, cancel) lives here too so individual adapters stay focused
//! on their CLI's flags and quirks.
//!
//! Step 5 ships the trait + one shared parser + a fake-agent fixture
//! that integration tests spawn as a stand-in for a real CLI. Step 6+
//! will plug the real adapters into the orchestrator.

#![allow(dead_code)] // Orchestrator (step 8) consumes the rest.

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::ipc::AgentKind;
use crate::storage::models::Subtask;

pub mod claude;
pub mod plan_parser;
pub mod process;
pub mod prompts;
#[cfg(test)]
pub mod tests;

// -- Core types ------------------------------------------------------

/// Context the master sees when producing a plan. Constructed by the
/// orchestrator once per run and handed to whichever agent is master.
#[derive(Debug, Clone)]
pub struct PlanningContext {
    pub repo_root: PathBuf,
    /// `find`-style listing, 2 levels deep, filtered (no `node_modules`
    /// / `target` / `.git`). Rendered into the prompt verbatim.
    pub directory_tree: String,
    pub claude_md: Option<String>,
    pub agents_md: Option<String>,
    pub gemini_md: Option<String>,
    /// Most recent commits on the current branch, newest first.
    pub recent_commits: Vec<CommitInfo>,
    /// Agents the orchestrator is willing to hand work to. The master
    /// must only assign subtasks to one of these.
    pub available_workers: Vec<AgentKind>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CommitInfo {
    pub sha: String,
    pub subject: String,
    pub author: String,
    pub when: String, // ISO 8601
}

/// Structured plan the master returns. Field names are the on-the-wire
/// JSON shape agents emit — don't rename without updating every prompt
/// template under `prompts/`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Plan {
    pub reasoning: String,
    pub subtasks: Vec<PlannedSubtask>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlannedSubtask {
    pub title: String,
    pub why: String,
    pub assigned_worker: AgentKind,
    /// Indices into the sibling `subtasks` array that must complete
    /// before this one can start. Must form a DAG.
    #[serde(default)]
    pub dependencies: Vec<usize>,
}

/// What the worker returns when it finishes. Phase 2 needs just enough
/// to show a diff and a one-line summary; Phase 3 will add judgment
/// (did the agent actually fulfil the subtask?).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionResult {
    pub summary: String,
    pub files_changed: Vec<PathBuf>,
}

// -- Error taxonomy --------------------------------------------------
//
// Keep these variants distinct: Phase 3's retry ladder branches on
// them. `TaskFailed` is a controlled refusal ("I can't do this"),
// `ProcessCrashed` is a crash we shouldn't retry blindly, and
// `ParseFailed` means the plan came back but we couldn't understand
// it — the right retry is usually "ask again with stricter format".

#[derive(Debug, Error)]
pub enum AgentError {
    #[error("agent process crashed (exit={exit_code:?}, signal={signal:?})")]
    ProcessCrashed {
        exit_code: Option<i32>,
        signal: Option<i32>,
    },
    #[error("agent refused the task: {reason}")]
    TaskFailed { reason: String },
    #[error("plan output couldn't be parsed: {reason}")]
    ParseFailed {
        reason: String,
        raw_output: String,
    },
    #[error("agent timed out after {after_secs}s")]
    Timeout { after_secs: u64 },
    #[error("agent run was cancelled")]
    Cancelled,
    #[error("couldn't spawn agent: {cause}")]
    SpawnFailed { cause: String },
}

// -- The trait -------------------------------------------------------

#[async_trait]
pub trait AgentImpl: Send + Sync {
    /// Which CLI this adapter drives. Stable for the lifetime of the
    /// adapter; matches the value in `AgentKind`.
    fn kind(&self) -> AgentKind;

    /// Version string reported by the CLI at construction time (e.g.
    /// `"2.1.113"`). Informational only — the orchestrator logs it but
    /// doesn't branch on it.
    fn version(&self) -> &str;

    /// Master role. Produce a structured plan for `task`. The
    /// `cancel` token is honored: if cancelled mid-run, the adapter
    /// kills its subprocess and returns [`AgentError::Cancelled`].
    async fn plan(
        &self,
        task: &str,
        context: PlanningContext,
        cancel: CancellationToken,
    ) -> Result<Plan, AgentError>;

    /// Worker role. Execute a single subtask inside `worktree_path`.
    /// Each line the CLI emits is sent through `log_tx`; dropped lines
    /// don't fail the run (best-effort). Same cancellation semantics
    /// as [`plan`].
    async fn execute(
        &self,
        subtask: &Subtask,
        worktree_path: &Path,
        shared_notes: &str,
        log_tx: mpsc::Sender<String>,
        cancel: CancellationToken,
    ) -> Result<ExecutionResult, AgentError>;
}
