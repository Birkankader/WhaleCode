//! Command handlers exposed to the frontend via `tauri::generate_handler!`.
//!
//! Phase 2 step 1: these are stubs. They validate argument shape, log the
//! invocation, emit a couple of obvious events (so the frontend wiring can
//! be exercised end-to-end), and return placeholder data. Real semantics
//! land when the orchestrator arrives in step 8.
//!
//! All commands use `rename_all = "camelCase"` so the JS side sends
//! idiomatic `runId`, `subtaskIds`, etc. instead of snake_case.

use std::sync::Mutex;

use tauri::{AppHandle, State};
use uuid::Uuid;

use super::events::{self, StatusChanged};
use super::{
    AgentDetectionResult, AgentKind, AgentStatus, RunId, RunStatus, SubtaskId,
};

/// Shared IPC state. Real run/subtask tracking lands in step 8; for now this
/// only holds the user's selected master agent (which Phase 1's top-bar chip
/// reads/writes via these commands).
#[derive(Debug)]
pub struct IpcState {
    pub master_agent: Mutex<AgentKind>,
}

impl Default for IpcState {
    fn default() -> Self {
        Self {
            master_agent: Mutex::new(AgentKind::Claude),
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn submit_task(
    app: AppHandle,
    input: String,
    repo_path: String,
) -> Result<RunId, String> {
    let run_id = Uuid::new_v4().to_string();
    eprintln!(
        "[ipc] submit_task: input={:?} repo_path={:?} → run_id={}",
        input, repo_path, run_id
    );
    // Emit the first state transition so the frontend can prove its listener
    // is wired up before the orchestrator exists.
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
pub fn approve_subtasks(
    run_id: RunId,
    subtask_ids: Vec<SubtaskId>,
) -> Result<(), String> {
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
pub fn set_master_agent(
    state: State<'_, IpcState>,
    agent: AgentKind,
) -> Result<(), String> {
    let mut guard = state
        .master_agent
        .lock()
        .map_err(|e| format!("master_agent lock poisoned: {e}"))?;
    *guard = agent;
    eprintln!("[ipc] set_master_agent: {:?}", agent);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_state_is_claude() {
        let state = IpcState::default();
        assert_eq!(*state.master_agent.lock().unwrap(), AgentKind::Claude);
    }

    #[test]
    fn detect_agents_stub_returns_not_installed() {
        let res = detect_agents().unwrap();
        assert_eq!(res.claude, AgentStatus::NotInstalled);
        assert_eq!(res.codex, AgentStatus::NotInstalled);
        assert_eq!(res.gemini, AgentStatus::NotInstalled);
        assert!(res.recommended_master.is_none());
    }
}
