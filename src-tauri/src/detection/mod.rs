//! Agent detection: probes each supported CLI (`claude`, `codex`, `gemini`)
//! and reports whether it is available, broken, or not installed. Results
//! feed the master-agent picker on the frontend.
//!
//! Strategy per agent:
//!   1. Look for a `<agent>BinaryPath` override in `SettingsStore`. If set,
//!      it's authoritative — even if a working binary exists on PATH, we
//!      respect the user's explicit intent and surface the override's state
//!      verbatim (including "override path broken" if the file moved).
//!   2. Otherwise, walk a small list of candidate names (`claude` →
//!      `claude-code`, etc.) against an augmented PATH and take the first
//!      match.
//!   3. Probe `--version` on whatever was resolved, with a 3s timeout.
//!
//! Parallelism: `detect_all` runs all three probes concurrently via
//! `tokio::join!`, so the worst-case wall time is one timeout (3s), not
//! three.
//!
//! PATH augmentation: on macOS, GUI-launched apps inherit a minimal PATH
//! that misses Homebrew, nvm, cargo, etc. `get_augmented_path` front-loads
//! the usual install locations before delegating to `PATH` from the env.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use regex::Regex;
use tokio::process::Command;
use tokio::time::timeout;

use crate::ipc::{AgentDetectionResult, AgentKind, AgentStatus};
use crate::settings::SettingsStore;

const VERSION_TIMEOUT: Duration = Duration::from_secs(3);

/// Preference order when recommending a default master. Matches the product
/// spec's "Claude → Codex" fallback chain. Phase 4 Step 1 removed the
/// Gemini tail — Gemini is worker-only (see `AgentKind::supports_master`).
/// Keep the entries in this array `supports_master() == true`; a debug
/// assertion in [`Detector::detect_all`] guards against a future regression.
const RECOMMENDED_ORDER: [AgentKind; 2] = [AgentKind::Claude, AgentKind::Codex];

#[derive(Clone)]
pub struct Detector {
    settings: Arc<SettingsStore>,
    /// When set, replaces the augmented PATH. Lets tests point at a
    /// tempdir full of fake CLIs without touching the process env var
    /// (which is global and racy under `cargo test`).
    path_override: Option<String>,
}

impl Detector {
    pub fn new(settings: Arc<SettingsStore>) -> Self {
        Self {
            settings,
            path_override: None,
        }
    }

    #[cfg(test)]
    pub fn with_path(settings: Arc<SettingsStore>, path: String) -> Self {
        Self {
            settings,
            path_override: Some(path),
        }
    }

    pub async fn detect_all(&self) -> AgentDetectionResult {
        let (claude, codex, gemini) = tokio::join!(
            self.detect(AgentKind::Claude),
            self.detect(AgentKind::Codex),
            self.detect(AgentKind::Gemini),
        );

        // Defence in depth: the `RECOMMENDED_ORDER` const doc says every
        // entry must be master-capable. If a future edit adds a worker-
        // only agent to the array, a debug build catches it before a
        // release ships a silently-broken master picker.
        debug_assert!(
            RECOMMENDED_ORDER.iter().all(|k| k.supports_master()),
            "RECOMMENDED_ORDER must contain only master-capable agents",
        );

        let recommended_master = RECOMMENDED_ORDER
            .iter()
            .find(|kind| {
                let status = match **kind {
                    AgentKind::Claude => &claude,
                    AgentKind::Codex => &codex,
                    // Gemini is worker-only (Phase 4 Step 1). The const
                    // excludes it, so this arm is unreachable under the
                    // current invariant. Pattern-match exhaustively
                    // anyway so adding a new variant forces a compile
                    // error at this site.
                    AgentKind::Gemini => &gemini,
                };
                matches!(status, AgentStatus::Available { .. })
            })
            .copied();

        AgentDetectionResult {
            claude,
            codex,
            gemini,
            recommended_master,
        }
    }

