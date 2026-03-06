use serde::Serialize;

/// Summary of a context event for prompt building (internal only, not IPC-exported).
#[derive(Debug, Clone)]
pub struct ContextEventSummary {
    pub tool_name: String,
    pub event_type: String,
    pub summary: String,
    pub files: Vec<String>,
    pub created_at: String,
}

/// Context data used to enrich prompts with recent project history.
#[derive(Debug, Clone)]
pub struct PromptContext {
    pub recent_events: Vec<ContextEventSummary>,
    pub project_dir: String,
}

/// An optimized prompt for a specific tool, ready for IPC export.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct OptimizedPrompt {
    pub tool_name: String,
    pub original_prompt: String,
    pub optimized_prompt: String,
}
