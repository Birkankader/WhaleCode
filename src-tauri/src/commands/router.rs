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

/// RAII guard that releases a dispatch slot reservation when dropped.
/// Ensures the reservation is always cleaned up, even on early `?` returns or panics.
struct ReservationGuard {
    state: AppState,
    dispatch_id: String,
    released: bool,
}

impl ReservationGuard {
    fn new(state: AppState, dispatch_id: String) -> Self {
        Self {
            state,
            dispatch_id,
            released: false,
        }
    }

    /// Explicitly release the reservation. Prevents double-release on drop.
    fn release(&mut self) {
        if !self.released {
            crate::process::manager::release_dispatch_slot(&self.state, &self.dispatch_id);
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
    // Generate a unique dispatch_id from the task_id (if provided) or a new UUID.
    // This keys the slot on the individual dispatch, not the agent name, allowing
    // multiple workers of the same agent type to run concurrently.
    let dispatch_id = task_id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // Atomically reserve the dispatch slot to prevent TOCTOU races.
    // Without this, two rapid dispatch calls with the same dispatch_id could
    // both pass the check before either spawns.
    crate::process::manager::acquire_dispatch_slot(&*state, &dispatch_id)?;
    let mut guard = ReservationGuard::new((*state).clone(), dispatch_id);

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
                format!("{}...", crate::utils::truncate_str(&prompt, 120))
            } else {
                prompt
            };
            entry.task_description = truncated;
        }
    }

    Ok(resolved_task_id)
}

/// Inner dispatch logic that accepts owned `AppState` and `ContextStore` directly,
/// without `tauri::State` wrappers. This allows calling from spawned Tokio tasks
/// (e.g., JoinSet workers in the orchestrator) where `tauri::State` lifetimes
/// cannot be satisfied.
///
/// The logic mirrors `dispatch_task` exactly: slot acquisition, prompt context
/// caching, prompt optimization, agent routing, and metadata update.
pub async fn dispatch_task_inner(
    prompt: String,
    project_dir: String,
    tool_name: String,
    task_id: Option<String>,
    on_event: Channel<OutputEvent>,
    state: AppState,
    context_store: ContextStore,
) -> Result<String, String> {
    let dispatch_id = task_id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    crate::process::manager::acquire_dispatch_slot(&state, &dispatch_id)?;
    let mut guard = ReservationGuard::new(state.clone(), dispatch_id);

    // Cache-aware prompt context (same logic as dispatch_task)
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
            {
                let mut inner = state.lock();
                if let Some(ref mut cached) = inner.cached_prompt_context {
                    cached.tasks_since_cache += 1;
                }
            }
            ctx
        } else {
            let store = context_store.clone();
            let project_dir_for_ctx = project_dir.clone();
            let fresh_context = tokio::task::spawn_blocking(move || {
                build_prompt_context(&store, &project_dir_for_ctx)
            })
            .await
            .map_err(|e| format!("Prompt context build failed: {}", e))??;

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

    let optimized_prompt = PromptEngine::optimize(&prompt, &tool_name, &context).optimized_prompt;

    // Route to correct agent — using spawn_with_env_core directly (no tauri::State needed)
    let expanded_dir = super::expand_tilde(&project_dir);
    let cwd = expanded_dir.to_str().ok_or("Invalid project dir path")?.to_string();
    let resolved_task_id = match tool_name.as_str() {
        "claude" => {
            let api_key = tokio::task::spawn_blocking(|| {
                crate::credentials::keychain::get_api_key().unwrap_or_default()
            })
            .await
            .map_err(|e| format!("Failed to retrieve API key: {}", e))?;
            let adapter = crate::adapters::claude::ClaudeAdapter;
            let cmd = crate::adapters::ToolAdapter::build_command(&adapter, &optimized_prompt, &cwd, &api_key);
            let env_refs: Vec<(&str, &str)> = cmd.env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
            let args: Vec<String> = cmd.args;
            crate::process::manager::spawn_with_env_core(
                &cmd.cmd, &args, &cmd.cwd, &env_refs, "", "",
                on_event, &state, task_id, Some(b"1\ny\n"),
            ).await?
        }
        "gemini" => {
            let api_key = tokio::task::spawn_blocking(|| {
                crate::credentials::gemini_keychain::get_gemini_api_key().unwrap_or_default()
            })
            .await
            .map_err(|e| format!("Failed to retrieve Gemini API key: {}", e))?;
            let adapter = crate::adapters::gemini::GeminiAdapter;
            let cmd = crate::adapters::ToolAdapter::build_command(&adapter, &optimized_prompt, &cwd, &api_key);
            let env_refs: Vec<(&str, &str)> = cmd.env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
            let args: Vec<String> = cmd.args;
            crate::process::manager::spawn_with_env_core(
                &cmd.cmd, &args, &cmd.cwd, &env_refs, "", "",
                on_event, &state, task_id, None,
            ).await?
        }
        "codex" => {
            let api_key = tokio::task::spawn_blocking(|| {
                crate::credentials::codex_keychain::get_codex_api_key().unwrap_or_default()
            })
            .await
            .map_err(|e| format!("Failed to retrieve Codex API key: {}", e))?;
            let adapter = crate::adapters::codex::CodexAdapter;
            let cmd = crate::adapters::ToolAdapter::build_command(&adapter, &optimized_prompt, &cwd, &api_key);
            let env_refs: Vec<(&str, &str)> = cmd.env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
            let args: Vec<String> = cmd.args;
            crate::process::manager::spawn_with_env_core(
                &cmd.cmd, &args, &cmd.cwd, &env_refs, "", "",
                on_event, &state, task_id, None,
            ).await?
        }
        _ => return Err(format!("Unknown tool: {}", tool_name)),
    };

    guard.release();

    // Update ProcessEntry with tool metadata
    {
        let mut inner = state.lock();
        if let Some(entry) = inner.processes.get_mut(&resolved_task_id) {
            entry.tool_name = tool_name;
            let truncated = if prompt.len() > 120 {
                format!("{}...", crate::utils::truncate_str(&prompt, 120))
            } else {
                prompt
            };
            entry.task_description = truncated;
        }
    }

    Ok(resolved_task_id)
}
