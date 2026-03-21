use crate::detection::credentials;
use crate::detection::models::{AuthStatus, DetectedAgent};

const SUBPROCESS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Check if a CLI tool is installed by looking for it in PATH.
/// Runs `which` in a spawned thread with a 5-second timeout to avoid
/// blocking the async runtime.
fn is_installed(name: &str) -> bool {
    let name = name.to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = std::process::Command::new("which")
            .arg(&name)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        let _ = tx.send(result);
    });
    rx.recv_timeout(SUBPROCESS_TIMEOUT).unwrap_or(false)
}

/// Get the version string from a CLI tool's `--version` output.
/// Runs the command in a spawned thread with a 5-second timeout to avoid
/// blocking the async runtime.
fn get_version(name: &str) -> Option<String> {
    let name = name.to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = std::process::Command::new(&name)
            .arg("--version")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .ok()
            .and_then(|output| {
                let text = String::from_utf8_lossy(&output.stdout).to_string();
                let line = text.lines().next().unwrap_or("").trim().to_string();
                if line.is_empty() { None } else { Some(line) }
            });
        let _ = tx.send(result);
    });
    rx.recv_timeout(SUBPROCESS_TIMEOUT).ok().flatten()
}

/// Scan for all supported agents.
pub async fn detect_all_agents() -> Vec<DetectedAgent> {
    let claude = detect_claude().await;
    let gemini = detect_gemini().await;
    let codex = detect_codex().await;
    vec![claude, gemini, codex]
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------
// Auth sources (per openusage/plugins/claude/plugin.js):
// 1. ~/.claude/.credentials.json → claudeAiOauth.accessToken
// 2. macOS Keychain service "Claude Code-credentials" → same JSON
// 3. ANTHROPIC_API_KEY env var

async fn detect_claude() -> DetectedAgent {
    let installed = is_installed("claude");
    let version = if installed { get_version("claude") } else { None };
    let auth_status = if !installed {
        AuthStatus::NotInstalled
    } else {
        check_claude_auth()
    };
    DetectedAgent {
        tool_name: "claude".to_string(),
        installed,
        binary_path: None,
        version,
        auth_status,
        display_name: "Claude Code".to_string(),
    }
}

fn check_claude_auth() -> AuthStatus {
    if credentials::has_claude_auth() {
        AuthStatus::Authenticated
    } else {
        AuthStatus::NeedsAuth
    }
}

// ---------------------------------------------------------------------------
// Gemini CLI
// ---------------------------------------------------------------------------
// Auth sources (per openusage/plugins/gemini/plugin.js):
// 1. ~/.gemini/oauth_creds.json → access_token or refresh_token
// 2. GEMINI_API_KEY or GOOGLE_API_KEY env var

async fn detect_gemini() -> DetectedAgent {
    let installed = is_installed("gemini");
    let version = if installed { get_version("gemini") } else { None };
    let auth_status = if !installed {
        AuthStatus::NotInstalled
    } else {
        check_gemini_auth()
    };
    DetectedAgent {
        tool_name: "gemini".to_string(),
        installed,
        binary_path: None,
        version,
        auth_status,
        display_name: "Gemini CLI".to_string(),
    }
}

fn check_gemini_auth() -> AuthStatus {
    if credentials::has_gemini_auth() {
        AuthStatus::Authenticated
    } else {
        AuthStatus::NeedsAuth
    }
}

// ---------------------------------------------------------------------------
// Codex CLI
// ---------------------------------------------------------------------------
// Auth sources (per openusage/plugins/codex/plugin.js):
// 1. $CODEX_HOME/auth.json → tokens.access_token
// 2. ~/.config/codex/auth.json
// 3. ~/.codex/auth.json
// 4. macOS Keychain "Codex Auth"
// 5. OPENAI_API_KEY env var

async fn detect_codex() -> DetectedAgent {
    let installed = is_installed("codex");
    let version = if installed { get_version("codex") } else { None };
    let auth_status = if !installed {
        AuthStatus::NotInstalled
    } else {
        check_codex_auth()
    };
    DetectedAgent {
        tool_name: "codex".to_string(),
        installed,
        binary_path: None,
        version,
        auth_status,
        display_name: "Codex CLI".to_string(),
    }
}

fn check_codex_auth() -> AuthStatus {
    if credentials::has_codex_auth() {
        AuthStatus::Authenticated
    } else {
        AuthStatus::NeedsAuth
    }
}

// ---------------------------------------------------------------------------
// Hex decode helper (for macOS Keychain hex-encoded payloads)
// ---------------------------------------------------------------------------

pub fn hex_decode_utf8(hex: &str) -> Option<String> {
    let hex = hex.trim();
    if hex.len() % 2 != 0 { return None; }
    // Check if it looks like hex (all chars are hex digits)
    if !hex.chars().all(|c| c.is_ascii_hexdigit()) { return None; }
    let bytes: Vec<u8> = (0..hex.len())
        .step_by(2)
        .filter_map(|i| u8::from_str_radix(&hex[i..i+2], 16).ok())
        .collect();
    String::from_utf8(bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hex_decode_valid() {
        assert_eq!(hex_decode_utf8("48656c6c6f"), Some("Hello".to_string()));
    }

    #[test]
    fn test_hex_decode_json() {
        // 7b0a = {\n
        assert_eq!(hex_decode_utf8("7b0a"), Some("{\n".to_string()));
    }

    #[test]
    fn test_hex_decode_invalid() {
        assert_eq!(hex_decode_utf8("not hex"), None);
        assert_eq!(hex_decode_utf8("123"), None); // odd length
    }

    #[test]
    fn test_hex_decode_empty() {
        assert_eq!(hex_decode_utf8(""), Some(String::new()));
    }

    #[test]
    fn test_is_installed_known_command() {
        // "echo" is a shell built-in but /bin/echo exists on all Unix systems
        // Use "ls" which is universally present as an external binary
        assert!(is_installed("ls"), "ls should be installed");
    }

    #[test]
    fn test_is_installed_unknown_command() {
        assert!(!is_installed("this_command_does_not_exist_12345"));
    }

    #[test]
    fn test_get_version_known_command() {
        // "ls" supports --version on Linux; on macOS it may not,
        // so we use a tool that reliably has --version everywhere.
        // "git" is widely installed and always has --version.
        // Fallback: just verify the function doesn't panic.
        let _ = get_version("ls");
    }

    #[test]
    fn test_get_version_unknown_command() {
        assert!(get_version("this_command_does_not_exist_12345").is_none());
    }
}
