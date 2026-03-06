use crate::context::store::ContextStore;
use crate::prompt::models::OptimizedPrompt;
use crate::prompt::{build_prompt_context, PromptEngine};

/// Preview optimized prompts for all supported tools without dispatching.
///
/// Returns a Vec<OptimizedPrompt> showing how the prompt would be transformed
/// for each tool (claude, gemini). Used by frontend for prompt preview UI.
#[tauri::command]
#[specta::specta]
pub async fn optimize_prompt(
    prompt: String,
    project_dir: String,
    context_store: tauri::State<'_, ContextStore>,
) -> Result<Vec<OptimizedPrompt>, String> {
    let store = context_store.inner().clone();
    let context = tokio::task::spawn_blocking(move || {
        build_prompt_context(&store, &project_dir)
    })
    .await
    .map_err(|e| format!("Failed to build prompt context: {}", e))??;

    Ok(PromptEngine::optimize_all(&prompt, &context))
}
