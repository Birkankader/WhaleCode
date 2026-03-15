use crate::credentials::{keychain, gemini_keychain, codex_keychain};
use crate::detection::models::{AuthStatus, DetectedAgent};

/// Check if a CLI tool is installed by looking for it in PATH.
fn is_installed(name: &str) -> bool {
    std::process::Command::new("which")
        .arg(name)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn get_version(name: &str) -> Option<String> {
    let output = std::process::Command::new(name)
        .arg("--version")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().next().unwrap_or("").trim().to_string();
    if line.is_empty() { None } else { Some(line) }
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
    // 1. Check ~/.claude/.credentials.json
    if let Ok(home) = std::env::var("HOME") {
        let cred_path = std::path::Path::new(&home).join(".claude").join(".credentials.json");
        if cred_path.exists() {
            if let Ok(content) = std::fs::read_to_string(&cred_path) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                    if json.get("claudeAiOauth")
                        .and_then(|o| o.get("accessToken"))
                        .and_then(|t| t.as_str())
                        .map(|t| !t.is_empty())
                        .unwrap_or(false)
                    {
                        return AuthStatus::Authenticated;
                    }
                }
            }
        }
    }

    // 2. Check macOS Keychain — "Claude Code-credentials"
    if let Ok(output) = std::process::Command::new("security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
    {
        if output.status.success() {
            let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
            // May be hex-encoded — try to parse as JSON directly or decode hex
            let json_str = if raw.starts_with('{') {
                raw
            } else {
                hex_decode_utf8(&raw).unwrap_or(raw)
            };
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&json_str) {
                if json.get("claudeAiOauth")
                    .and_then(|o| o.get("accessToken"))
                    .and_then(|t| t.as_str())
                    .map(|t| !t.is_empty())
                    .unwrap_or(false)
                {
                    return AuthStatus::Authenticated;
                }
            }
        }
    }

    // 3. WhaleCode's own keychain
    if keychain::has_api_key() {
        return AuthStatus::Authenticated;
    }

    // 4. ANTHROPIC_API_KEY env var
    if std::env::var("ANTHROPIC_API_KEY").map(|k| !k.is_empty()).unwrap_or(false) {
        return AuthStatus::Authenticated;
    }

    AuthStatus::NeedsAuth
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
    // 1. ~/.gemini/oauth_creds.json
    if let Ok(home) = std::env::var("HOME") {
        let cred_path = std::path::Path::new(&home).join(".gemini").join("oauth_creds.json");
        if cred_path.exists() {
            if let Ok(content) = std::fs::read_to_string(&cred_path) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                    let has_access = json.get("access_token").and_then(|t| t.as_str()).map(|t| !t.is_empty()).unwrap_or(false);
                    let has_refresh = json.get("refresh_token").and_then(|t| t.as_str()).map(|t| !t.is_empty()).unwrap_or(false);
                    if has_access || has_refresh {
                        return AuthStatus::Authenticated;
                    }
                }
            }
        }
    }

    // 2. WhaleCode's own keychain
    if gemini_keychain::has_gemini_api_key() {
        return AuthStatus::Authenticated;
    }

    // 3. Env vars
    if std::env::var("GEMINI_API_KEY").map(|k| !k.is_empty()).unwrap_or(false) {
        return AuthStatus::Authenticated;
    }
    if std::env::var("GOOGLE_API_KEY").map(|k| !k.is_empty()).unwrap_or(false) {
        return AuthStatus::Authenticated;
    }

    AuthStatus::NeedsAuth
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
    let home = std::env::var("HOME").unwrap_or_default();

    // Auth file paths (in priority order)
    let codex_home = std::env::var("CODEX_HOME").ok();
    let auth_paths: Vec<std::path::PathBuf> = vec![
        codex_home.as_ref().map(|h| std::path::PathBuf::from(h).join("auth.json")),
        Some(std::path::PathBuf::from(&home).join(".config").join("codex").join("auth.json")),
        Some(std::path::PathBuf::from(&home).join(".codex").join("auth.json")),
    ].into_iter().flatten().collect();

    for path in &auth_paths {
        if path.exists() {
            if let Ok(content) = std::fs::read_to_string(path) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                    let has_token = json.get("tokens")
                        .and_then(|t| t.get("access_token"))
                        .and_then(|t| t.as_str())
                        .map(|t| !t.is_empty())
                        .unwrap_or(false);
                    let has_api_key = json.get("OPENAI_API_KEY")
                        .and_then(|k| k.as_str())
                        .map(|k| !k.is_empty())
                        .unwrap_or(false);
                    if has_token || has_api_key {
                        return AuthStatus::Authenticated;
                    }
                }
            }
        }
    }

    // macOS Keychain — "Codex Auth"
    if let Ok(output) = std::process::Command::new("security")
        .args(["find-generic-password", "-s", "Codex Auth", "-w"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
    {
        if output.status.success() {
            let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !raw.is_empty() {
                return AuthStatus::Authenticated;
            }
        }
    }

    // WhaleCode's own keychain
    if codex_keychain::has_codex_api_key() {
        return AuthStatus::Authenticated;
    }

    // OPENAI_API_KEY env var
    if std::env::var("OPENAI_API_KEY").map(|k| !k.is_empty()).unwrap_or(false) {
        return AuthStatus::Authenticated;
    }

    AuthStatus::NeedsAuth
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
}
