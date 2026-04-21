//! Command handlers exposed to the frontend via `tauri::generate_handler!`.
//!
//! # Error split
//!
//! There are two distinct failure surfaces, and they carry different
//! semantics — keep them separate when adding new commands.
//!
//! - **Command-level `Err(String)`** — synchronous, pre-run validation
//!   that blocks the action entirely: no repo, unknown run id, wrong
//!   lifecycle state, agent binary missing, storage unavailable. The
//!   frontend surfaces these as `ipc.invoke` rejections; the user sees
//!   an error banner at the call site (see `ErrorBanner`).
//!
//! - **`RunEvent::Failed` / `MergeConflict`** — in-flight runtime
//!   problems that occur *after* a run is already accepted: a worker
//!   crashes, a merge conflict, the planning agent dies mid-stream.
//!   The frontend receives these as `run:failed` / `run:merge_conflict`
//!   events and updates the graph node to a terminal failed state.
//!
//! Rule of thumb: if the command hasn't returned yet, surface as
//! `Err`. If the run has already been handed off to the lifecycle
//! task, surface as a RunEvent — the lifecycle task owns the state
//! transition from that point on.
//!
//! All commands use `rename_all = "camelCase"` where they take multi-word
//! args so the JS side sends idiomatic `runId`, `subtaskIds`, etc.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::State;

use super::{
    AgentDetectionResult, AgentKind, MigrationNotice, RecoveryEntry, RunId, SkipResult,
    SubtaskDraft, SubtaskId, SubtaskPatch,
};
use crate::detection::Detector;
use crate::editor::EditorResult;
use crate::orchestration::Orchestrator;
use crate::settings::{Settings, SettingsStore};
use crate::worktree_actions::TerminalResult;

