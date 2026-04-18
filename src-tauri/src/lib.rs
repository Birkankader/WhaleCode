mod ipc;

use ipc::{commands, IpcState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(IpcState::default())
        .invoke_handler(tauri::generate_handler![
            commands::submit_task,
            commands::approve_subtasks,
            commands::reject_run,
            commands::apply_run,
            commands::discard_run,
            commands::cancel_run,
            commands::detect_agents,
            commands::set_master_agent,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
