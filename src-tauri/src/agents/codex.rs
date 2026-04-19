//! Codex CLI adapter.
//!
//! Codex (`codex` binary, run as `codex exec`) emits JSONL events when
//! passed `--json`. The event we care about is the last
//! `{"type":"item.completed","item":{"type":"agent_message","text":...}}`
//! — that `text` field contains the model's final response, where our
//! fenced ```json plan block lives.
//!
//! Planning runs with `--sandbox read-only` (master shouldn't write
//! while deciding how to split work). Execution runs with
//! `--full-auto` (workspace-write sandbox, auto-approved), which is
//! the right scope for a worker confined to its worktree.

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
use super::prompts::MASTER_CODEX;
use super::{AgentError, AgentImpl, ExecutionResult, Plan, PlanningContext};

pub struct CodexAdapter {
    binary: PathBuf,
    version: String,
}

impl CodexAdapter {
    pub fn new(binary: PathBuf, version: String) -> Self {
        Self { binary, version }
    }

    pub fn build_plan_prompt(task: &str, ctx: &PlanningContext) -> String {
        let commits = format_commits(&ctx.recent_commits);
        let workers = format_workers(&ctx.available_workers);
        render_template(
            MASTER_CODEX,
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

    pub fn build_execute_prompt(
        subtask: &Subtask,
        worktree_path: &Path,
        shared_notes: &str,
        extra_context: Option<&str>,
    ) -> String {
        let why = subtask.why.as_deref().unwrap_or("(no rationale given)");
        let mut prompt = format!(
            "You are a WhaleCode worker. Working directory: {worktree_path}. \
             All edits must stay inside this directory.\n\n\
             # Subtask\n**{title}**\n\nWhy: {why}\n\n\
             # Shared notes (read-only)\n{shared_notes}\n\n\
             # Instructions\n\
             Complete the subtask with minimal edits. Summarize what \
             changed in one or two sentences and stop.\n",
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
}

#[async_trait]
impl AgentImpl for CodexAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::Codex
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
            "exec".into(),
            "--json".into(),
            "--skip-git-repo-check".into(),
            "--sandbox".into(),
            "read-only".into(),
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
            "exec".into(),
            "--json".into(),
            "--full-auto".into(),
            "-C".into(),
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
        let summary = last_agent_message(&out.stdout)
            .unwrap_or_else(|| "(no final message emitted)".to_string());
        let summary = summary
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("")
            .trim()
            .to_string();
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
        // Read-only sandbox — no files should change during a notes
        // consolidation.
        let args = vec![
            "exec".into(),
            "--json".into(),
            "--skip-git-repo-check".into(),
            "--sandbox".into(),
            "read-only".into(),
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
        last_agent_message(&out.stdout).ok_or_else(|| AgentError::ParseFailed {
            reason: "no `item.completed` agent_message event in Codex JSONL stream".to_string(),
            raw_output: out.stdout.clone(),
        })
    }
}

// -- JSONL envelope parsing ------------------------------------------

/// Return the text of the **last** `item.completed` event whose item
/// is an `agent_message`. That's where Codex puts the final response.
/// Earlier messages (tool calls, intermediate reasoning) are ignored.
fn last_agent_message(jsonl: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct Event {
        #[serde(rename = "type")]
        kind: String,
        item: Option<Item>,
    }
    #[derive(Deserialize)]
    struct Item {
        #[serde(rename = "type")]
        kind: String,
        text: Option<String>,
    }

    let mut last = None;
    for line in jsonl.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(ev) = serde_json::from_str::<Event>(line) else {
            continue;
        };
        if ev.kind == "item.completed" {
            if let Some(item) = ev.item {
                if item.kind == "agent_message" {
                    if let Some(text) = item.text {
                        last = Some(text);
                    }
                }
            }
        }
    }
    last
}

fn handle_plan_output(
    out: ChildOutput,
    available_workers: &[AgentKind],
) -> Result<Plan, AgentError> {
    if out.exit_code != Some(0) {
        return Err(classify_nonzero(out.exit_code, out.signal, &out.stderr));
    }
    let body = last_agent_message(&out.stdout).ok_or_else(|| AgentError::ParseFailed {
        reason: "no `item.completed` agent_message event in Codex JSONL stream".to_string(),
        raw_output: out.stdout.clone(),
    })?;
    parse_and_validate(&body, available_workers)
}

// -- Formatting helpers (duplicated from claude.rs; see below) -------
//
// I considered hoisting these into process.rs, but they're
// presentation concerns that each adapter might tweak over time
// (Codex plans might benefit from a more verbose commit line once we
// see how it handles hashes, for instance). Five lines of duplication
// is cheaper than a premature abstraction.

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::{AgentKind, SubtaskState};

    fn ctx() -> PlanningContext {
        PlanningContext {
            repo_root: PathBuf::from("/tmp/repo"),
            directory_tree: "src/\n".to_string(),
            claude_md: None,
            agents_md: None,
            gemini_md: None,
            recent_commits: vec![],
            available_workers: vec![AgentKind::Codex],
        }
    }

    #[test]
    fn build_plan_prompt_includes_task_and_workers() {
        let p = CodexAdapter::build_plan_prompt("ship feature X", &ctx());
        assert!(p.contains("ship feature X"));
        assert!(p.contains("codex"));
        // No unsubstituted placeholders leak through.
        assert!(!p.contains("{{"));
    }

    #[test]
    fn last_agent_message_returns_final_item_text() {
        let jsonl = r#"{"type":"thread.started","thread_id":"x"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"first"}}
{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"final answer"}}
{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}"#;
        assert_eq!(last_agent_message(jsonl).unwrap(), "final answer");
    }

