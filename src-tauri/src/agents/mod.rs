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
pub mod codex;
pub mod gemini;
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

/// Context the master sees when producing a *replacement* plan after a
/// subtask has burned through Layer 1's retry budget. Distinct from
/// [`PlanningContext`] because the inputs are different — the master
/// has already seen the repo; what it needs now is failure forensics
/// and a running picture of what the rest of the plan accomplished.
///
/// The orchestrator constructs this at Step 4 time (dispatcher escalated
/// with `Exhausted` or `Deterministic`) and hands it to the master's
/// [`AgentImpl::replan`] method. All string fields are pre-rendered for
/// the prompt — the adapter substitutes them in verbatim, no further
/// shaping.
#[derive(Debug, Clone)]
pub struct ReplanContext {
    /// The user's original task prompt (verbatim from the run row).
    pub original_task: String,
    /// Repo root, same as [`PlanningContext::repo_root`]. Used as the
    /// child's cwd so the adapter sees the target repo.
    pub repo_root: PathBuf,
    /// Title of the failed subtask.
    pub failed_subtask_title: String,
    /// The "why" the master gave when proposing the failed subtask.
    pub failed_subtask_why: String,
    /// Error messages from every attempt on the failed subtask, in
    /// chronological order. For `Exhausted` there are two entries (the
    /// first-attempt error and the retry's error); for `Deterministic`
    /// (e.g. `SpawnFailed`) there's one.
    pub attempt_errors: Vec<String>,
    /// Tail of the failed subtask's worker log, ~50 lines, already
    /// bounded + newline-joined. Empty string when no logs were emitted.
    pub worker_log_tail: String,
    /// One-line summaries of subtasks that have already completed in
    /// this run. Gives the master a running picture of what landed so
    /// the replacement can build on it.
    pub completed_subtask_summaries: Vec<String>,
    /// How many replans have already fired in the failed subtask's
    /// lineage (including the one about to happen). `1` on the first
    /// replan, `2` on the second. The prompt surfaces this so the
    /// master can lean toward smaller / alternative decompositions
    /// when the budget is almost spent.
    pub attempt_counter: u32,
    /// Same allow-list as [`PlanningContext::available_workers`]. The
    /// master may only assign the replacement plan to one of these.
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

#[derive(Debug, Clone, Error)]
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
    ///
    /// `extra_context` carries Phase-3 retry context: on the first
    /// attempt it is `None`; on a Layer-1 retry the dispatcher fills it
    /// with a summary of the previous failure so the adapter can
    /// render it into the worker prompt. Adapters must tolerate
    /// `None` (the normal path) and fold `Some` text into the prompt
    /// when present — no sibling method, one code path.
    async fn execute(
        &self,
        subtask: &Subtask,
        worktree_path: &Path,
        shared_notes: &str,
        extra_context: Option<&str>,
        log_tx: mpsc::Sender<String>,
        cancel: CancellationToken,
    ) -> Result<ExecutionResult, AgentError>;

    /// Free-form prompt → response. Used by the notes module to ask
    /// the master to rewrite shared notes when they grow large, but
    /// the method is general: anywhere we want the CLI to read text
    /// and produce text without planning or writing files. Runs in
    /// read-only permission mode — no tool use should occur.
    ///
    /// Return value: the model's raw response body, stripped of any
    /// CLI-specific envelope. Empty-string on valid-but-empty
    /// response (e.g. if the model produced only whitespace). Caller
    /// decides what "too short" means.
    async fn summarize(
        &self,
        prompt: &str,
        cancel: CancellationToken,
    ) -> Result<String, AgentError>;

    /// Master role — Layer 2. Produce a replacement plan when a
    /// previously-approved subtask failed Layer 1. Inputs differ from
    /// [`plan`] enough to warrant a separate method: the master has
    /// already seen the repo and now needs failure forensics + a
    /// running picture of what already landed.
    ///
    /// The returned [`Plan`]'s `subtasks` replace the failed subtask —
    /// an empty vec is a legitimate outcome meaning "this is infeasible,
    /// surface it to the human" (the orchestrator converts an empty
    /// replan into a Layer-3 escalation). Each returned
    /// [`PlannedSubtask`] is otherwise indistinguishable from one
    /// produced by [`plan`]; the orchestrator assigns fresh ulids and
    /// records `subtask_replans` lineage rows, so adapters need not
    /// stamp anything special.
    ///
    /// Default impl errors with `TaskFailed` so an adapter that hasn't
    /// implemented replan yet surfaces loudly rather than silently
    /// hanging the Layer-2 path. Every real adapter overrides this.
    async fn replan(
        &self,
        context: ReplanContext,
        cancel: CancellationToken,
    ) -> Result<Plan, AgentError> {
        let _ = (context, cancel);
        Err(AgentError::TaskFailed {
            reason: "replan not implemented for this adapter".to_string(),
        })
    }
}
