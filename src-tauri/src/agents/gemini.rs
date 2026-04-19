//! Gemini CLI adapter.
//!
//! Gemini (`gemini` binary) returns a clean JSON document with a
//! top-level `response` field when invoked with
//! `--output-format json --yolo`. We dig the fenced ```json plan
//! block out of that `response` string.
//!
//! The CLI auto-detects non-interactive mode when stdin is a pipe —
//! no `-p` flag needed. `--yolo` auto-approves all tool calls, which
//! is the headless equivalent of Claude's `--dangerously-skip-
//! permissions`: fine because execution happens inside a sandboxed
//! worktree. For planning we add `--approval-mode plan` so the master
//! stays read-only.
//!
//! Gemini emits noisy stderr lines (mode banners, deprecation hints,
//! transient 429 retries). We tolerate them — stderr is only
//! inspected when the exit is non-zero.

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde::Deserialize;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::ipc::AgentKind;
use crate::storage::models::Subtask;

use super::plan_parser::parse_and_validate;
use super::process::{
    classify_nonzero, git_changed_files, render_template, run_streaming, ChildOutput, RunSpec,
    DEFAULT_EXECUTE_TIMEOUT, DEFAULT_PLAN_TIMEOUT,
};
use super::prompts::{MASTER_GEMINI, REPLAN_GEMINI};
use super::{AgentError, AgentImpl, ExecutionResult, Plan, PlanningContext, ReplanContext};

/// If the prompt grows past this, Gemini's API tends to slow down or
/// reject with 413. We shrink the directory tree first (cheapest
/// signal to lose) before hitting that wall. The threshold is a
/// rough heuristic — Gemini doesn't publish an exact cap.
const PROMPT_CHAR_BUDGET: usize = 60_000;

pub struct GeminiAdapter {
    binary: PathBuf,
    version: String,
}

impl GeminiAdapter {
    pub fn new(binary: PathBuf, version: String) -> Self {
        Self { binary, version }
    }

    pub fn build_plan_prompt(task: &str, ctx: &PlanningContext) -> String {
        let commits = format_commits(&ctx.recent_commits);
        let workers = format_workers(&ctx.available_workers);
        let tree = trim_tree_to_budget(&ctx.directory_tree, PROMPT_CHAR_BUDGET);
        render_template(
            MASTER_GEMINI,
            &[
                ("task", task),
                ("directory_tree", &tree),
                ("claude_md", ctx.claude_md.as_deref().unwrap_or("")),
                ("agents_md", ctx.agents_md.as_deref().unwrap_or("")),
                ("gemini_md", ctx.gemini_md.as_deref().unwrap_or("")),
                ("recent_commits", &commits),
                ("available_workers", &workers),
            ],
        )
    }

    pub fn build_execute_prompt(
        subtask: &Subtask,
        worktree_path: &Path,
        shared_notes: &str,
        extra_context: Option<&str>,
    ) -> String {
        let why = subtask.why.as_deref().unwrap_or("(no rationale given)");
        let mut prompt = format!(
            "You are a WhaleCode worker running in a sandboxed git \
             worktree at {worktree_path}. Do not edit anything outside \
             this directory.\n\n\
             # Subtask\n**{title}**\n\nWhy: {why}\n\n\
             # Shared notes (read-only)\n{shared_notes}\n\n\
             # Instructions\n\
             Make the minimal set of changes needed to complete the \
             subtask. When finished, print a one- or two-sentence \
             summary and stop — do not ask follow-up questions.\n",
            worktree_path = worktree_path.display(),
            title = subtask.title,
        );
        if let Some(ctx) = extra_context {
            prompt.push_str("\n# Retry context\n");
            prompt.push_str(ctx);
            prompt.push('\n');
        }
        prompt
    }

    /// Render the master re-planning prompt. Trims the worker log tail
    /// against `PROMPT_CHAR_BUDGET` using the same strategy as
    /// [`Self::build_plan_prompt`] — Gemini is prone to 413s when the
    /// request grows past ~60 KB.
    pub fn build_replan_prompt(ctx: &ReplanContext) -> String {
        let attempt_errors = format_attempt_errors(&ctx.attempt_errors);
        let completed = format_completed_summaries(&ctx.completed_subtask_summaries);
        let workers = format_workers(&ctx.available_workers);
        let log_tail = if ctx.worker_log_tail.is_empty() {
            "(no log lines captured)".to_string()
        } else {
            trim_tree_to_budget(&ctx.worker_log_tail, PROMPT_CHAR_BUDGET)
        };
        let counter = ctx.attempt_counter.to_string();
        render_template(
            REPLAN_GEMINI,
            &[
                ("original_task", ctx.original_task.as_str()),
                ("failed_title", ctx.failed_subtask_title.as_str()),
                ("failed_why", ctx.failed_subtask_why.as_str()),
                ("attempt_errors", &attempt_errors),
                ("worker_log_tail", &log_tail),
                ("completed_summaries", &completed),
                ("attempt_counter", &counter),
                ("available_workers", &workers),
            ],
        )
    }
}