    pub async fn detect(&self, kind: AgentKind) -> AgentStatus {
        match self.resolve_override(kind) {
            Ok(Some(path)) => {
                if !path.exists() {
                    return AgentStatus::Broken {
                        binary_path: path.clone(),
                        error: format!(
                            "Override path broken: {} (to use PATH-discovered binary, clear the override in settings)",
                            path.display()
                        ),
                    };
                }
                run_version(path).await
            }
            Ok(None) => match self.find_on_path(kind) {
                Some(path) => run_version(path).await,
                None => AgentStatus::NotInstalled,
            },
            Err(e) => AgentStatus::Broken {
                binary_path: PathBuf::new(),
                error: e,
            },
        }
    }

    fn resolve_override(&self, kind: AgentKind) -> Result<Option<PathBuf>, String> {
        let snap = self.settings.snapshot()?;
        let raw = match kind {
            AgentKind::Claude => snap.claude_binary_path,
            AgentKind::Codex => snap.codex_binary_path,
            AgentKind::Gemini => snap.gemini_binary_path,
        };
        Ok(raw.map(PathBuf::from))
    }

    fn find_on_path(&self, kind: AgentKind) -> Option<PathBuf> {
        let path_env = self
            .path_override
            .clone()
            .unwrap_or_else(get_augmented_path);
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        for name in candidate_binary_names(kind) {
            if let Ok(resolved) = which::which_in(name, Some(&path_env), &cwd) {
                return Some(resolved);
            }
        }
        None
    }
}

fn candidate_binary_names(kind: AgentKind) -> &'static [&'static str] {
    match kind {
        AgentKind::Claude => &["claude", "claude-code"],
        AgentKind::Codex => &["codex"],
        AgentKind::Gemini => &["gemini"],
    }
}

async fn run_version(path: PathBuf) -> AgentStatus {
    let mut cmd = Command::new(&path);
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    match timeout(VERSION_TIMEOUT, cmd.output()).await {
        Err(_) => AgentStatus::Broken {
            binary_path: path,
            error: "Version check timed out after 3s".into(),
        },
        Ok(Err(e)) => AgentStatus::Broken {
            binary_path: path,
            error: format!("failed to spawn: {e}"),
        },
        Ok(Ok(output)) => {
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                return AgentStatus::Broken {
                    binary_path: path,
                    error: if stderr.is_empty() {
                        format!("exited with {}", output.status)
                    } else {
                        stderr
                    },
                };
            }
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if stdout.is_empty() {
                return AgentStatus::Broken {
                    binary_path: path,
                    error: "Version output was empty".into(),
                };
            }
            AgentStatus::Available {
                version: parse_version(&stdout),
                binary_path: path,
            }
        }
    }
}

/// Best-effort semver extraction. Returns the first `X.Y.Z[-prerelease]`
/// token; falls back to the trimmed raw stdout if no match.
fn parse_version(stdout: &str) -> String {
    // Compiled once per call — cheap enough for a boot-time probe.
    let re = Regex::new(r"\d+\.\d+\.\d+(?:-[\w.]+)?").expect("version regex");
    match re.find(stdout) {
        Some(m) => m.as_str().to_string(),
        None => stdout.trim().to_string(),
    }
}

/// Computes the PATH we'll use when searching for agent binaries. On
/// macOS, front-load install locations that GUI launches miss. On other
/// platforms, pass through the env PATH unchanged.
pub fn get_augmented_path() -> String {
    let base = std::env::var("PATH").unwrap_or_default();

    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").map(PathBuf::from).ok();
        let extras = augmented_path_extras(home.as_deref());
        join_paths(&extras, &base)
    }

    #[cfg(not(target_os = "macos"))]
    {
        base
    }
}

