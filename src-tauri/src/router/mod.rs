pub mod dag;
pub mod models;
pub mod orchestrator;

use models::RoutingSuggestion;

pub struct TaskRouter;

impl TaskRouter {
    /// Suggest the best tool for a given prompt based on keyword heuristics and tool availability.
    ///
    /// Scoring: each keyword match adds its weight to the respective tool's score.
    /// If a tool is busy, its score is multiplied by 0.3 (penalty).
    /// Default bias: if both scores are 0.0, claude_score is set to 0.5.
    /// Confidence = (winning_score / 2.0).min(1.0).
    pub fn suggest(prompt: &str, claude_busy: bool, gemini_busy: bool, codex_busy: bool) -> RoutingSuggestion {
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

        let codex_keywords: &[(&str, f32)] = &[
            ("generate", 0.7),
            ("complete", 0.6),
            ("code gen", 0.8),
            ("openai", 0.9),
            ("codex", 0.9),
            ("scaffold", 0.6),
            ("boilerplate", 0.6),
            ("prototype", 0.5),
            ("stub", 0.5),
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

        let mut codex_score: f32 = 0.0;
        for (keyword, weight) in codex_keywords {
            if prompt_lower.contains(keyword) {
                codex_score += weight;
            }
        }

        // Default bias: if no keywords matched, favor Claude
        if claude_score == 0.0 && gemini_score == 0.0 && codex_score == 0.0 {
            claude_score = 0.5;
        }

        // Apply busy penalties
        if claude_busy {
            claude_score *= 0.3;
        }
        if gemini_busy {
            gemini_score *= 0.3;
        }
        if codex_busy {
            codex_score *= 0.3;
        }

        // Availability bonus: if the top-scoring tool is busy, boost free tools
        // so the suggestion shifts away from busy tools.
        // Order: [claude, gemini, codex] — first free tool wins ties.
        let busy_max = [
            (claude_score, claude_busy),
            (gemini_score, gemini_busy),
            (codex_score, codex_busy),
        ]
        .iter()
        .filter(|(_, busy)| *busy)
        .map(|(s, _)| *s)
        .fold(0.0f32, f32::max);

        if busy_max > 0.0 {
            // Boost the first free tool that has the highest score (or all at 0.0)
            let free_tools: &mut [(& mut f32, bool)] = &mut [
                (&mut claude_score, claude_busy),
                (&mut gemini_score, gemini_busy),
                (&mut codex_score, codex_busy),
            ];
            // Find the best free score
            let best_free = free_tools
                .iter()
                .filter(|(_, busy)| !*busy)
                .map(|(s, _)| **s)
                .fold(f32::NEG_INFINITY, f32::max);
            // Boost the first free tool with that score
            for (score, busy) in free_tools.iter_mut() {
                if !*busy && **score == best_free && **score <= busy_max {
                    **score = busy_max + 0.1;
                    break; // only boost one
                }
            }
        }

        // Collect scores into a sortable list
        let mut scores = vec![
            ("claude", claude_score, claude_busy),
            ("gemini", gemini_score, gemini_busy),
            ("codex", codex_score, codex_busy),
        ];

        // Sort by score descending
        scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        let (suggested, winning_score, is_busy) = (scores[0].0, scores[0].1, scores[0].2);
        let alternative = scores[1].0;

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
        let result = TaskRouter::suggest("refactor the auth module", false, false, false);
        assert_eq!(result.suggested_tool, "claude");
        assert!(result.confidence > 0.3, "confidence {} should be > 0.3", result.confidence);
    }

    #[test]
    fn suggest_gemini_for_analysis() {
        let result = TaskRouter::suggest("analyze the codebase structure", false, false, false);
        assert_eq!(result.suggested_tool, "gemini");
        assert!(result.confidence > 0.3, "confidence {} should be > 0.3", result.confidence);
    }

    #[test]
    fn suggest_gemini_for_reading() {
        let result = TaskRouter::suggest("read all files in src/", false, false, false);
        assert_eq!(result.suggested_tool, "gemini");
    }

    #[test]
    fn suggest_claude_for_bug_fix() {
        let result = TaskRouter::suggest("fix bug in login", false, false, false);
        assert_eq!(result.suggested_tool, "claude");
    }

    #[test]
    fn suggest_codex_for_code_gen() {
        let result = TaskRouter::suggest("use codex to generate boilerplate", false, false, false);
        assert_eq!(result.suggested_tool, "codex");
    }

    #[test]
    fn default_bias_favors_claude() {
        let result = TaskRouter::suggest("do something", false, false, false);
        assert_eq!(result.suggested_tool, "claude");
    }

    #[test]
    fn penalize_busy_claude() {
        let result = TaskRouter::suggest("refactor auth", true, false, false);
        assert_eq!(result.suggested_tool, "gemini", "should suggest gemini when claude is busy");
    }

    #[test]
    fn penalize_busy_gemini() {
        let result = TaskRouter::suggest("analyze code", false, true, false);
        assert_eq!(result.suggested_tool, "claude", "should suggest claude when gemini is busy");
    }

    #[test]
    fn both_busy_returns_suggestion() {
        let result = TaskRouter::suggest("anything", true, true, true);
        assert!(!result.suggested_tool.is_empty(), "should still return a suggestion");
    }

    #[test]
    fn suggestion_has_all_fields() {
        let result = TaskRouter::suggest("refactor the auth module", false, false, false);
        assert!(!result.reason.is_empty(), "reason should not be empty");
        assert!(result.alternative_tool.is_some(), "should have alternative tool");
        assert!(result.confidence >= 0.0 && result.confidence <= 1.0, "confidence should be 0.0-1.0");
        assert!(result.tool_available, "tool should be available when not busy");
    }

    #[test]
    fn tool_not_available_when_busy() {
        let result = TaskRouter::suggest("refactor auth", true, false, false);
        // When claude is busy and gemini is suggested, gemini should be available
        if result.suggested_tool == "gemini" {
            assert!(result.tool_available, "gemini should be available");
        }
        // When we suggest the busy tool anyway, it should report not available
        let result2 = TaskRouter::suggest("anything", true, true, true);
        // all busy — the suggested tool is not available
        assert!(!result2.tool_available, "suggested tool should not be available when all are busy");
    }
}
