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
    classify_nonzero, git_changed_files, render_template, run_streaming, ChildOutput, RunSpec,
    DEFAULT_EXECUTE_TIMEOUT, DEFAULT_PLAN_TIMEOUT,
};
use super::prompts::{MASTER_CLAUDE, REPLAN_CLAUDE};
use super::tool_event::ToolEvent;
use super::{AgentError, AgentImpl, ExecutionResult, Plan, PlanningContext, ReplanContext};

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

    /// Render the master re-planning prompt. Same pattern as
    /// [`Self::build_plan_prompt`] — extracted so tests can verify the
    /// rendered text without spawning `claude`.
    pub fn build_replan_prompt(ctx: &ReplanContext) -> String {
        let attempt_errors = format_attempt_errors(&ctx.attempt_errors);
        let completed = format_completed_summaries(&ctx.completed_subtask_summaries);
        let workers = format_workers(&ctx.available_workers);
        let log_tail = if ctx.worker_log_tail.is_empty() {
            "(no log lines captured)".to_string()
        } else {
            ctx.worker_log_tail.clone()
        };
        let counter = ctx.attempt_counter.to_string();
        render_template(
            REPLAN_CLAUDE,
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

    /// Worker-side prompt: enough context to carry out one subtask
    /// without needing to ask follow-up questions.
    ///
    /// When `extra_context` is `Some`, it is appended as a final
    /// "# Retry context" block so the worker sees why the previous
    /// attempt failed before starting the new one.
    pub fn build_execute_prompt(
        subtask: &Subtask,
        worktree_path: &Path,
        shared_notes: &str,
        extra_context: Option<&str>,
    ) -> String {
        let why = subtask.why.as_deref().unwrap_or("(no rationale given)");
        let mut prompt = format!(
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
        extra_context: Option<&str>,
        log_tx: mpsc::Sender<String>,
        cancel: CancellationToken,
    ) -> Result<ExecutionResult, AgentError> {
        let prompt = Self::build_execute_prompt(subtask, worktree_path, shared_notes, extra_context);
        // Phase 6 Step 2: switch from `--print` plain text to
        // `--print --output-format stream-json --verbose` so the
        // dispatcher's parser tee can extract structured tool_use
        // events. `--verbose` is required when stream-json is set
        // (Claude CLI rejects the combo otherwise). Q&A detection
        // (Phase 5 Step 4) keys on `ExecutionResult.summary`; the
        // new envelope handler extracts the model's final text
        // reply from the `result` event so detection still fires
        // when the agent ends in `?`.
        let args = vec![
            "--print".into(),
            "--output-format".into(),
            "stream-json".into(),
            "--verbose".into(),
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
        let summary = extract_stream_json_summary(&out.stdout);
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
        // Same envelope as plan, same read-only permission mode — we
        // want Claude to think and emit text, not touch any files.
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
            cwd: None,
            stdin: Some(prompt.to_string()),
            timeout: DEFAULT_PLAN_TIMEOUT,
            log_tx: None,
            cancel,
        };
        let out = run_streaming(spec).await?;
        handle_summarize_output(out)
    }

    async fn replan(
        &self,
        context: ReplanContext,
        cancel: CancellationToken,
    ) -> Result<Plan, AgentError> {
        // Same subprocess envelope as `plan` — Claude's planning mode
        // is read-only, which is exactly what a replan needs. The only
        // thing that differs is the prompt.
        let prompt = Self::build_replan_prompt(&context);
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

/// Same envelope shape as the plan path, but no fenced-JSON extraction
/// — the `result` field *is* the model's free-form text response.
fn handle_summarize_output(out: ChildOutput) -> Result<String, AgentError> {
    if out.exit_code != Some(0) {
        return Err(classify_nonzero(out.exit_code, out.signal, &out.stderr));
    }
    let envelope: ClaudeEnvelope =
        serde_json::from_str(out.stdout.trim()).map_err(|e| AgentError::ParseFailed {
            reason: format!("envelope didn't match Claude's --output-format json shape: {e}"),
            raw_output: out.stdout.clone(),
        })?;
    if envelope.is_error {
        return Err(AgentError::TaskFailed {
            reason: envelope
                .subtype
                .unwrap_or_else(|| "claude reported is_error=true".to_string()),
        });
    }
    Ok(envelope.result.unwrap_or_default())
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

/// Phase 6 Step 2 — extract the model's final natural-language
/// reply from a stream-json transcript. The CLI's `result` event
/// (last NDJSON line in a clean run) carries the full reply text;
/// when absent (truncated stream / spawn failure) we fall through
/// to the last assistant text-content block. Q&A detection (Phase 5)
/// keys on this summary, so the trailing-? heuristic continues to
/// work even though the surrounding stdout is now structured JSON.
pub(crate) fn extract_stream_json_summary(stdout: &str) -> String {
    // Pass 1: prefer the explicit `result` event.
    for line in stdout.lines().rev() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        if value.get("type").and_then(|v| v.as_str()) == Some("result") {
            if let Some(result) = value.get("result").and_then(|v| v.as_str()) {
                return result.trim().to_string();
            }
        }
    }
    // Pass 2: last assistant text content as fallback.
    for line in stdout.lines().rev() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        if value.get("type").and_then(|v| v.as_str()) == Some("assistant") {
            if let Some(content) = value
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
            {
                for block in content.iter().rev() {
                    if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                        if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                            return text.trim().to_string();
                        }
                    }
                }
            }
        }
    }
    String::new()
}

/// Phase 6 Step 2 — parse one stream-json NDJSON line into zero or
/// one `ToolEvent`. Non-event lines (system, assistant text,
/// thinking, result) return `vec![]`; unknown tool kinds route to
/// `ToolEvent::Other` per the Step 0 escape-hatch contract.
///
/// Cost: one `serde_json::from_str` per line + a handful of field
/// lookups. Bounded sub-millisecond on typical lines (Step 0
/// diagnostic measurements).
pub fn parse_tool_events(line: &str) -> Vec<ToolEvent> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return vec![];
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
        return vec![];
    };
    let kind = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        // Top-level tool_use events appear in two shapes — either as
        // a bare `{"type":"tool_use", …}` line (older shape) or
        // wrapped in an assistant message's content blocks (current
        // shape). Handle both for robustness.
        "tool_use" => one_tool_event_from_object(&value).into_iter().collect(),
        "assistant" => {
            let Some(content) = value
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
            else {
                return vec![];
            };
            let mut out = Vec::new();
            for block in content {
                if block.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                    if let Some(ev) = one_tool_event_from_object(block) {
                        out.push(ev);
                    }
                }
            }
            out
        }
        _ => vec![],
    }
}

