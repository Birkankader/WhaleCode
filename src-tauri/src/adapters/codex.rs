// Codex CLI adapter: NDJSON parsing, command building, failure detection, rate limit detection

use serde::Deserialize;

use super::{
    ToolAdapter, ToolCommand,
    RateLimitInfo as SharedRateLimitInfo, RetryPolicy as SharedRetryPolicy,
    Question, QuestionType, DisplayLine, DisplayLineType,
};

// ---------------------------------------------------------------------------
// NDJSON Event Types
// ---------------------------------------------------------------------------

/// Represents a single line from Codex CLI's stdout output.
/// Uses serde tagged enum on the `type` field. All inner fields are `Option<T>` for
/// resilient parsing — the exact schema may vary across CLI versions.
///
/// NOTE: Like Gemini, Codex's message content is a plain String (not Vec<ContentBlock>).
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum CodexStreamEvent {
    #[serde(rename = "init")]
    Init {
        session_id: Option<String>,
        model: Option<String>,
        timestamp: Option<String>,
    },

    #[serde(rename = "message")]
    Message {
        role: Option<String>,
        content: Option<String>,
        timestamp: Option<String>,
    },

    #[serde(rename = "tool_use")]
    ToolUse {
        /// Codex CLI uses `function_name` for tool_use events
        function_name: Option<String>,
        /// Codex CLI uses `call_id` instead of `tool_id`
        call_id: Option<String>,
        /// Codex CLI uses `arguments` instead of `parameters`
        arguments: Option<serde_json::Value>,
        timestamp: Option<String>,
    },

    #[serde(rename = "tool_result")]
    ToolResult {
        tool_id: Option<String>,
        status: Option<String>,
        output: Option<String>,
        timestamp: Option<String>,
    },

    #[serde(rename = "error")]
    Error {
        message: Option<String>,
        timestamp: Option<String>,
    },

    #[serde(rename = "result")]
    Result {
        status: Option<String>,
        response: Option<String>,
        stats: Option<CodexStats>,
        timestamp: Option<String>,
    },
}

