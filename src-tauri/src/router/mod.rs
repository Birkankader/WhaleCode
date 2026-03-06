pub mod models;

use models::RoutingSuggestion;

pub struct TaskRouter;

impl TaskRouter {
    pub fn suggest(_prompt: &str, _claude_busy: bool, _gemini_busy: bool) -> RoutingSuggestion {
        todo!()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suggest_claude_for_refactoring() {
        let result = TaskRouter::suggest("refactor the auth module", false, false);
        assert_eq!(result.suggested_tool, "claude");
        assert!(result.confidence > 0.3, "confidence {} should be > 0.3", result.confidence);
    }

    #[test]
    fn suggest_gemini_for_analysis() {
        let result = TaskRouter::suggest("analyze the codebase structure", false, false);
        assert_eq!(result.suggested_tool, "gemini");
        assert!(result.confidence > 0.3, "confidence {} should be > 0.3", result.confidence);
    }

    #[test]
    fn suggest_gemini_for_reading() {
        let result = TaskRouter::suggest("read all files in src/", false, false);
        assert_eq!(result.suggested_tool, "gemini");
    }

    #[test]
    fn suggest_claude_for_bug_fix() {
        let result = TaskRouter::suggest("fix bug in login", false, false);
        assert_eq!(result.suggested_tool, "claude");
    }

    #[test]
    fn default_bias_favors_claude() {
        let result = TaskRouter::suggest("do something", false, false);
        assert_eq!(result.suggested_tool, "claude");
    }

    #[test]
    fn penalize_busy_claude() {
        let result = TaskRouter::suggest("refactor auth", true, false);
        assert_eq!(result.suggested_tool, "gemini", "should suggest gemini when claude is busy");
    }

    #[test]
    fn penalize_busy_gemini() {
        let result = TaskRouter::suggest("analyze code", false, true);
        assert_eq!(result.suggested_tool, "claude", "should suggest claude when gemini is busy");
    }

    #[test]
    fn both_busy_returns_suggestion() {
        let result = TaskRouter::suggest("anything", true, true);
        assert!(!result.suggested_tool.is_empty(), "should still return a suggestion");
    }

    #[test]
    fn suggestion_has_all_fields() {
        let result = TaskRouter::suggest("refactor the auth module", false, false);
        assert!(!result.reason.is_empty(), "reason should not be empty");
        assert!(result.alternative_tool.is_some(), "should have alternative tool");
        assert!(result.confidence >= 0.0 && result.confidence <= 1.0, "confidence should be 0.0-1.0");
        assert!(result.tool_available, "tool should be available when not busy");
    }

    #[test]
    fn tool_not_available_when_busy() {
        let result = TaskRouter::suggest("refactor auth", true, false);
        // When claude is busy and gemini is suggested, gemini should be available
        if result.suggested_tool == "gemini" {
            assert!(result.tool_available, "gemini should be available");
        }
        // When we suggest the busy tool anyway, it should report not available
        let result2 = TaskRouter::suggest("anything", true, true);
        // both busy — the suggested tool is not available
        assert!(!result2.tool_available, "suggested tool should not be available when both are busy");
    }
}
