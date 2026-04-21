//! Editor resolution for Layer-3 human escalation.
//!
//! When the master's replan budget is exhausted, the user needs to take
//! over. The "Open in editor" affordance on the escalation surface calls
//! [`open_in_editor`], which tries tiers in order and reports back which
//! one won so the frontend can show an accurate status:
//!
//!   1. `configured` — `settings.editor` (user-set binary, e.g. `code`).
//!   2. `environment` — `$EDITOR`.
//!   3. `platform_default` — `open` (macOS), `xdg-open` (Linux),
//!      `cmd /C start "" <path>` (Windows).
//!   4. `clipboard_only` — no spawner succeeded. The backend makes no
//!      clipboard call of its own; the frontend uses `navigator.clipboard`
//!      on receipt of this variant so we don't pull in an OS-specific
//!      clipboard crate on the Rust side.
//!
//! [`resolve`] takes a spawn closure so unit tests can exercise the
//! fallback chain without launching real processes.

// Commit 2 wires the orchestrator to call `open_in_editor` from the
// `manual_fix_subtask` command; until then the functions are reachable
// only from tests, which would otherwise fail the dead-code lint.
#![allow(dead_code)]

use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EditorMethod {
    Configured,
    Environment,
    PlatformDefault,
    ClipboardOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EditorResult {
    pub method: EditorMethod,
    /// The absolute path the frontend should open or copy. Always
    /// populated so the status line can surface it regardless of which
    /// tier won.
    pub path: String,
}

/// Testable core. `spawn` returns `true` iff the process launched
/// successfully; the closure lets tests walk the fallback chain without
/// shelling out.
pub fn resolve<F>(
    path: &Path,
    configured: Option<&str>,
    env_editor: Option<String>,
    mut spawn: F,
) -> EditorResult
where
    F: FnMut(&str, &[&str]) -> bool,
{
    let path_str = path.to_string_lossy().into_owned();

    if let Some(cmd) = configured.map(str::trim).filter(|s| !s.is_empty()) {
        if spawn(cmd, &[path_str.as_str()]) {
            return EditorResult {
                method: EditorMethod::Configured,
                path: path_str,
            };
        }
    }

    if let Some(env) = env_editor
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if spawn(env, &[path_str.as_str()]) {
            return EditorResult {
                method: EditorMethod::Environment,
                path: path_str,
            };
        }
    }

    if let Some((cmd, args)) = platform_default_command(&path_str) {
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        if spawn(cmd, &arg_refs) {
            return EditorResult {
                method: EditorMethod::PlatformDefault,
                path: path_str,
            };
        }
    }

    EditorResult {
        method: EditorMethod::ClipboardOnly,
        path: path_str,
    }
}

#[cfg(target_os = "macos")]
fn platform_default_command(path: &str) -> Option<(&'static str, Vec<String>)> {
    Some(("open", vec![path.to_owned()]))
}

#[cfg(target_os = "linux")]
fn platform_default_command(path: &str) -> Option<(&'static str, Vec<String>)> {
    Some(("xdg-open", vec![path.to_owned()]))
}

