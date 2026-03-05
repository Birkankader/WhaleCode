mod commands;
mod ipc;
mod state;

use commands::{get_task_count, start_stream};
use state::AppState;
use tauri_specta::collect_commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder =
        tauri_specta::Builder::<tauri::Wry>::new().commands(collect_commands![start_stream, get_task_count,]);

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
        .run(|_app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                println!("App exiting cleanly");
                // Phase 2: kill child processes from AppState here
            }
        });
}
