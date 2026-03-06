use tauri::ipc::Channel;

use crate::context::store::ContextStore;
use crate::ipc::events::OutputEvent;
use crate::state::AppState;

/// Spawn a Claude Code subprocess in headless streaming mode.
///
/// Retrieves the API key from the macOS Keychain, builds the Claude CLI command,
/// and spawns it through the process manager with secure env var injection.
/// Automatically prepends recent project context to the prompt.
///
/// Returns the task_id for tracking the process.
#[tauri::command]
#[specta::specta]
pub async fn spawn_claude_task(
    prompt: String,
    project_dir: String,
    on_event: Channel<OutputEvent>,
    state: tauri::State<'_, AppState>,
    context_store: tauri::State<'_, ContextStore>,
) -> Result<String, String> {
    // Clean up stale worktrees from previous crashed sessions (best-effort, non-blocking)
    // This runs on the first task spawn when project_dir is known, satisfying SAFE-03 cleanup requirement.
    {
        let cleanup_dir = project_dir.clone();
        let _ = tokio::task::spawn_blocking(move || {
            let manager =
                crate::worktree::manager::WorktreeManager::new(std::path::PathBuf::from(&cleanup_dir));
            match manager.cleanup_stale_worktrees() {
                Ok(cleaned) => {
                    if !cleaned.is_empty() {
                        eprintln!(
                            "whalecode: cleaned {} stale worktrees: {:?}",
                            cleaned.len(),
                            cleaned
                        );
                    }
                }
                Err(e) => {
                    eprintln!("whalecode: failed to cleanup stale worktrees: {}", e);
                }
            }
        })
        .await;
    }

    // Retrieve API key from keychain (blocking call wrapped for async)
    let api_key = tokio::task::spawn_blocking(|| {
        crate::credentials::keychain::get_api_key()
    })
    .await
    .map_err(|e| format!("Failed to retrieve API key: {}", e))??;

    // Build context preamble from recent project history
    let context_store_clone = context_store.inner().clone();
    let project_dir_clone = project_dir.clone();
    let context_preamble = tokio::task::spawn_blocking(move || {
        context_store_clone.with_conn(|conn| {
            crate::context::injection::build_context_preamble(conn, &project_dir_clone, 5, 2000)
        })
    })
    .await
    .map_err(|e| format!("Context injection failed: {}", e))??;

    let full_prompt = if context_preamble.is_empty() {
        prompt
    } else {
        format!("{}\n\n---\nUser task:\n{}", context_preamble, prompt)
    };

    // Generate task_id upfront so it can be used for both worktree creation and process tracking
    let task_id = uuid::Uuid::new_v4().to_string();

    // Create an isolated worktree for this task
    let task_id_for_wt = task_id.clone();
    let project_dir_for_wt = project_dir.clone();
    let worktree_entry = tokio::task::spawn_blocking(move || {
        let manager =
            crate::worktree::manager::WorktreeManager::new(std::path::PathBuf::from(&project_dir_for_wt));
        manager.create_for_task(&task_id_for_wt)
    })
    .await
    .map_err(|e| format!("Worktree creation failed: {}", e))??;

    // Build Claude-specific command — use worktree path as cwd for isolation
    let worktree_cwd = worktree_entry
        .path
        .to_str()
        .ok_or_else(|| "Invalid worktree path".to_string())?
        .to_string();
    let cmd = crate::adapters::claude::build_command(&full_prompt, &worktree_cwd, &api_key);

    // Convert env Vec<(String, String)> to slice-compatible format
    let env_refs: Vec<(&str, &str)> = cmd.env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();

    // Spawn through existing process manager
    let args: Vec<String> = cmd.args;
    crate::process::manager::spawn_with_env(
        &cmd.cmd,
        &args,
        &cmd.cwd,
        &env_refs,
        on_event,
        state,
        Some(task_id),
    )
    .await
}

/// Store a Claude API key in the macOS Keychain.
///
/// Validates that the key starts with "sk-ant-" before storing.
/// SECURITY: The key is never logged or included in error messages.
#[tauri::command]
#[specta::specta]
pub async fn set_claude_api_key(key: String) -> Result<(), String> {
    // Validate key format
    if !key.starts_with("sk-ant-") {
        return Err("Invalid API key format: must start with 'sk-ant-'".to_string());
    }

    tokio::task::spawn_blocking(move || {
        crate::credentials::keychain::set_api_key(&key)
    })
    .await
    .map_err(|e| format!("Failed to store API key: {}", e))?
}

/// Check whether a Claude API key is stored in the macOS Keychain.
#[tauri::command]
#[specta::specta]
pub async fn has_claude_api_key() -> Result<bool, String> {
    tokio::task::spawn_blocking(|| {
        Ok(crate::credentials::keychain::has_api_key())
    })
    .await
    .map_err(|e| format!("Failed to check API key: {}", e))?
}

/// Validate a Claude Code result JSON for silent failures.
///
/// Parses the result JSON line with `parse_stream_line`, then validates via
/// `validate_result` — checking is_error, empty result, zero turns, and status.
#[tauri::command]
#[specta::specta]
pub async fn validate_claude_result(result_json: String) -> Result<(), String> {
    let event = crate::adapters::claude::parse_stream_line(&result_json)
        .ok_or_else(|| "Failed to parse result JSON".to_string())?;
    crate::adapters::claude::validate_result(&event)
}

/// Delete the stored Claude API key from the macOS Keychain.
#[tauri::command]
#[specta::specta]
pub async fn delete_claude_api_key() -> Result<(), String> {
    tokio::task::spawn_blocking(|| {
        crate::credentials::keychain::delete_api_key()
    })
    .await
    .map_err(|e| format!("Failed to delete API key: {}", e))?
}
