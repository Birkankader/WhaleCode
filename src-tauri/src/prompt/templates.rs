use super::models::{ContextEventSummary, PromptContext};

const MAX_PROMPT_CHARS: usize = 8000;

/// Format context events in Claude's structured markdown style.
fn format_context_for_claude(events: &[ContextEventSummary]) -> String {
    if events.is_empty() {
        return String::new();
    }

    let mut section = String::from("## Project Context\n\n");
    for event in events {
        let files_str = if event.files.is_empty() {
            String::new()
        } else {
            format!(" [{}]", event.files.join(", "))
        };
        section.push_str(&format!(
            "- **{}** ({}) at {}: {}{}\n",
            event.tool_name, event.event_type, event.created_at, event.summary, files_str
        ));
    }
    section.push_str("\nConsider these recent changes when planning your approach.");
    section
}

/// Format context events in Gemini's flat list style.
fn format_context_for_gemini(events: &[ContextEventSummary]) -> String {
    if events.is_empty() {
        return String::new();
    }

    let mut section = String::from("Context: Recent project changes:\n");
    for event in events {
        let files_str = if event.files.is_empty() {
            String::new()
        } else {
            format!(" [{}]", event.files.join(", "))
        };
        section.push_str(&format!(
            "- {} by {} at {}{}\n",
            event.summary, event.tool_name, event.created_at, files_str
        ));
    }
    section
}

/// Truncate context section to keep total prompt under MAX_PROMPT_CHARS.
fn truncate_to_fit(base: &str, context_section: &str, task_section: &str) -> String {
    let base_len = base.len() + task_section.len() + 20; // 20 for separators
    if base_len + context_section.len() <= MAX_PROMPT_CHARS {
        return context_section.to_string();
    }
    let available = MAX_PROMPT_CHARS.saturating_sub(base_len);
    if available < 50 {
        return String::new(); // Not enough room for context
    }
    format!("{}...(truncated)", &context_section[..available.min(context_section.len())])
}

/// Produce a structured Claude prompt with planning preamble and context sections.
pub fn claude_template(prompt: &str, context: &PromptContext) -> String {
    let planning = "## Task Plan\n\nBefore making changes, analyze the codebase and plan your approach.";
    let task_section = format!("## Task\n\n{}", prompt);
    let context_section = format_context_for_claude(&context.recent_events);

    if context_section.is_empty() {
        let result = format!("{}\n\n---\n\n{}", planning, task_section);
        return truncate_final(result);
    }

    let truncated_context = truncate_to_fit(planning, &context_section, &task_section);
    let result = format!(
        "{}\n\n---\n\n{}\n\n---\n\n{}",
        planning, truncated_context, task_section
    );
    truncate_final(result)
}

/// Produce a flat Gemini prompt with context-first structure.
pub fn gemini_template(prompt: &str, context: &PromptContext) -> String {
    let task_section = format!("Task: {}", prompt);
    let context_section = format_context_for_gemini(&context.recent_events);

    if context_section.is_empty() {
        return truncate_final(task_section);
    }

    let truncated_context = truncate_to_fit("", &context_section, &task_section);
    let result = format!("{}\n\n{}", truncated_context, task_section);
    truncate_final(result)
}

/// Default template falls back to Claude-style (safe default).
pub fn default_template(prompt: &str, context: &PromptContext) -> String {
    claude_template(prompt, context)
}

/// Final safety net: hard-truncate to MAX_PROMPT_CHARS.
fn truncate_final(s: String) -> String {
    if s.len() <= MAX_PROMPT_CHARS {
        s
    } else {
        format!("{}...", &s[..MAX_PROMPT_CHARS - 3])
    }
}
