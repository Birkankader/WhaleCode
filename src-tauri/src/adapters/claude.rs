// Claude Code adapter: NDJSON parsing, command building, failure detection, rate limit detection

use serde::Deserialize;

use super::{
    ToolAdapter, ToolCommand,
    RateLimitInfo as SharedRateLimitInfo, RetryPolicy as SharedRetryPolicy,
    Question, QuestionType, DisplayLine, DisplayLineType,
};

// ---------------------------------------------------------------------------
// NDJSON Event Types
// ---------------------------------------------------------------------------

/// Represents a single line from Claude Code's `--output-format stream-json` NDJSON output.
/// Uses serde tagged enum on the `type` field. All inner fields are `Option<T>` for
/// resilient parsing — the exact schema may vary across CLI versions.
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum ClaudeStreamEvent {
    #[serde(rename = "init")]
    Init {
        session_id: Option<String>,
    },

    #[serde(rename = "message")]
    Message {
        role: Option<String>,
        content: Option<Vec<ContentBlock>>,
    },

    #[serde(rename = "tool_use")]
    ToolUse {
        name: Option<String>,
        input: Option<serde_json::Value>,
    },

    #[serde(rename = "tool_result")]
    ToolResult {
        output: Option<String>,
    },

    #[serde(rename = "result")]
    Result {
        status: Option<String>,
        duration_ms: Option<u64>,
        result: Option<String>,
        subtype: Option<String>,
        is_error: Option<bool>,
        total_cost_usd: Option<f64>,
        num_turns: Option<u32>,
        session_id: Option<String>,
    },

    /// Raw API events emitted with --verbose --include-partial-messages
    #[serde(rename = "stream_event")]
    StreamEvent {
        event: Option<serde_json::Value>,
    },
}

/// A content block inside a `message` event.
#[derive(Debug, Deserialize)]
pub struct ContentBlock {
    #[serde(rename = "type")]
    pub block_type: String,
    pub text: Option<String>,
    pub name: Option<String>,
    pub input: Option<serde_json::Value>,
}

// ---------------------------------------------------------------------------
// Command Builder
// ---------------------------------------------------------------------------

/// Holds the fully resolved command, args, env vars, and working directory
/// needed to spawn a Claude Code subprocess.
pub struct ClaudeCommand {
    pub cmd: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: String,
}

/// Build the environment variable list for Claude Code.
/// Always includes NO_COLOR=1; adds ANTHROPIC_API_KEY when non-empty.
fn build_env(api_key: &str) -> Vec<(String, String)> {
    let mut env = vec![("NO_COLOR".to_string(), "1".to_string())];
    if !api_key.is_empty() {
        env.push(("ANTHROPIC_API_KEY".to_string(), api_key.to_string()));
    }
    env
}

/// Build the CLI command for spawning Claude Code in headless streaming mode.
///
/// SECURITY: The `api_key` is stored in `env` only — it is never included
/// in args or logged.
pub fn build_command(prompt: &str, cwd: &str, api_key: &str) -> ClaudeCommand {
    ClaudeCommand {
        cmd: "claude".to_string(),
        args: vec![
            "-p".to_string(),
            prompt.to_string(),
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--verbose".to_string(),
            "--dangerously-skip-permissions".to_string(),
        ],
        env: build_env(api_key),
        cwd: cwd.to_string(),
    }
}

// ---------------------------------------------------------------------------
// NDJSON Parser
// ---------------------------------------------------------------------------

/// Parse a single line from Claude Code's NDJSON output stream.
/// Returns `None` for non-JSON lines (expected per Pitfall 5 in research).
pub fn parse_stream_line(line: &str) -> Option<ClaudeStreamEvent> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    serde_json::from_str(trimmed).ok()
}

// ---------------------------------------------------------------------------
// Result Validator
// ---------------------------------------------------------------------------

