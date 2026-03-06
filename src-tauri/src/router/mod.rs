pub mod models;

use models::RoutingSuggestion;

pub struct TaskRouter;

impl TaskRouter {
    /// Suggest the best tool for a given prompt based on keyword heuristics and tool availability.
    ///
    /// Scoring: each keyword match adds its weight to the respective tool's score.
    /// If a tool is busy, its score is multiplied by 0.3 (penalty).
    /// Default bias: if both scores are 0.0, claude_score is set to 0.5.
    /// Confidence = (winning_score / 2.0).min(1.0).
    pub fn suggest(prompt: &str, claude_busy: bool, gemini_busy: bool) -> RoutingSuggestion {
        let prompt_lower = prompt.to_lowercase();

        // Keyword weights for each tool
        let claude_keywords: &[(&str, f32)] = &[
            ("refactor", 0.8),
            ("architect", 0.7),
            ("redesign", 0.7),
            ("fix bug", 0.8),
            ("debug", 0.7),
            ("implement", 0.6),
            ("write test", 0.6),
            ("type", 0.3),
            ("fix", 0.5),
        ];

        let gemini_keywords: &[(&str, f32)] = &[
            ("read", 0.6),
            ("analyze", 0.7),
            ("search", 0.6),
            ("find", 0.5),
            ("explain", 0.6),
            ("summarize", 0.7),
            ("review", 0.5),
            ("understand", 0.5),
            ("large", 0.4),
        ];

        // Calculate raw scores
        let mut claude_score: f32 = 0.0;
        for (keyword, weight) in claude_keywords {
            if prompt_lower.contains(keyword) {
                claude_score += weight;
            }
        }

        let mut gemini_score: f32 = 0.0;
        for (keyword, weight) in gemini_keywords {
            if prompt_lower.contains(keyword) {
                gemini_score += weight;
            }
        }

        // Default bias: if no keywords matched, favor Claude
        if claude_score == 0.0 && gemini_score == 0.0 {
            claude_score = 0.5;
        }

        // Apply busy penalties
        if claude_busy {
            claude_score *= 0.3;
        }
        if gemini_busy {
            gemini_score *= 0.3;
        }

        // Availability bonus: if one tool is busy and the other has zero score,
        // give the available tool a small baseline so the suggestion shifts
        if claude_busy && !gemini_busy && gemini_score == 0.0 && claude_score > 0.0 {
            gemini_score = claude_score + 0.1;
        }
        if gemini_busy && !claude_busy && claude_score == 0.0 && gemini_score > 0.0 {
            claude_score = gemini_score + 0.1;
        }

        // Determine winner
        let (suggested, alternative, winning_score, is_busy) = if claude_score >= gemini_score {
            ("claude", "gemini", claude_score, claude_busy)
        } else {
            ("gemini", "claude", gemini_score, gemini_busy)
        };

        let confidence = (winning_score / 2.0).min(1.0);
        let reason = Self::explain_choice(suggested, prompt, is_busy);

        RoutingSuggestion {
            suggested_tool: suggested.to_string(),
            confidence,
            reason,
            alternative_tool: Some(alternative.to_string()),
            tool_available: !is_busy,
        }
    }

    /// Build a human-readable explanation for the routing suggestion.
    fn explain_choice(tool: &str, prompt: &str, busy: bool) -> String {
        let truncated = if prompt.len() > 60 {
            format!("{}...", &prompt[..60])
        } else {
            prompt.to_string()
        };

        if busy {
            format!(
                "{} is recommended for '{}' but is currently busy",
                tool, truncated
            )
        } else {
            format!(
                "{} is recommended for '{}'",
                tool, truncated
            )
        }
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