#[cfg(target_os = "windows")]
fn platform_default_command(path: &str) -> Option<(&'static str, Vec<String>)> {
    // `cmd /C start "" <path>` — the empty string is the window title
    // argument `start` expects when the first quoted token is a path.
    Some((
        "cmd",
        vec!["/C".into(), "start".into(), String::new(), path.to_owned()],
    ))
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn platform_default_command(_path: &str) -> Option<(&'static str, Vec<String>)> {
    None
}

/// Public entry. Wraps [`resolve`] with the real `std::process::Command::spawn`.
pub fn open_in_editor(path: &Path, configured: Option<&str>) -> EditorResult {
    let env_editor = std::env::var("EDITOR").ok();
    resolve(path, configured, env_editor, |cmd, args| {
        std::process::Command::new(cmd).args(args).spawn().is_ok()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn p() -> PathBuf {
        PathBuf::from("/tmp/subtask-run1-s1.md")
    }

    #[test]
    fn configured_wins_when_it_spawns() {
        let mut calls: Vec<String> = Vec::new();
        let res = resolve(
            &p(),
            Some("code"),
            Some("vim".into()),
            |cmd, _args| {
                calls.push(cmd.to_owned());
                true
            },
        );
        assert_eq!(res.method, EditorMethod::Configured);
        assert_eq!(calls, vec!["code"]);
    }

    #[test]
    fn falls_through_configured_failure_to_environment() {
        let mut calls: Vec<String> = Vec::new();
        let res = resolve(&p(), Some("code"), Some("vim".into()), |cmd, _args| {
            calls.push(cmd.to_owned());
            cmd == "vim"
        });
        assert_eq!(res.method, EditorMethod::Environment);
        assert_eq!(calls, vec!["code", "vim"]);
    }

    #[test]
    fn skips_configured_when_empty_string() {
        let mut calls: Vec<String> = Vec::new();
        let res = resolve(&p(), Some("   "), Some("vim".into()), |cmd, _args| {
            calls.push(cmd.to_owned());
            cmd == "vim"
        });
        assert_eq!(res.method, EditorMethod::Environment);
        // The whitespace-only configured value never reached the spawner.
        assert_eq!(calls, vec!["vim"]);
    }

    #[test]
    fn skips_env_when_empty_string() {
        let mut calls: Vec<String> = Vec::new();
        let res = resolve(&p(), None, Some("  ".into()), |cmd, _args| {
            calls.push(cmd.to_owned());
            // Accept the platform default, not the (empty) env.
            !cmd.is_empty()
        });
        assert_ne!(res.method, EditorMethod::Environment);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn falls_through_to_platform_default_macos() {
        let mut calls: Vec<String> = Vec::new();
        let res = resolve(&p(), None, None, |cmd, args| {
            calls.push(format!("{cmd} {args:?}"));
            cmd == "open"
        });
        assert_eq!(res.method, EditorMethod::PlatformDefault);
        assert_eq!(calls.len(), 1);
        assert!(calls[0].starts_with("open"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn falls_through_to_platform_default_linux() {
        let mut calls: Vec<String> = Vec::new();
        let res = resolve(&p(), None, None, |cmd, _args| {
            calls.push(cmd.to_owned());
            cmd == "xdg-open"
        });
        assert_eq!(res.method, EditorMethod::PlatformDefault);
        assert_eq!(calls, vec!["xdg-open"]);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn falls_through_to_platform_default_windows() {
        let mut calls: Vec<String> = Vec::new();
        let res = resolve(&p(), None, None, |cmd, args| {
            calls.push(format!("{cmd} {args:?}"));
            cmd == "cmd"
        });
        assert_eq!(res.method, EditorMethod::PlatformDefault);
        assert_eq!(calls.len(), 1);
        assert!(calls[0].starts_with("cmd"));
    }

    #[test]
    fn lands_on_clipboard_only_when_everything_fails() {
        let res = resolve(&p(), Some("code"), Some("vim".into()), |_, _| false);
        assert_eq!(res.method, EditorMethod::ClipboardOnly);
        assert_eq!(res.path, "/tmp/subtask-run1-s1.md");
    }

    #[test]
    fn clipboard_only_when_no_configured_no_env_no_platform() {
        // All tiers fail (platform default returns false); clipboard is
        // the terminal fallback regardless of the path or configured
        // value.
        let res = resolve(&p(), None, None, |_, _| false);
        assert_eq!(res.method, EditorMethod::ClipboardOnly);
    }

    #[test]
    fn path_is_round_tripped_into_result() {
        let res = resolve(&p(), None, None, |_, _| false);
        assert_eq!(res.path, "/tmp/subtask-run1-s1.md");
    }
}
