mod ipc;
mod repo;
mod settings;

use ipc::{commands, IpcState};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let state = IpcState::load(app.handle())?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::submit_task,
            commands::approve_subtasks,
            commands::reject_run,
            commands::apply_run,
            commands::discard_run,
            commands::cancel_run,
            commands::detect_agents,
            commands::set_master_agent,
            commands::get_settings,
            commands::set_settings,
            repo::pick_repo,
            repo::validate_repo,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