fn one_tool_event_from_object(obj: &serde_json::Value) -> Option<ToolEvent> {
    let name = obj.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let input = obj.get("input").cloned().unwrap_or(serde_json::Value::Null);
    Some(match name {
        "Read" => {
            let path = input.get("file_path").and_then(|v| v.as_str())?.to_string();
            let lines = match (
                input.get("offset").and_then(|v| v.as_u64()),
                input.get("limit").and_then(|v| v.as_u64()),
            ) {
                (Some(o), Some(l)) => Some((o as u32, (o + l) as u32)),
                _ => None,
            };
            ToolEvent::FileRead {
                path: PathBuf::from(path),
                lines,
            }
        }
        "Edit" | "Write" | "MultiEdit" => {
            let path = input.get("file_path").and_then(|v| v.as_str())?.to_string();
            let summary = if name == "Write" {
                "wrote file".to_string()
            } else if name == "MultiEdit" {
                input
                    .get("edits")
                    .and_then(|v| v.as_array())
                    .map(|a| format!("{} edits", a.len()))
                    .unwrap_or_else(|| "edited".to_string())
            } else {
                "edited".to_string()
            };
            ToolEvent::FileEdit {
                path: PathBuf::from(path),
                summary,
            }
        }
        "Bash" => {
            let command = input
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            ToolEvent::Bash { command }
        }
        "Grep" | "Glob" => {
            let query = input
                .get("pattern")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let paths = input
                .get("path")
                .and_then(|v| v.as_str())
                .map(|p| vec![PathBuf::from(p)])
                .unwrap_or_default();
            ToolEvent::Search { query, paths }
        }
        "" => return None,
        other => {
            // Escape hatch: capture the kind verbatim + a short
            // detail string so the UI shows something useful.
            let detail = input
                .as_object()
                .and_then(|m| m.iter().next())
                .map(|(k, v)| {
                    let val = v.as_str().unwrap_or(&v.to_string()[..]).chars().take(60).collect::<String>();
                    format!("{k}: {val}")
                })
                .unwrap_or_default();
            ToolEvent::Other {
                tool_name: other.to_string(),
                detail,
            }
        }
    })
}