/// Usage/statistics from a Codex CLI result event.
/// Codex CLI uses `prompt_tokens`/`completion_tokens` naming (OpenAI convention).
#[derive(Debug, Deserialize)]
pub struct CodexStats {
    pub total_tokens: Option<u64>,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub duration_ms: Option<u64>,
    pub tool_calls: Option<u32>,
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

/// Build the CLI command for spawning Codex CLI in non-interactive mode.
///
/// SECURITY: The `api_key` is stored in `env` only — it is never included
/// in args or logged.
///
/// Uses `codex exec --full-auto` for headless tool execution (no confirmation prompts).
/// Codex CLI does not support `--output-format`; output is plain text on stdout.
pub fn build_command(prompt: &str, cwd: &str, api_key: &str) -> CodexCommand {
    let mut env = vec![("NO_COLOR".to_string(), "1".to_string())];
    if !api_key.is_empty() {
        env.push(("OPENAI_API_KEY".to_string(), api_key.to_string()));
    }
    CodexCommand {
        cmd: "codex".to_string(),
        args: vec![
            "exec".to_string(),
            "--full-auto".to_string(),
            prompt.to_string(),
        ],
        env,
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
///
/// Checks:
/// - response text is non-empty
/// - status is not "error"
/// - event is a Result (not Error or other type)
///
/// NOTE: Does NOT check num_turns or is_error (Claude-specific fields per Pitfall 6).
///
/// Returns a descriptive error for each failure mode.
pub fn validate_result(event: &CodexStreamEvent) -> Result<(), String> {
    match event {
        CodexStreamEvent::Result {
            status,
            response,
            ..
        } => {
            // Check for error status
            if status.as_deref() == Some("error") {
                return Err("Codex CLI reported an error status".to_string());
            }
            // Check for empty/missing response (silent failure)
            if response.as_ref().map_or(true, |r| r.trim().is_empty()) {
                return Err("Codex CLI returned empty response (silent failure)".to_string());
            }
            Ok(())
        }
        CodexStreamEvent::Error { message, .. } => {
            Err(format!(
                "Codex CLI error: {}",
                message.as_deref().unwrap_or("unknown error")
            ))
        }
        _ => Err("No result event received from Codex CLI".to_string()),
    }
}

// ---------------------------------------------------------------------------
// Rate Limit Detector
// ---------------------------------------------------------------------------

/// Information about a detected rate limit.
pub struct RateLimitInfo {
    pub retry_after_secs: Option<u64>,
}

/// Detect rate-limit or quota errors in a stderr/stdout line.
/// Returns `Some(RateLimitInfo)` if the line indicates a rate limit.
///
/// OpenAI/Codex-specific patterns:
/// - 429 HTTP status
/// - rate_limit
/// - Too Many Requests
/// - insufficient_quota
pub fn detect_rate_limit(line: &str) -> Option<RateLimitInfo> {
    let lower = line.to_lowercase();
    if lower.contains("429")
        || lower.contains("rate_limit")
        || lower.contains("too many requests")
        || lower.contains("insufficient_quota")
    {
        Some(RateLimitInfo {
            retry_after_secs: None,
        })
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Retry Policy
// ---------------------------------------------------------------------------

/// Exponential backoff retry policy for rate-limited Codex CLI requests.
pub struct RetryPolicy {
    pub max_retries: u32,
    pub base_delay_ms: u64,
    pub max_delay_ms: u64,
}

impl RetryPolicy {
    /// Default retry policy for Codex CLI: 3 retries, 5s base, 60s max.
    pub fn default_codex() -> Self {
        Self {
            max_retries: 3,
            base_delay_ms: 5_000,
            max_delay_ms: 60_000,
        }
    }

    /// Calculate the delay in milliseconds for a given attempt (0-indexed).
    /// Delay = base * 2^attempt, capped at max_delay_ms.
    pub fn delay_for_attempt(&self, attempt: u32) -> u64 {
        let delay = self.base_delay_ms.saturating_mul(2u64.saturating_pow(attempt));
        delay.min(self.max_delay_ms)
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
        detect_rate_limit(line).map(|info| SharedRateLimitInfo {
            retry_after_secs: info.retry_after_secs,
        })
    }

    fn retry_policy(&self) -> SharedRetryPolicy {
        let p = RetryPolicy::default_codex();
        SharedRetryPolicy {
            max_retries: p.max_retries,
            base_delay_ms: p.base_delay_ms,
            max_delay_ms: p.max_delay_ms,
        }
    }

    fn name(&self) -> &str {
        "Codex CLI"
    }

    fn build_interactive_command(&self, cwd: &str, api_key: &str) -> ToolCommand {
        let mut env = vec![("NO_COLOR".to_string(), "1".to_string())];
        if !api_key.is_empty() {
            env.push(("OPENAI_API_KEY".to_string(), api_key.to_string()));
        }
        ToolCommand {
            cmd: "codex".to_string(),
            args: vec![
                "--full-auto".to_string(),
            ],
            env,
            cwd: cwd.to_string(),
        }
    }

    fn detect_question(&self, line: &str) -> Option<Question> {
        let event = parse_stream_line(line)?;
        match event {
            CodexStreamEvent::Message { content, .. } => {
                let text = content?;
                if text.contains("[QUESTION]") || text.contains("[ASK]") {
                    let qtype = if text.contains("permission") || text.contains("Permission") {
                        QuestionType::Permission
                    } else if text.contains("clarif") || text.contains("Clarif") {
                        QuestionType::Clarification
                    } else {
                        QuestionType::Technical
                    };
                    return Some(Question {
                        source_agent: "codex".to_string(),
                        content: text,
                        question_type: qtype,
                    });
                }
                None
            }
            _ => None,
        }
    }

    fn parse_display_output(&self, line: &str) -> Option<DisplayLine> {
        let event = parse_stream_line(line)?;
        match event {
            CodexStreamEvent::Message { content, .. } => {
                let text = content?;
                if text.is_empty() {
                    return None;
                }
                Some(DisplayLine {
                    content: text,
                    line_type: DisplayLineType::AgentThinking,
                })
            }
            CodexStreamEvent::ToolUse { function_name, arguments, .. } => {
                let name = function_name.unwrap_or_else(|| "unknown".to_string());
                let args_str = arguments
                    .map(|v| serde_json::to_string(&v).unwrap_or_default())
                    .unwrap_or_default();
                Some(DisplayLine {
                    content: format!("[{}] {}", name, args_str),
                    line_type: DisplayLineType::ToolExecution,
                })
            }
            CodexStreamEvent::ToolResult { output, .. } => {
                Some(DisplayLine {
                    content: output.unwrap_or_default(),
                    line_type: DisplayLineType::Result,
                })
            }
            CodexStreamEvent::Result { response, .. } => {
                Some(DisplayLine {
                    content: response.unwrap_or_default(),
                    line_type: DisplayLineType::Result,
                })
            }
            _ => None,
        }
    }

    fn extract_result(&self, output_lines: &[String]) -> Option<String> {
        for line in output_lines.iter().rev() {
            if let Some(event) = parse_stream_line(line) {
                if let CodexStreamEvent::Result { response, .. } = event {
                    return response;
                }
            }
        }
        None
    }

    fn is_turn_complete(&self, line: &str) -> bool {
        match parse_stream_line(line) {
            Some(CodexStreamEvent::Result { .. }) => true,
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // Event Parsing Tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_parse_init_event() {
        let line = r#"{"type":"init","session_id":"abc","model":"o4-mini"}"#;
        let event = parse_stream_line(line);
        assert!(event.is_some(), "Expected Some for init event");
        match event.unwrap() {
            CodexStreamEvent::Init { session_id, model, .. } => {
                assert_eq!(session_id, Some("abc".to_string()));
                assert_eq!(model, Some("o4-mini".to_string()));
            }
            other => panic!("Expected Init, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_message_event() {
        let line = r#"{"type":"message","role":"assistant","content":"Hello"}"#;
        let event = parse_stream_line(line);
        assert!(event.is_some(), "Expected Some for message event");
        match event.unwrap() {
            CodexStreamEvent::Message { role, content, .. } => {
                assert_eq!(role, Some("assistant".to_string()));
                assert_eq!(content, Some("Hello".to_string()));
            }
            other => panic!("Expected Message, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_tool_use_event() {
        let line = r#"{"type":"tool_use","function_name":"Bash","call_id":"t1","arguments":{"command":"ls"}}"#;
        let event = parse_stream_line(line);
        assert!(event.is_some(), "Expected Some for tool_use event");
        match event.unwrap() {
            CodexStreamEvent::ToolUse { function_name, call_id, arguments, .. } => {
                assert_eq!(function_name, Some("Bash".to_string()));
                assert_eq!(call_id, Some("t1".to_string()));
                assert!(arguments.is_some());
            }
            other => panic!("Expected ToolUse, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_tool_result_event() {
        let line = r#"{"type":"tool_result","tool_id":"t1","status":"success","output":"file.txt"}"#;
        let event = parse_stream_line(line);
        assert!(event.is_some(), "Expected Some for tool_result event");
        match event.unwrap() {
            CodexStreamEvent::ToolResult { tool_id, status, output, .. } => {
                assert_eq!(tool_id, Some("t1".to_string()));
                assert_eq!(status, Some("success".to_string()));
                assert_eq!(output, Some("file.txt".to_string()));
            }
            other => panic!("Expected ToolResult, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_result_event() {
        let line = r#"{"type":"result","status":"completed","response":"Done","stats":{"total_tokens":500,"prompt_tokens":200,"completion_tokens":300,"duration_ms":1500}}"#;
        let event = parse_stream_line(line);
        assert!(event.is_some(), "Expected Some for result event");
        match event.unwrap() {
            CodexStreamEvent::Result { status, response, stats, .. } => {
                assert_eq!(status, Some("completed".to_string()));
                assert_eq!(response, Some("Done".to_string()));
                let s = stats.unwrap();
                assert_eq!(s.total_tokens, Some(500));
                assert_eq!(s.prompt_tokens, Some(200));
                assert_eq!(s.completion_tokens, Some(300));
                assert_eq!(s.duration_ms, Some(1500));
            }
            other => panic!("Expected Result, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_error_event() {
        let line = r#"{"type":"error","message":"API error"}"#;
        let event = parse_stream_line(line);
        assert!(event.is_some(), "Expected Some for error event");
        match event.unwrap() {
            CodexStreamEvent::Error { message, .. } => {
                assert_eq!(message, Some("API error".to_string()));
            }
            other => panic!("Expected Error, got {:?}", other),
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
    fn test_validate_result_success() {
        let event = CodexStreamEvent::Result {
            status: Some("completed".to_string()),
            response: Some("Task completed successfully".to_string()),
            stats: None,
            timestamp: None,
        };
        assert!(validate_result(&event).is_ok());
    }

    #[test]
    fn test_validate_result_empty_response() {
        let event = CodexStreamEvent::Result {
            status: Some("completed".to_string()),
            response: Some("".to_string()),
            stats: None,
            timestamp: None,
        };
        let err = validate_result(&event);
        assert!(err.is_err(), "Expected Err for empty response");
        assert!(err.unwrap_err().contains("empty response"));
    }

    #[test]
    fn test_validate_result_missing_response() {
        let event = CodexStreamEvent::Result {
            status: Some("completed".to_string()),
            response: None,
            stats: None,
            timestamp: None,
        };
        let err = validate_result(&event);
        assert!(err.is_err(), "Expected Err for missing response");
        assert!(err.unwrap_err().contains("empty response"));
    }

    #[test]
    fn test_validate_result_error_status() {
        let event = CodexStreamEvent::Result {
            status: Some("error".to_string()),
            response: Some("Something went wrong".to_string()),
            stats: None,
            timestamp: None,
        };
        let err = validate_result(&event);
        assert!(err.is_err(), "Expected Err for error status");
        assert!(err.unwrap_err().contains("error"));
    }

    #[test]
    fn test_validate_result_error_event() {
        let event = CodexStreamEvent::Error {
            message: Some("API error".to_string()),
            timestamp: None,
        };
        let err = validate_result(&event);
        assert!(err.is_err(), "Expected Err for Error event");
        assert!(err.unwrap_err().contains("API error"));
    }

    #[test]
    fn test_validate_result_non_result_event() {
        let event = CodexStreamEvent::Init {
            session_id: Some("abc".to_string()),
            model: None,
            timestamp: None,
        };
        let err = validate_result(&event);
        assert!(err.is_err(), "Expected Err for non-result event");
        assert!(err.unwrap_err().contains("No result event"));
    }

    // -----------------------------------------------------------------------
    // Rate Limit Detection Tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_detect_rate_limit_429() {
        let info = detect_rate_limit("Error: 429 Too Many Requests");
        assert!(info.is_some(), "Expected rate limit detection for 429");
    }

    #[test]
    fn test_detect_rate_limit_rate_limit_string() {
        let info = detect_rate_limit("rate_limit exceeded");
        assert!(info.is_some(), "Expected rate limit detection for rate_limit");
    }

    #[test]
    fn test_detect_rate_limit_too_many_requests() {
        let info = detect_rate_limit("Too Many Requests, please retry later");
        assert!(info.is_some(), "Expected rate limit detection for Too Many Requests");
    }

    #[test]
    fn test_detect_rate_limit_insufficient_quota() {
        let info = detect_rate_limit("insufficient_quota: you have exceeded your usage limit");
        assert!(info.is_some(), "Expected rate limit detection for insufficient_quota");
    }

    #[test]
    fn test_detect_rate_limit_normal_line() {
        let info = detect_rate_limit("Processing your request...");
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
        assert!(!cmd.args.contains(&"--output-format".to_string()));
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
        let policy = RetryPolicy::default_codex();
        assert_eq!(policy.max_retries, 3);
        assert_eq!(policy.base_delay_ms, 5_000);
        assert_eq!(policy.max_delay_ms, 60_000);
    }

    #[test]
    fn test_retry_policy_delay_doubles() {
        let policy = RetryPolicy::default_codex();
        let d0 = policy.delay_for_attempt(0); // 5000
        let d1 = policy.delay_for_attempt(1); // 10000
        let d2 = policy.delay_for_attempt(2); // 20000
        assert_eq!(d0, 5_000);
        assert_eq!(d1, 10_000);
        assert_eq!(d2, 20_000);
    }

    #[test]
    fn test_retry_policy_delay_capped_at_max() {
        let policy = RetryPolicy::default_codex();
        let d10 = policy.delay_for_attempt(10); // would be huge, capped at 60000
        assert_eq!(d10, 60_000);
    }

    // -----------------------------------------------------------------------
    // New Trait Method Tests
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
        // Must contain --full-auto
        assert!(cmd.args.contains(&"--full-auto".to_string()));
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
        let line = r#"{"type":"message","role":"assistant","content":"[QUESTION] Which schema to use?"}"#;
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
        let line = r#"{"type":"message","role":"assistant","content":"[ASK] Need clarification"}"#;
        let q = adapter.detect_question(line);
        assert!(q.is_some());
    }

    #[test]
    fn test_detect_question_no_tag_returns_none() {
        let adapter = CodexAdapter;
        let line = r#"{"type":"message","role":"assistant","content":"Working on it..."}"#;
        assert!(adapter.detect_question(line).is_none());
    }

    #[test]
    fn test_detect_question_tool_use_returns_none() {
        let adapter = CodexAdapter;
        let line = r#"{"type":"tool_use","function_name":"Bash","call_id":"t1","arguments":{"command":"ls"}}"#;
        assert!(adapter.detect_question(line).is_none());
    }

    #[test]
    fn test_parse_display_output_message() {
        let adapter = CodexAdapter;
        let line = r#"{"type":"message","role":"assistant","content":"Analyzing code..."}"#;
        let dl = adapter.parse_display_output(line);
        assert!(dl.is_some());
        let dl = dl.unwrap();
        assert_eq!(dl.content, "Analyzing code...");
        assert!(matches!(dl.line_type, super::super::DisplayLineType::AgentThinking));
    }

    #[test]
    fn test_parse_display_output_tool_use() {
        let adapter = CodexAdapter;
        let line = r#"{"type":"tool_use","function_name":"Bash","call_id":"t1","arguments":{"command":"ls"}}"#;
        let dl = adapter.parse_display_output(line);
        assert!(dl.is_some());
        let dl = dl.unwrap();
        assert!(dl.content.contains("[Bash]"));
        assert!(matches!(dl.line_type, super::super::DisplayLineType::ToolExecution));
    }

    #[test]
    fn test_parse_display_output_tool_result() {
        let adapter = CodexAdapter;
        let line = r#"{"type":"tool_result","tool_id":"t1","status":"success","output":"file.txt"}"#;
        let dl = adapter.parse_display_output(line);
        assert!(dl.is_some());
        assert!(matches!(dl.unwrap().line_type, super::super::DisplayLineType::Result));
    }

    #[test]
    fn test_parse_display_output_result_event() {
        let adapter = CodexAdapter;
        let line = r#"{"type":"result","status":"completed","response":"All done"}"#;
        let dl = adapter.parse_display_output(line);
        assert!(dl.is_some());
        let dl = dl.unwrap();
        assert_eq!(dl.content, "All done");
        assert!(matches!(dl.line_type, super::super::DisplayLineType::Result));
    }

    #[test]
    fn test_parse_display_output_init_returns_none() {
        let adapter = CodexAdapter;
        let line = r#"{"type":"init","session_id":"abc"}"#;
        assert!(adapter.parse_display_output(line).is_none());
    }

    #[test]
    fn test_parse_display_output_non_json_returns_none() {
        let adapter = CodexAdapter;
        assert!(adapter.parse_display_output("Starting Codex CLI...").is_none());
    }

    #[test]
    fn test_extract_result_finds_last_result() {
        let adapter = CodexAdapter;
        let lines = vec![
            r#"{"type":"init","session_id":"abc"}"#.to_string(),
            r#"{"type":"message","role":"assistant","content":"Working..."}"#.to_string(),
            r#"{"type":"result","status":"completed","response":"Task done"}"#.to_string(),
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
    fn test_extract_result_no_result_event() {
        let adapter = CodexAdapter;
        let lines = vec![
            r#"{"type":"init","session_id":"abc"}"#.to_string(),
            r#"{"type":"message","role":"assistant","content":"Working..."}"#.to_string(),
        ];
        assert!(adapter.extract_result(&lines).is_none());
    }

    #[test]
    fn test_is_turn_complete_result_event() {
        let adapter = CodexAdapter;
        let line = r#"{"type":"result","status":"completed","response":"Done"}"#;
        assert!(adapter.is_turn_complete(line));
    }

    #[test]
    fn test_is_turn_complete_message_event() {
        let adapter = CodexAdapter;
        let line = r#"{"type":"message","role":"assistant","content":"Still working"}"#;
        assert!(!adapter.is_turn_complete(line));
    }

    #[test]
    fn test_is_turn_complete_non_json() {
        let adapter = CodexAdapter;
        assert!(!adapter.is_turn_complete("Starting Codex CLI..."));
    }
}
