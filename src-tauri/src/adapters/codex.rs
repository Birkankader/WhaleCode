// Codex CLI adapter: NDJSON parsing, command building, failure detection, rate limit detection
//
// Uses real Codex CLI v0.111.0 JSONL format with --json flag:
// thread.started, turn.started, item.completed, turn.completed events.

use serde::Deserialize;

use super::{
    ToolAdapter, ToolCommand,
    RateLimitInfo as SharedRateLimitInfo, RetryPolicy as SharedRetryPolicy,
    Question, QuestionType, DisplayLine, DisplayLineType,
};

// ---------------------------------------------------------------------------
// NDJSON Event Types (real Codex CLI format)
// ---------------------------------------------------------------------------

/// Represents a single line from Codex CLI's JSONL output (--json mode).
/// Uses serde tagged enum on the `type` field. All inner fields are `Option<T>` for
/// resilient parsing — the exact schema may vary across CLI versions.
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum CodexStreamEvent {
    #[serde(rename = "thread.started")]
    ThreadStarted {
        thread_id: Option<String>,
    },

    #[serde(rename = "turn.started")]
    TurnStarted {},

    #[serde(rename = "item.completed")]
    ItemCompleted {
        item: Option<CodexItem>,
    },

    #[serde(rename = "turn.completed")]
    TurnCompleted {
        usage: Option<CodexUsage>,
    },
}

/// An item within an item.completed event.
#[derive(Debug, Deserialize)]
pub struct CodexItem {
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub item_type: Option<String>,
    pub text: Option<String>,
    // tool_use fields
    pub function_name: Option<String>,
    pub arguments: Option<serde_json::Value>,
    // tool_result fields
    pub output: Option<String>,
    pub status: Option<String>,
}

/// Usage/statistics from a Codex CLI turn.completed event.
#[derive(Debug, Deserialize)]
pub struct CodexUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
}

// ---------------------------------------------------------------------------
// Command Builder
// ---------------------------------------------------------------------------

/// Holds the fully resolved command, args, env vars, and working directory
/// needed to spawn a Codex CLI subprocess.
pub struct CodexCommand {
    pub cmd: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: String,
}

/// Build the environment variable list for Codex CLI.
/// Always includes NO_COLOR=1; adds OPENAI_API_KEY when non-empty.
fn build_env(api_key: &str) -> Vec<(String, String)> {
    let mut env = vec![("NO_COLOR".to_string(), "1".to_string())];
    if !api_key.is_empty() {
        env.push(("OPENAI_API_KEY".to_string(), api_key.to_string()));
    }
    env
}

/// Build the CLI command for spawning Codex CLI in non-interactive mode.
///
/// SECURITY: The `api_key` is stored in `env` only — it is never included
/// in args or logged.
///
/// Uses `codex exec --full-auto --json` for headless tool execution with JSONL output.
pub fn build_command(prompt: &str, cwd: &str, api_key: &str) -> CodexCommand {
    CodexCommand {
        cmd: "codex".to_string(),
        args: vec![
            "exec".to_string(),
            "--full-auto".to_string(),
            "--json".to_string(),
            prompt.to_string(),
        ],
        env: build_env(api_key),
        cwd: cwd.to_string(),
    }
}

// ---------------------------------------------------------------------------
// NDJSON Parser
// ---------------------------------------------------------------------------

/// Parse a single line from Codex CLI's NDJSON output stream.
/// Returns `None` for non-JSON lines (expected per Pitfall 5 in research).
pub fn parse_stream_line(line: &str) -> Option<CodexStreamEvent> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    serde_json::from_str(trimmed).ok()
}

// ---------------------------------------------------------------------------
// Result Validator
// ---------------------------------------------------------------------------

