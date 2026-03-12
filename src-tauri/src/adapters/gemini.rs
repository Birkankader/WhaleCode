// Gemini CLI adapter: NDJSON parsing, command building, failure detection, rate limit detection

use serde::Deserialize;

use super::{
    ToolAdapter, ToolCommand,
    RateLimitInfo as SharedRateLimitInfo, RetryPolicy as SharedRetryPolicy,
    Question, QuestionType, DisplayLine, DisplayLineType,
};

// ---------------------------------------------------------------------------
// NDJSON Event Types
// ---------------------------------------------------------------------------

/// Represents a single line from Gemini CLI's `--output-format stream-json` NDJSON output.
/// Uses serde tagged enum on the `type` field. All inner fields are `Option<T>` for
/// resilient parsing — the exact schema may vary across CLI versions.
///
/// NOTE: Unlike Claude, Gemini's message content is a plain String (not Vec<ContentBlock>).
// Fields are deserialized from JSON for completeness; not all are read directly in Rust.
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum GeminiStreamEvent {
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
        tool_name: Option<String>,
        tool_id: Option<String>,
        parameters: Option<serde_json::Value>,
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
        stats: Option<GeminiStats>,
        timestamp: Option<String>,
    },
}

/// Statistics from a Gemini CLI result event.
// Fields are deserialized from JSON for completeness; not all are read directly in Rust.
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct GeminiStats {
    pub total_tokens: Option<u64>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub duration_ms: Option<u64>,
    pub tool_calls: Option<u32>,
}

// ---------------------------------------------------------------------------
// Command Builder
// ---------------------------------------------------------------------------

/// Holds the fully resolved command, args, env vars, and working directory
/// needed to spawn a Gemini CLI subprocess.
pub struct GeminiCommand {
    pub cmd: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: String,
}

/// Build the environment variable list for Gemini CLI.
/// Always includes NO_COLOR=1; adds GEMINI_API_KEY when non-empty.
fn build_env(api_key: &str) -> Vec<(String, String)> {
    let mut env = vec![("NO_COLOR".to_string(), "1".to_string())];
    if !api_key.is_empty() {
        env.push(("GEMINI_API_KEY".to_string(), api_key.to_string()));
    }
    env
}

/// Build the CLI command for spawning Gemini CLI in headless streaming mode.
///
/// SECURITY: The `api_key` is stored in `env` only — it is never included
/// in args or logged.
///
/// The `--yolo` flag is required for headless tool execution (no confirmation prompts).
pub fn build_command(prompt: &str, cwd: &str, api_key: &str) -> GeminiCommand {
    GeminiCommand {
        cmd: "gemini".to_string(),
        args: vec![
            "-p".to_string(),
            prompt.to_string(),
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--yolo".to_string(),
        ],
        env: build_env(api_key),
        cwd: cwd.to_string(),
    }
}

// ---------------------------------------------------------------------------
// NDJSON Parser
// ---------------------------------------------------------------------------

/// Parse a single line from Gemini CLI's NDJSON output stream.
/// Returns `None` for non-JSON lines (expected per Pitfall 5 in research).
pub fn parse_stream_line(line: &str) -> Option<GeminiStreamEvent> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    serde_json::from_str(trimmed).ok()
}

// ---------------------------------------------------------------------------
// Result Validator
// ---------------------------------------------------------------------------

/// Validate a result event from Gemini CLI for silent failures.
///
/// Checks:
/// - response text is non-empty
/// - status is not "error"
/// - event is a Result (not Error or other type)
///
/// NOTE: Does NOT check num_turns or is_error (Claude-specific fields per Pitfall 6).
///
/// Returns a descriptive error for each failure mode.
pub fn validate_result(event: &GeminiStreamEvent) -> Result<(), String> {
    match event {
        GeminiStreamEvent::Result {
            status,
            response,
            ..
        } => {
            // Check for error status
            if status.as_deref() == Some("error") {
                return Err("Gemini CLI reported an error status".to_string());
            }
            // Check for empty/missing response (silent failure)
            if response.as_ref().map_or(true, |r| r.trim().is_empty()) {
                return Err("Gemini CLI returned empty response (silent failure)".to_string());
            }
            Ok(())
        }
        GeminiStreamEvent::Error { message, .. } => {
            Err(format!(
                "Gemini CLI error: {}",
                message.as_deref().unwrap_or("unknown error")
            ))
        }
        _ => Err("No result event received from Gemini CLI".to_string()),
    }
}

