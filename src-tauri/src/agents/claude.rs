//! Claude Code adapter.
//!
//! Claude Code (`claude` binary) is the most structured of the three
//! CLIs for our purposes — `--print --output-format json` wraps the
//! model's response in a predictable envelope, so the planning path
//! reduces to: invoke → parse envelope → extract fenced ```json block
//! from the `result` field → validate.
//!
//! For planning we run with `--permission-mode plan` (read-only), so
//! the master can't accidentally touch the tree while deciding how
//! to break the task up. Execution runs with
//! `--dangerously-skip-permissions`: each worker already lives in its
//! own git worktree (Step 6), so the blast radius is contained.

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde::Deserialize;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::ipc::AgentKind;
use crate::storage::models::Subtask;

use super::plan_parser::parse_and_validate;
use super::process::{
    classify_nonzero, render_template, run_streaming, ChildOutput, RunSpec,
    DEFAULT_EXECUTE_TIMEOUT, DEFAULT_PLAN_TIMEOUT,
};
use super::prompts::MASTER_CLAUDE;
use super::{AgentError, AgentImpl, ExecutionResult, Plan, PlanningContext};

pub struct ClaudeAdapter {
    binary: PathBuf,
    version: String,
}

impl ClaudeAdapter {
    pub fn new(binary: PathBuf, version: String) -> Self {
        Self { binary, version }
    }

    /// Render the master planning prompt with the supplied context.
    /// Extracted so tests can assert on the final text without
    /// actually spawning `claude`.
    pub fn build_plan_prompt(task: &str, ctx: &PlanningContext) -> String {
        let commits = format_commits(&ctx.recent_commits);
        let workers = format_workers(&ctx.available_workers);
        render_template(
            MASTER_CLAUDE,
            &[
                ("task", task),
                ("directory_tree", &ctx.directory_tree),
                ("claude_md", ctx.claude_md.as_deref().unwrap_or("")),
                ("agents_md", ctx.agents_md.as_deref().unwrap_or("")),
                ("gemini_md", ctx.gemini_md.as_deref().unwrap_or("")),
                ("recent_commits", &commits),
                ("available_workers", &workers),
            ],
        )
    }

    /// Worker-side prompt: enough context to carry out one subtask
    /// without needing to ask follow-up questions.
    pub fn build_execute_prompt(
        subtask: &Subtask,
        worktree_path: &Path,
        shared_notes: &str,
    ) -> String {
        let why = subtask.why.as_deref().unwrap_or("(no rationale given)");
        format!(
            "You are a WhaleCode worker running inside a git worktree at \
             {worktree_path}. Stay strictly within this directory — do \
             not touch files outside it.\n\n\
             # Subtask\n\
             **{title}**\n\n\
             Why: {why}\n\n\
             # Shared notes (read-only)\n\
             {shared_notes}\n\n\
             # Instructions\n\
             Carry out the subtask. Make minimal changes. When you're \
             done, summarize what you did in one or two sentences and \
             stop — don't ask for confirmation.\n",
            worktree_path = worktree_path.display(),
            title = subtask.title,
        )
    }
}

