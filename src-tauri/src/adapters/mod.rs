pub mod claude;
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
