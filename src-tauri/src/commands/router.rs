use tauri::ipc::Channel;

use crate::context::store::ContextStore;
use crate::ipc::events::OutputEvent;
use crate::prompt::{build_prompt_context, PromptEngine};
use crate::router::TaskRouter;
use crate::state::{AppState, ProcessStatus};

/// Suggest the best tool for a given prompt based on keyword heuristics and tool availability.
///
/// Checks which tools currently have running processes to determine busyness,
/// then delegates to TaskRouter::suggest for the routing decision.
#[tauri::command]
#[specta::specta]
pub async fn suggest_tool(
    prompt: String,
    state: tauri::State<'_, AppState>,
) -> Result<crate::router::models::RoutingSuggestion, String> {
    let (claude_busy, gemini_busy) = {
        let inner = state.lock().map_err(|e| e.to_string())?;
        let mut cb = false;
        let mut gb = false;
        for (_id, proc) in inner.processes.iter() {
            if matches!(proc.status, ProcessStatus::Running) {
                if proc.tool_name == "claude" {
                    cb = true;
                }
                if proc.tool_name == "gemini" {
                    gb = true;
                }
            }
        }
        (cb, gb)
    };

    Ok(TaskRouter::suggest(&prompt, claude_busy, gemini_busy))
}

/// Dispatch a task to the specified tool (claude or gemini).
///
/// Enforces max 1 running process per tool. Routes to the correct spawn function
/// based on tool_name, then updates the ProcessEntry with tool metadata.
#[tauri::command]
#[specta::specta]
pub async fn dispatch_task(
    prompt: String,
    project_dir: String,
    tool_name: String,
    on_event: Channel<OutputEvent>,
    state: tauri::State<'_, AppState>,
    context_store: tauri::State<'_, ContextStore>,
) -> Result<String, String> {
    // Check if the requested tool already has a running process
    {
        let inner = state.lock().map_err(|e| e.to_string())?;
        for (_id, proc) in inner.processes.iter() {
            if proc.tool_name == tool_name && matches!(proc.status, ProcessStatus::Running) {
                return Err(format!("{} is already running a task", tool_name));
            }
        }
    }

    // Optimize prompt using the prompt engine (context injection happens here, not in spawn functions)
    let store = context_store.inner().clone();
    let project_dir_for_ctx = project_dir.clone();
    let tool_name_for_opt = tool_name.clone();
    let prompt_for_opt = prompt.clone();
    let optimized = tokio::task::spawn_blocking(move || {
        let context = build_prompt_context(&store, &project_dir_for_ctx)?;
        Ok::<_, String>(PromptEngine::optimize(&prompt_for_opt, &tool_name_for_opt, &context))
    })
    .await
    .map_err(|e| format!("Prompt optimization failed: {}", e))??;

    let optimized_prompt = optimized.optimized_prompt;

    // Route to the correct adapter's spawn function (prompt is already optimized)
    let task_id = match tool_name.as_str() {
        "claude" => {
            super::claude::spawn_claude_task(
                optimized_prompt,
                project_dir,
                on_event,
                state.clone(),
            )
            .await?
        }
        "gemini" => {
            super::gemini::spawn_gemini_task(
                optimized_prompt,
                project_dir,
                on_event,
                state.clone(),
            )
            .await?
        }
        _ => return Err(format!("Unknown tool: {}", tool_name)),
    };

    // Update the ProcessEntry with tool metadata
    {
        let mut inner = state.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = inner.processes.get_mut(&task_id) {
            entry.tool_name = tool_name;
            let truncated = if prompt.len() > 120 {
                format!("{}...", &prompt[..120])
            } else {
                prompt
            };
            entry.task_description = truncated;
        }
    }

    Ok(task_id)
}
