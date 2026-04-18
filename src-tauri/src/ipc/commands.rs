//! Command handlers exposed to the frontend via `tauri::generate_handler!`.
//!
//! Phase 2 step 1 stubbed the run-lifecycle commands (`submit_task`,
//! `approve_subtasks`, …). Step 2 added `get_settings` / `set_settings` on
//! top of `SettingsStore`. Step 4 replaces the agent-detection stub with a
//! real `Detector` and turns `set_master_agent` into a settings update that
//! returns the merged snapshot so the frontend can keep its store in sync
//! without re-fetching.
//!
//! All commands use `rename_all = "camelCase"` where they take multi-word
//! args so the JS side sends idiomatic `runId`, `subtaskIds`, etc.

use std::sync::Arc;

use tauri::{AppHandle, State};
use uuid::Uuid;

use super::events::{self, StatusChanged};
use super::{AgentDetectionResult, AgentKind, RunId, RunStatus, SubtaskId};
use crate::detection::Detector;
use crate::settings::{Settings, SettingsStore};

#[tauri::command(rename_all = "camelCase")]
pub fn submit_task(app: AppHandle, input: String, repo_path: String) -> Result<RunId, String> {
    let run_id = Uuid::new_v4().to_string();
    eprintln!(
        "[ipc] submit_task: input={:?} repo_path={:?} → run_id={}",
        input, repo_path, run_id
    );
    // INVARIANT: emit nothing before returning `run_id`. The frontend
    // attaches its RunSubscription after `submit_task` returns; any
    // event fired before that point would be dropped. Mirror the real
    // orchestrator (see `Orchestrator::submit_task`) by deferring the
    // first emit to a spawned task that yields before emitting.
    let emit_run_id = run_id.clone();
    let emit_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::task::yield_now().await;
        let _ = events::emit_status_changed(
            &emit_app,
            &StatusChanged {
                run_id: emit_run_id,
                status: RunStatus::Planning,
            },
        );
    });
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

#[tauri::command]
pub async fn detect_agents(
    detector: State<'_, Detector>,
) -> Result<AgentDetectionResult, String> {
    Ok(detector.detect_all().await)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn set_master_agent(
    settings: State<'_, Arc<SettingsStore>>,
    agent: AgentKind,
) -> Result<Settings, String> {
    let updated = settings.update(&serde_json::json!({ "masterAgent": agent }))?;
    eprintln!("[ipc] set_master_agent: {:?}", agent);
    Ok(updated)
}

#[tauri::command]
pub fn get_settings(settings: State<'_, Arc<SettingsStore>>) -> Result<Settings, String> {
    settings.snapshot()
}

#[tauri::command]
pub fn set_settings(
    settings: State<'_, Arc<SettingsStore>>,
    patch: serde_json::Value,
) -> Result<Settings, String> {
    let merged = settings.update(&patch)?;
    eprintln!("[ipc] set_settings: applied {}", patch);
    Ok(merged)
}
