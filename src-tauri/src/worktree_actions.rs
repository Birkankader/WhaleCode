//! Worktree inspection affordances for Phase 4 Step 4.
//!
//! Three user-facing actions live in the frontend's WorktreeActions
//! menu — two of them shell out through this module:
//!
//!   - **Reveal** in Finder / Explorer / Files: a single platform-default
//!     spawn (`open` / `xdg-open` / `explorer`). If that spawn fails we
//!     let the frontend fall back to "copy path" — surfaced by returning
//!     `false` from [`reveal_path`].
//!   - **Open terminal** at the worktree: walks a first-match candidate
//!     list per platform and returns [`TerminalResult`] indicating which
//!     tier won so the frontend can toast "opened in gnome-terminal" vs
//!     "no terminal detected; path copied instead".
//!
//! The third action ("Copy path") is frontend-only (navigator.clipboard)
//! and never reaches this module.
//!
//! # Security
//!
//! Every spawn uses `std::process::Command::args` with a pre-split
//! argument vector — no `sh -c <str>`, no format-into-shell. Worktree
//! paths are derived from `{run_id}/{subtask_id}` (both ULIDs, so
//! `[0-9A-HJKMNP-TV-Z]` only), which can't contain shell metacharacters
//! by construction, but we still pass paths as structured arguments in
//! case a future path source (e.g. user-set repo root) introduces
//! characters the shell would interpret.
//!
//! # Testability
//!
//! Public API splits the resolve/dispatch logic from the spawn side-
//! effect. [`reveal_path_with`] and [`open_terminal_with`] take a spawn
//! closure returning `bool`, and [`reveal_path`] / [`open_terminal`]
//! are thin wrappers around them that hand in the real
//! `std::process::Command::spawn`. Unit tests drive the spawn closure
//! directly and assert the (cmd, args) pairs the resolver tried.

#![cfg_attr(not(test), allow(dead_code))]

use std::path::Path;

use serde::{Deserialize, Serialize};

/// Did the terminal-open affordance find a spawner, or does the
/// frontend need to fall back to copying the path? Mirrored on the
/// frontend as `TerminalMethod`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalMethod {
    /// A terminal emulator was found and spawned successfully.
    Spawned,
    /// No terminal emulator was available (or all candidates failed to
    /// spawn); the frontend should copy the path to the clipboard and
    /// surface a toast. The path is always populated on the
    /// [`TerminalResult`] so the frontend has what it needs.
    ClipboardOnly,
}

/// Wire payload for `open_terminal_at`. Always carries the path so the
/// frontend can render "opened terminal at /foo" or, on
/// `ClipboardOnly`, fall back to copying that same path.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResult {
    pub method: TerminalMethod,
    pub path: String,
}

// ---------- Reveal in file manager ----------

/// Return value for [`reveal_path`]. `true` = a file manager launched,
/// `false` = frontend should toast an error (or fall back to Copy
/// path). Deliberately just a bool — there's only one tier per
/// platform, so no "which fallback won" to surface.
pub type RevealResult = bool;

/// Testable entry for "Reveal in Finder / Explorer / Files". `spawn`
/// returns `true` iff the process launched. Returns `false` if the
/// platform has no registered handler or the spawner failed.
pub fn reveal_path_with<F>(path: &Path, mut spawn: F) -> RevealResult
where
    F: FnMut(&str, &[&str]) -> bool,
{
    let path_str = path.to_string_lossy().into_owned();
    let Some((cmd, args)) = reveal_command(&path_str) else {
        return false;
    };
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    spawn(cmd, &arg_refs)
}

/// Real `reveal_path` — wraps [`reveal_path_with`] with
/// `std::process::Command::spawn`.
pub fn reveal_path(path: &Path) -> RevealResult {
    reveal_path_with(path, |cmd, args| {
        std::process::Command::new(cmd).args(args).spawn().is_ok()
    })
}

#[cfg(target_os = "macos")]
fn reveal_command(path: &str) -> Option<(&'static str, Vec<String>)> {
    // `open <dir>` opens the directory in Finder. Using the
    // directory-open form rather than `open -R <file>` because the
    // worktree path IS the directory — there's no enclosing parent
    // to reveal.
    Some(("open", vec![path.to_owned()]))
}

#[cfg(target_os = "linux")]
fn reveal_command(path: &str) -> Option<(&'static str, Vec<String>)> {
    // `xdg-open <dir>` delegates to the XDG-configured file manager.
    // On most desktops this is Files/Nautilus/Dolphin/Thunar.
    Some(("xdg-open", vec![path.to_owned()]))
}

