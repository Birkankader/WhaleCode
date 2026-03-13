use tauri::AppHandle;
use tauri::Manager;
use crate::config::AppConfig;

#[tauri::command]
#[specta::specta]
pub async fn get_config(app_handle: AppHandle) -> Result<AppConfig, String> {
    let app_data_dir = app_handle.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    Ok(AppConfig::load(&app_data_dir))
}

#[tauri::command]
#[specta::specta]
pub async fn set_config(app_handle: AppHandle, config: AppConfig) -> Result<(), String> {
    let app_data_dir = app_handle.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    config.save(&app_data_dir)
}