/// Validate a result event from Claude Code for silent failures.
///
/// Checks:
/// - is_error is not true
/// - result text is non-empty
/// - num_turns > 0
/// - status == "success"
///
/// Returns a descriptive error for each failure mode.
pub fn validate_result(event: &ClaudeStreamEvent) -> Result<(), String> {
    match event {
        ClaudeStreamEvent::Result {
            status,
            result,
            is_error,
            num_turns,
            ..
        } => {
            // Check for explicit error flag
            if *is_error == Some(true) {
                return Err("Claude Code reported an error".to_string());
            }
            // Check for empty/missing result (silent failure)
            if result.as_ref().map_or(true, |r| r.trim().is_empty()) {
                return Err(
                    "Claude Code returned empty result (silent failure)".to_string(),
                );
            }
            // Check for zero turns (nothing happened)
            if *num_turns == Some(0) {
                return Err(
                    "Claude Code completed zero turns (silent failure)".to_string(),
                );
            }
            // Check status
            if status.as_deref() != Some("success") {
                return Err(format!("Claude Code status: {:?}", status));
            }
            Ok(())
        }
        _ => Err("No result event received from Claude Code".to_string()),
    }
}

// ---------------------------------------------------------------------------
// Rate Limit Detector
// ---------------------------------------------------------------------------

/// Information about a detected rate limit.
pub struct RateLimitInfo {
    pub retry_after_secs: Option<u64>,
}

