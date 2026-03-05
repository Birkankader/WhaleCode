mod adapters;
mod commands;
mod credentials;
mod ipc;
mod process;
mod context;
mod worktree;
mod state;

use commands::{
    cancel_process, delete_claude_api_key, get_context_summary, get_recent_changes,
    get_task_count, has_claude_api_key, pause_process, record_task_completion_cmd,
    resume_process, set_claude_api_key, spawn_claude_task, spawn_process, start_stream,
    validate_claude_result,
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
        .unwrap()
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                println!("App exiting — killing all tracked processes");
                let state: tauri::State<AppState> = app_handle.state();
                let mut inner = state.lock().unwrap();
                for (_id, proc) in inner.processes.drain() {
                    let _ = nix::sys::signal::killpg(
                        nix::unistd::Pid::from_raw(proc.pgid),
                        nix::sys::signal::Signal::SIGKILL,
                    );
                }
            }
        });
}
