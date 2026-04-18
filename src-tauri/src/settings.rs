//! User settings persisted to `$app_config_dir/settings.json`.
//!
//! Loaded once at startup (see `IpcState::load` in `ipc::commands`). Mutated
//! through `set_settings`, which takes a JSON patch so callers can update a
//! subset without serializing the other fields. Writes are best-effort — the
//! orchestrator doesn't depend on settings being durable across a crash, and
//! a failed write is reported back to the frontend.
//!
//! The on-disk shape and the wire shape are the same camelCase JSON, so one
//! `Settings` struct serves both. Extending fields later just means adding
//! `Option<T>` members with `#[serde(default)]`.
//!
//! Wire types mirrored in `src/lib/ipc.ts` — keep the two in sync.
//!
//! Current Phase 2 users of each field:
//!   - `last_repo`: consumed at boot; step 6 also reads it when initializing
//!     the worktree manager.
//!   - `master_agent`: read by the orchestrator (step 8) to pick the master.
//!   - `*_binary_path`: detected-agent overrides (step 4).
//! The `dead_code` allow-list on the struct covers readers that land in
//! later steps.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::ipc::AgentKind;

/// User-editable settings. Stored as camelCase JSON so the file is readable
/// and matches the IPC wire format.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[allow(dead_code)] // consumed by boot flow via get_settings; no direct Rust reader yet
    pub last_repo: Option<String>,
    #[allow(dead_code)] // orchestrator (step 8) will read this
    pub master_agent: AgentKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[allow(dead_code)] // agent detection (step 4) will honor these overrides
    pub claude_binary_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[allow(dead_code)]
    pub codex_binary_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[allow(dead_code)]
    pub gemini_binary_path: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            last_repo: None,
            master_agent: AgentKind::Claude,
            claude_binary_path: None,
            codex_binary_path: None,
            gemini_binary_path: None,
        }
    }
}

/// Read settings from disk. Missing file → defaults. Corrupt file → defaults
/// (the corrupt file is left alone; the next `save` will overwrite it).
pub fn load_from(path: &Path) -> Settings {
    match std::fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|e| {
            eprintln!("[settings] corrupt {}: {e} — using defaults", path.display());
            Settings::default()
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Settings::default(),
        Err(e) => {
            eprintln!("[settings] read {} failed: {e} — using defaults", path.display());
            Settings::default()
        }
    }
}

/// Persist settings atomically: write to `<path>.tmp` then rename. On the
/// same filesystem this avoids a half-written file if the process dies mid
/// write. The parent directory is created if missing.
pub fn save_to(settings: &Settings, path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create settings dir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| format!("serialize: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("rename tmp: {e}"))?;
    Ok(())
}

/// Apply a JSON patch in place. Unknown keys are ignored (forwards compatible
/// with older backends). Known keys with the wrong type return an error so
/// the caller can surface a type mismatch instead of silently dropping it.
pub fn apply_patch(settings: &mut Settings, patch: &serde_json::Value) -> Result<(), String> {
    let Some(obj) = patch.as_object() else {
        return Err("patch must be a JSON object".into());
    };
    for (key, value) in obj {
        match key.as_str() {
            "lastRepo" => settings.last_repo = from_nullable_string(key, value)?,
            "masterAgent" => {
                settings.master_agent = serde_json::from_value(value.clone())
                    .map_err(|e| format!("masterAgent: {e}"))?;
            }
            "claudeBinaryPath" => settings.claude_binary_path = from_nullable_string(key, value)?,
            "codexBinaryPath" => settings.codex_binary_path = from_nullable_string(key, value)?,
            "geminiBinaryPath" => settings.gemini_binary_path = from_nullable_string(key, value)?,
            _ => {} // ignore unknown keys
        }
    }
    Ok(())
}

fn from_nullable_string(key: &str, value: &serde_json::Value) -> Result<Option<String>, String> {
    match value {
        serde_json::Value::Null => Ok(None),
        serde_json::Value::String(s) => Ok(Some(s.clone())),
        _ => Err(format!("{key}: expected string or null")),
    }
}

/// Resolves `<app_config_dir>/settings.json` and ensures the directory exists.
pub fn resolve_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("resolve app_config_dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create app_config_dir: {e}"))?;
    Ok(dir.join("settings.json"))
}