    #[test]
    fn last_agent_message_ignores_non_agent_items() {
        let jsonl = r#"{"type":"item.completed","item":{"id":"x","type":"tool_call","text":"unused"}}
{"type":"item.completed","item":{"id":"y","type":"agent_message","text":"the one"}}"#;
        assert_eq!(last_agent_message(jsonl).unwrap(), "the one");
    }

    #[test]
    fn last_agent_message_none_when_absent() {
        let jsonl = r#"{"type":"turn.started"}
{"type":"turn.completed"}"#;
        assert!(last_agent_message(jsonl).is_none());
    }

    #[test]
    fn last_agent_message_tolerates_malformed_lines() {
        // Non-JSON warning from Codex's own stderr sometimes bleeds
        // into stdout; the parser must skip it rather than fail.
        let jsonl = r#"WARNING: something
{"type":"item.completed","item":{"id":"y","type":"agent_message","text":"ok"}}"#;
        assert_eq!(last_agent_message(jsonl).unwrap(), "ok");
    }

    #[test]
    fn handle_plan_output_happy_path() {
        let agent_text = "prose\n```json\n{\"reasoning\":\"r\",\"subtasks\":[{\"title\":\"t\",\"why\":\"w\",\"assigned_worker\":\"codex\",\"dependencies\":[]}]}\n```";
        let escaped = agent_text.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n");
        let jsonl = format!(
            r#"{{"type":"item.completed","item":{{"id":"x","type":"agent_message","text":"{escaped}"}}}}"#
        );
        let out = ChildOutput {
            stdout: jsonl,
            stderr: String::new(),
            exit_code: Some(0),
            signal: None,
        };
        let plan = handle_plan_output(out, &[AgentKind::Codex]).unwrap();
        assert_eq!(plan.subtasks.len(), 1);
        assert_eq!(plan.subtasks[0].assigned_worker, AgentKind::Codex);
    }

    #[test]
    fn handle_plan_output_no_agent_message_is_parse_failed() {
        let out = ChildOutput {
            stdout: r#"{"type":"turn.started"}
{"type":"turn.completed"}"#
                .to_string(),
            stderr: String::new(),
            exit_code: Some(0),
            signal: None,
        };
        match handle_plan_output(out, &[AgentKind::Codex]).unwrap_err() {
            AgentError::ParseFailed { reason, .. } => assert!(reason.contains("agent_message")),
            e => panic!("expected ParseFailed, got {e:?}"),
        }
    }

    #[test]
    fn build_execute_prompt_pins_worktree_scope() {
        let subtask = Subtask {
            id: "s".into(),
            run_id: "r".into(),
            title: "Add handler".into(),
            why: Some("new route".into()),
            assigned_worker: AgentKind::Codex,
            state: SubtaskState::Running,
            started_at: None,
            finished_at: None,
            error: None,
        };
        let p = CodexAdapter::build_execute_prompt(&subtask, Path::new("/tmp/wt"), "notes", None);
        assert!(p.contains("/tmp/wt"));
        assert!(p.contains("stay inside this directory"));
        assert!(p.contains("Add handler"));
        assert!(!p.contains("# Retry context"));
    }

    #[test]
    fn build_execute_prompt_appends_retry_context_when_present() {
        let subtask = Subtask {
            id: "s".into(),
            run_id: "r".into(),
            title: "Add handler".into(),
            why: Some("new route".into()),
            assigned_worker: AgentKind::Codex,
            state: SubtaskState::Running,
            started_at: None,
            finished_at: None,
            error: None,
        };
        let p = CodexAdapter::build_execute_prompt(
            &subtask,
            Path::new("/tmp/wt"),
            "notes",
            Some("Previous attempt failed with: parse error"),
        );
        assert!(p.contains("# Retry context"));
        assert!(p.contains("parse error"));
    }
}
