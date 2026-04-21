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
//!
//! The `dead_code` allow-list on the struct covers readers that land in
//! later steps.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::ipc::{AgentKind, MigrationKind, MigrationNotice};

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
    /// Preferred editor binary for Layer-3 human escalation. Passed to
    /// [`crate::editor::open_in_editor`] as the first tier of the
    /// resolution chain. `None` (absent / null) skips straight to
    /// `$EDITOR` / platform default / clipboard.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[allow(dead_code)]
    pub editor: Option<String>,
    /// Phase 3 Step 7: auto-approve plans without showing the
    /// approval sheet. When `true`, the lifecycle synthesizes an
    /// `Approve(all_ids)` decision for the initial plan and for any
    /// Layer-2 replan — *subject* to the `max_subtasks_per_auto_approved_run`
    /// ceiling. Layer-3 human escalation and the merge/apply step are
    /// never bypassed. Defaults to `false` so first-time users hit the
    /// normal approval flow.
    #[serde(default)]
    pub auto_approve: bool,
    /// Hard ceiling on how many subtasks a single auto-approved run is
    /// allowed to dispatch across all plan passes (initial + replans).
    /// When an approval pass would push the total past this number,
    /// auto-approve is suspended for the rest of the run and the user
    /// falls back into manual approval. 20 is the Q7 default.
    #[serde(default = "default_max_subtasks_per_auto_approved_run")]
    pub max_subtasks_per_auto_approved_run: u32,
    /// `true` after the user has acknowledged the auto-approve consent
    /// modal at least once. The modal explains that auto-approve skips
    /// the approval sheet on initial plans and replans, and that
    /// Layer-3 + apply still require a user click. The frontend shows
    /// the modal the first time the toggle is flipped on while this
    /// flag is `false`; flipping it back off does not clear the flag.
    #[serde(default)]
    pub auto_approve_consent_given: bool,
}

fn default_max_subtasks_per_auto_approved_run() -> u32 {
    20
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            last_repo: None,
            master_agent: AgentKind::Claude,
            claude_binary_path: None,
            codex_binary_path: None,
            gemini_binary_path: None,
            editor: None,
            auto_approve: false,
            max_subtasks_per_auto_approved_run: default_max_subtasks_per_auto_approved_run(),
            auto_approve_consent_given: false,
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

/// Apply schema migrations to a freshly-loaded [`Settings`]. Returns
/// the list of notices the frontend should surface once at boot;
/// today that's just the Phase 4 Step 1 Gemini demotion.
///
/// Mutation policy: migrations MUST be idempotent — calling `migrate`
/// on an already-migrated settings struct is a no-op. The caller is
/// responsible for persisting the mutated struct back to disk; see
/// [`SettingsStore::load_at`].
///
/// The split from `load_from` keeps the on-disk parsing pure and
/// testable without reaching for `SettingsStore` plumbing.
pub fn migrate(settings: &mut Settings) -> Vec<MigrationNotice> {
    let mut notices = Vec::new();

    // Phase 4 Step 1: Gemini is worker-only. A user who picked it as
    // master in Phase 3 (or earlier) gets flipped to Claude — the
    // default master — and a one-shot notice explains why.
    if !settings.master_agent.supports_master() {
        let previous = settings.master_agent;
        settings.master_agent = Settings::default().master_agent;
        // Only the Gemini case is known today; future worker-only
        // agents would produce the same migration variant.
        if matches!(previous, AgentKind::Gemini) {
            notices.push(MigrationNotice {
                kind: MigrationKind::GeminiMasterDemoted,
                message: format!(
                    "Gemini is now worker-only — master agent switched to {}. \
                     You can still assign Gemini to individual subtasks.",
                    agent_display_name(settings.master_agent)
                ),
            });
        }
    }

    notices
}

fn agent_display_name(kind: AgentKind) -> &'static str {
    match kind {
        AgentKind::Claude => "Claude Code",
        AgentKind::Codex => "Codex CLI",
        AgentKind::Gemini => "Gemini CLI",
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
                let parsed: AgentKind = serde_json::from_value(value.clone())
                    .map_err(|e| format!("masterAgent: {e}"))?;
                // Defence in depth against a client that managed to
                // send a worker-only agent (stale UI, hand-crafted IPC
                // call). The TopBar filters these before submit; this
                // check makes sure the backend can't be coaxed into
                // accepting one.
                if !parsed.supports_master() {
                    return Err(format!(
                        "masterAgent: {:?} is worker-only and cannot be master",
                        parsed
                    ));
                }
                settings.master_agent = parsed;
            }
            "claudeBinaryPath" => settings.claude_binary_path = from_nullable_string(key, value)?,
            "codexBinaryPath" => settings.codex_binary_path = from_nullable_string(key, value)?,
            "geminiBinaryPath" => settings.gemini_binary_path = from_nullable_string(key, value)?,
            "editor" => settings.editor = from_nullable_string(key, value)?,
            "autoApprove" => {
                settings.auto_approve = value
                    .as_bool()
                    .ok_or_else(|| format!("{key}: expected boolean"))?;
            }
            "maxSubtasksPerAutoApprovedRun" => {
                let n = value
                    .as_u64()
                    .ok_or_else(|| format!("{key}: expected positive integer"))?;
                if n == 0 {
                    return Err(format!("{key}: must be greater than zero"));
                }
                if n > u32::MAX as u64 {
                    return Err(format!("{key}: must fit in u32"));
                }
                settings.max_subtasks_per_auto_approved_run = n as u32;
            }
            "autoApproveConsentGiven" => {
                settings.auto_approve_consent_given = value
                    .as_bool()
                    .ok_or_else(|| format!("{key}: expected boolean"))?;
            }
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
    /// Boot-time migration notices stashed here until the frontend
    /// drains them via `consume_migration_notices`. Read-once: a
    /// second call returns `[]`. Independent mutex from `settings`
    /// so the two don't contend under IPC load.
    migration_notices: Mutex<Vec<MigrationNotice>>,
}