/// Pure helper: compute the extra directories to prepend for a given HOME.
/// Unit-testable with a tempdir without mutating the process env.
fn augmented_path_extras(home: Option<&Path>) -> Vec<PathBuf> {
    let mut extras: Vec<PathBuf> =
        vec![PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")];

    if let Some(home) = home {
        extras.push(home.join(".local").join("bin"));
        extras.push(home.join(".cargo").join("bin"));
        extras.push(home.join(".volta").join("bin"));

        // nvm installs live at $HOME/.nvm/versions/node/<ver>/bin — glob all
        // present versions so users on nvm don't need to rehash PATH.
        let nvm = home.join(".nvm").join("versions").join("node");
        if let Ok(entries) = std::fs::read_dir(&nvm) {
            for entry in entries.flatten() {
                let bin = entry.path().join("bin");
                if bin.is_dir() {
                    extras.push(bin);
                }
            }
        }
    }

    extras
}

fn join_paths(extras: &[PathBuf], base: &str) -> String {
    let sep = if cfg!(windows) { ';' } else { ':' };
    let mut parts: Vec<String> = extras
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    if !base.is_empty() {
        parts.push(base.to_string());
    }
    parts.join(&sep.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{Settings, SettingsStore};
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::TempDir;

    // --- fixtures ---------------------------------------------------------

    fn store_with(settings: Settings) -> Arc<SettingsStore> {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, serde_json::to_string(&settings).unwrap()).unwrap();
        // Keep the tempdir alive for the test's lifetime by leaking it — the
        // OS cleans up on process exit and the file isn't written to again.
        std::mem::forget(dir);
        Arc::new(SettingsStore::load_at(path))
    }

    /// Writes a fake CLI into `dir/<name>` that echoes `stdout`/`stderr`
    /// and exits with `exit_code`. Returns the full path.
    #[cfg(unix)]
    fn fake_cli(dir: &Path, name: &str, stdout: &str, stderr: &str, exit_code: i32) -> PathBuf {
        let path = dir.join(name);
        let script = format!(
            "#!/bin/sh\nprintf '%s' \"{}\"\nprintf '%s' \"{}\" 1>&2\nexit {}\n",
            stdout.replace('"', "\\\""),
            stderr.replace('"', "\\\""),
            exit_code
        );
        fs::write(&path, script).unwrap();
        let mut perms = fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&path, perms).unwrap();
        path
    }

    // --- parse_version ----------------------------------------------------

    #[test]
    fn parse_version_extracts_semver() {
        assert_eq!(parse_version("claude 1.2.3"), "1.2.3");
        assert_eq!(parse_version("version 0.10.1-beta.4"), "0.10.1-beta.4");
    }

    #[test]
    fn parse_version_falls_back_to_raw_when_no_match() {
        assert_eq!(parse_version("unreleased-build"), "unreleased-build");
    }

    // --- augmented_path_extras -------------------------------------------

    #[test]
    fn augmented_path_extras_includes_homebrew_and_cargo() {
        let dir = TempDir::new().unwrap();
        let extras = augmented_path_extras(Some(dir.path()));
        assert!(extras.iter().any(|p| p.ends_with(".cargo/bin")));
        assert!(extras.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert!(extras.contains(&PathBuf::from("/usr/local/bin")));
    }

    #[test]
    fn augmented_path_extras_globs_nvm_versions() {
        let dir = TempDir::new().unwrap();
        let nvm = dir.path().join(".nvm/versions/node/v20.0.0/bin");
        fs::create_dir_all(&nvm).unwrap();
        let extras = augmented_path_extras(Some(dir.path()));
        assert!(extras.iter().any(|p| p == &nvm));
    }

    #[test]
    fn augmented_path_extras_handles_missing_home() {
        let extras = augmented_path_extras(None);
        assert!(extras.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert!(!extras.iter().any(|p| p.to_string_lossy().contains(".cargo")));
    }

    // --- Detector ---------------------------------------------------------

    #[cfg(unix)]
    #[tokio::test]
    async fn detects_all_available_when_each_cli_responds() {
        let dir = TempDir::new().unwrap();
        fake_cli(dir.path(), "claude", "claude 1.2.3\n", "", 0);
        fake_cli(dir.path(), "codex", "codex/0.4.0\n", "", 0);
        fake_cli(dir.path(), "gemini", "Gemini CLI 2.0.1\n", "", 0);
        let detector = Detector::with_path(
            store_with(Settings::default()),
            dir.path().to_string_lossy().into_owned(),
        );

        let res = detector.detect_all().await;
        match &res.claude {
            AgentStatus::Available { version, .. } => assert_eq!(version, "1.2.3"),
            other => panic!("expected claude available, got {other:?}"),
        }
        match &res.codex {
            AgentStatus::Available { version, .. } => assert_eq!(version, "0.4.0"),
            other => panic!("expected codex available, got {other:?}"),
        }
        match &res.gemini {
            AgentStatus::Available { version, .. } => assert_eq!(version, "2.0.1"),
            other => panic!("expected gemini available, got {other:?}"),
        }
        assert_eq!(res.recommended_master, Some(AgentKind::Claude));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn recommends_next_available_when_claude_missing() {
        let dir = TempDir::new().unwrap();
        fake_cli(dir.path(), "codex", "0.4.0\n", "", 0);
        let detector = Detector::with_path(
            store_with(Settings::default()),
            dir.path().to_string_lossy().into_owned(),
        );
        let res = detector.detect_all().await;
        assert!(matches!(res.claude, AgentStatus::NotInstalled));
        assert!(matches!(res.codex, AgentStatus::Available { .. }));
        assert_eq!(res.recommended_master, Some(AgentKind::Codex));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn gemini_is_never_recommended_as_master_even_when_sole_available() {
        // Phase 4 Step 1: Gemini is worker-only. Even when it's the
        // only CLI installed, `recommended_master` stays `None` —
        // the frontend then routes to AgentSetupState's "install a
        // master-capable agent" prompt.
        let dir = TempDir::new().unwrap();
        fake_cli(dir.path(), "gemini", "Gemini CLI 2.0.1\n", "", 0);
        let detector = Detector::with_path(
            store_with(Settings::default()),
            dir.path().to_string_lossy().into_owned(),
        );
        let res = detector.detect_all().await;
        assert!(matches!(res.gemini, AgentStatus::Available { .. }));
        assert!(matches!(res.claude, AgentStatus::NotInstalled));
        assert!(matches!(res.codex, AgentStatus::NotInstalled));
        assert_eq!(res.recommended_master, None);
    }

    #[test]
    fn recommended_order_contains_only_master_capable_agents() {
        // Mirror of the runtime `debug_assert!` in `detect_all`.
        // Having it as a unit test gives us the invariant in release
        // builds too.
        for kind in RECOMMENDED_ORDER.iter() {
            assert!(
                kind.supports_master(),
                "RECOMMENDED_ORDER leaked a worker-only agent: {kind:?}"
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn detects_broken_when_version_exits_nonzero() {
        let dir = TempDir::new().unwrap();
        fake_cli(dir.path(), "claude", "", "library not found", 127);
        let detector = Detector::with_path(
            store_with(Settings::default()),
            dir.path().to_string_lossy().into_owned(),
        );
        let status = detector.detect(AgentKind::Claude).await;
        match status {
            AgentStatus::Broken { error, .. } => assert!(error.contains("library not found")),
            other => panic!("expected broken, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn detects_not_installed_with_empty_path() {
        let dir = TempDir::new().unwrap(); // empty dir, nothing resolvable
        let detector = Detector::with_path(
            store_with(Settings::default()),
            dir.path().to_string_lossy().into_owned(),
        );
        let res = detector.detect_all().await;
        assert!(matches!(res.claude, AgentStatus::NotInstalled));
        assert!(matches!(res.codex, AgentStatus::NotInstalled));
        assert!(matches!(res.gemini, AgentStatus::NotInstalled));
        assert_eq!(res.recommended_master, None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn claude_code_alias_is_found_when_claude_is_missing() {
        let dir = TempDir::new().unwrap();
        fake_cli(dir.path(), "claude-code", "claude-code 3.1.0\n", "", 0);
        let detector = Detector::with_path(
            store_with(Settings::default()),
            dir.path().to_string_lossy().into_owned(),
        );
        let status = detector.detect(AgentKind::Claude).await;
        match status {
            AgentStatus::Available { version, binary_path } => {
                assert_eq!(version, "3.1.0");
                assert!(binary_path.ends_with("claude-code"));
            }
            other => panic!("expected available, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn override_path_wins_over_path_discovered_binary() {
        let dir = TempDir::new().unwrap();
        // PATH-discoverable one: working.
        fake_cli(dir.path(), "claude", "claude 1.0.0\n", "", 0);
        // Override: a different path that reports a distinct version.
        let override_dir = TempDir::new().unwrap();
        let overridden = fake_cli(override_dir.path(), "myclaude", "custom 9.9.9\n", "", 0);

        let settings = Settings {
            claude_binary_path: Some(overridden.to_string_lossy().into_owned()),
            ..Settings::default()
        };
        let detector = Detector::with_path(
            store_with(settings),
            dir.path().to_string_lossy().into_owned(),
        );
        let status = detector.detect(AgentKind::Claude).await;
        match status {
            AgentStatus::Available { version, binary_path } => {
                assert_eq!(version, "9.9.9");
                assert_eq!(binary_path, overridden);
            }
            other => panic!("expected overridden available, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn override_path_pointing_nowhere_is_broken_with_hint() {
        let settings = Settings {
            claude_binary_path: Some("/definitely/not/there".into()),
            ..Settings::default()
        };
        let detector = Detector::with_path(store_with(settings), String::new());
        let status = detector.detect(AgentKind::Claude).await;
        match status {
            AgentStatus::Broken { error, binary_path } => {
                assert!(error.contains("Override path broken"));
                assert!(error.contains("clear the override"));
                assert_eq!(binary_path, PathBuf::from("/definitely/not/there"));
            }
            other => panic!("expected broken, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn version_parse_falls_back_when_stdout_has_no_semver() {
        let dir = TempDir::new().unwrap();
        fake_cli(dir.path(), "claude", "nightly-build-xyz\n", "", 0);
        let detector = Detector::with_path(
            store_with(Settings::default()),
            dir.path().to_string_lossy().into_owned(),
        );
        match detector.detect(AgentKind::Claude).await {
            AgentStatus::Available { version, .. } => assert_eq!(version, "nightly-build-xyz"),
            other => panic!("expected available, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn version_check_times_out() {
        // Shell script that sleeps longer than the timeout window.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("claude");
        fs::write(&path, "#!/bin/sh\nsleep 10\n").unwrap();
        let mut perms = fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&path, perms).unwrap();

        let detector = Detector::with_path(
            store_with(Settings::default()),
            dir.path().to_string_lossy().into_owned(),
        );
        let status = tokio::time::timeout(
            Duration::from_secs(5),
            detector.detect(AgentKind::Claude),
        )
        .await
        .expect("detect returned within test budget");
        match status {
            AgentStatus::Broken { error, .. } => assert!(error.contains("timed out")),
            other => panic!("expected broken-timeout, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn available_version_with_empty_stdout_is_broken() {
        let dir = TempDir::new().unwrap();
        fake_cli(dir.path(), "claude", "", "", 0);
        let detector = Detector::with_path(
            store_with(Settings::default()),
            dir.path().to_string_lossy().into_owned(),
        );
        match detector.detect(AgentKind::Claude).await {
            AgentStatus::Broken { error, .. } => assert!(error.contains("empty")),
            other => panic!("expected broken, got {other:?}"),
        }
    }
}
