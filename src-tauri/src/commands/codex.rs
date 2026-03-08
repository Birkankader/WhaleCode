use tauri::ipc::Channel;

use crate::ipc::events::OutputEvent;
use crate::state::AppState;

/// Spawn a Codex CLI subprocess in headless streaming mode.
///
/// Retrieves the API key from the macOS Keychain, builds the Codex CLI command,
/// and spawns it through the process manager with secure env var injection.
/// The prompt is expected to be already optimized by the prompt engine (dispatch_task handles this).
///
/// Returns the task_id for tracking the process.
#[tauri::command]
#[specta::specta]
pub async fn spawn_codex_task(
    prompt: String,
    project_dir: String,
    task_id: Option<String>,
    on_event: Channel<OutputEvent>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    // Retrieve Codex (OpenAI) API key from keychain if available (optional — CLI handles its own auth)
    let api_key = tokio::task::spawn_blocking(|| {
        crate::credentials::codex_keychain::get_codex_api_key().unwrap_or_default()
    })
    .await
    .map_err(|e| format!("Failed to retrieve Codex API key: {}", e))?;

    // Prompt is already optimized by dispatch_task's prompt engine — use directly
    let full_prompt = prompt;

    // Use provided task_id or generate a new one
    let task_id = task_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // Use project directory directly (no worktree isolation)
    let expanded_dir = super::expand_tilde(&project_dir);
    let cwd = expanded_dir.to_str().ok_or("Invalid project dir path")?;
    let adapter = crate::adapters::codex::CodexAdapter;
    let cmd = crate::adapters::ToolAdapter::build_command(&adapter, &full_prompt, cwd, &api_key);

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

/// Store a Codex (OpenAI) API key in the macOS Keychain.
///
/// Validates that the key starts with "sk-" (OpenAI key format) and is non-empty.
/// SECURITY: The key is never logged or included in error messages.
#[tauri::command]
#[specta::specta]
pub async fn set_codex_api_key(key: String) -> Result<(), String> {
    // Validate key starts with "sk-" (OpenAI key format)
    if key.trim().is_empty() {
        return Err("API key cannot be empty".to_string());
    }
    if !key.starts_with("sk-") {
        return Err("OpenAI API key must start with 'sk-'".to_string());
    }
    if key.len() <= 10 {
        return Err("API key is too short (must be longer than 10 characters)".to_string());
    }

    tokio::task::spawn_blocking(move || {
        crate::credentials::codex_keychain::set_codex_api_key(&key)
    })
    .await
    .map_err(|e| format!("Failed to store Codex API key: {}", e))?
}

/// Check whether a Codex (OpenAI) API key is stored in the macOS Keychain.
#[tauri::command]
#[specta::specta]
pub async fn has_codex_api_key() -> Result<bool, String> {
    tokio::task::spawn_blocking(|| {
        Ok(crate::credentials::codex_keychain::has_codex_api_key())
    })
    .await
    .map_err(|e| format!("Failed to check Codex API key: {}", e))?
}

/// Validate a Codex CLI result JSON for silent failures.
///
/// Parses the result JSON line with `parse_stream_line`, then validates via
/// `validate_result` — checking empty response, error status, and error events.
#[tauri::command]
#[specta::specta]
pub async fn validate_codex_result(result_json: String) -> Result<(), String> {
    let adapter = crate::adapters::codex::CodexAdapter;
    crate::adapters::ToolAdapter::validate_result_json(&adapter, &result_json)
}

/// Delete the stored Codex (OpenAI) API key from the macOS Keychain.
#[tauri::command]
#[specta::specta]
pub async fn delete_codex_api_key() -> Result<(), String> {
    tokio::task::spawn_blocking(|| {
        crate::credentials::codex_keychain::delete_codex_api_key()
    })
    .await
    .map_err(|e| format!("Failed to delete Codex API key: {}", e))?
}