impl SettingsStore {
    pub fn load_at(path: PathBuf) -> Self {
        let mut settings = load_from(&path);
        let notices = migrate(&mut settings);
        // Persist the migrated struct so subsequent boots don't
        // re-trigger the same migration. Best-effort: if the write
        // fails, the notice still fires but the user will see the
        // banner again next launch — no data loss.
        if !notices.is_empty() {
            if let Err(e) = save_to(&settings, &path) {
                eprintln!(
                    "[settings] persist after migration failed: {e} — notices still queued",
                );
            }
        }
        Self {
            settings: Mutex::new(settings),
            path,
            migration_notices: Mutex::new(notices),
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

    /// Drain the boot-time migration notices. Read-once: subsequent
    /// calls return an empty vec. Wired to the
    /// `consume_migration_notices` IPC command so the frontend can
    /// render a single heads-up banner per launch.
    pub fn consume_migration_notices(&self) -> Result<Vec<MigrationNotice>, String> {
        let mut guard = self
            .migration_notices
            .lock()
            .map_err(|e| format!("migration notices lock poisoned: {e}"))?;
        Ok(std::mem::take(&mut *guard))
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
            editor: None,
            auto_approve: false,
            max_subtasks_per_auto_approved_run:
                default_max_subtasks_per_auto_approved_run(),
            auto_approve_consent_given: false,
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
            editor: None,
            auto_approve: false,
            max_subtasks_per_auto_approved_run:
                default_max_subtasks_per_auto_approved_run(),
            auto_approve_consent_given: false,
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
            "masterAgent": "codex",
            "garbage": "ignored"
        });
        apply_patch(&mut s, &patch).unwrap();
        assert_eq!(s.last_repo.as_deref(), Some("/foo"));
        assert_eq!(s.master_agent, AgentKind::Codex);
    }