#[tauri::command(rename_all = "camelCase")]
pub async fn submit_task(
    orch: State<'_, Arc<Orchestrator>>,
    input: String,
    repo_path: String,
) -> Result<RunId, String> {
    orch.submit_task(input, PathBuf::from(repo_path))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn approve_subtasks(
    orch: State<'_, Arc<Orchestrator>>,
    run_id: RunId,
    subtask_ids: Vec<SubtaskId>,
) -> Result<(), String> {
    orch.approve_subtasks(&run_id, subtask_ids)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn reject_run(
    orch: State<'_, Arc<Orchestrator>>,
    run_id: RunId,
) -> Result<(), String> {
    orch.reject_run(&run_id).await.map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn apply_run(
    orch: State<'_, Arc<Orchestrator>>,
    run_id: RunId,
) -> Result<(), String> {
    orch.apply_run(&run_id).await.map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn discard_run(
    orch: State<'_, Arc<Orchestrator>>,
    run_id: RunId,
) -> Result<(), String> {
    orch.discard_run(&run_id).await.map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn cancel_run(
    orch: State<'_, Arc<Orchestrator>>,
    run_id: RunId,
) -> Result<(), String> {
    orch.cancel_run(&run_id).await.map_err(|e| e.to_string())
}

// -- Phase 3 plan-edit commands ---------------------------------------
//
// These three are only valid while a run is in `AwaitingApproval`
// (the window between `run:subtasks_proposed` and `approve_subtasks` /
// `reject_run`). The orchestrator enforces the state gate and the
// validation rules; here we stay thin — deserialize, dispatch, map the
// error to a string for the frontend banner.

#[tauri::command(rename_all = "camelCase")]
pub async fn update_subtask(
    orch: State<'_, Arc<Orchestrator>>,
    run_id: RunId,
    subtask_id: SubtaskId,
    patch: SubtaskPatch,
) -> Result<(), String> {
    orch.update_subtask(&run_id, &subtask_id, patch)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn add_subtask(
    orch: State<'_, Arc<Orchestrator>>,
    run_id: RunId,
    draft: SubtaskDraft,
) -> Result<SubtaskId, String> {
    orch.add_subtask(&run_id, draft)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn remove_subtask(
    orch: State<'_, Arc<Orchestrator>>,
    run_id: RunId,
    subtask_id: SubtaskId,
) -> Result<(), String> {
    orch.remove_subtask(&run_id, &subtask_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn detect_agents(
    detector: State<'_, Arc<Detector>>,
) -> Result<AgentDetectionResult, String> {
    Ok(detector.detect_all().await)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn set_master_agent(
    settings: State<'_, Arc<SettingsStore>>,
    agent: AgentKind,
) -> Result<Settings, String> {
    settings.update(&serde_json::json!({ "masterAgent": agent }))
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
    settings.update(&patch)
}

/// Drain the boot-time recovery report. The frontend calls this
/// once on startup (see App.tsx init) and surfaces a heads-up
/// banner if the list is non-empty. Subsequent calls return `[]`.
#[tauri::command]
pub async fn consume_recovery_report(
    orch: State<'_, Arc<Orchestrator>>,
) -> Result<Vec<RecoveryEntry>, String> {
    Ok(orch.consume_recovery_report().await)
}

/// Drain the boot-time migration notices. One-shot sibling of
/// `consume_recovery_report`: the settings store stashes any
/// migration that ran during `SettingsStore::load_at` (see
/// `settings::migrate`), and the frontend surfaces them once per
/// launch. Subsequent calls return `[]`.
#[tauri::command]
pub fn consume_migration_notices(
    settings: State<'_, Arc<SettingsStore>>,
) -> Result<Vec<MigrationNotice>, String> {
    settings.consume_migration_notices()
}

// -- Phase 3 Step 5 Layer-3 escalation commands -----------------------
//
// Surfaced when a subtask has entered `HumanEscalation`. The frontend
// drives the user through one of three choices: open the file in an
// editor and mark it fixed, skip the subtask (and its dependents), or
// ask the master for another replan attempt (only visible when
// `replan_count < 2`).
//
// Commit 1 wires the IPC skeleton; Commit 2 fills in the orchestrator
// logic. See `src/editor.rs` for the fallback chain returned by
// `manual_fix_subtask`.

#[tauri::command(rename_all = "camelCase")]
pub async fn manual_fix_subtask(
    orch: State<'_, Arc<Orchestrator>>,
    run_id: RunId,
    subtask_id: SubtaskId,
) -> Result<EditorResult, String> {
    orch.manual_fix_subtask(&run_id, &subtask_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn mark_subtask_fixed(
    orch: State<'_, Arc<Orchestrator>>,
    run_id: RunId,
    subtask_id: SubtaskId,
) -> Result<(), String> {
    orch.mark_subtask_fixed(&run_id, &subtask_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn skip_subtask(
    orch: State<'_, Arc<Orchestrator>>,
    run_id: RunId,
    subtask_id: SubtaskId,
) -> Result<SkipResult, String> {
    orch.skip_subtask(&run_id, &subtask_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn try_replan_again(
    orch: State<'_, Arc<Orchestrator>>,
    run_id: RunId,
    subtask_id: SubtaskId,
) -> Result<(), String> {
    orch.try_replan_again(&run_id, &subtask_id)
        .await
        .map_err(|e| e.to_string())
}

// Phase 4 Step 4: worktree inspection affordances. The three commands
// below back the frontend's WorktreeActions menu (folder icon on
// inspectable worker cards → Reveal / Copy path / Open terminal).
//
// All three go through
// [`Orchestrator::subtask_worktree_path_for_inspection`], which enforces
// the invariant that paths only leak to the UI when the subtask is in
// an inspectable state (done / failed / human-escalation / cancelled)
// and a worktree still exists on disk. Running workers, proposed
// subtasks, and skipped/waiting subtasks all refuse.
//
// `get_subtask_worktree_path` is the clipboard path-fetch — it runs no
// side effects beyond the lookup so "Copy path" doesn't spawn anything
// the user didn't ask for. `reveal_worktree` and `open_terminal_at`
// forward to `crate::worktree_actions` after the lookup; each spawn
// uses structured arg vectors only (no `sh -c` interpolation) so
// shell metacharacters in the path — impossible today with ULIDs, but
// cheap insurance — can't escape.

#[tauri::command(rename_all = "camelCase")]
pub async fn get_subtask_worktree_path(
    orch: State<'_, Arc<Orchestrator>>,
    run_id: RunId,
    subtask_id: SubtaskId,
) -> Result<String, String> {
    orch.subtask_worktree_path_for_inspection(&run_id, &subtask_id)
        .await
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn reveal_worktree(
    orch: State<'_, Arc<Orchestrator>>,
    run_id: RunId,
    subtask_id: SubtaskId,
) -> Result<String, String> {
    let path = orch
        .subtask_worktree_path_for_inspection(&run_id, &subtask_id)
        .await
        .map_err(|e| e.to_string())?;
    let ok = crate::worktree_actions::reveal_path(&path);
    if !ok {
        return Err(format!(
            "could not reveal {}: no file manager registered on this platform",
            path.display()
        ));
    }
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn open_terminal_at(
    orch: State<'_, Arc<Orchestrator>>,
    run_id: RunId,
    subtask_id: SubtaskId,
) -> Result<TerminalResult, String> {
    let path = orch
        .subtask_worktree_path_for_inspection(&run_id, &subtask_id)
        .await
        .map_err(|e| e.to_string())?;
    // Never returns Err — the frontend branches on
    // `TerminalMethod::ClipboardOnly` to toast "no terminal detected;
    // path copied instead" and fall back to a clipboard write. An
    // Err here would force the frontend to do the same branching
    // against a string, which is worse.
    Ok(crate::worktree_actions::open_terminal(&path))
}
