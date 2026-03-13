use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// App configuration with sensible defaults.
/// Stored as `whalecode.json` in the app data directory.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct AppConfig {
    /// Master agent timeout in minutes (default: 10)
    pub master_timeout_minutes: u32,
    /// Worker agent timeout in minutes (default: 5)
    pub worker_timeout_minutes: u32,
    /// Maximum rate limit retries before failing (default: 3)
    pub max_rate_limit_retries: u32,
    /// Maximum worker retries before marking as failed (default: 2)
    pub max_worker_retries: u32,
    /// Seconds to wait before cleaning up completed plans (default: 60)
    pub plan_cleanup_delay_secs: u32,
    /// Maximum concurrent workers (default: 3)
    pub max_concurrent_workers: u32,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            master_timeout_minutes: 10,
            worker_timeout_minutes: 5,
            max_rate_limit_retries: 3,
            max_worker_retries: 2,
            plan_cleanup_delay_secs: 60,
            max_concurrent_workers: 3,
        }
    }
}

impl AppConfig {
    fn config_path(app_data_dir: &std::path::Path) -> PathBuf {
        app_data_dir.join("whalecode.json")
    }

    /// Load config from disk, or return defaults if not found.
    pub fn load(app_data_dir: &std::path::Path) -> Self {
        let path = Self::config_path(app_data_dir);
        match std::fs::read_to_string(&path) {
            Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    /// Save config to disk.
    pub fn save(&self, app_data_dir: &std::path::Path) -> Result<(), String> {
        let path = Self::config_path(app_data_dir);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create config dir: {}", e))?;
        }
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;
        std::fs::write(&path, json)
            .map_err(|e| format!("Failed to write config: {}", e))?;
        Ok(())
    }
}
