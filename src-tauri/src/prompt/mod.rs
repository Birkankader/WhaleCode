pub mod models;
pub mod templates;

use models::{ContextEventSummary, OptimizedPrompt, PromptContext};
use templates::{claude_template, codex_template, default_template, gemini_template};

use crate::context::queries::get_recent_events;
use crate::context::store::ContextStore;

/// The prompt engine transforms a single user prompt into tool-specific optimized versions.
pub struct PromptEngine;

impl PromptEngine {
    /// Optimize a raw prompt for a specific tool, injecting relevant project context.
    pub fn optimize(raw_prompt: &str, tool_name: &str, context: &PromptContext) -> OptimizedPrompt {
        let optimized = match tool_name {
            "claude" => claude_template(raw_prompt, context),
            "gemini" => gemini_template(raw_prompt, context),
            "codex" => codex_template(raw_prompt, context),
            _ => default_template(raw_prompt, context),
        };

        OptimizedPrompt {
            tool_name: tool_name.to_string(),
            original_prompt: raw_prompt.to_string(),
            optimized_prompt: optimized,
        }
    }

    /// Optimize a raw prompt for all supported tools.
    pub fn optimize_all(raw_prompt: &str, context: &PromptContext) -> Vec<OptimizedPrompt> {
        vec![
            Self::optimize(raw_prompt, "claude", context),
            Self::optimize(raw_prompt, "gemini", context),
            Self::optimize(raw_prompt, "codex", context),
        ]
    }
}

/// Build a PromptContext from the ContextStore by fetching recent events.
pub fn build_prompt_context(
    context_store: &ContextStore,
    project_dir: &str,
) -> Result<PromptContext, String> {
    let events = context_store.with_conn(|conn| get_recent_events(conn, project_dir, 5))?;

    let recent_events: Vec<ContextEventSummary> = events
        .into_iter()
        .map(|(event, files)| ContextEventSummary {
            tool_name: event.tool_name,
            event_type: event.event_type,
            summary: event.summary.unwrap_or_else(|| "no summary".to_string()),
            files,
            created_at: event.created_at,
        })
        .collect();

    Ok(PromptContext {
        recent_events,
        project_dir: project_dir.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_context() -> PromptContext {
        PromptContext {
            recent_events: vec![],
            project_dir: "/test/project".to_string(),
        }
    }

    fn context_with_events() -> PromptContext {
        PromptContext {
            recent_events: vec![
                ContextEventSummary {
                    tool_name: "claude".to_string(),
                    event_type: "task_completed".to_string(),
                    summary: "Fixed null pointer in auth module".to_string(),
                    files: vec!["src/auth.rs".to_string(), "src/main.rs".to_string()],
                    created_at: "2026-03-06 10:00:00".to_string(),
                },
                ContextEventSummary {
                    tool_name: "gemini".to_string(),
                    event_type: "task_completed".to_string(),
                    summary: "Added unit tests for parser".to_string(),
                    files: vec!["tests/parser_test.rs".to_string()],
                    created_at: "2026-03-06 09:30:00".to_string(),
                },
            ],
            project_dir: "/test/project".to_string(),
        }
    }

    #[test]
    fn claude_output_contains_planning_preamble() {
        let ctx = context_with_events();
        let result = PromptEngine::optimize("fix bug", "claude", &ctx);
        assert!(
            result.optimized_prompt.contains("## Task Plan"),
            "Claude output should contain planning preamble, got: {}",
            &result.optimized_prompt[..200.min(result.optimized_prompt.len())]
        );
    }

    #[test]
    fn gemini_output_starts_with_context_not_planning() {
        let ctx = context_with_events();
        let result = PromptEngine::optimize("fix bug", "gemini", &ctx);
        assert!(
            result.optimized_prompt.starts_with("Context:"),
            "Gemini output should start with context, got: {}",
            &result.optimized_prompt[..200.min(result.optimized_prompt.len())]
        );
        assert!(
            !result.optimized_prompt.contains("## Task Plan"),
            "Gemini output should NOT contain planning preamble"
        );
    }

    #[test]
    fn claude_and_gemini_produce_different_output() {
        let ctx = context_with_events();
        let claude = PromptEngine::optimize("fix bug", "claude", &ctx);
        let gemini = PromptEngine::optimize("fix bug", "gemini", &ctx);
        assert_ne!(
            claude.optimized_prompt, gemini.optimized_prompt,
            "Claude and Gemini should produce different optimized prompts"
        );
    }

    #[test]
    fn optimize_all_returns_three_entries() {
        let ctx = context_with_events();
        let results = PromptEngine::optimize_all("fix bug", &ctx);
        assert_eq!(results.len(), 3, "optimize_all should return exactly 3 entries");
        assert_eq!(results[0].tool_name, "claude");
        assert_eq!(results[1].tool_name, "gemini");
        assert_eq!(results[2].tool_name, "codex");
    }

    #[test]
    fn context_events_included_in_output() {
        let ctx = context_with_events();
        let claude = PromptEngine::optimize("fix bug", "claude", &ctx);
        assert!(
            claude.optimized_prompt.contains("Fixed null pointer"),
            "Claude output should include event summary"
        );
        assert!(
            claude.optimized_prompt.contains("src/auth.rs"),
            "Claude output should include file paths"
        );

        let gemini = PromptEngine::optimize("fix bug", "gemini", &ctx);
        assert!(
            gemini.optimized_prompt.contains("Fixed null pointer"),
            "Gemini output should include event summary"
        );
        assert!(
            gemini.optimized_prompt.contains("src/auth.rs"),
            "Gemini output should include file paths"
        );
    }

    #[test]
    fn empty_context_produces_clean_prompt() {
        let ctx = empty_context();
        let claude = PromptEngine::optimize("fix bug", "claude", &ctx);
        assert!(
            !claude.optimized_prompt.contains("Project Context"),
            "Empty context should not produce context section in Claude output"
        );
        assert!(
            claude.optimized_prompt.contains("fix bug"),
            "User prompt should still be present"
        );

        let gemini = PromptEngine::optimize("fix bug", "gemini", &ctx);
        assert!(
            !gemini.optimized_prompt.contains("Context:"),
            "Empty context should not produce context section in Gemini output"
        );
        assert!(
            gemini.optimized_prompt.contains("fix bug"),
            "User prompt should still be present"
        );
    }

    #[test]
    fn optimized_prompt_stays_under_8000_chars() {
        // Create context with many large events
        let mut events = Vec::new();
        for i in 0..50 {
            events.push(ContextEventSummary {
                tool_name: "claude".to_string(),
                event_type: "task_completed".to_string(),
                summary: format!("This is a very long summary for event {} that contains lots of text to push the total length over the limit and test truncation behavior properly", i),
                files: vec![
                    format!("src/module_{}/handler.rs", i),
                    format!("src/module_{}/models.rs", i),
                    format!("src/module_{}/tests.rs", i),
                ],
                created_at: format!("2026-03-06 {:02}:00:00", i % 24),
            });
        }
        let ctx = PromptContext {
            recent_events: events,
            project_dir: "/test/project".to_string(),
        };

        let claude = PromptEngine::optimize("fix bug", "claude", &ctx);
        assert!(
            claude.optimized_prompt.len() <= 8000,
            "Claude prompt should be <= 8000 chars, got {}",
            claude.optimized_prompt.len()
        );

        let gemini = PromptEngine::optimize("fix bug", "gemini", &ctx);
        assert!(
            gemini.optimized_prompt.len() <= 8000,
            "Gemini prompt should be <= 8000 chars, got {}",
            gemini.optimized_prompt.len()
        );
    }
}