/// Validate a result event from Codex CLI for silent failures.
pub fn validate_result(event: &CodexStreamEvent) -> Result<(), String> {
    match event {
        CodexStreamEvent::TurnCompleted { usage } => {
            if usage.is_none() {
                return Err("Codex CLI turn completed without usage data".to_string());
            }
            Ok(())
        }
        CodexStreamEvent::ItemCompleted { item } => {
            let item = item.as_ref().ok_or("Empty item in item.completed")?;
            if item.item_type.as_deref() == Some("agent_message") {
                if item.text.as_ref().map_or(true, |t| t.trim().is_empty()) {
                    return Err("Codex CLI returned empty agent message".to_string());
                }
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// Rate Limit Detector
// ---------------------------------------------------------------------------

/// Information about a detected rate limit.
#[allow(dead_code)]
// ---------------------------------------------------------------------------
// Rate Limiting — uses shared RateLimitInfo from adapters::mod
// ---------------------------------------------------------------------------

/// Detect rate-limit or quota errors in a stderr/stdout line.
/// OpenAI/Codex-specific patterns: 429, rate_limit, Too Many Requests, insufficient_quota.
pub(crate) fn detect_rate_limit_codex(line: &str) -> Option<super::RateLimitInfo> {
    let lower = line.to_lowercase();
    if lower.contains("429")
        || lower.contains("rate_limit")
        || lower.contains("too many requests")
        || lower.contains("insufficient_quota")
    {
        Some(super::RateLimitInfo {
            retry_after_secs: None,
        })
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// ToolAdapter Implementation
// ---------------------------------------------------------------------------

/// Zero-cost unit struct for polymorphic adapter dispatch.
pub struct CodexAdapter;

impl ToolAdapter for CodexAdapter {
    fn build_command(&self, prompt: &str, cwd: &str, api_key: &str) -> ToolCommand {
        let c = build_command(prompt, cwd, api_key);
        ToolCommand {
            cmd: c.cmd,
            args: c.args,
            env: c.env,
            cwd: c.cwd,
        }
    }

    fn parse_stream_line(&self, line: &str) -> Option<String> {
        parse_stream_line(line).map(|_| line.trim().to_string())
    }

    fn validate_result_json(&self, result_json: &str) -> Result<(), String> {
        let event = parse_stream_line(result_json)
            .ok_or_else(|| "Failed to parse Codex result JSON".to_string())?;
        validate_result(&event)
    }

    fn detect_rate_limit(&self, line: &str) -> Option<SharedRateLimitInfo> {
        detect_rate_limit_codex(line)
    }

    fn retry_policy(&self) -> SharedRetryPolicy {
        SharedRetryPolicy {
            max_retries: 3,
            base_delay_ms: 5_000,
            max_delay_ms: 60_000,
        }
    }

    fn name(&self) -> &str {
        "Codex CLI"
    }

    fn build_interactive_command(&self, cwd: &str, api_key: &str) -> ToolCommand {
        ToolCommand {
            cmd: "codex".to_string(),
            args: vec![
                "--full-auto".to_string(),
                "--json".to_string(),
            ],
            env: build_env(api_key),
            cwd: cwd.to_string(),
        }
    }

    fn detect_question(&self, line: &str) -> Option<Question> {
        let event = parse_stream_line(line)?;
        match event {
            CodexStreamEvent::ItemCompleted { item } => {
                let item = item?;
                if item.item_type.as_deref() != Some("agent_message") { return None; }
                let text = item.text?;
                if text.contains("[QUESTION]") || text.contains("[ASK]") {
                    let qtype = QuestionType::from_text(&text);
                    Some(Question {
                        source_agent: "codex".to_string(),
                        content: text,
                        question_type: qtype,
                    })
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    fn parse_display_output(&self, line: &str) -> Option<DisplayLine> {
        let event = parse_stream_line(line)?;
        match event {
            CodexStreamEvent::ItemCompleted { item } => {
                let item = item?;
                match item.item_type.as_deref() {
                    Some("agent_message") => {
                        let text = item.text?;
                        if text.is_empty() { return None; }
                        Some(DisplayLine { content: text, line_type: DisplayLineType::AgentThinking })
                    }
                    Some("tool_use") => {
                        let name = item.function_name.unwrap_or_else(|| "unknown".to_string());
                        let args = item.arguments.map(|v| serde_json::to_string(&v).unwrap_or_default()).unwrap_or_default();
                        Some(DisplayLine { content: format!("[{}] {}", name, args), line_type: DisplayLineType::ToolExecution })
                    }
                    Some("tool_result") => {
                        let content = item.output.unwrap_or_default();
                        if content.is_empty() { return None; }
                        Some(DisplayLine { content, line_type: DisplayLineType::Result })
                    }
                    _ => None,
                }
            }
            CodexStreamEvent::TurnCompleted { usage } => {
                let u = usage?;
                let input = u.input_tokens.unwrap_or(0);
                let output = u.output_tokens.unwrap_or(0);
                Some(DisplayLine {
                    content: format!("Turn complete ({}in/{}out tokens)", input, output),
                    line_type: DisplayLineType::Result,
                })
            }
            _ => None,
        }
    }

    fn extract_result(&self, output_lines: &[String]) -> Option<String> {
        // Find last agent_message text
        for line in output_lines.iter().rev() {
            if let Some(event) = parse_stream_line(line) {
                if let CodexStreamEvent::ItemCompleted { item: Some(item) } = event {
                    if item.item_type.as_deref() == Some("agent_message") {
                        return item.text;
                    }
                }
            }
        }
        None
    }

    fn is_turn_complete(&self, line: &str) -> bool {
        matches!(parse_stream_line(line), Some(CodexStreamEvent::TurnCompleted { .. }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // Event Parsing Tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_parse_thread_started_event() {
        let line = r#"{"type":"thread.started","thread_id":"abc"}"#;
        let event = parse_stream_line(line);
        assert!(event.is_some(), "Expected Some for thread.started event");
        match event.unwrap() {
            CodexStreamEvent::ThreadStarted { thread_id } => {
                assert_eq!(thread_id, Some("abc".to_string()));
            }
            other => panic!("Expected ThreadStarted, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_turn_started_event() {
        let line = r#"{"type":"turn.started"}"#;
        let event = parse_stream_line(line);
        assert!(event.is_some(), "Expected Some for turn.started event");
        assert!(matches!(event.unwrap(), CodexStreamEvent::TurnStarted {}));
    }

    #[test]
    fn test_parse_item_completed_agent_message() {
        let line = r#"{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Hello"}}"#;
        let event = parse_stream_line(line);
        assert!(event.is_some(), "Expected Some for item.completed event");
        match event.unwrap() {
            CodexStreamEvent::ItemCompleted { item } => {
                let item = item.unwrap();
                assert_eq!(item.item_type, Some("agent_message".to_string()));
                assert_eq!(item.text, Some("Hello".to_string()));
            }
            other => panic!("Expected ItemCompleted, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_item_completed_tool_use() {
        let line = r#"{"type":"item.completed","item":{"id":"i2","type":"tool_use","function_name":"Bash","arguments":{"command":"ls"}}}"#;
        let event = parse_stream_line(line);
        assert!(event.is_some(), "Expected Some for item.completed tool_use");
        match event.unwrap() {
            CodexStreamEvent::ItemCompleted { item } => {
                let item = item.unwrap();
                assert_eq!(item.item_type, Some("tool_use".to_string()));
                assert_eq!(item.function_name, Some("Bash".to_string()));
                assert!(item.arguments.is_some());
            }
            other => panic!("Expected ItemCompleted, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_item_completed_tool_result() {
        let line = r#"{"type":"item.completed","item":{"id":"i3","type":"tool_result","output":"file.txt","status":"success"}}"#;
        let event = parse_stream_line(line);
        assert!(event.is_some(), "Expected Some for item.completed tool_result");
        match event.unwrap() {
            CodexStreamEvent::ItemCompleted { item } => {
                let item = item.unwrap();
                assert_eq!(item.item_type, Some("tool_result".to_string()));
                assert_eq!(item.output, Some("file.txt".to_string()));
                assert_eq!(item.status, Some("success".to_string()));
            }
            other => panic!("Expected ItemCompleted, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_turn_completed_event() {
        let line = r#"{"type":"turn.completed","usage":{"input_tokens":200,"output_tokens":300,"cached_input_tokens":50}}"#;
        let event = parse_stream_line(line);
        assert!(event.is_some(), "Expected Some for turn.completed event");
        match event.unwrap() {
            CodexStreamEvent::TurnCompleted { usage } => {
                let u = usage.unwrap();
                assert_eq!(u.input_tokens, Some(200));
                assert_eq!(u.output_tokens, Some(300));
                assert_eq!(u.cached_input_tokens, Some(50));
            }
            other => panic!("Expected TurnCompleted, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_non_json_line_returns_none() {
        let line = "Starting Codex CLI...";
        assert!(parse_stream_line(line).is_none());
    }

    #[test]
    fn test_parse_empty_line_returns_none() {
        assert!(parse_stream_line("").is_none());
    }

    // -----------------------------------------------------------------------
    // Validation Tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_validate_turn_completed_success() {
        let event = CodexStreamEvent::TurnCompleted {
            usage: Some(CodexUsage {
                input_tokens: Some(100),
                output_tokens: Some(50),
                cached_input_tokens: None,
            }),
        };
        assert!(validate_result(&event).is_ok());
    }

    #[test]
    fn test_validate_turn_completed_no_usage() {
        let event = CodexStreamEvent::TurnCompleted { usage: None };
        let err = validate_result(&event);
        assert!(err.is_err());
        assert!(err.unwrap_err().contains("without usage data"));
    }

    #[test]
    fn test_validate_item_completed_agent_message_success() {
        let event = CodexStreamEvent::ItemCompleted {
            item: Some(CodexItem {
                id: Some("i1".to_string()),
                item_type: Some("agent_message".to_string()),
                text: Some("Task completed".to_string()),
                function_name: None, arguments: None, output: None, status: None,
            }),
        };
        assert!(validate_result(&event).is_ok());
    }

    #[test]
    fn test_validate_item_completed_empty_message() {
        let event = CodexStreamEvent::ItemCompleted {
            item: Some(CodexItem {
                id: Some("i1".to_string()),
                item_type: Some("agent_message".to_string()),
                text: Some("".to_string()),
                function_name: None, arguments: None, output: None, status: None,
            }),
        };
        let err = validate_result(&event);
        assert!(err.is_err());
        assert!(err.unwrap_err().contains("empty agent message"));
    }

    #[test]
    fn test_validate_item_completed_no_item() {
        let event = CodexStreamEvent::ItemCompleted { item: None };
        let err = validate_result(&event);
        assert!(err.is_err());
        assert!(err.unwrap_err().contains("Empty item"));
    }

    #[test]
    fn test_validate_thread_started_ok() {
        let event = CodexStreamEvent::ThreadStarted { thread_id: Some("abc".to_string()) };
        assert!(validate_result(&event).is_ok());
    }

    // -----------------------------------------------------------------------
    // Rate Limit Detection Tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_detect_rate_limit_429() {
        let info = super::detect_rate_limit_codex("Error: 429 Too Many Requests");
        assert!(info.is_some(), "Expected rate limit detection for 429");
    }

    #[test]
    fn test_detect_rate_limit_rate_limit_string() {
        let info = super::detect_rate_limit_codex("rate_limit exceeded");
        assert!(info.is_some(), "Expected rate limit detection for rate_limit");
    }

    #[test]
    fn test_detect_rate_limit_too_many_requests() {
        let info = super::detect_rate_limit_codex("Too Many Requests, please retry later");
        assert!(info.is_some(), "Expected rate limit detection for Too Many Requests");
    }

    #[test]
    fn test_detect_rate_limit_insufficient_quota() {
        let info = super::detect_rate_limit_codex("insufficient_quota: you have exceeded your usage limit");
        assert!(info.is_some(), "Expected rate limit detection for insufficient_quota");
    }

    #[test]
    fn test_detect_rate_limit_normal_line() {
        let info = super::detect_rate_limit_codex("Processing your request...");
        assert!(info.is_none(), "Expected None for normal line");
    }

    // -----------------------------------------------------------------------
    // Command Builder Tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_build_command_produces_correct_args() {
        let cmd = build_command("write hello world", "/tmp/project", "sk-key-123");
        assert_eq!(cmd.cmd, "codex");
        assert!(cmd.args.contains(&"exec".to_string()));
        assert!(cmd.args.contains(&"write hello world".to_string()));
        assert!(cmd.args.contains(&"--full-auto".to_string()));
        assert!(cmd.args.contains(&"--json".to_string()));
    }

    #[test]
    fn test_build_command_env_has_openai_key() {
        let cmd = build_command("test", "/tmp", "sk-my-api-key");
        let key_env = cmd.env.iter().find(|(k, _)| k == "OPENAI_API_KEY");
        assert!(key_env.is_some(), "Expected OPENAI_API_KEY in env");
        assert_eq!(key_env.unwrap().1, "sk-my-api-key");
    }

    #[test]
    fn test_build_command_env_has_no_color() {
        let cmd = build_command("test", "/tmp", "key");
        let no_color = cmd.env.iter().find(|(k, _)| k == "NO_COLOR");
        assert!(no_color.is_some(), "Expected NO_COLOR in env");
        assert_eq!(no_color.unwrap().1, "1");
    }

    #[test]
    fn test_build_command_cwd() {
        let cmd = build_command("test", "/home/user/project", "key");
        assert_eq!(cmd.cwd, "/home/user/project");
    }

    // -----------------------------------------------------------------------
    // Retry Policy Tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_retry_policy_default_codex() {
        let policy = super::super::RetryPolicy { max_retries: 3, base_delay_ms: 5_000, max_delay_ms: 60_000 };
        assert_eq!(policy.max_retries, 3);
        assert_eq!(policy.base_delay_ms, 5_000);
        assert_eq!(policy.max_delay_ms, 60_000);
    }

    #[test]
    fn test_retry_policy_delay_doubles() {
        let policy = super::super::RetryPolicy { max_retries: 3, base_delay_ms: 5_000, max_delay_ms: 60_000 };
        let d0 = policy.delay_for_attempt(0); // 5000
        let d1 = policy.delay_for_attempt(1); // 10000
        let d2 = policy.delay_for_attempt(2); // 20000
        assert_eq!(d0, 5_000);
        assert_eq!(d1, 10_000);
        assert_eq!(d2, 20_000);
    }

    #[test]
    fn test_retry_policy_delay_capped_at_max() {
        let policy = super::super::RetryPolicy { max_retries: 3, base_delay_ms: 5_000, max_delay_ms: 60_000 };
        let d10 = policy.delay_for_attempt(10); // would be huge, capped at 60000
        assert_eq!(d10, 60_000);
    }

    // -----------------------------------------------------------------------
    // ToolAdapter Trait Method Tests
    // -----------------------------------------------------------------------

    use super::super::ToolAdapter;

    #[test]
    fn test_build_interactive_command_no_prompt_flag() {
        let adapter = CodexAdapter;
        let cmd = adapter.build_interactive_command("/tmp/project", "sk-key");
        assert_eq!(cmd.cmd, "codex");
        // Must NOT contain -p or exec (interactive mode, not exec mode)
        assert!(!cmd.args.contains(&"-p".to_string()));
        assert!(!cmd.args.contains(&"exec".to_string()));
        // Must contain --full-auto and --json
        assert!(cmd.args.contains(&"--full-auto".to_string()));
        assert!(cmd.args.contains(&"--json".to_string()));
    }

    #[test]
    fn test_build_interactive_command_env() {
        let adapter = CodexAdapter;
        let cmd = adapter.build_interactive_command("/tmp", "sk-key-123");
        let key_env = cmd.env.iter().find(|(k, _)| k == "OPENAI_API_KEY");
        assert!(key_env.is_some());
        assert_eq!(key_env.unwrap().1, "sk-key-123");
        assert_eq!(cmd.cwd, "/tmp");
    }

    #[test]
    fn test_build_interactive_command_empty_key() {
        let adapter = CodexAdapter;
        let cmd = adapter.build_interactive_command("/tmp", "");
        let key_env = cmd.env.iter().find(|(k, _)| k == "OPENAI_API_KEY");
        assert!(key_env.is_none());
    }

    #[test]
    fn test_detect_question_with_question_tag() {
        let adapter = CodexAdapter;
        let line = r#"{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"[QUESTION] Which schema to use?"}}"#;
        let q = adapter.detect_question(line);
        assert!(q.is_some());
        let q = q.unwrap();
        assert_eq!(q.source_agent, "codex");
        assert!(q.content.contains("[QUESTION]"));
        assert!(matches!(q.question_type, super::super::QuestionType::Technical));
    }

    #[test]
    fn test_detect_question_with_ask_tag() {
        let adapter = CodexAdapter;
        let line = r#"{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"[ASK] Need clarification"}}"#;
        let q = adapter.detect_question(line);
        assert!(q.is_some());
    }

    #[test]
    fn test_detect_question_no_tag_returns_none() {
        let adapter = CodexAdapter;
        let line = r#"{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Working on it..."}}"#;
        assert!(adapter.detect_question(line).is_none());
    }

    #[test]
    fn test_detect_question_tool_use_returns_none() {
        let adapter = CodexAdapter;
        let line = r#"{"type":"item.completed","item":{"id":"i2","type":"tool_use","function_name":"Bash","arguments":{"command":"ls"}}}"#;
        assert!(adapter.detect_question(line).is_none());
    }

    #[test]
    fn test_parse_display_output_agent_message() {
        let adapter = CodexAdapter;
        let line = r#"{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Analyzing code..."}}"#;
        let dl = adapter.parse_display_output(line);
        assert!(dl.is_some());
        let dl = dl.unwrap();
        assert_eq!(dl.content, "Analyzing code...");
        assert!(matches!(dl.line_type, super::super::DisplayLineType::AgentThinking));
    }

    #[test]
    fn test_parse_display_output_tool_use() {
        let adapter = CodexAdapter;
        let line = r#"{"type":"item.completed","item":{"id":"i2","type":"tool_use","function_name":"Bash","arguments":{"command":"ls"}}}"#;
        let dl = adapter.parse_display_output(line);
        assert!(dl.is_some());
        let dl = dl.unwrap();
        assert!(dl.content.contains("[Bash]"));
        assert!(matches!(dl.line_type, super::super::DisplayLineType::ToolExecution));
    }

    #[test]
    fn test_parse_display_output_tool_result() {
        let adapter = CodexAdapter;
        let line = r#"{"type":"item.completed","item":{"id":"i3","type":"tool_result","output":"file.txt","status":"success"}}"#;
        let dl = adapter.parse_display_output(line);
        assert!(dl.is_some());
        assert!(matches!(dl.unwrap().line_type, super::super::DisplayLineType::Result));
    }

    #[test]
    fn test_parse_display_output_turn_completed() {
        let adapter = CodexAdapter;
        let line = r#"{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}"#;
        let dl = adapter.parse_display_output(line);
        assert!(dl.is_some());
        let dl = dl.unwrap();
        assert!(dl.content.contains("100in/50out"));
        assert!(matches!(dl.line_type, super::super::DisplayLineType::Result));
    }

    #[test]
    fn test_parse_display_output_thread_started_returns_none() {
        let adapter = CodexAdapter;
        let line = r#"{"type":"thread.started","thread_id":"abc"}"#;
        assert!(adapter.parse_display_output(line).is_none());
    }

    #[test]
    fn test_parse_display_output_non_json_returns_none() {
        let adapter = CodexAdapter;
        assert!(adapter.parse_display_output("Starting Codex CLI...").is_none());
    }

    #[test]
    fn test_extract_result_finds_last_agent_message() {
        let adapter = CodexAdapter;
        let lines = vec![
            r#"{"type":"thread.started","thread_id":"abc"}"#.to_string(),
            r#"{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Working..."}}"#.to_string(),
            r#"{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"Task done"}}"#.to_string(),
            r#"{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}"#.to_string(),
        ];
        let result = adapter.extract_result(&lines);
        assert_eq!(result, Some("Task done".to_string()));
    }

    #[test]
    fn test_extract_result_empty_returns_none() {
        let adapter = CodexAdapter;
        assert!(adapter.extract_result(&[]).is_none());
    }

    #[test]
    fn test_extract_result_no_agent_message() {
        let adapter = CodexAdapter;
        let lines = vec![
            r#"{"type":"thread.started","thread_id":"abc"}"#.to_string(),
            r#"{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}"#.to_string(),
        ];
        assert!(adapter.extract_result(&lines).is_none());
    }

    #[test]
    fn test_is_turn_complete_turn_completed() {
        let adapter = CodexAdapter;
        let line = r#"{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}"#;
        assert!(adapter.is_turn_complete(line));
    }

    #[test]
    fn test_is_turn_complete_item_completed() {
        let adapter = CodexAdapter;
        let line = r#"{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Still working"}}"#;
        assert!(!adapter.is_turn_complete(line));
    }

    #[test]
    fn test_is_turn_complete_non_json() {
        let adapter = CodexAdapter;
        assert!(!adapter.is_turn_complete("Starting Codex CLI..."));
    }
}
