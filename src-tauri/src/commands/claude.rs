use tauri::ipc::Channel;

use crate::ipc::events::OutputEvent;
use crate::state::AppState;

/// Spawn a Claude Code subprocess in headless streaming mode.
///
/// Retrieves the API key from the macOS Keychain, builds the Claude CLI command,
/// and spawns it through the process manager with secure env var injection.
///
/// Returns the task_id for tracking the process.
#[tauri::command]
#[specta::specta]
pub async fn spawn_claude_task(
    prompt: String,
    project_dir: String,
    on_event: Channel<OutputEvent>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    // Retrieve API key from keychain (blocking call wrapped for async)
    let api_key = tokio::task::spawn_blocking(|| {
        crate::credentials::keychain::get_api_key()
    })
    .await
    .map_err(|e| format!("Failed to retrieve API key: {}", e))??;

    // Build Claude-specific command
    let cmd = crate::adapters::claude::build_command(&prompt, &project_dir, &api_key);

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
