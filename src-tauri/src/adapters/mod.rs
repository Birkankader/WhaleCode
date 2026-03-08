pub mod claude;
pub mod codex;
pub mod gemini;

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Shared Types for ToolAdapter Trait
// ---------------------------------------------------------------------------

/// Unified command structure for spawning any CLI tool subprocess.
/// Replaces tool-specific ClaudeCommand/GeminiCommand at the trait level.
pub struct ToolCommand {
    pub cmd: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: String,
}

/// Shared rate limit information returned by any adapter's detect_rate_limit.
pub struct RateLimitInfo {
    pub retry_after_secs: Option<u64>,
}

/// Shared exponential backoff retry policy for rate-limited requests.
pub struct RetryPolicy {
    pub max_retries: u32,
    pub base_delay_ms: u64,
    pub max_delay_ms: u64,
}

impl RetryPolicy {
    /// Calculate the delay in milliseconds for a given attempt (0-indexed).
    /// Delay = base * 2^attempt, capped at max_delay_ms.
    pub fn delay_for_attempt(&self, attempt: u32) -> u64 {
        let delay = self.base_delay_ms.saturating_mul(2u64.saturating_pow(attempt));
        delay.min(self.max_delay_ms)
    }
}

// ---------------------------------------------------------------------------
// Orchestration Types
// ---------------------------------------------------------------------------

/// A question detected from a worker agent's output stream.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct Question {
    pub source_agent: String,
    pub content: String,
    pub question_type: QuestionType,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub enum QuestionType {
    Technical,
    Clarification,
    Permission,
}

impl QuestionType {
    /// Classify question type from text content using case-insensitive matching.
    pub fn from_text(text: &str) -> Self {
        let lower = text.to_lowercase();
        if lower.contains("permission") {
            QuestionType::Permission
        } else if lower.contains("clarif") {
            QuestionType::Clarification
        } else {
            QuestionType::Technical
        }
    }
}

/// Normalized display line for uniform agent output rendering.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct DisplayLine {
    pub content: String,
    pub line_type: DisplayLineType,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub enum DisplayLineType {
    AgentThinking,
    ToolExecution,
    Result,
    Info,
}

/// Structured response when master agent needs user input.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AskUserResponse {
    pub ask_user: String,
}

// ---------------------------------------------------------------------------
// ToolAdapter Trait
// ---------------------------------------------------------------------------

/// Shared contract for CLI tool adapters (Claude Code, Gemini CLI, future tools).
///
/// Uses `&self` methods so adapters can be instantiated as zero-cost unit structs.
/// This trait enables polymorphic dispatch in the Task Router (Phase 7) and ensures
/// adding a third adapter requires only implementing this trait.
pub trait ToolAdapter {
    /// Build the CLI command for this tool with the given prompt, working directory, and API key.
    fn build_command(&self, prompt: &str, cwd: &str, api_key: &str) -> ToolCommand;

    /// Parse a single NDJSON line from the tool's output stream.
    /// Returns a JSON string representation of the parsed event for cross-adapter validation,
    /// or None if the line is not valid JSON for this adapter.
    fn parse_stream_line(&self, line: &str) -> Option<String>;

    /// Validate a result JSON string for silent failures.
    /// Returns Ok(()) if the result is valid, Err(description) if it indicates a failure.
    fn validate_result_json(&self, result_json: &str) -> Result<(), String>;

    /// Detect rate-limit or quota errors in a stderr/stdout line.
    fn detect_rate_limit(&self, line: &str) -> Option<RateLimitInfo>;

    /// Get the default retry policy for this tool.
    fn retry_policy(&self) -> RetryPolicy;

    /// Human-readable name for this tool (e.g., "Claude Code", "Gemini CLI").
    fn name(&self) -> &str;

    /// Build the CLI command for interactive (long-lived) mode.
    /// Unlike `build_command`, this does NOT include `-p <prompt>` so the process
    /// stays alive and accepts input via stdin.
    fn build_interactive_command(&self, cwd: &str, api_key: &str) -> ToolCommand;

    /// Detect a question in a parsed output line from a worker agent.
    /// Returns `Some(Question)` if the line contains a question tag (e.g. `[QUESTION]`, `[ASK]`).
    fn detect_question(&self, line: &str) -> Option<Question>;

    /// Parse an output line into a normalized `DisplayLine` for uniform rendering.
    /// Returns `None` if the line is not parseable or should be skipped.
    fn parse_display_output(&self, line: &str) -> Option<DisplayLine>;

    /// Extract the final result text from collected output lines.
    /// Iterates in reverse to find the result event and returns its text.
    fn extract_result(&self, output_lines: &[String]) -> Option<String>;

    /// Returns true if the given output line signals that the agent's turn is complete.
    fn is_turn_complete(&self, line: &str) -> bool;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::claude::ClaudeAdapter;
    use crate::adapters::codex::CodexAdapter;
    use crate::adapters::gemini::GeminiAdapter;

    #[test]
    fn test_claude_adapter_implements_tool_trait() {
        let adapter = ClaudeAdapter;
        assert_eq!(adapter.name(), "Claude Code");
        let cmd = adapter.build_command("test prompt", "/tmp", "sk-ant-key");
        assert_eq!(cmd.cmd, "claude");
        assert!(!cmd.args.is_empty());
        let policy = adapter.retry_policy();
        assert_eq!(policy.max_retries, 3);
    }

    #[test]
    fn test_gemini_adapter_implements_tool_trait() {
        let adapter = GeminiAdapter;
        assert_eq!(adapter.name(), "Gemini CLI");
        let cmd = adapter.build_command("test prompt", "/tmp", "gemini-key");
        assert_eq!(cmd.cmd, "gemini");
        assert!(cmd.args.contains(&"--yolo".to_string()));
        let policy = adapter.retry_policy();
        assert_eq!(policy.max_retries, 3);
    }