#[async_trait]
impl AgentImpl for GeminiAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::Gemini
    }

    fn version(&self) -> &str {
        &self.version
    }

    async fn plan(
        &self,
        task: &str,
        context: PlanningContext,
        cancel: CancellationToken,
    ) -> Result<Plan, AgentError> {
        let prompt = Self::build_plan_prompt(task, &context);
        let args = vec![
            "--output-format".into(),
            "json".into(),
            "--approval-mode".into(),
            "plan".into(),
        ];
        let spec = RunSpec {
            binary: &self.binary,
            args,
            cwd: Some(&context.repo_root),
            stdin: Some(prompt),
            timeout: DEFAULT_PLAN_TIMEOUT,
            log_tx: None,
            cancel,
        };
        let out = run_streaming(spec).await?;
        handle_plan_output(out, &context.available_workers)
    }

    async fn execute(
        &self,
        subtask: &Subtask,
        worktree_path: &Path,
        shared_notes: &str,
        extra_context: Option<&str>,
        log_tx: mpsc::Sender<String>,
        cancel: CancellationToken,
    ) -> Result<ExecutionResult, AgentError> {
        let prompt = Self::build_execute_prompt(subtask, worktree_path, shared_notes, extra_context);
        let args = vec![
            "--output-format".into(),
            "text".into(),
            "--yolo".into(),
            "--include-directories".into(),
            worktree_path.to_string_lossy().into_owned(),
        ];
        let spec = RunSpec {
            binary: &self.binary,
            args,
            cwd: Some(worktree_path),
            stdin: Some(prompt),
            timeout: DEFAULT_EXECUTE_TIMEOUT,
            log_tx: Some(log_tx),
            cancel,
        };
        let out = run_streaming(spec).await?;
        if out.exit_code != Some(0) {
            return Err(classify_nonzero(out.exit_code, out.signal, &out.stderr));
        }
        let summary = summarize_last_lines(&out.stdout, 3);
        let files_changed = git_changed_files(worktree_path).await.unwrap_or_default();
        Ok(ExecutionResult {
            summary,
            files_changed,
        })
    }

    async fn summarize(
        &self,
        prompt: &str,
        cancel: CancellationToken,
    ) -> Result<String, AgentError> {
        let args = vec![
            "--output-format".into(),
            "json".into(),
            "--approval-mode".into(),
            "plan".into(),
        ];
        let spec = RunSpec {
            binary: &self.binary,
            args,
            cwd: None,
            stdin: Some(prompt.to_string()),
            timeout: DEFAULT_PLAN_TIMEOUT,
            log_tx: None,
            cancel,
        };
        let out = run_streaming(spec).await?;
        if out.exit_code != Some(0) {
            return Err(classify_nonzero(out.exit_code, out.signal, &out.stderr));
        }
        let envelope: GeminiEnvelope =
            serde_json::from_str(out.stdout.trim()).map_err(|e| AgentError::ParseFailed {
                reason: format!("envelope didn't match Gemini's --output-format json shape: {e}"),
                raw_output: out.stdout.clone(),
            })?;
        if let Some(err) = envelope.error {
            return Err(AgentError::TaskFailed { reason: err });
        }
        Ok(envelope.response.unwrap_or_default())
    }

    async fn replan(
        &self,
        context: ReplanContext,
        cancel: CancellationToken,
    ) -> Result<Plan, AgentError> {
        // Same envelope as `plan`: read-only approval mode, JSON
        // output. Only the prompt changes.
        let prompt = Self::build_replan_prompt(&context);
        let args = vec![
            "--output-format".into(),
            "json".into(),
            "--approval-mode".into(),
            "plan".into(),
        ];
        let spec = RunSpec {
            binary: &self.binary,
            args,
            cwd: Some(&context.repo_root),
            stdin: Some(prompt),
            timeout: DEFAULT_PLAN_TIMEOUT,
            log_tx: None,
            cancel,
        };
        let out = run_streaming(spec).await?;
        handle_plan_output(out, &context.available_workers)
    }
}

// -- Envelope parsing -----------------------------------------------

