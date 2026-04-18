mod ipc;
mod repo;
mod settings;
mod storage;

use ipc::{commands, IpcState};
use storage::{migrations, Storage};
use tauri::Manager;

/// DB filename under `$app_config_dir`. Shared by `tauri-plugin-sql` (frontend
/// access) and the Rust-side `Storage` (orchestrator, step 8). Both pools open
/// the same file; migrations are idempotent so whichever runs first wins.
const DB_FILENAME: &str = "whalecode.db";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(&format!("sqlite:{DB_FILENAME}"), migrations::all())
                .build(),
        )
        .setup(|app| {
            let ipc_state = IpcState::load(app.handle())?;
            app.manage(ipc_state);

            // Open the Rust-side Storage pool at the same DB file. Done on
            // the async runtime because sqlx is async-only. Failures here
            // abort startup — the orchestrator can't run without a DB.
            let db_path = app
                .path()
                .app_config_dir()
                .map(|d| d.join(DB_FILENAME))?;
            let storage = tauri::async_runtime::block_on(Storage::open(&db_path))?;
            app.manage(storage);
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