/// Phase 6 Step 3 — extract thinking blocks from a stream-json
/// NDJSON line. Returns `None` for non-thinking lines. Step 3
/// surfaces these on an opt-in panel; Step 2 wires the parser tee.
pub fn parse_thinking(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(trimmed).ok()?;
    if value.get("type").and_then(|v| v.as_str()) == Some("thinking") {
        return value
            .get("thinking")
            .and_then(|v| v.as_str())
            .map(str::to_string);
    }
    None
}

fn summarize_last_lines(stdout: &str, n: usize) -> String {
    let lines: Vec<&str> = stdout
        .lines()
        .filter(|l| !l.trim().is_empty())
        .collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join(" ").trim().to_string()
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
        let prompt = ClaudeAdapter::build_execute_prompt(
            &subtask,
            Path::new("/tmp/wt"),
            "# shared notes",
            None,
        );
        assert!(prompt.contains("Write ThemeProvider"));
        assert!(prompt.contains("/tmp/wt"));
        assert!(prompt.contains("react context needed"));
        assert!(prompt.contains("# shared notes"));
        // No retry block when extra_context is None.
        assert!(!prompt.contains("# Retry context"));
    }

    #[test]
    fn build_execute_prompt_appends_retry_context_when_present() {
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
        let prompt = ClaudeAdapter::build_execute_prompt(
            &subtask,
            Path::new("/tmp/wt"),
            "# shared notes",
            Some("Previous attempt failed with: Timeout after 600s"),
        );
        assert!(prompt.contains("# Retry context"));
        assert!(prompt.contains("Timeout after 600s"));
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

    fn replan_ctx() -> ReplanContext {
        ReplanContext {
            original_task: "Add dark mode toggle".to_string(),
            repo_root: PathBuf::from("/tmp/repo"),
            failed_subtask_title: "Write ThemeProvider".to_string(),
            failed_subtask_why: "react context needed".to_string(),
            attempt_errors: vec![
                "Timeout after 600s".to_string(),
                "Timeout after 600s".to_string(),
            ],
            worker_log_tail: "last log line\nanother line".to_string(),
            completed_subtask_summaries: vec!["Added tailwind tokens".to_string()],
            attempt_counter: 1,
            available_workers: vec![AgentKind::Claude, AgentKind::Codex],
        }
    }

    #[test]
    fn build_replan_prompt_substitutes_all_fields() {
        let prompt = ClaudeAdapter::build_replan_prompt(&replan_ctx());
        // Every `{{var}}` resolves — no leaks.
        assert!(!prompt.contains("{{"));
        // Original task + failed subtask copy-through.
        assert!(prompt.contains("Add dark mode toggle"));
        assert!(prompt.contains("Write ThemeProvider"));
        assert!(prompt.contains("react context needed"));
        // Both attempt errors rendered as bullet lines.
        assert!(prompt.contains("attempt 1: Timeout after 600s"));
        assert!(prompt.contains("attempt 2: Timeout after 600s"));
        // Worker log tail inlined verbatim.
        assert!(prompt.contains("last log line"));
        // Completed summaries bulleted.
        assert!(prompt.contains("- Added tailwind tokens"));
        // Attempt counter surfaced for the model's calibration.
        assert!(prompt.contains("attempt 1 of 2"));
        // Workers allow-list rendered.
        assert!(prompt.contains("claude, codex"));
    }

    #[test]
    fn build_replan_prompt_handles_empty_completed_and_empty_log() {
        let mut ctx = replan_ctx();
        ctx.completed_subtask_summaries = vec![];
        ctx.worker_log_tail = String::new();
        let prompt = ClaudeAdapter::build_replan_prompt(&ctx);
        assert!(prompt.contains("(none yet"));
        assert!(prompt.contains("(no log lines captured)"));
    }

    #[test]
    fn format_attempt_errors_empty_falls_back() {
        assert_eq!(
            format_attempt_errors(&[]),
            "(no error messages captured)"
        );
    }
}
