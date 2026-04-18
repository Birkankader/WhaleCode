//! Command handlers exposed to the frontend via `tauri::generate_handler!`.
//!
//! Phase 2 step 1 stubbed the run-lifecycle commands (`submit_task`,
//! `approve_subtasks`, …). Step 2 adds `get_settings` / `set_settings`
//! wrappers on top of `SettingsStore`. Repo inspection commands live in
//! `crate::repo` — they're registered from `lib.rs` directly.
//!
//! All commands use `rename_all = "camelCase"` so the JS side sends
//! idiomatic `runId`, `subtaskIds`, etc. instead of snake_case.

use tauri::{AppHandle, State};
use uuid::Uuid;

use super::events::{self, StatusChanged};
use super::{AgentDetectionResult, AgentKind, AgentStatus, RunId, RunStatus, SubtaskId};
use crate::settings::{self, Settings, SettingsStore};

/// Shared IPC state. Holds the loaded settings; `Mutex` inside `SettingsStore`
/// handles concurrent command invocations. Real run/subtask tracking lands
/// in step 8.
pub struct IpcState {
    pub settings: SettingsStore,
}

impl IpcState {
    /// Resolves `app_config_dir/settings.json`, creates the directory if
    /// missing, loads settings (or defaults), and returns the state. Called
    /// once from the Tauri `setup` hook.
    pub fn load(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let path = settings::resolve_path(app)?;
        Ok(Self {
            settings: SettingsStore::load_at(path),
        })
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn submit_task(app: AppHandle, input: String, repo_path: String) -> Result<RunId, String> {
    let run_id = Uuid::new_v4().to_string();
    eprintln!(
        "[ipc] submit_task: input={:?} repo_path={:?} → run_id={}",
        input, repo_path, run_id
    );
    let _ = events::emit_status_changed(
        &app,
        &StatusChanged {
            run_id: run_id.clone(),
            status: RunStatus::Planning,
        },
    );
    Ok(run_id)
}

#[tauri::command(rename_all = "camelCase")]
pub fn approve_subtasks(run_id: RunId, subtask_ids: Vec<SubtaskId>) -> Result<(), String> {
    eprintln!(
        "[ipc] approve_subtasks: run_id={} subtask_ids={:?}",
        run_id, subtask_ids
    );
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn reject_run(run_id: RunId) -> Result<(), String> {
    eprintln!("[ipc] reject_run: run_id={}", run_id);
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn apply_run(run_id: RunId) -> Result<(), String> {
    eprintln!("[ipc] apply_run: run_id={}", run_id);
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn discard_run(run_id: RunId) -> Result<(), String> {
    eprintln!("[ipc] discard_run: run_id={}", run_id);
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn cancel_run(run_id: RunId) -> Result<(), String> {
    eprintln!("[ipc] cancel_run: run_id={}", run_id);
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn detect_agents() -> Result<AgentDetectionResult, String> {
    // Placeholder: real detection lands in step 4. Returning NotInstalled for
    // all agents is the honest answer from a stub — frontend can render the
    // onboarding state against it to verify the wiring.
    Ok(AgentDetectionResult {
        claude: AgentStatus::NotInstalled,
        codex: AgentStatus::NotInstalled,
        gemini: AgentStatus::NotInstalled,
        recommended_master: None,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_master_agent(state: State<'_, IpcState>, agent: AgentKind) -> Result<(), String> {
    state
        .settings
        .update(&serde_json::json!({ "masterAgent": agent }))?;
    eprintln!("[ipc] set_master_agent: {:?}", agent);
    Ok(())
}

#[tauri::command]
pub fn get_settings(state: State<'_, IpcState>) -> Result<Settings, String> {
    state.settings.snapshot()
}

#[tauri::command]
pub fn set_settings(
    state: State<'_, IpcState>,
    patch: serde_json::Value,
) -> Result<Settings, String> {
    let merged = state.settings.update(&patch)?;
    eprintln!("[ipc] set_settings: applied {}", patch);
    Ok(merged)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_agents_stub_returns_not_installed() {
        let res = detect_agents().unwrap();
        assert_eq!(res.claude, AgentStatus::NotInstalled);
        assert_eq!(res.codex, AgentStatus::NotInstalled);
        assert_eq!(res.gemini, AgentStatus::NotInstalled);
        assert!(res.recommended_master.is_none());
    }
}
