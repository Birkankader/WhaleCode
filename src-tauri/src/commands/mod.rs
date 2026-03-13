pub mod claude;
pub mod cleanup;
pub mod codex;
pub mod config;
pub mod detection;
pub mod gemini;
pub mod context;
pub mod orchestrator;
pub mod process;
pub mod prompt;
pub mod router;
pub mod stdin;
pub mod worktree;
pub mod git;
pub mod fs_explorer;

#[cfg(test)]
mod orchestrator_test;

use std::path::PathBuf;
use tauri::ipc::Channel;

use crate::ipc::events::OutputEvent;
use crate::state::AppState;

/// Expand `~` at the start of a path to the user's home directory.
/// Uses `HOME` on Unix and `USERPROFILE` on Windows.
pub fn expand_tilde(path: &str) -> PathBuf {
    let home_var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    if let Some(rest) = path.strip_prefix("~/") {
        if let Ok(home) = std::env::var(home_var) {
            return PathBuf::from(home).join(rest);
        }
    } else if path == "~" {
        if let Ok(home) = std::env::var(home_var) {
            return PathBuf::from(home);
        }
    }
    PathBuf::from(path)
}

pub use claude::{
    delete_claude_api_key, has_claude_api_key, set_claude_api_key, spawn_claude_task,
    validate_claude_result,
};
pub use gemini::{
    delete_gemini_api_key, has_gemini_api_key, set_gemini_api_key, spawn_gemini_task,
    validate_gemini_result,
};
pub use codex::{
    delete_codex_api_key, has_codex_api_key, set_codex_api_key, spawn_codex_task,
    validate_codex_result,
};
pub use context::{get_context_summary, get_orchestration_history, get_recent_changes, record_task_completion_cmd};
pub use process::{cancel_process, pause_process, resume_process, spawn_process};
pub use prompt::optimize_prompt;
pub use orchestrator::{
    dispatch_orchestrated_task, get_agent_context_info,
    clear_orchestration_context, answer_user_question,
    approve_decomposition, reject_decomposition,
    approve_orchestration,
};
pub use router::{dispatch_task, suggest_tool};
pub use worktree::{
    check_worktree_conflicts, cleanup_worktrees, create_worktree, get_worktree_diff,
    list_worktrees, merge_worktree,
};
pub use stdin::send_to_process;
pub use cleanup::cleanup_completed_processes;
pub use detection::detect_agents;
pub use git::{
    git_commit, git_diff_file, git_log, git_pull, git_push, git_stage_files, git_status,
    git_unstage_files,
};
pub use fs_explorer::{list_directory, read_file, write_file};
pub use config::{get_config, set_config};

#[tauri::command]
#[specta::specta]
pub async fn start_stream(on_event: Channel<OutputEvent>) -> Result<(), String> {
    tauri::async_runtime::spawn(async move {
        on_event
            .send(OutputEvent::Stdout("Test event from Rust".to_string()))
            .ok();
        on_event.send(OutputEvent::Exit(0)).ok();
    });
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn get_task_count(state: tauri::State<'_, AppState>) -> Result<u32, String> {
    let inner = state.lock().map_err(|e| e.to_string())?;
    Ok(inner.tasks.len() as u32)
}
