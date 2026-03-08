use tauri::ipc::Channel;

use crate::ipc::events::OutputEvent;
use crate::state::AppState;

/// Spawn a Gemini CLI subprocess in headless streaming mode.
///
/// Retrieves the API key from the macOS Keychain, builds the Gemini CLI command,
/// and spawns it through the process manager with secure env var injection.
/// The prompt is expected to be already optimized by the prompt engine (dispatch_task handles this).
///
/// Returns the task_id for tracking the process.
#[tauri::command]
#[specta::specta]
pub async fn spawn_gemini_task(
    prompt: String,
    project_dir: String,
    task_id: Option<String>,
    on_event: Channel<OutputEvent>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    // Retrieve Gemini API key from keychain if available (optional — CLI handles its own auth)
    let api_key = tokio::task::spawn_blocking(|| {
        crate::credentials::gemini_keychain::get_gemini_api_key().unwrap_or_default()
    })
    .await
    .map_err(|e| format!("Failed to retrieve Gemini API key: {}", e))?;

    // Prompt is already optimized by dispatch_task's prompt engine — use directly
    let full_prompt = prompt;

    // Use provided task_id or generate a new one
    let task_id = task_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // Use project directory directly (no worktree isolation)
    let expanded_dir = super::expand_tilde(&project_dir);
    let cwd = expanded_dir.to_str().ok_or("Invalid project dir path")?;
    let adapter = crate::adapters::gemini::GeminiAdapter;
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
        None, // Gemini --yolo bypasses prompts
    )
    .await
}

/// Store a Gemini API key in the macOS Keychain.
///
/// Validates that the key is non-empty and has reasonable length (> 10 chars).
/// NOTE: Gemini API keys have no known prefix pattern (unlike Claude's sk-ant-).
/// SECURITY: The key is never logged or included in error messages.
#[tauri::command]
#[specta::specta]
pub async fn set_gemini_api_key(key: String) -> Result<(), String> {
    // Validate key has reasonable length (no known prefix for Gemini keys)
    if key.trim().is_empty() {
        return Err("API key cannot be empty".to_string());
    }
    if key.len() <= 10 {
        return Err("API key is too short (must be longer than 10 characters)".to_string());
    }

    tokio::task::spawn_blocking(move || {
        crate::credentials::gemini_keychain::set_gemini_api_key(&key)
    })
    .await
    .map_err(|e| format!("Failed to store Gemini API key: {}", e))?
}

/// Check whether a Gemini API key is stored in the macOS Keychain.
#[tauri::command]
#[specta::specta]
pub async fn has_gemini_api_key() -> Result<bool, String> {
    tokio::task::spawn_blocking(|| {
        Ok(crate::credentials::gemini_keychain::has_gemini_api_key())
    })
    .await
    .map_err(|e| format!("Failed to check Gemini API key: {}", e))?
}

/// Validate a Gemini CLI result JSON for silent failures.
///
/// Parses the result JSON line with `parse_stream_line`, then validates via
/// `validate_result` — checking empty response, error status, and error events.
#[tauri::command]
#[specta::specta]
pub async fn validate_gemini_result(result_json: String) -> Result<(), String> {
    let adapter = crate::adapters::gemini::GeminiAdapter;
    crate::adapters::ToolAdapter::validate_result_json(&adapter, &result_json)
}

/// Delete the stored Gemini API key from the macOS Keychain.
#[tauri::command]
#[specta::specta]
pub async fn delete_gemini_api_key() -> Result<(), String> {
    tokio::task::spawn_blocking(|| {
        crate::credentials::gemini_keychain::delete_gemini_api_key()
    })
    .await
    .map_err(|e| format!("Failed to delete Gemini API key: {}", e))?
}