    #[test]
    fn patch_rejects_worker_only_agent_as_master() {
        // Phase 4 Step 1: Gemini is worker-only. The backend
        // rejects `masterAgent: "gemini"` on the patch path even
        // though the enum still accepts the variant for worker
        // assignment purposes.
        let mut s = Settings::default();
        let err = apply_patch(&mut s, &serde_json::json!({ "masterAgent": "gemini" }))
            .unwrap_err();
        assert!(err.contains("masterAgent"));
        assert!(
            err.to_lowercase().contains("worker-only"),
            "error should explain the rejection: {err}"
        );
        // And the field is left untouched on rejection.
        assert_eq!(s.master_agent, AgentKind::Claude);
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
            master_agent: AgentKind::Claude,
            ..Settings::default()
        };
        apply_patch(&mut s, &serde_json::json!({ "masterAgent": "codex" })).unwrap();
        assert_eq!(s.last_repo.as_deref(), Some("/keep"));
        assert_eq!(s.master_agent, AgentKind::Codex);
    }

    #[test]
    fn patch_rejects_wrong_type() {
        let mut s = Settings::default();
        let err = apply_patch(&mut s, &serde_json::json!({ "lastRepo": 42 })).unwrap_err();
        assert!(err.contains("lastRepo"));
    }

    #[test]
    fn patch_sets_and_clears_editor() {
        let mut s = Settings::default();
        apply_patch(&mut s, &serde_json::json!({ "editor": "code" })).unwrap();
        assert_eq!(s.editor.as_deref(), Some("code"));
        apply_patch(&mut s, &serde_json::json!({ "editor": null })).unwrap();
        assert!(s.editor.is_none());
    }

    #[test]
    fn editor_field_round_trips_via_json() {
        let s = Settings {
            editor: Some("code".into()),
            ..Settings::default()
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"editor\":\"code\""));
        // Absent field deserializes back to None without complaint.
        let without: Settings = serde_json::from_str(
            r#"{"lastRepo":null,"masterAgent":"claude"}"#,
        )
        .unwrap();
        assert!(without.editor.is_none());
    }

    #[test]
    fn auto_approve_defaults_are_safe() {
        // Defaults must skip the bypass entirely — a freshly-installed
        // app never auto-approves until the user opts in.
        let s = Settings::default();
        assert!(!s.auto_approve);
        assert!(!s.auto_approve_consent_given);
        assert_eq!(s.max_subtasks_per_auto_approved_run, 20);
    }

    #[test]
    fn patch_toggles_auto_approve_flags() {
        let mut s = Settings::default();
        apply_patch(
            &mut s,
            &serde_json::json!({
                "autoApprove": true,
                "autoApproveConsentGiven": true,
            }),
        )
        .unwrap();
        assert!(s.auto_approve);
        assert!(s.auto_approve_consent_given);

        // Turning auto-approve back off does not clear the consent flag
        // — the user has seen the modal once and doesn't need to re-ack.
        apply_patch(&mut s, &serde_json::json!({ "autoApprove": false })).unwrap();
        assert!(!s.auto_approve);
        assert!(s.auto_approve_consent_given);
    }

    #[test]
    fn patch_updates_max_subtasks() {
        let mut s = Settings::default();
        apply_patch(
            &mut s,
            &serde_json::json!({ "maxSubtasksPerAutoApprovedRun": 5 }),
        )
        .unwrap();
        assert_eq!(s.max_subtasks_per_auto_approved_run, 5);
    }

    #[test]
    fn patch_rejects_zero_max_subtasks() {
        let mut s = Settings::default();
        let err = apply_patch(
            &mut s,
            &serde_json::json!({ "maxSubtasksPerAutoApprovedRun": 0 }),
        )
        .unwrap_err();
        assert!(err.contains("maxSubtasksPerAutoApprovedRun"));
        assert_eq!(
            s.max_subtasks_per_auto_approved_run,
            default_max_subtasks_per_auto_approved_run()
        );
    }

    #[test]
    fn patch_rejects_wrong_type_for_auto_approve() {
        let mut s = Settings::default();
        let err =
            apply_patch(&mut s, &serde_json::json!({ "autoApprove": "yes" })).unwrap_err();
        assert!(err.contains("autoApprove"));
    }

    #[test]
    fn auto_approve_fields_round_trip_through_disk() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let original = Settings {
            auto_approve: true,
            auto_approve_consent_given: true,
            max_subtasks_per_auto_approved_run: 7,
            ..Settings::default()
        };
        save_to(&original, &path).unwrap();
        let reloaded = load_from(&path);
        assert!(reloaded.auto_approve);
        assert!(reloaded.auto_approve_consent_given);
        assert_eq!(reloaded.max_subtasks_per_auto_approved_run, 7);
    }

    #[test]
    fn migrate_demotes_gemini_master_and_emits_notice() {
        // Phase 4 Step 1: a legacy settings file with `masterAgent:
        // "gemini"` must be flipped to the default master on load,
        // and a notice must be queued so the UI can explain why.
        let mut s = Settings {
            master_agent: AgentKind::Gemini,
            ..Settings::default()
        };
        let notices = migrate(&mut s);
        assert_eq!(s.master_agent, AgentKind::Claude);
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].kind, crate::ipc::MigrationKind::GeminiMasterDemoted);
        assert!(
            notices[0].message.to_lowercase().contains("gemini"),
            "notice should mention the demoted agent: {}",
            notices[0].message,
        );
    }

    #[test]
    fn migrate_is_idempotent_for_already_migrated_settings() {
        let mut s = Settings::default();
        let first = migrate(&mut s);
        assert!(first.is_empty());
        let second = migrate(&mut s);
        assert!(second.is_empty());
    }

    #[test]
    fn migrate_leaves_codex_master_untouched() {
        // Sanity: only worker-only agents get demoted. Codex is a
        // supported master; migrate must not touch it.
        let mut s = Settings {
            master_agent: AgentKind::Codex,
            ..Settings::default()
        };
        let notices = migrate(&mut s);
        assert_eq!(s.master_agent, AgentKind::Codex);
        assert!(notices.is_empty());
    }

    #[test]
    fn settings_store_load_at_surfaces_gemini_demotion_once() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let legacy = Settings {
            master_agent: AgentKind::Gemini,
            ..Settings::default()
        };
        save_to(&legacy, &path).unwrap();

        let store = SettingsStore::load_at(path.clone());
        // First drain: one notice for the Gemini demotion.
        let notices = store.consume_migration_notices().unwrap();
        assert_eq!(notices.len(), 1);

        // Read-once semantics: second drain is empty.
        let again = store.consume_migration_notices().unwrap();
        assert!(again.is_empty());

        // The migration was persisted: reopening the file returns
        // Claude, not Gemini, so the banner never fires twice.
        let reloaded = load_from(&path);
        assert_eq!(reloaded.master_agent, AgentKind::Claude);
    }

    #[test]
    fn missing_auto_approve_fields_deserialize_to_defaults() {
        // Upgrading from a pre-Phase-3 settings file must not error —
        // the new fields fall back to safe defaults.
        let legacy = r#"{"lastRepo":null,"masterAgent":"claude"}"#;
        let s: Settings = serde_json::from_str(legacy).unwrap();
        assert!(!s.auto_approve);
        assert!(!s.auto_approve_consent_given);
        assert_eq!(
            s.max_subtasks_per_auto_approved_run,
            default_max_subtasks_per_auto_approved_run()
        );
    }
}