    #[test]
    fn test_codex_adapter_implements_tool_trait() {
        let adapter = CodexAdapter;
        assert_eq!(adapter.name(), "Codex CLI");
        let cmd = adapter.build_command("test prompt", "/tmp", "sk-key");
        assert_eq!(cmd.cmd, "codex");
        assert!(cmd.args.contains(&"--full-auto".to_string()));
        let policy = adapter.retry_policy();
        assert_eq!(policy.max_retries, 3);
    }

    #[test]
    fn test_adapters_are_interchangeable() {
        // All adapters can be used through the same trait reference
        let adapters: Vec<Box<dyn ToolAdapter>> = vec![
            Box::new(ClaudeAdapter),
            Box::new(GeminiAdapter),
            Box::new(CodexAdapter),
        ];
        for adapter in &adapters {
            let cmd = adapter.build_command("hello", "/tmp", "key");
            assert!(!cmd.cmd.is_empty());
            assert!(!cmd.args.is_empty());
            // Rate limit detection works through trait
            assert!(adapter.detect_rate_limit("429 error").is_some());
            assert!(adapter.detect_rate_limit("normal line").is_none());
        }
    }

    #[test]
    fn test_adapters_interchangeable_new_methods() {
        let adapters: Vec<Box<dyn ToolAdapter>> = vec![
            Box::new(ClaudeAdapter),
            Box::new(GeminiAdapter),
            Box::new(CodexAdapter),
        ];
        for adapter in &adapters {
            // build_interactive_command works through trait
            let cmd = adapter.build_interactive_command("/tmp", "key");
            assert!(!cmd.cmd.is_empty());
            // interactive command must not contain -p
            assert!(!cmd.args.contains(&"-p".to_string()));
            // is_turn_complete on garbage returns false
            assert!(!adapter.is_turn_complete("not json"));
            // detect_question on garbage returns None
            assert!(adapter.detect_question("not json").is_none());
            // parse_display_output on garbage returns None
            assert!(adapter.parse_display_output("not json").is_none());
            // extract_result on empty returns None
            assert!(adapter.extract_result(&[]).is_none());
        }
    }

    #[test]
    fn test_retry_policy_shared_behavior() {
        let policy = RetryPolicy { max_retries: 3, base_delay_ms: 5_000, max_delay_ms: 60_000 };
        assert_eq!(policy.delay_for_attempt(0), 5_000);
        assert_eq!(policy.delay_for_attempt(1), 10_000);
        assert_eq!(policy.delay_for_attempt(10), 60_000);
    }

    // -----------------------------------------------------------------------
    // New Type Tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_question_type_debug() {
        let q = Question {
            source_agent: "codex".to_string(),
            content: "Which schema to use?".to_string(),
            question_type: QuestionType::Clarification,
        };
        assert_eq!(q.source_agent, "codex");
        assert!(matches!(q.question_type, QuestionType::Clarification));
    }

    #[test]
    fn test_display_line_types() {
        let line = DisplayLine {
            content: "Analyzing files...".to_string(),
            line_type: DisplayLineType::AgentThinking,
        };
        assert_eq!(line.content, "Analyzing files...");
        assert!(matches!(line.line_type, DisplayLineType::AgentThinking));
    }

    #[test]
    fn test_ask_user_response() {
        let resp = AskUserResponse {
            ask_user: "Which database schema?".to_string(),
        };
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("ask_user"));
        let parsed: AskUserResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.ask_user, "Which database schema?");
    }

    #[test]
    fn test_question_serialization_roundtrip() {
        let q = Question {
            source_agent: "claude".to_string(),
            content: "Should I use async?".to_string(),
            question_type: QuestionType::Technical,
        };
        let json = serde_json::to_string(&q).unwrap();
        let parsed: Question = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.source_agent, "claude");
        assert_eq!(parsed.content, "Should I use async?");
        assert!(matches!(parsed.question_type, QuestionType::Technical));
    }

    #[test]
    fn test_question_type_from_text_case_insensitive() {
        // Permission variants
        assert!(matches!(QuestionType::from_text("Do I have permission?"), QuestionType::Permission));
        assert!(matches!(QuestionType::from_text("PERMISSION denied"), QuestionType::Permission));
        assert!(matches!(QuestionType::from_text("need Permission to proceed"), QuestionType::Permission));

        // Clarification variants
        assert!(matches!(QuestionType::from_text("need clarification"), QuestionType::Clarification));
        assert!(matches!(QuestionType::from_text("CLARIFY this please"), QuestionType::Clarification));
        assert!(matches!(QuestionType::from_text("Could you Clarify?"), QuestionType::Clarification));

        // Technical (default)
        assert!(matches!(QuestionType::from_text("Which database to use?"), QuestionType::Technical));
        assert!(matches!(QuestionType::from_text(""), QuestionType::Technical));

        // Permission takes priority over clarification
        assert!(matches!(
            QuestionType::from_text("Need clarification on permission"),
            QuestionType::Permission
        ));
    }

    #[test]
    fn test_display_line_serialization_roundtrip() {
        let line = DisplayLine {
            content: "[Bash] ls -la".to_string(),
            line_type: DisplayLineType::ToolExecution,
        };
        let json = serde_json::to_string(&line).unwrap();
        let parsed: DisplayLine = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.content, "[Bash] ls -la");
        assert!(matches!(parsed.line_type, DisplayLineType::ToolExecution));
    }
}