// ---------------------------------------------------------------------------
// Rate Limit Detector
// ---------------------------------------------------------------------------

/// Information about a detected rate limit.
#[allow(dead_code)]
pub struct RateLimitInfo {
    pub retry_after_secs: Option<u64>,
}

/// Detect rate-limit or quota errors in a stderr/stdout line.
/// Returns `Some(RateLimitInfo)` if the line indicates a rate limit.
///
/// Gemini-specific patterns differ from Claude (Pitfall 3):
/// - 429 HTTP status
/// - RESOURCE_EXHAUSTED gRPC status
/// - quota exceeded
/// - Too Many Requests
/// - rate limit
#[allow(dead_code)]
pub fn detect_rate_limit(line: &str) -> Option<RateLimitInfo> {
    let lower = line.to_lowercase();
    if lower.contains("429")
        || lower.contains("resource_exhausted")
        || lower.contains("quota")
        || lower.contains("too many requests")
        || lower.contains("rate limit")
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

/// Exponential backoff retry policy for rate-limited Gemini CLI requests.
#[allow(dead_code)]
pub struct RetryPolicy {
    pub max_retries: u32,
    pub base_delay_ms: u64,
    pub max_delay_ms: u64,
}

#[allow(dead_code)]
impl RetryPolicy {
    /// Default retry policy for Gemini CLI: 3 retries, 5s base, 60s max.
    pub fn default_gemini() -> Self {
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
pub struct GeminiAdapter;

impl ToolAdapter for GeminiAdapter {
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
            .ok_or_else(|| "Failed to parse Gemini result JSON".to_string())?;
        validate_result(&event)
    }

    fn detect_rate_limit(&self, line: &str) -> Option<SharedRateLimitInfo> {
        detect_rate_limit(line).map(|info| SharedRateLimitInfo {
            retry_after_secs: info.retry_after_secs,
        })
    }

    fn retry_policy(&self) -> SharedRetryPolicy {
        let p = RetryPolicy::default_gemini();
        SharedRetryPolicy {
            max_retries: p.max_retries,
            base_delay_ms: p.base_delay_ms,
            max_delay_ms: p.max_delay_ms,
        }
    }

    fn name(&self) -> &str {
        "Gemini CLI"
    }

    fn build_interactive_command(&self, cwd: &str, api_key: &str) -> ToolCommand {
        ToolCommand {
            cmd: "gemini".to_string(),
            args: vec![
                "--output-format".to_string(),
                "stream-json".to_string(),
                "--yolo".to_string(),
            ],
            env: build_env(api_key),
            cwd: cwd.to_string(),
        }
    }

    fn detect_question(&self, line: &str) -> Option<Question> {
        let event = parse_stream_line(line)?;
        match event {
            GeminiStreamEvent::Message { content, .. } => {
                let text = content?;
                if text.contains("[QUESTION]") || text.contains("[ASK]") {
                    let qtype = QuestionType::from_text(&text);
                    return Some(Question {
                        source_agent: "gemini".to_string(),
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
            GeminiStreamEvent::Message { content, .. } => {
                let text = content?;
                if text.is_empty() {
                    return None;
                }
                Some(DisplayLine {
                    content: text,
                    line_type: DisplayLineType::AgentThinking,
                })
            }
            GeminiStreamEvent::ToolUse { tool_name, parameters, .. } => {
                let name = tool_name.unwrap_or_else(|| "unknown".to_string());
                let params_str = parameters
                    .map(|v| serde_json::to_string(&v).unwrap_or_default())
                    .unwrap_or_default();
                Some(DisplayLine {
                    content: format!("[{}] {}", name, params_str),
                    line_type: DisplayLineType::ToolExecution,
                })
            }
            GeminiStreamEvent::ToolResult { output, .. } => {
                let content = output.unwrap_or_default();
                if content.is_empty() {
                    return None;
                }
                Some(DisplayLine {
                    content,
                    line_type: DisplayLineType::Result,
                })
            }
            GeminiStreamEvent::Result { response, .. } => {
                let content = response.unwrap_or_default();
                if content.is_empty() {
                    return None;
                }
                Some(DisplayLine {
                    content,
                    line_type: DisplayLineType::Result,
                })
            }
            _ => None,
        }
    }

    fn extract_result(&self, output_lines: &[String]) -> Option<String> {
        for line in output_lines.iter().rev() {
            if let Some(event) = parse_stream_line(line) {
                if let GeminiStreamEvent::Result { response, .. } = event {
                    return response;
                }
            }
        }
        None
    }

    fn is_turn_complete(&self, line: &str) -> bool {
        matches!(parse_stream_line(line), Some(GeminiStreamEvent::Result { .. }))
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
        let line = r#"{"type":"init","session_id":"abc","model":"gemini-2.5-pro"}"#;
        let event = parse_stream_line(line);
        assert!(event.is_some(), "Expected Some for init event");
        match event.unwrap() {
            GeminiStreamEvent::Init { session_id, model, .. } => {
                assert_eq!(session_id, Some("abc".to_string()));
                assert_eq!(model, Some("gemini-2.5-pro".to_string()));
            }
            other => panic!("Expected Init, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_message_event() {
        let line = r#"{"type":"message","role":"model","content":"Hello"}"#;
        let event = parse_stream_line(line);
        assert!(event.is_some(), "Expected Some for message event");
        match event.unwrap() {
            GeminiStreamEvent::Message { role, content, .. } => {
                assert_eq!(role, Some("model".to_string()));
                assert_eq!(content, Some("Hello".to_string()));
            }
            other => panic!("Expected Message, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_tool_use_event() {
        let line = r#"{"type":"tool_use","tool_name":"Bash","tool_id":"t1","parameters":{"command":"ls"}}"#;
        let event = parse_stream_line(line);
        assert!(event.is_some(), "Expected Some for tool_use event");
        match event.unwrap() {
            GeminiStreamEvent::ToolUse { tool_name, tool_id, parameters, .. } => {
                assert_eq!(tool_name, Some("Bash".to_string()));
                assert_eq!(tool_id, Some("t1".to_string()));
                assert!(parameters.is_some());
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
            GeminiStreamEvent::ToolResult { tool_id, status, output, .. } => {
                assert_eq!(tool_id, Some("t1".to_string()));
                assert_eq!(status, Some("success".to_string()));
                assert_eq!(output, Some("file.txt".to_string()));
            }
            other => panic!("Expected ToolResult, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_result_event() {
        let line = r#"{"type":"result","status":"completed","response":"Done","stats":{"total_tokens":500}}"#;
        let event = parse_stream_line(line);
        assert!(event.is_some(), "Expected Some for result event");
        match event.unwrap() {
            GeminiStreamEvent::Result { status, response, stats, .. } => {
                assert_eq!(status, Some("completed".to_string()));
                assert_eq!(response, Some("Done".to_string()));
                let s = stats.unwrap();
                assert_eq!(s.total_tokens, Some(500));
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
            GeminiStreamEvent::Error { message, .. } => {
                assert_eq!(message, Some("API error".to_string()));
            }
            other => panic!("Expected Error, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_non_json_line_returns_none() {
        let line = "Starting Gemini CLI...";
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
        let event = GeminiStreamEvent::Result {
            status: Some("completed".to_string()),
            response: Some("Task completed successfully".to_string()),
            stats: None,
            timestamp: None,
        };
        assert!(validate_result(&event).is_ok());
    }

    #[test]
    fn test_validate_result_empty_response() {
        let event = GeminiStreamEvent::Result {
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
        let event = GeminiStreamEvent::Result {
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
        let event = GeminiStreamEvent::Result {
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
        let event = GeminiStreamEvent::Error {
            message: Some("API error".to_string()),
            timestamp: None,
        };
        let err = validate_result(&event);
        assert!(err.is_err(), "Expected Err for Error event");
        assert!(err.unwrap_err().contains("API error"));
    }

    #[test]
    fn test_validate_result_non_result_event() {
        let event = GeminiStreamEvent::Init {
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
    fn test_detect_rate_limit_resource_exhausted() {
        let info = detect_rate_limit("RESOURCE_EXHAUSTED: quota exceeded");
        assert!(info.is_some(), "Expected rate limit detection for RESOURCE_EXHAUSTED");
    }

    #[test]
    fn test_detect_rate_limit_quota() {
        let info = detect_rate_limit("Your quota has been exceeded");
        assert!(info.is_some(), "Expected rate limit detection for quota");
    }

    #[test]
    fn test_detect_rate_limit_too_many_requests() {
        let info = detect_rate_limit("Too Many Requests, please retry later");
        assert!(info.is_some(), "Expected rate limit detection for Too Many Requests");
    }

    #[test]
    fn test_detect_rate_limit_rate_limit_string() {
        let info = detect_rate_limit("rate limit exceeded");
        assert!(info.is_some(), "Expected rate limit detection for rate limit");
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
        let cmd = build_command("write hello world", "/tmp/project", "gemini-key-123");
        assert_eq!(cmd.cmd, "gemini");
        assert!(cmd.args.contains(&"-p".to_string()));
        assert!(cmd.args.contains(&"write hello world".to_string()));
        assert!(cmd.args.contains(&"--output-format".to_string()));
        assert!(cmd.args.contains(&"stream-json".to_string()));
        assert!(cmd.args.contains(&"--yolo".to_string()));
    }

    #[test]
    fn test_build_command_env_has_gemini_key() {
        let cmd = build_command("test", "/tmp", "my-api-key");
        let key_env = cmd.env.iter().find(|(k, _)| k == "GEMINI_API_KEY");
        assert!(key_env.is_some(), "Expected GEMINI_API_KEY in env");
        assert_eq!(key_env.unwrap().1, "my-api-key");
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
    fn test_retry_policy_default_gemini() {
        let policy = RetryPolicy::default_gemini();
        assert_eq!(policy.max_retries, 3);
        assert_eq!(policy.base_delay_ms, 5_000);
        assert_eq!(policy.max_delay_ms, 60_000);
    }

    #[test]
    fn test_retry_policy_delay_doubles() {
        let policy = RetryPolicy::default_gemini();
        let d0 = policy.delay_for_attempt(0); // 5000
        let d1 = policy.delay_for_attempt(1); // 10000
        let d2 = policy.delay_for_attempt(2); // 20000
        assert_eq!(d0, 5_000);
        assert_eq!(d1, 10_000);
        assert_eq!(d2, 20_000);
    }

    #[test]
    fn test_retry_policy_delay_capped_at_max() {
        let policy = RetryPolicy::default_gemini();
        let d10 = policy.delay_for_attempt(10); // would be huge, capped at 60000
        assert_eq!(d10, 60_000);
    }

    // -----------------------------------------------------------------------
    // New Trait Method Tests
    // -----------------------------------------------------------------------

    use super::super::ToolAdapter;

    #[test]
    fn test_build_interactive_command_no_prompt_flag() {
        let adapter = GeminiAdapter;
        let cmd = adapter.build_interactive_command("/tmp/project", "gemini-key");
        assert_eq!(cmd.cmd, "gemini");
        // Must NOT contain -p
        assert!(!cmd.args.contains(&"-p".to_string()));
        // Must contain streaming/yolo flags
        assert!(cmd.args.contains(&"--output-format".to_string()));
        assert!(cmd.args.contains(&"stream-json".to_string()));
        assert!(cmd.args.contains(&"--yolo".to_string()));
    }

    #[test]
    fn test_build_interactive_command_env() {
        let adapter = GeminiAdapter;
        let cmd = adapter.build_interactive_command("/tmp", "gemini-key-123");
        let key_env = cmd.env.iter().find(|(k, _)| k == "GEMINI_API_KEY");
        assert!(key_env.is_some());
        assert_eq!(key_env.unwrap().1, "gemini-key-123");
        assert_eq!(cmd.cwd, "/tmp");
    }

    #[test]
    fn test_build_interactive_command_empty_key() {
        let adapter = GeminiAdapter;
        let cmd = adapter.build_interactive_command("/tmp", "");
        let key_env = cmd.env.iter().find(|(k, _)| k == "GEMINI_API_KEY");
        assert!(key_env.is_none());
    }

    #[test]
    fn test_detect_question_with_question_tag() {
        let adapter = GeminiAdapter;
        let line = r#"{"type":"message","role":"model","content":"[QUESTION] Which schema to use?"}"#;
        let q = adapter.detect_question(line);
        assert!(q.is_some());
        let q = q.unwrap();
        assert_eq!(q.source_agent, "gemini");
        assert!(q.content.contains("[QUESTION]"));
        assert!(matches!(q.question_type, super::super::QuestionType::Technical));
    }

    #[test]
    fn test_detect_question_with_ask_tag() {
        let adapter = GeminiAdapter;
        let line = r#"{"type":"message","role":"model","content":"[ASK] Need clarification on API"}"#;
        let q = adapter.detect_question(line);
        assert!(q.is_some());
    }

    #[test]
    fn test_detect_question_no_tag_returns_none() {
        let adapter = GeminiAdapter;
        let line = r#"{"type":"message","role":"model","content":"Working on it..."}"#;
        assert!(adapter.detect_question(line).is_none());
    }

    #[test]
    fn test_detect_question_tool_use_returns_none() {
        let adapter = GeminiAdapter;
        let line = r#"{"type":"tool_use","tool_name":"Bash","tool_id":"t1","parameters":{"command":"ls"}}"#;
        assert!(adapter.detect_question(line).is_none());
    }

    #[test]
    fn test_parse_display_output_message() {
        let adapter = GeminiAdapter;
        let line = r#"{"type":"message","role":"model","content":"Analyzing code..."}"#;
        let dl = adapter.parse_display_output(line);
        assert!(dl.is_some());
        let dl = dl.unwrap();
        assert_eq!(dl.content, "Analyzing code...");
        assert!(matches!(dl.line_type, super::super::DisplayLineType::AgentThinking));
    }

    #[test]
    fn test_parse_display_output_tool_use() {
        let adapter = GeminiAdapter;
        let line = r#"{"type":"tool_use","tool_name":"Bash","tool_id":"t1","parameters":{"command":"ls"}}"#;
        let dl = adapter.parse_display_output(line);
        assert!(dl.is_some());
        let dl = dl.unwrap();
        assert!(dl.content.contains("[Bash]"));
        assert!(matches!(dl.line_type, super::super::DisplayLineType::ToolExecution));
    }

    #[test]
    fn test_parse_display_output_tool_result() {
        let adapter = GeminiAdapter;
        let line = r#"{"type":"tool_result","tool_id":"t1","status":"success","output":"file.txt"}"#;
        let dl = adapter.parse_display_output(line);
        assert!(dl.is_some());
        assert!(matches!(dl.unwrap().line_type, super::super::DisplayLineType::Result));
    }

    #[test]
    fn test_parse_display_output_result_event() {
        let adapter = GeminiAdapter;
        let line = r#"{"type":"result","status":"completed","response":"All done"}"#;
        let dl = adapter.parse_display_output(line);
        assert!(dl.is_some());
        let dl = dl.unwrap();
        assert_eq!(dl.content, "All done");
        assert!(matches!(dl.line_type, super::super::DisplayLineType::Result));
    }

    #[test]
    fn test_parse_display_output_init_returns_none() {
        let adapter = GeminiAdapter;
        let line = r#"{"type":"init","session_id":"abc"}"#;
        assert!(adapter.parse_display_output(line).is_none());
    }

    #[test]
    fn test_parse_display_output_non_json_returns_none() {
        let adapter = GeminiAdapter;
        assert!(adapter.parse_display_output("Starting Gemini CLI...").is_none());
    }

    #[test]
    fn test_extract_result_finds_last_result() {
        let adapter = GeminiAdapter;
        let lines = vec![
            r#"{"type":"init","session_id":"abc"}"#.to_string(),
            r#"{"type":"message","role":"model","content":"Working..."}"#.to_string(),
            r#"{"type":"result","status":"completed","response":"Task done"}"#.to_string(),
        ];
        let result = adapter.extract_result(&lines);
        assert_eq!(result, Some("Task done".to_string()));
    }

    #[test]
    fn test_extract_result_empty_returns_none() {
        let adapter = GeminiAdapter;
        assert!(adapter.extract_result(&[]).is_none());
    }

    #[test]
    fn test_extract_result_no_result_event() {
        let adapter = GeminiAdapter;
        let lines = vec![
            r#"{"type":"init","session_id":"abc"}"#.to_string(),
            r#"{"type":"message","role":"model","content":"Working..."}"#.to_string(),
        ];
        assert!(adapter.extract_result(&lines).is_none());
    }

    #[test]
    fn test_is_turn_complete_result_event() {
        let adapter = GeminiAdapter;
        let line = r#"{"type":"result","status":"completed","response":"Done"}"#;
        assert!(adapter.is_turn_complete(line));
    }

    #[test]
    fn test_is_turn_complete_message_event() {
        let adapter = GeminiAdapter;
        let line = r#"{"type":"message","role":"model","content":"Still working"}"#;
        assert!(!adapter.is_turn_complete(line));
    }

    #[test]
    fn test_is_turn_complete_non_json() {
        let adapter = GeminiAdapter;
        assert!(!adapter.is_turn_complete("Starting Gemini CLI..."));
    }
}
