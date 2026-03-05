mod adapters;
mod commands;
mod credentials;
mod ipc;
mod process;
mod state;

use commands::{
    cancel_process, delete_claude_api_key, get_task_count, has_claude_api_key, pause_process,
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
        .setup(|_app| Ok(()))
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