#[derive(Debug, Deserialize)]
struct GeminiEnvelope {
    response: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

fn handle_plan_output(
    out: ChildOutput,
    available_workers: &[AgentKind],
) -> Result<Plan, AgentError> {
    if out.exit_code != Some(0) {
        return Err(classify_nonzero(out.exit_code, out.signal, &out.stderr));
    }
    // Gemini puts banner lines on stderr; the stdout payload itself
    // is clean JSON. Trim whitespace just in case.
    let envelope: GeminiEnvelope =
        serde_json::from_str(out.stdout.trim()).map_err(|e| AgentError::ParseFailed {
            reason: format!("envelope didn't match Gemini's --output-format json shape: {e}"),
            raw_output: out.stdout.clone(),
        })?;
    if let Some(err) = envelope.error {
        return Err(AgentError::TaskFailed { reason: err });
    }
    let body = envelope.response.ok_or_else(|| AgentError::ParseFailed {
        reason: "envelope had no `response` field".to_string(),
        raw_output: out.stdout.clone(),
    })?;
    parse_and_validate(&body, available_workers)
}

// -- Helpers ---------------------------------------------------------

fn format_commits(commits: &[super::CommitInfo]) -> String {
    if commits.is_empty() {
        return "(no commits on this branch)".to_string();
    }
    commits
        .iter()
        .map(|c| format!("- {} {} ({})", &c.sha[..c.sha.len().min(8)], c.subject, c.author))
        .collect::<Vec<_>>()
        .join("\n")
}

fn format_workers(workers: &[AgentKind]) -> String {
    if workers.is_empty() {
        return "(none)".to_string();
    }
    workers
        .iter()
        .map(|k| match k {
            AgentKind::Claude => "claude",
            AgentKind::Codex => "codex",
            AgentKind::Gemini => "gemini",
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn format_attempt_errors(errors: &[String]) -> String {
    if errors.is_empty() {
        return "(no error messages captured)".to_string();
    }
    errors
        .iter()
        .enumerate()
        .map(|(i, e)| format!("- attempt {}: {e}", i + 1))
        .collect::<Vec<_>>()
        .join("\n")
}

fn format_completed_summaries(summaries: &[String]) -> String {
    if summaries.is_empty() {
        return "(none yet — this is the first subtask to finish)".to_string();
    }
    summaries
        .iter()
        .map(|s| format!("- {s}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn summarize_last_lines(stdout: &str, n: usize) -> String {
    let lines: Vec<&str> = stdout
        .lines()
        .filter(|l| !l.trim().is_empty())
        .collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join(" ").trim().to_string()
}

/// Crude but effective: if the directory listing blows past the
/// budget, truncate at the nearest line break with a note so the
/// master knows what happened. Gemini's long-prompt failure mode is
/// silent degradation, not explicit error, so we'd rather cut early.
fn trim_tree_to_budget(tree: &str, budget: usize) -> String {
    if tree.len() <= budget {
        return tree.to_string();
    }
    let cutoff = tree[..budget]
        .rfind('\n')
        .unwrap_or(budget.min(tree.len()));
    let mut out = tree[..cutoff].to_string();
    out.push_str("\n... (directory tree truncated for prompt size)\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::{AgentKind, SubtaskState};

    fn ctx() -> PlanningContext {
        PlanningContext {
            repo_root: PathBuf::from("/tmp/repo"),
            directory_tree: "src/\n".to_string(),
            claude_md: None,
            agents_md: Some("# AGENTS.md\nRule".to_string()),
            gemini_md: None,
            recent_commits: vec![],
            available_workers: vec![AgentKind::Gemini],
        }
    }

    #[test]
    fn build_plan_prompt_interpolates_known_keys() {
        let p = GeminiAdapter::build_plan_prompt("task X", &ctx());
        assert!(p.contains("task X"));
        assert!(p.contains("# AGENTS.md"));
        assert!(!p.contains("{{"));
    }

    #[test]
    fn handle_plan_output_extracts_response_and_validates() {
        let envelope = r#"{
          "session_id":"s",
          "response":"prose\n```json\n{\"reasoning\":\"r\",\"subtasks\":[{\"title\":\"t\",\"why\":\"w\",\"assigned_worker\":\"gemini\",\"dependencies\":[]}]}\n```"
        }"#;
        let out = ChildOutput {
            stdout: envelope.to_string(),
            stderr: "YOLO mode is enabled.".to_string(),
            exit_code: Some(0),
            signal: None,
        };
        let plan = handle_plan_output(out, &[AgentKind::Gemini]).unwrap();
        assert_eq!(plan.subtasks.len(), 1);
    }

    #[test]
    fn handle_plan_output_surfaces_envelope_error_as_task_failed() {
        let out = ChildOutput {
            stdout: r#"{"error":"RESOURCE_EXHAUSTED"}"#.to_string(),
            stderr: String::new(),
            exit_code: Some(0),
            signal: None,
        };
        match handle_plan_output(out, &[AgentKind::Gemini]).unwrap_err() {
            AgentError::TaskFailed { reason } => assert_eq!(reason, "RESOURCE_EXHAUSTED"),
            e => panic!("expected TaskFailed, got {e:?}"),
        }
    }

    #[test]
    fn handle_plan_output_missing_response_is_parse_failed() {
        let out = ChildOutput {
            stdout: r#"{"session_id":"s"}"#.to_string(),
            stderr: String::new(),
            exit_code: Some(0),
            signal: None,
        };
        match handle_plan_output(out, &[AgentKind::Gemini]).unwrap_err() {
            AgentError::ParseFailed { reason, .. } => assert!(reason.contains("response")),
            e => panic!("expected ParseFailed, got {e:?}"),
        }
    }

    #[test]
    fn trim_tree_to_budget_keeps_small_tree_intact() {
        let tree = "a\nb\nc";
        assert_eq!(trim_tree_to_budget(tree, 100), tree);
    }

    #[test]
    fn trim_tree_to_budget_truncates_long_tree_at_newline() {
        let long = "a\n".repeat(50_000); // 100_000 chars
        let trimmed = trim_tree_to_budget(&long, 100);
        assert!(trimmed.len() <= 200);
        assert!(trimmed.contains("truncated"));
    }

    #[test]
    fn build_execute_prompt_scopes_to_worktree() {
        let subtask = Subtask {
            id: "s".into(),
            run_id: "r".into(),
            title: "Update README".into(),
            why: Some("missing section".into()),
            assigned_worker: AgentKind::Gemini,
            state: SubtaskState::Running,
            started_at: None,
            finished_at: None,
            error: None,
        };
        let p = GeminiAdapter::build_execute_prompt(&subtask, Path::new("/tmp/wt"), "notes", None);
        assert!(p.contains("/tmp/wt"));
        assert!(p.contains("Update README"));
        assert!(p.contains("missing section"));
        assert!(p.contains("outside this directory"));
        assert!(!p.contains("# Retry context"));
    }

    #[test]
    fn build_execute_prompt_appends_retry_context_when_present() {
        let subtask = Subtask {
            id: "s".into(),
            run_id: "r".into(),
            title: "Update README".into(),
            why: Some("missing section".into()),
            assigned_worker: AgentKind::Gemini,
            state: SubtaskState::Running,
            started_at: None,
            finished_at: None,
            error: None,
        };
        let p = GeminiAdapter::build_execute_prompt(
            &subtask,
            Path::new("/tmp/wt"),
            "notes",
            Some("Previous attempt failed with: RESOURCE_EXHAUSTED"),
        );
        assert!(p.contains("# Retry context"));
        assert!(p.contains("RESOURCE_EXHAUSTED"));
    }

    fn replan_ctx() -> ReplanContext {
        ReplanContext {
            original_task: "Update README".to_string(),
            repo_root: PathBuf::from("/tmp/repo"),
            failed_subtask_title: "Write intro".to_string(),
            failed_subtask_why: "explain the product".to_string(),
            attempt_errors: vec![
                "RESOURCE_EXHAUSTED".to_string(),
                "RESOURCE_EXHAUSTED".to_string(),
            ],
            worker_log_tail: "unable to reach model".to_string(),
            completed_subtask_summaries: vec![
                "Added tokens to tailwind config".to_string(),
            ],
            attempt_counter: 1,
            available_workers: vec![AgentKind::Gemini, AgentKind::Claude],
        }
    }

    #[test]
    fn build_replan_prompt_substitutes_fields_and_trims_log() {
        let p = GeminiAdapter::build_replan_prompt(&replan_ctx());
        assert!(!p.contains("{{"));
        assert!(p.contains("Update README"));
        assert!(p.contains("Write intro"));
        assert!(p.contains("attempt 1: RESOURCE_EXHAUSTED"));
        assert!(p.contains("unable to reach model"));
        assert!(p.contains("- Added tokens to tailwind config"));
        assert!(p.contains("attempt 1 of 2"));
        assert!(p.contains("gemini, claude"));
    }

    #[test]
    fn build_replan_prompt_trims_long_log_tail() {
        let mut ctx = replan_ctx();
        // Blow past PROMPT_CHAR_BUDGET to force trim.
        ctx.worker_log_tail = "L\n".repeat(PROMPT_CHAR_BUDGET);
        let p = GeminiAdapter::build_replan_prompt(&ctx);
        // Rendered prompt must be bounded; truncation marker present.
        assert!(p.contains("truncated"));
    }
}