/// Detect rate-limit or overload errors in a stderr/stdout line.
/// Returns `Some(RateLimitInfo)` if the line indicates a rate limit.
pub fn detect_rate_limit(line: &str) -> Option<RateLimitInfo> {
    if line.contains("rate_limit")
        || line.contains("Rate limit")
        || line.contains("overloaded")
        || line.contains("529")
        || line.contains("429")
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

/// Exponential backoff retry policy for rate-limited Claude Code requests.
pub struct RetryPolicy {
    pub max_retries: u32,
    pub base_delay_ms: u64,
    pub max_delay_ms: u64,
}

impl RetryPolicy {
    /// Default retry policy for Claude Code: 3 retries, 5s base, 60s max.
    pub fn default_claude() -> Self {
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
pub struct ClaudeAdapter;

impl ToolAdapter for ClaudeAdapter {
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
            .ok_or_else(|| "Failed to parse result JSON".to_string())?;
        validate_result(&event)
    }

    fn detect_rate_limit(&self, line: &str) -> Option<SharedRateLimitInfo> {
        detect_rate_limit(line).map(|info| SharedRateLimitInfo {
            retry_after_secs: info.retry_after_secs,
        })
    }

    fn retry_policy(&self) -> SharedRetryPolicy {
        let p = RetryPolicy::default_claude();
        SharedRetryPolicy {
            max_retries: p.max_retries,
            base_delay_ms: p.base_delay_ms,
            max_delay_ms: p.max_delay_ms,
        }
    }

    fn name(&self) -> &str {
        "Claude Code"
    }

    fn build_interactive_command(&self, cwd: &str, api_key: &str) -> ToolCommand {
        ToolCommand {
            cmd: "claude".to_string(),
            args: vec![
                "--output-format".to_string(),
                "stream-json".to_string(),
                "--verbose".to_string(),
                "--dangerously-skip-permissions".to_string(),
            ],
            env: build_env(api_key),
            cwd: cwd.to_string(),
        }
    }

    fn detect_question(&self, line: &str) -> Option<Question> {
        let event = parse_stream_line(line)?;
        match event {
            ClaudeStreamEvent::Message { content, .. } => {
                let blocks = content?;
                for block in &blocks {
                    if let Some(ref text) = block.text {
                        if text.contains("[QUESTION]") || text.contains("[ASK]") {
                            return Some(Question {
                                source_agent: "claude".to_string(),
                                content: text.clone(),
                                question_type: QuestionType::from_text(text),
                            });
                        }
                    }
                }
                None
            }
            _ => None,
        }
    }

    fn parse_display_output(&self, line: &str) -> Option<DisplayLine> {
        let event = parse_stream_line(line)?;
        match event {
            ClaudeStreamEvent::Message { content, .. } => {
                let blocks = content?;
                let text_parts: Vec<String> = blocks
                    .iter()
                    .filter_map(|b| b.text.clone())
                    .collect();
                if text_parts.is_empty() {
                    return None;
                }
                Some(DisplayLine {
                    content: text_parts.join(""),
                    line_type: DisplayLineType::AgentThinking,
                })
            }
            ClaudeStreamEvent::ToolUse { name, input, .. } => {
                let tool_name = name.unwrap_or_else(|| "unknown".to_string());
                let input_str = input
                    .map(|v| serde_json::to_string(&v).unwrap_or_default())
                    .unwrap_or_default();
                Some(DisplayLine {
                    content: format!("[{}] {}", tool_name, input_str),
                    line_type: DisplayLineType::ToolExecution,
                })
            }
            ClaudeStreamEvent::ToolResult { output, .. } => {
                let content = output.unwrap_or_default();
                if content.is_empty() {
                    return None;
                }
                Some(DisplayLine {
                    content,
                    line_type: DisplayLineType::Result,
                })
            }
            ClaudeStreamEvent::Result { result, .. } => {
                let content = result.unwrap_or_default();
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
                if let ClaudeStreamEvent::Result { result, .. } = event {
                    return result;
                }
            }
        }
        None
    }

    fn is_turn_complete(&self, line: &str) -> bool {
        matches!(parse_stream_line(line), Some(ClaudeStreamEvent::Result { .. }))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_parse_init_event() {
        let line = r#"{"type":"init","session_id":"abc"}"#;
        let event = super::parse_stream_line(line);
        assert!(event.is_some(), "Expected Some for init event");
        match event.unwrap() {
            super::ClaudeStreamEvent::Init { session_id, .. } => {
                assert_eq!(session_id, Some("abc".to_string()));
            }
            other => panic!("Expected Init, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_message_event_with_content_blocks() {
        let line = r#"{"type":"message","role":"assistant","content":[{"type":"text","text":"Hello world"}]}"#;
        let event = super::parse_stream_line(line);
        assert!(event.is_some(), "Expected Some for message event");
        match event.unwrap() {
            super::ClaudeStreamEvent::Message { role, content, .. } => {
                assert_eq!(role, Some("assistant".to_string()));
                let blocks = content.unwrap();
                assert_eq!(blocks.len(), 1);
                assert_eq!(blocks[0].block_type, "text");
                assert_eq!(blocks[0].text, Some("Hello world".to_string()));
            }
            other => panic!("Expected Message, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_tool_use_event() {
        let line = r#"{"type":"tool_use","name":"Bash","input":{"command":"ls"}}"#;
        let event = super::parse_stream_line(line);
        assert!(event.is_some(), "Expected Some for tool_use event");
        match event.unwrap() {
            super::ClaudeStreamEvent::ToolUse { name, input, .. } => {
                assert_eq!(name, Some("Bash".to_string()));
                assert!(input.is_some());
            }
            other => panic!("Expected ToolUse, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_tool_result_event() {
        let line = r#"{"type":"tool_result","output":"file.txt\nother.txt"}"#;
        let event = super::parse_stream_line(line);
        assert!(event.is_some(), "Expected Some for tool_result event");
        match event.unwrap() {
            super::ClaudeStreamEvent::ToolResult { output, .. } => {
                assert_eq!(output, Some("file.txt\nother.txt".to_string()));
            }
            other => panic!("Expected ToolResult, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_result_event() {
        let line = r#"{"type":"result","status":"success","result":"Done","num_turns":3,"duration_ms":5000,"total_cost_usd":0.05}"#;
        let event = super::parse_stream_line(line);
        assert!(event.is_some(), "Expected Some for result event");
        match event.unwrap() {
            super::ClaudeStreamEvent::Result {
                status,
                result,
                num_turns,
                duration_ms,
                total_cost_usd,
                ..
            } => {
                assert_eq!(status, Some("success".to_string()));
                assert_eq!(result, Some("Done".to_string()));
                assert_eq!(num_turns, Some(3));
                assert_eq!(duration_ms, Some(5000));
                assert_eq!(total_cost_usd, Some(0.05));
            }
            other => panic!("Expected Result, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_non_json_line_returns_none() {
        let line = "Starting Claude Code...";
        assert!(super::parse_stream_line(line).is_none());
    }

    #[test]
    fn test_parse_empty_line_returns_none() {
        assert!(super::parse_stream_line("").is_none());
    }

    #[test]
    fn test_validate_result_success() {
        let event = super::ClaudeStreamEvent::Result {
            status: Some("success".to_string()),
            result: Some("Task completed".to_string()),
            num_turns: Some(2),
            duration_ms: Some(3000),
            total_cost_usd: Some(0.03),
            is_error: None,
            session_id: None,
            subtype: None,
        };
        assert!(super::validate_result(&event).is_ok());
    }

    #[test]
    fn test_validate_result_empty_result_string() {
        let event = super::ClaudeStreamEvent::Result {
            status: Some("success".to_string()),
            result: Some("".to_string()),
            num_turns: Some(1),
            duration_ms: Some(1000),
            total_cost_usd: None,
            is_error: None,
            session_id: None,
            subtype: None,
        };
        let err = super::validate_result(&event);
        assert!(err.is_err(), "Expected Err for empty result");
        assert!(err.unwrap_err().contains("empty result"));
    }

    #[test]
    fn test_validate_result_zero_turns() {
        let event = super::ClaudeStreamEvent::Result {
            status: Some("success".to_string()),
            result: Some("Something".to_string()),
            num_turns: Some(0),
            duration_ms: Some(500),
            total_cost_usd: None,
            is_error: None,
            session_id: None,
            subtype: None,
        };
        let err = super::validate_result(&event);
        assert!(err.is_err(), "Expected Err for zero turns");
        assert!(err.unwrap_err().contains("zero turns"));
    }

    #[test]
    fn test_validate_result_is_error_true() {
        let event = super::ClaudeStreamEvent::Result {
            status: Some("error".to_string()),
            result: Some("Error occurred".to_string()),
            num_turns: Some(1),
            duration_ms: Some(1000),
            total_cost_usd: None,
            is_error: Some(true),
            session_id: None,
            subtype: None,
        };
        let err = super::validate_result(&event);
        assert!(err.is_err(), "Expected Err for is_error=true");
        assert!(err.unwrap_err().contains("error"));
    }

    #[test]
    fn test_validate_result_no_result_event() {
        let event = super::ClaudeStreamEvent::Init {
            session_id: Some("abc".to_string()),
        };
        let err = super::validate_result(&event);
        assert!(err.is_err(), "Expected Err for non-result event");
        assert!(err.unwrap_err().contains("No result event"));
    }

    #[test]
    fn test_detect_rate_limit_429() {
        let info = super::detect_rate_limit("Error: 429 Too Many Requests");
        assert!(info.is_some(), "Expected rate limit detection for 429");
    }

    #[test]
    fn test_detect_rate_limit_rate_limit_string() {
        let info = super::detect_rate_limit("rate_limit exceeded, please retry");
        assert!(info.is_some(), "Expected rate limit detection for rate_limit");
    }

    #[test]
    fn test_detect_rate_limit_overloaded() {
        let info = super::detect_rate_limit("Server overloaded, try again later");
        assert!(info.is_some(), "Expected rate limit detection for overloaded");
    }

    #[test]
    fn test_detect_rate_limit_normal_line() {
        let info = super::detect_rate_limit("Processing your request...");
        assert!(info.is_none(), "Expected None for normal line");
    }

    #[test]
    fn test_build_command_produces_correct_args() {
        let cmd = super::build_command("write hello world", "/tmp/project", "sk-ant-key123");
        assert_eq!(cmd.cmd, "claude");
        assert!(cmd.args.contains(&"-p".to_string()));
        assert!(cmd.args.contains(&"write hello world".to_string()));
        assert!(cmd.args.contains(&"--output-format".to_string()));
        assert!(cmd.args.contains(&"stream-json".to_string()));
        assert!(cmd.args.contains(&"--verbose".to_string()));
    }

    #[test]
    fn test_build_command_includes_prompt() {
        let cmd = super::build_command("fix the bug", "/home/user", "sk-ant-key");
        let prompt_idx = cmd.args.iter().position(|a| a == "-p").unwrap();
        assert_eq!(cmd.args[prompt_idx + 1], "fix the bug");
    }

    #[test]
    fn test_retry_policy_delay_doubles() {
        let policy = super::RetryPolicy::default_claude();
        let d0 = policy.delay_for_attempt(0); // 5000
        let d1 = policy.delay_for_attempt(1); // 10000
        let d2 = policy.delay_for_attempt(2); // 20000
        assert_eq!(d0, 5_000);
        assert_eq!(d1, 10_000);
        assert_eq!(d2, 20_000);
    }

    #[test]
    fn test_retry_policy_delay_capped_at_max() {
        let policy = super::RetryPolicy::default_claude();
        let d10 = policy.delay_for_attempt(10); // would be huge, capped at 60000
        assert_eq!(d10, 60_000);
    }

    // -----------------------------------------------------------------------
    // New Trait Method Tests
    // -----------------------------------------------------------------------

    use super::super::ToolAdapter;

    #[test]
    fn test_build_interactive_command_no_prompt_flag() {
        let adapter = super::ClaudeAdapter;
        let cmd = adapter.build_interactive_command("/tmp/project", "sk-ant-key");
        assert_eq!(cmd.cmd, "claude");
        // Must NOT contain -p (no prompt in interactive mode)
        assert!(!cmd.args.contains(&"-p".to_string()));
        // Must contain streaming/verbose flags
        assert!(cmd.args.contains(&"--output-format".to_string()));
        assert!(cmd.args.contains(&"stream-json".to_string()));
        assert!(cmd.args.contains(&"--verbose".to_string()));
        assert!(cmd.args.contains(&"--dangerously-skip-permissions".to_string()));
    }

    #[test]
    fn test_build_interactive_command_env() {
        let adapter = super::ClaudeAdapter;
        let cmd = adapter.build_interactive_command("/tmp", "sk-ant-key123");
        let key_env = cmd.env.iter().find(|(k, _)| k == "ANTHROPIC_API_KEY");
        assert!(key_env.is_some());
        assert_eq!(key_env.unwrap().1, "sk-ant-key123");
        assert_eq!(cmd.cwd, "/tmp");
    }

    #[test]
    fn test_build_interactive_command_empty_key() {
        let adapter = super::ClaudeAdapter;
        let cmd = adapter.build_interactive_command("/tmp", "");
        let key_env = cmd.env.iter().find(|(k, _)| k == "ANTHROPIC_API_KEY");
        assert!(key_env.is_none(), "Empty key should not be in env");
    }

    #[test]
    fn test_detect_question_with_question_tag() {
        let adapter = super::ClaudeAdapter;
        let line = r#"{"type":"message","role":"assistant","content":[{"type":"text","text":"[QUESTION] Which database schema should I use?"}]}"#;
        let q = adapter.detect_question(line);
        assert!(q.is_some());
        let q = q.unwrap();
        assert_eq!(q.source_agent, "claude");
        assert!(q.content.contains("[QUESTION]"));
        assert!(matches!(q.question_type, super::super::QuestionType::Technical));
    }

    #[test]
    fn test_detect_question_with_ask_tag() {
        let adapter = super::ClaudeAdapter;
        let line = r#"{"type":"message","role":"assistant","content":[{"type":"text","text":"[ASK] Need clarification on the API design"}]}"#;
        let q = adapter.detect_question(line);
        assert!(q.is_some());
        let q = q.unwrap();
        assert!(q.content.contains("[ASK]"));
    }

    #[test]
    fn test_detect_question_with_permission_keyword() {
        let adapter = super::ClaudeAdapter;
        let line = r#"{"type":"message","role":"assistant","content":[{"type":"text","text":"[QUESTION] Do I have permission to delete these files?"}]}"#;
        let q = adapter.detect_question(line);
        assert!(q.is_some());
        assert!(matches!(q.unwrap().question_type, super::super::QuestionType::Permission));
    }

    #[test]
    fn test_detect_question_with_clarification_keyword() {
        let adapter = super::ClaudeAdapter;
        let line = r#"{"type":"message","role":"assistant","content":[{"type":"text","text":"[QUESTION] I need clarification on the requirement"}]}"#;
        let q = adapter.detect_question(line);
        assert!(q.is_some());
        assert!(matches!(q.unwrap().question_type, super::super::QuestionType::Clarification));
    }

    #[test]
    fn test_detect_question_no_tag_returns_none() {
        let adapter = super::ClaudeAdapter;
        let line = r#"{"type":"message","role":"assistant","content":[{"type":"text","text":"I will implement the feature now."}]}"#;
        assert!(adapter.detect_question(line).is_none());
    }

    #[test]
    fn test_detect_question_tool_use_returns_none() {
        let adapter = super::ClaudeAdapter;
        let line = r#"{"type":"tool_use","name":"Bash","input":{"command":"ls"}}"#;
        assert!(adapter.detect_question(line).is_none());
    }

    #[test]
    fn test_parse_display_output_message() {
        let adapter = super::ClaudeAdapter;
        let line = r#"{"type":"message","role":"assistant","content":[{"type":"text","text":"Analyzing the code..."}]}"#;
        let dl = adapter.parse_display_output(line);
        assert!(dl.is_some());
        let dl = dl.unwrap();
        assert_eq!(dl.content, "Analyzing the code...");
        assert!(matches!(dl.line_type, super::super::DisplayLineType::AgentThinking));
    }

    #[test]
    fn test_parse_display_output_tool_use() {
        let adapter = super::ClaudeAdapter;
        let line = r#"{"type":"tool_use","name":"Bash","input":{"command":"ls"}}"#;
        let dl = adapter.parse_display_output(line);
        assert!(dl.is_some());
        let dl = dl.unwrap();
        assert!(dl.content.contains("[Bash]"));
        assert!(matches!(dl.line_type, super::super::DisplayLineType::ToolExecution));
    }

    #[test]
    fn test_parse_display_output_tool_result() {
        let adapter = super::ClaudeAdapter;
        let line = r#"{"type":"tool_result","output":"file.txt\nother.txt"}"#;
        let dl = adapter.parse_display_output(line);
        assert!(dl.is_some());
        let dl = dl.unwrap();
        assert!(matches!(dl.line_type, super::super::DisplayLineType::Result));
    }

    #[test]
    fn test_parse_display_output_result_event() {
        let adapter = super::ClaudeAdapter;
        let line = r#"{"type":"result","status":"success","result":"All done","num_turns":2}"#;
        let dl = adapter.parse_display_output(line);
        assert!(dl.is_some());
        let dl = dl.unwrap();
        assert_eq!(dl.content, "All done");
        assert!(matches!(dl.line_type, super::super::DisplayLineType::Result));
    }

    #[test]
    fn test_parse_display_output_init_returns_none() {
        let adapter = super::ClaudeAdapter;
        let line = r#"{"type":"init","session_id":"abc"}"#;
        assert!(adapter.parse_display_output(line).is_none());
    }

    #[test]
    fn test_parse_display_output_non_json_returns_none() {
        let adapter = super::ClaudeAdapter;
        assert!(adapter.parse_display_output("Starting Claude Code...").is_none());
    }

    #[test]
    fn test_extract_result_finds_last_result() {
        let adapter = super::ClaudeAdapter;
        let lines = vec![
            r#"{"type":"init","session_id":"abc"}"#.to_string(),
            r#"{"type":"message","role":"assistant","content":[{"type":"text","text":"Working..."}]}"#.to_string(),
            r#"{"type":"result","status":"success","result":"Task completed","num_turns":2}"#.to_string(),
        ];
        let result = adapter.extract_result(&lines);
        assert_eq!(result, Some("Task completed".to_string()));
    }

    #[test]
    fn test_extract_result_empty_lines_returns_none() {
        let adapter = super::ClaudeAdapter;
        assert!(adapter.extract_result(&[]).is_none());
    }

    #[test]
    fn test_extract_result_no_result_event_returns_none() {
        let adapter = super::ClaudeAdapter;
        let lines = vec![
            r#"{"type":"init","session_id":"abc"}"#.to_string(),
            r#"{"type":"message","role":"assistant","content":[{"type":"text","text":"Working..."}]}"#.to_string(),
        ];
        assert!(adapter.extract_result(&lines).is_none());
    }

    #[test]
    fn test_is_turn_complete_result_event() {
        let adapter = super::ClaudeAdapter;
        let line = r#"{"type":"result","status":"success","result":"Done","num_turns":1}"#;
        assert!(adapter.is_turn_complete(line));
    }

    #[test]
    fn test_is_turn_complete_message_event() {
        let adapter = super::ClaudeAdapter;
        let line = r#"{"type":"message","role":"assistant","content":[{"type":"text","text":"Still working"}]}"#;
        assert!(!adapter.is_turn_complete(line));
    }

    #[test]
    fn test_is_turn_complete_non_json() {
        let adapter = super::ClaudeAdapter;
        assert!(!adapter.is_turn_complete("Starting Claude Code..."));
    }
}