#[cfg(target_os = "windows")]
fn reveal_command(path: &str) -> Option<(&'static str, Vec<String>)> {
    // `explorer <dir>` opens the directory in File Explorer. Unlike
    // `cmd /C start`, explorer doesn't need a title-placeholder
    // argument so we can pass the path cleanly.
    Some(("explorer", vec![path.to_owned()]))
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn reveal_command(_path: &str) -> Option<(&'static str, Vec<String>)> {
    None
}

// ---------- Open terminal at path ----------

/// A terminal candidate: the binary name plus the (already-split)
/// argument vector. Each candidate must carry the worktree path in a
/// structured arg — never interpolated into a shell string.
struct TerminalCandidate {
    cmd: &'static str,
    args: Vec<String>,
}

/// Testable entry for "Open terminal at path". Tries candidates in
/// order and returns `Spawned` on the first one that launches, or
/// `ClipboardOnly` if all fail / no candidates exist for this
/// platform.
pub fn open_terminal_with<F>(path: &Path, mut spawn: F) -> TerminalResult
where
    F: FnMut(&str, &[&str]) -> bool,
{
    let path_str = path.to_string_lossy().into_owned();
    let candidates = terminal_candidates(&path_str);
    for c in &candidates {
        let arg_refs: Vec<&str> = c.args.iter().map(String::as_str).collect();
        if spawn(c.cmd, &arg_refs) {
            return TerminalResult {
                method: TerminalMethod::Spawned,
                path: path_str,
            };
        }
    }
    TerminalResult {
        method: TerminalMethod::ClipboardOnly,
        path: path_str,
    }
}

/// Real `open_terminal` — wraps [`open_terminal_with`] with
/// `std::process::Command::spawn`.
pub fn open_terminal(path: &Path) -> TerminalResult {
    open_terminal_with(path, |cmd, args| {
        std::process::Command::new(cmd).args(args).spawn().is_ok()
    })
}

#[cfg(target_os = "macos")]
fn terminal_candidates(path: &str) -> Vec<TerminalCandidate> {
    // Decision 2 (locked): macOS forces Terminal.app via `-a Terminal`.
    // iTerm / Warp users get a settings toggle in Phase 5 — not
    // worth scope creep here.
    vec![TerminalCandidate {
        cmd: "open",
        args: vec!["-a".into(), "Terminal".into(), path.to_owned()],
    }]
}

#[cfg(target_os = "linux")]
fn terminal_candidates(path: &str) -> Vec<TerminalCandidate> {
    // Decision 3 (locked): first-match of gnome-terminal / konsole /
    // xterm / alacritty / kitty. `xterm -e` hands the cwd to a login
    // shell as `$1` so the path can't be re-interpreted by the shell;
    // the other four have native `--working-directory`-style flags.
    vec![
        TerminalCandidate {
            cmd: "gnome-terminal",
            args: vec!["--working-directory".into(), path.to_owned()],
        },
        TerminalCandidate {
            cmd: "konsole",
            args: vec!["--workdir".into(), path.to_owned()],
        },
        TerminalCandidate {
            cmd: "xterm",
            args: vec![
                "-e".into(),
                "sh".into(),
                "-c".into(),
                // `$1` is the first positional arg after `_`. Keeping
                // the path out of the script string means the shell
                // never parses it for metacharacters.
                "cd \"$1\"; exec \"${SHELL:-sh}\"".into(),
                "_".into(),
                path.to_owned(),
            ],
        },
        TerminalCandidate {
            cmd: "alacritty",
            args: vec!["--working-directory".into(), path.to_owned()],
        },
        TerminalCandidate {
            cmd: "kitty",
            args: vec!["--directory".into(), path.to_owned()],
        },
    ]
}

#[cfg(target_os = "windows")]
fn terminal_candidates(path: &str) -> Vec<TerminalCandidate> {
    // Decision 4 (locked): default to CMD via `start cmd /K cd /d`.
    // PowerShell users get a toggle in Phase 5 if asked. The empty
    // string is `start`'s window-title placeholder so it doesn't
    // swallow our first real argument.
    vec![TerminalCandidate {
        cmd: "cmd",
        args: vec![
            "/C".into(),
            "start".into(),
            String::new(),
            "cmd".into(),
            "/K".into(),
            "cd".into(),
            "/d".into(),
            path.to_owned(),
        ],
    }]
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn terminal_candidates(_path: &str) -> Vec<TerminalCandidate> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn p() -> PathBuf {
        // ULID-shaped path — mirrors `{run_id}/{subtask_id}` under
        // `.whalecode-worktrees`. No shell metacharacters by
        // construction; the test just asserts the path is passed
        // through as a structured arg.
        PathBuf::from("/tmp/.whalecode-worktrees/01HABC/01HXYZ")
    }

    // ---------- Reveal ----------

    #[test]
    fn reveal_returns_true_when_spawn_succeeds() {
        let mut calls: Vec<(String, Vec<String>)> = Vec::new();
        let ok = reveal_path_with(&p(), |cmd, args| {
            calls.push((cmd.to_owned(), args.iter().map(|s| s.to_string()).collect()));
            true
        });
        assert!(ok);
        assert_eq!(calls.len(), 1);
        // Path is always the last arg regardless of platform.
        assert_eq!(calls[0].1.last().unwrap(), &p().to_string_lossy().into_owned());
    }

    #[test]
    fn reveal_returns_false_when_spawn_fails() {
        let ok = reveal_path_with(&p(), |_cmd, _args| false);
        assert!(!ok);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn reveal_uses_open_on_macos() {
        let mut calls: Vec<String> = Vec::new();
        reveal_path_with(&p(), |cmd, _args| {
            calls.push(cmd.to_owned());
            true
        });
        assert_eq!(calls, vec!["open"]);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reveal_uses_xdg_open_on_linux() {
        let mut calls: Vec<String> = Vec::new();
        reveal_path_with(&p(), |cmd, _args| {
            calls.push(cmd.to_owned());
            true
        });
        assert_eq!(calls, vec!["xdg-open"]);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn reveal_uses_explorer_on_windows() {
        let mut calls: Vec<String> = Vec::new();
        reveal_path_with(&p(), |cmd, _args| {
            calls.push(cmd.to_owned());
            true
        });
        assert_eq!(calls, vec!["explorer"]);
    }

    // ---------- Open terminal ----------

    #[test]
    fn terminal_spawned_when_first_candidate_succeeds() {
        let mut calls: Vec<String> = Vec::new();
        let res = open_terminal_with(&p(), |cmd, _args| {
            calls.push(cmd.to_owned());
            true
        });
        assert_eq!(res.method, TerminalMethod::Spawned);
        assert_eq!(res.path, p().to_string_lossy().into_owned());
        assert_eq!(calls.len(), 1);
    }

    #[test]
    fn terminal_clipboard_only_when_all_candidates_fail() {
        let mut calls: Vec<String> = Vec::new();
        let res = open_terminal_with(&p(), |cmd, _args| {
            calls.push(cmd.to_owned());
            false
        });
        assert_eq!(res.method, TerminalMethod::ClipboardOnly);
        assert_eq!(res.path, p().to_string_lossy().into_owned());
        // At least one candidate was attempted (macOS: 1, Linux: 5,
        // Windows: 1); we only assert >= 1 so the test is
        // platform-agnostic.
        assert!(!calls.is_empty());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn terminal_falls_through_candidates_on_linux() {
        // Fourth candidate ("alacritty") is the one that "works" —
        // the resolver must have tried gnome-terminal, konsole, and
        // xterm first and given up on them before landing on
        // alacritty. Locks Decision 3's ordering: gnome-terminal /
        // konsole / xterm / alacritty / kitty.
        let mut calls: Vec<String> = Vec::new();
        let res = open_terminal_with(&p(), |cmd, _args| {
            calls.push(cmd.to_owned());
            cmd == "alacritty"
        });
        assert_eq!(res.method, TerminalMethod::Spawned);
        assert_eq!(
            calls,
            vec!["gnome-terminal", "konsole", "xterm", "alacritty"]
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn terminal_xterm_path_is_positional_arg_not_script_interpolation() {
        // Regression guard for Decision 5: the path must never be
        // splatted into the `sh -c` command string. xterm is the
        // only candidate that uses an inline script, and the path
        // is supposed to ride in as `$1` via the `_ <path>` suffix.
        let mut script_and_argv: Option<(String, Vec<String>)> = None;
        open_terminal_with(&p(), |cmd, args| {
            if cmd == "xterm" {
                // Capture the script (args[3]) + the trailing path arg
                // so we can assert the path never appears in the
                // script string.
                let script = args.get(3).copied().unwrap_or_default().to_owned();
                let tail: Vec<String> = args.iter().map(|s| s.to_string()).collect();
                script_and_argv = Some((script, tail));
            }
            cmd == "xterm"
        });
        let (script, argv) = script_and_argv.expect("xterm candidate must be tried");
        assert!(
            !script.contains(&p().to_string_lossy().into_owned()),
            "xterm script string must not contain the path; got {script:?}"
        );
        assert_eq!(argv.last().unwrap(), &p().to_string_lossy().into_owned());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn terminal_uses_terminal_app_on_macos() {
        let mut calls: Vec<(String, Vec<String>)> = Vec::new();
        open_terminal_with(&p(), |cmd, args| {
            calls.push((cmd.to_owned(), args.iter().map(|s| s.to_string()).collect()));
            true
        });
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "open");
        // `-a Terminal <path>`
        assert_eq!(calls[0].1, vec!["-a", "Terminal", &p().to_string_lossy()]);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn terminal_uses_cmd_start_on_windows() {
        let mut calls: Vec<(String, Vec<String>)> = Vec::new();
        open_terminal_with(&p(), |cmd, args| {
            calls.push((cmd.to_owned(), args.iter().map(|s| s.to_string()).collect()));
            true
        });
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "cmd");
        // /C start "" cmd /K cd /d <path>
        assert_eq!(calls[0].1[0], "/C");
        assert_eq!(calls[0].1[1], "start");
        assert_eq!(calls[0].1[2], "");
        assert_eq!(calls[0].1.last().unwrap(), &p().to_string_lossy().into_owned());
    }
}
