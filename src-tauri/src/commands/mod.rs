pub mod claude;
pub mod gemini;
pub mod context;
pub mod process;
pub mod prompt;
pub mod router;
pub mod worktree;

use tauri::ipc::Channel;

use crate::ipc::events::OutputEvent;
use crate::state::AppState;

pub use claude::{
    delete_claude_api_key, has_claude_api_key, set_claude_api_key, spawn_claude_task,
    validate_claude_result,
};
pub use gemini::{
    delete_gemini_api_key, has_gemini_api_key, set_gemini_api_key, spawn_gemini_task,
    validate_gemini_result,
};
pub use context::{get_context_summary, get_recent_changes, record_task_completion_cmd};
pub use process::{cancel_process, pause_process, resume_process, spawn_process};
pub use prompt::optimize_prompt;
pub use router::{dispatch_task, suggest_tool};
pub use worktree::{
    check_worktree_conflicts, cleanup_worktrees, create_worktree, get_worktree_diff,
    list_worktrees, merge_worktree,
};

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
