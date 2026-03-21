use tauri::ipc::Channel;

use crate::context::store::ContextStore;
use crate::ipc::events::OutputEvent;
use crate::prompt::{build_prompt_context, PromptEngine};
use crate::router::TaskRouter;
use crate::state::{AppState, CachedPromptContext, ProcessStatus};

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
    let (claude_busy, gemini_busy, codex_busy) = {
        let inner = state.lock();
        let mut cb = false;
        let mut gb = false;
        let mut xb = false;
        for (_id, proc) in inner.processes.iter() {
            if matches!(proc.status, ProcessStatus::Running) {
                if proc.tool_name == "claude" {
                    cb = true;
                }
                if proc.tool_name == "gemini" {
                    gb = true;
                }
                if proc.tool_name == "codex" {
                    xb = true;
                }
            }
        }
        (cb, gb, xb)
    };

    Ok(TaskRouter::suggest(&prompt, claude_busy, gemini_busy, codex_busy))
}

/// RAII guard that releases a tool reservation when dropped.
/// Ensures the reservation is always cleaned up, even on early `?` returns or panics.
struct ReservationGuard {
    state: AppState,
    tool_name: String,
    released: bool,
}

impl ReservationGuard {
    fn new(state: AppState, tool_name: String) -> Self {
        Self {
            state,
            tool_name,
            released: false,
        }
    }

    /// Explicitly release the reservation. Prevents double-release on drop.
    fn release(&mut self) {
        if !self.released {
            crate::process::manager::release_tool_slot(&self.state, &self.tool_name);
            self.released = true;
        }
    }
}

impl Drop for ReservationGuard {
    fn drop(&mut self) {
        self.release();
    }
}

/// Dispatch a task to the specified tool (claude or gemini).
///
/// Enforces max 1 running process per tool. Routes to the correct spawn function
/// based on tool_name, then updates the ProcessEntry with tool metadata.
///
/// Uses an atomic reservation pattern to prevent TOCTOU races: the tool is reserved
/// in the same lock scope as the running-process check, and a RAII guard ensures
/// the reservation is always released (even on early error returns).
#[tauri::command]
#[specta::specta]
pub async fn dispatch_task(
    prompt: String,
    project_dir: String,
    tool_name: String,
    task_id: Option<String>,
    on_event: Channel<OutputEvent>,
    state: tauri::State<'_, AppState>,
    context_store: tauri::State<'_, ContextStore>,
) -> Result<String, String> {
    // Atomically check no running process AND reserve the tool to prevent TOCTOU races.
    // Without this, two rapid dispatch calls could both pass the check before either spawns.
    crate::process::manager::acquire_tool_slot(&*state, &tool_name)?;
    let mut guard = ReservationGuard::new((*state).clone(), tool_name.clone());

    // Cache-aware prompt context: reuse cached context if valid, otherwise rebuild from SQLite
    // CRITICAL: Do NOT hold AppState lock while calling build_prompt_context (deadlock risk)
    let context = {
        let cache_hit = {
            let inner = state.lock();
            if let Some(ref cached) = inner.cached_prompt_context {
                if cached.is_valid(&project_dir) {
                    Some(cached.context.clone())
                } else {
                    None
                }
            } else {
                None
            }
        };

        if let Some(ctx) = cache_hit {
            // Cache hit: increment task counter
            {
                let mut inner = state.lock();
                if let Some(ref mut cached) = inner.cached_prompt_context {
                    cached.tasks_since_cache += 1;
                }
            }
            ctx
        } else {
            // Cache miss: rebuild context from SQLite (lock dropped before this call)
            let store = context_store.inner().clone();
            let project_dir_for_ctx = project_dir.clone();
            let fresh_context = tokio::task::spawn_blocking(move || {
                build_prompt_context(&store, &project_dir_for_ctx)
            })
            .await
            .map_err(|e| format!("Prompt context build failed: {}", e))??;

            // Store in cache
            {
                let mut inner = state.lock();
                inner.cached_prompt_context = Some(CachedPromptContext {
                    context: fresh_context.clone(),
                    project_dir: project_dir.clone(),
                    cached_at: std::time::Instant::now(),
                    tasks_since_cache: 1,
                });
            }
            fresh_context
        }
    };

    // Optimize prompt using the prompt engine
    let optimized_prompt = PromptEngine::optimize(&prompt, &tool_name, &context).optimized_prompt;

    // Route to the correct adapter's spawn function (prompt is already optimized)
    let resolved_task_id = match tool_name.as_str() {
        "claude" => {
            super::claude::spawn_claude_task(
                optimized_prompt,
                project_dir,
                task_id,
                on_event,
                state.clone(),
            )
            .await?
        }
        "gemini" => {
            super::gemini::spawn_gemini_task(
                optimized_prompt,
                project_dir,
                task_id,
                on_event,
                state.clone(),
            )
            .await?
        }
        "codex" => {
            super::codex::spawn_codex_task(
                optimized_prompt,
                project_dir,
                task_id,
                on_event,
                state.clone(),
            )
            .await?
        }
        _ => return Err(format!("Unknown tool: {}", tool_name)),
    };

    // Spawn succeeded — release reservation explicitly (guard would also do it on drop)
    guard.release();

    // Update the ProcessEntry with tool metadata
    {
        let mut inner = state.lock();
        if let Some(entry) = inner.processes.get_mut(&resolved_task_id) {
            entry.tool_name = tool_name;
            let truncated = if prompt.len() > 120 {
                format!("{}...", crate::commands::orchestrator::truncate_str(&prompt, 120))
            } else {
                prompt
            };
            entry.task_description = truncated;
        }
    }

    Ok(resolved_task_id)
}