#[async_trait]
impl AgentImpl for ClaudeAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::Claude
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
            "--print".into(),
            "--output-format".into(),
            "json".into(),
            "--permission-mode".into(),
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
        log_tx: mpsc::Sender<String>,
        cancel: CancellationToken,
    ) -> Result<ExecutionResult, AgentError> {
        let prompt = Self::build_execute_prompt(subtask, worktree_path, shared_notes);
        let args = vec![
            "--print".into(),
            "--dangerously-skip-permissions".into(),
            "--add-dir".into(),
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
}

// -- Envelope parsing -----------------------------------------------
//
// The `--output-format json` envelope, whittled down to just the
// fields the adapter needs. Extra fields (usage, modelUsage, etc.)
// are ignored by serde.

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct ClaudeEnvelope {
    #[serde(rename = "type")]
    kind: String,
    subtype: Option<String>,
    is_error: bool,
    /// The actual response text. Contains the fenced ```json plan.
    result: Option<String>,
}

fn handle_plan_output(
    out: ChildOutput,
    available_workers: &[AgentKind],
) -> Result<Plan, AgentError> {
    if out.exit_code != Some(0) {
        return Err(classify_nonzero(out.exit_code, out.signal, &out.stderr));
    }
    let envelope: ClaudeEnvelope =
        serde_json::from_str(out.stdout.trim()).map_err(|e| AgentError::ParseFailed {
            reason: format!("envelope didn't match Claude's --output-format json shape: {e}"),
            raw_output: out.stdout.clone(),
        })?;
    if envelope.kind != "result" {
        return Err(AgentError::ParseFailed {
            reason: format!("unexpected envelope type {:?}", envelope.kind),
            raw_output: out.stdout.clone(),
        });
    }
    if envelope.is_error {
        return Err(AgentError::TaskFailed {
            reason: envelope
                .subtype
                .unwrap_or_else(|| "claude reported is_error=true".to_string()),
        });
    }
    let body = envelope.result.ok_or_else(|| AgentError::ParseFailed {
        reason: "envelope had no `result` field".to_string(),
        raw_output: out.stdout.clone(),
    })?;
    parse_and_validate(&body, available_workers)
}

// -- Formatting helpers ----------------------------------------------

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

fn summarize_last_lines(stdout: &str, n: usize) -> String {
    let lines: Vec<&str> = stdout
        .lines()
        .filter(|l| !l.trim().is_empty())
        .collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join(" ").trim().to_string()
}

async fn git_changed_files(worktree: &Path) -> Result<Vec<PathBuf>, std::io::Error> {
    let out = tokio::process::Command::new("git")
        .arg("status")
        .arg("--porcelain")
        .current_dir(worktree)
        .output()
        .await?;
    if !out.status.success() {
        return Ok(vec![]);
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    // porcelain format: two status chars, space, then path. Rename
    // lines have "orig -> new"; we take the "new" side.
    let mut files = Vec::new();
    for line in stdout.lines() {
        if line.len() < 4 {
            continue;
        }
        let path = &line[3..];
        let path = path.split(" -> ").last().unwrap_or(path);
        files.push(PathBuf::from(path.trim()));
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::{AgentKind, SubtaskState};

    fn ctx() -> PlanningContext {
        PlanningContext {
            repo_root: PathBuf::from("/tmp/repo"),
            directory_tree: "src/\ntests/".to_string(),
            claude_md: Some("# CLAUDE.md\nRule: do X".to_string()),
            agents_md: None,
            gemini_md: None,
            recent_commits: vec![super::super::CommitInfo {
                sha: "abcdef1234".to_string(),
                subject: "initial".to_string(),
                author: "alice".to_string(),
                when: "2025-01-01T00:00:00Z".to_string(),
            }],
            available_workers: vec![AgentKind::Claude, AgentKind::Codex],
        }
    }

    #[test]
    fn build_plan_prompt_substitutes_task_and_tree() {
        let prompt = ClaudeAdapter::build_plan_prompt("Add dark mode toggle", &ctx());
        assert!(prompt.contains("Add dark mode toggle"));
        assert!(prompt.contains("src/\ntests/"));
        assert!(prompt.contains("# CLAUDE.md"));
        assert!(prompt.contains("claude, codex"));
        assert!(prompt.contains("abcdef12 initial"));
    }

    #[test]
    fn build_plan_prompt_handles_missing_agents_md() {
        let prompt = ClaudeAdapter::build_plan_prompt("x", &ctx());
        // No `{{agents_md}}` leak — substitution collapses to empty.
        assert!(!prompt.contains("{{"));
    }

    #[test]
    fn build_execute_prompt_includes_subtask_and_path() {
        let subtask = Subtask {
            id: "st1".into(),
            run_id: "r1".into(),
            title: "Write ThemeProvider".into(),
            why: Some("react context needed".into()),
            assigned_worker: AgentKind::Claude,
            state: SubtaskState::Running,
            started_at: None,
            finished_at: None,
            error: None,
        };
        let prompt =
            ClaudeAdapter::build_execute_prompt(&subtask, Path::new("/tmp/wt"), "# shared notes");
        assert!(prompt.contains("Write ThemeProvider"));
        assert!(prompt.contains("/tmp/wt"));
        assert!(prompt.contains("react context needed"));
        assert!(prompt.contains("# shared notes"));
    }

    #[test]
    fn handle_plan_output_parses_envelope_and_extracts_fenced_plan() {
        let envelope = r#"{
            "type":"result",
            "subtype":"success",
            "is_error":false,
            "result":"some prose\n```json\n{\"reasoning\":\"r\",\"subtasks\":[{\"title\":\"t\",\"why\":\"w\",\"assigned_worker\":\"claude\",\"dependencies\":[]}]}\n```"
        }"#;
        let out = ChildOutput {
            stdout: envelope.to_string(),
            stderr: String::new(),
            exit_code: Some(0),
            signal: None,
        };
        let plan = handle_plan_output(out, &[AgentKind::Claude]).unwrap();
        assert_eq!(plan.subtasks.len(), 1);
    }

    #[test]
    fn handle_plan_output_surfaces_is_error_as_task_failed() {
        let envelope = r#"{"type":"result","subtype":"content_policy","is_error":true,"result":""}"#;
        let out = ChildOutput {
            stdout: envelope.to_string(),
            stderr: String::new(),
            exit_code: Some(0),
            signal: None,
        };
        match handle_plan_output(out, &[AgentKind::Claude]).unwrap_err() {
            AgentError::TaskFailed { reason } => assert_eq!(reason, "content_policy"),
            e => panic!("expected TaskFailed, got {e:?}"),
        }
    }

    #[test]
    fn handle_plan_output_non_zero_exit_is_classified() {
        let out = ChildOutput {
            stdout: String::new(),
            stderr: "stack trace line".to_string(),
            exit_code: Some(1),
            signal: None,
        };
        match handle_plan_output(out, &[AgentKind::Claude]).unwrap_err() {
            AgentError::ProcessCrashed { exit_code, .. } => assert_eq!(exit_code, Some(1)),
            e => panic!("expected ProcessCrashed, got {e:?}"),
        }
    }

    #[test]
    fn handle_plan_output_malformed_envelope_is_parse_failed() {
        let out = ChildOutput {
            stdout: "not json".to_string(),
            stderr: String::new(),
            exit_code: Some(0),
            signal: None,
        };
        match handle_plan_output(out, &[AgentKind::Claude]).unwrap_err() {
            AgentError::ParseFailed { raw_output, .. } => assert_eq!(raw_output, "not json"),
            e => panic!("expected ParseFailed, got {e:?}"),
        }
    }

    #[test]
    fn summarize_last_lines_picks_trailing_non_empty() {
        let s = "line one\n\nline two\nline three\n\n";
        assert_eq!(summarize_last_lines(s, 2), "line two line three");
    }
}