/// Wrapper exposing the loaded settings + the path they came from. Held in
/// `IpcState`; guarded by a `Mutex` because command handlers are `Sync` and
/// may be invoked concurrently from different frontend calls.
#[derive(Debug)]
pub struct SettingsStore {
    pub settings: Mutex<Settings>,
    pub path: PathBuf,
}

impl SettingsStore {
    pub fn load_at(path: PathBuf) -> Self {
        let settings = load_from(&path);
        Self {
            settings: Mutex::new(settings),
            path,
        }
    }

    pub fn snapshot(&self) -> Result<Settings, String> {
        self.settings
            .lock()
            .map(|g| g.clone())
            .map_err(|e| format!("settings lock poisoned: {e}"))
    }

    pub fn update(&self, patch: &serde_json::Value) -> Result<Settings, String> {
        let mut guard = self
            .settings
            .lock()
            .map_err(|e| format!("settings lock poisoned: {e}"))?;
        apply_patch(&mut guard, patch)?;
        save_to(&guard, &self.path)?;
        Ok(guard.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn defaults_have_claude_as_master() {
        let s = Settings::default();
        assert_eq!(s.master_agent, AgentKind::Claude);
        assert!(s.last_repo.is_none());
    }

    #[test]
    fn serde_roundtrips_through_camel_case_json() {
        let original = Settings {
            last_repo: Some("/tmp/repo".into()),
            master_agent: AgentKind::Gemini,
            claude_binary_path: Some("/usr/local/bin/claude".into()),
            codex_binary_path: None,
            gemini_binary_path: None,
        };
        let json = serde_json::to_string(&original).unwrap();
        assert!(json.contains("\"lastRepo\":\"/tmp/repo\""));
        assert!(json.contains("\"masterAgent\":\"gemini\""));
        // None fields with skip_serializing_if shouldn't appear.
        assert!(!json.contains("codexBinaryPath"));
        let parsed: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.master_agent, AgentKind::Gemini);
        assert_eq!(parsed.last_repo.as_deref(), Some("/tmp/repo"));
    }

    #[test]
    fn missing_file_returns_defaults() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let s = load_from(&path);
        assert_eq!(s.master_agent, AgentKind::Claude);
    }

    #[test]
    fn corrupt_file_returns_defaults_without_deleting() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{ not json").unwrap();
        let s = load_from(&path);
        assert_eq!(s.master_agent, AgentKind::Claude);
        // File is left alone — only save_to overwrites.
        assert!(path.exists());
    }

    #[test]
    fn save_and_load_are_symmetric() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let original = Settings {
            last_repo: Some("/x".into()),
            master_agent: AgentKind::Codex,
            claude_binary_path: None,
            codex_binary_path: Some("/usr/bin/codex".into()),
            gemini_binary_path: None,
        };
        save_to(&original, &path).unwrap();
        let reloaded = load_from(&path);
        assert_eq!(reloaded.master_agent, AgentKind::Codex);
        assert_eq!(reloaded.codex_binary_path.as_deref(), Some("/usr/bin/codex"));
    }

    #[test]
    fn patch_merges_known_keys_and_ignores_unknown() {
        let mut s = Settings::default();
        let patch = serde_json::json!({
            "lastRepo": "/foo",
            "masterAgent": "gemini",
            "garbage": "ignored"
        });
        apply_patch(&mut s, &patch).unwrap();
        assert_eq!(s.last_repo.as_deref(), Some("/foo"));
        assert_eq!(s.master_agent, AgentKind::Gemini);
    }

    #[test]
    fn patch_clears_last_repo_with_null() {
        let mut s = Settings {
            last_repo: Some("/foo".into()),
            ..Settings::default()
        };
        apply_patch(&mut s, &serde_json::json!({ "lastRepo": null })).unwrap();
        assert!(s.last_repo.is_none());
    }

    #[test]
    fn patch_leaves_unspecified_keys_untouched() {
        let mut s = Settings {
            last_repo: Some("/keep".into()),
            master_agent: AgentKind::Codex,
            ..Settings::default()
        };
        apply_patch(&mut s, &serde_json::json!({ "masterAgent": "gemini" })).unwrap();
        assert_eq!(s.last_repo.as_deref(), Some("/keep"));
        assert_eq!(s.master_agent, AgentKind::Gemini);
    }

    #[test]
    fn patch_rejects_wrong_type() {
        let mut s = Settings::default();
        let err = apply_patch(&mut s, &serde_json::json!({ "lastRepo": 42 })).unwrap_err();
        assert!(err.contains("lastRepo"));
    }
}
