mod adapters;
mod commands;
mod credentials;
mod detection;
mod ipc;
mod messenger;
mod process;
mod context;
mod prompt;
mod router;
mod worktree;
mod state;

use commands::{
    cancel_process, check_worktree_conflicts, cleanup_worktrees, create_worktree,
    delete_claude_api_key, delete_codex_api_key, delete_gemini_api_key, detect_agents,
    dispatch_orchestrated_task, dispatch_task, get_agent_context_info, get_context_summary,
    get_recent_changes, get_task_count, get_worktree_diff, has_claude_api_key, has_codex_api_key,
    has_gemini_api_key, list_worktrees, merge_worktree, optimize_prompt, pause_process,
    record_task_completion_cmd, resume_process, set_claude_api_key, set_codex_api_key,
    set_gemini_api_key, spawn_claude_task, spawn_codex_task, spawn_gemini_task, spawn_process,
    send_to_process, start_stream, suggest_tool, validate_claude_result, validate_codex_result,
    validate_gemini_result, cleanup_completed_processes,
    clear_orchestration_context, answer_user_question,
    approve_decomposition, reject_decomposition,
};
use state::AppState;
use tauri::Manager;
use tauri_specta::collect_commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri_specta::Builder::<tauri::Wry>::new().commands(collect_commands![
        start_stream,
        get_task_count,
        spawn_process,
        cancel_process,
        pause_process,
        resume_process,
        spawn_claude_task,
        set_claude_api_key,
        has_claude_api_key,
        validate_claude_result,
        delete_claude_api_key,
        record_task_completion_cmd,
        get_recent_changes,
        get_context_summary,
        create_worktree,
        check_worktree_conflicts,
        get_worktree_diff,
        merge_worktree,
        cleanup_worktrees,
        list_worktrees,
        spawn_gemini_task,
        set_gemini_api_key,
        has_gemini_api_key,
        validate_gemini_result,
        delete_gemini_api_key,
        spawn_codex_task,
        set_codex_api_key,
        has_codex_api_key,
        validate_codex_result,
        delete_codex_api_key,
        suggest_tool,
        dispatch_task,
        dispatch_orchestrated_task,
        get_agent_context_info,
        optimize_prompt,
        send_to_process,
        cleanup_completed_processes,
        clear_orchestration_context,
        answer_user_question,
        approve_decomposition,
        reject_decomposition,
        detect_agents,
    ]);

    #[cfg(debug_assertions)]
    {
        let export_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/bindings.ts");
        println!("Exporting bindings to: {:?}", export_path);
        builder
            .export(specta_typescript::Typescript::default(), &export_path)
            .expect("Failed to export typescript bindings");
        println!("Bindings exported successfully");
    }

    let invoke_handler = builder.invoke_handler();

    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(invoke_handler)
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir().map_err(|e| {
                Box::<dyn std::error::Error>::from(format!("Failed to get app_data_dir: {}", e))
            })?;
            let db_path =
                context::store::ContextStore::db_path_for_project(&app_data_dir, "default");
            let context_store = context::store::ContextStore::new(&db_path).map_err(|e| {
                Box::<dyn std::error::Error>::from(format!("Failed to init ContextStore: {}", e))
            })?;
            app.manage(context_store);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Failed to build Tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                println!("App exiting — killing all tracked processes");
                let state: tauri::State<AppState> = app_handle.state();
                let lock_result = state.lock();
                match lock_result {
                    Ok(mut inner) => {
                        for (_id, proc) in inner.processes.drain() {
                            let _ = nix::sys::signal::killpg(
                                nix::unistd::Pid::from_raw(proc.pgid),
                                nix::sys::signal::Signal::SIGKILL,
                            );
                        }
                    }
                    Err(e) => {
                        eprintln!("Failed to lock state during exit: {}", e);
                    }
                }
            }
        });
}
