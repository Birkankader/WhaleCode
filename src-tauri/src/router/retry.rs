/// Configuration for retry behavior.
pub struct RetryConfig {
    pub max_retries: u32,
    pub base_delay_ms: u64,
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            max_retries: 2,
            base_delay_ms: 5000,
        }
    }
}

/// Check if another retry attempt is allowed.
pub fn should_retry(current_attempt: u32, config: &RetryConfig) -> bool {
    current_attempt < config.max_retries
}

/// Calculate exponential backoff delay in milliseconds.
pub fn retry_delay_ms(attempt: u32, config: &RetryConfig) -> u64 {
    config.base_delay_ms * 2u64.pow(attempt)
}

/// Select fallback agent. Returns first available agent that isn't the failed one.
/// Preference order: claude > gemini > codex.
pub fn select_fallback_agent(failed_agent: &str, available: &[&str]) -> Option<String> {
    let preference = ["claude", "gemini", "codex"];
    preference
        .iter()
        .find(|&&a| a != failed_agent && available.contains(&a))
        .map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_select_fallback_agent() {
        let result = select_fallback_agent("claude", &["claude", "gemini", "codex"]);
        assert_eq!(result, Some("gemini".to_string()));
    }

    #[test]
    fn test_fallback_skips_same_agent() {
        let result = select_fallback_agent("gemini", &["claude", "gemini", "codex"]);
        assert_eq!(result, Some("claude".to_string()));
    }

    #[test]
    fn test_fallback_none_when_only_agent() {
        let result = select_fallback_agent("claude", &["claude"]);
        assert_eq!(result, None);
    }

    #[test]
    fn test_should_retry() {
        let policy = RetryConfig {
            max_retries: 2,
            base_delay_ms: 1000,
        };
        assert!(should_retry(0, &policy));
        assert!(should_retry(1, &policy));
        assert!(!should_retry(2, &policy));
    }

    #[test]
    fn test_retry_delay_exponential() {
        let config = RetryConfig {
            max_retries: 3,
            base_delay_ms: 1000,
        };
        assert_eq!(retry_delay_ms(0, &config), 1000);
        assert_eq!(retry_delay_ms(1, &config), 2000);
        assert_eq!(retry_delay_ms(2, &config), 4000);
    }
}
