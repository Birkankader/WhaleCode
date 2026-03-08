pub mod claude;
pub mod codex;
pub mod gemini;

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
    fn test_retry_policy_shared_behavior() {
        let policy = RetryPolicy { max_retries: 3, base_delay_ms: 5_000, max_delay_ms: 60_000 };
        assert_eq!(policy.delay_for_attempt(0), 5_000);
        assert_eq!(policy.delay_for_attempt(1), 10_000);
        assert_eq!(policy.delay_for_attempt(10), 60_000);
    }
}
