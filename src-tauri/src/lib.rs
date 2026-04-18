mod agents;
mod detection;
mod ipc;
mod repo;
mod settings;
mod storage;

use std::sync::Arc;

use detection::Detector;
use ipc::commands;
use settings::SettingsStore;
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
            // Settings: load once, share via Arc so Detector can hold a clone
            // while commands borrow through Tauri's `State<Arc<...>>`.
            let settings_path = settings::resolve_path(app.handle())?;
            let settings = Arc::new(SettingsStore::load_at(settings_path));
            app.manage(settings.clone());

            // Detector: stateless apart from its settings handle. Cheap to
            // clone; we keep a single managed copy.
            app.manage(Detector::new(settings.clone()));

            // Storage: Rust-side pool against the same DB file plugin-sql uses.
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
