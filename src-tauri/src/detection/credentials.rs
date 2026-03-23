/// Shared credential resolution for agent detection and usage fetching.
///
/// scanner.rs checks these for auth STATUS (returns AuthStatus enum),
/// while usage.rs uses them to obtain Bearer tokens for API calls.
/// This module provides the raw credential data so each caller can
/// interpret it as needed.

use crate::credentials::{codex_keychain, gemini_keychain, keychain};
use crate::detection::scanner::hex_decode_utf8;

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

/// OAuth credential data extracted from Claude's credential stores.
pub struct ClaudeOAuthCredential {
    pub access_token: String,
    pub subscription_type: Option<String>,
    pub rate_limit_tier: Option<String>,
}

/// Try to read a Claude OAuth credential from the credentials file or Keychain.
///
/// Checks in order:
/// 1. `~/.claude/.credentials.json` -> `claudeAiOauth.accessToken`
/// 2. macOS Keychain service "Claude Code-credentials" -> same JSON shape
///
/// Does NOT check `ANTHROPIC_API_KEY` or WhaleCode's own keychain — those are
/// agent-specific fallbacks handled by the callers.
pub fn get_claude_oauth_credential() -> Option<ClaudeOAuthCredential> {
    // 1. ~/.claude/.credentials.json
    if let Ok(home) = std::env::var("HOME") {
        let path = std::path::Path::new(&home)
            .join(".claude")
            .join(".credentials.json");
        if let Some(cred) = parse_claude_credential_json_file(&path) {
            return Some(cred);
        }
    }

    // 2. macOS Keychain — "Claude Code-credentials"
    if let Ok(output) = std::process::Command::new("security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
    {
        if output.status.success() {
            let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let json_str = if raw.starts_with('{') {
                raw
            } else {
                hex_decode_utf8(&raw).unwrap_or(raw.clone())
            };
            if let Some(cred) = parse_claude_credential_json(&json_str) {
                return Some(cred);
            }
        }
    }

    None
}

/// Check if Claude has any form of authentication (OAuth, WhaleCode keychain, or env var).
pub fn has_claude_auth() -> bool {
    if get_claude_oauth_credential().is_some() {
        return true;
    }
    if keychain::has_api_key() {
        return true;
    }
    if std::env::var("ANTHROPIC_API_KEY")
        .map(|k| !k.is_empty())
        .unwrap_or(false)
    {
        return true;
    }
    false
}

fn parse_claude_credential_json_file(path: &std::path::Path) -> Option<ClaudeOAuthCredential> {
    let content = std::fs::read_to_string(path).ok()?;
    parse_claude_credential_json(&content)
}

fn parse_claude_credential_json(content: &str) -> Option<ClaudeOAuthCredential> {
    let json: serde_json::Value = serde_json::from_str(content).ok()?;
    let oauth = json.get("claudeAiOauth")?;
    let token = oauth.get("accessToken")?.as_str().filter(|t| !t.is_empty())?;
    let subscription_type = oauth
        .get("subscriptionType")
        .and_then(|s| s.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from);
    let rate_limit_tier = oauth
        .get("rateLimitTier")
        .and_then(|t| t.as_str())
        .filter(|t| !t.is_empty())
        .map(String::from);
    Some(ClaudeOAuthCredential {
        access_token: token.to_string(),
        subscription_type,
        rate_limit_tier,
    })
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

/// Try to read the Gemini OAuth access token from `~/.gemini/oauth_creds.json`.
///
/// Returns `None` if the token is expired (checks `expiry` and `expires_at` fields).
/// Does NOT check env vars or WhaleCode's own keychain.
pub fn get_gemini_oauth_token() -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let path = std::path::Path::new(&home)
        .join(".gemini")
        .join("oauth_creds.json");
    let content = std::fs::read_to_string(&path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;

    let is_expired = json
        .get("expiry")
        .and_then(|v| v.as_str())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|exp| exp < chrono::Utc::now())
        .or_else(|| {
            json.get("expires_at")
                .and_then(|v| v.as_i64())
                .map(|ts| ts < chrono::Utc::now().timestamp())
        });

    if is_expired == Some(true) {
        eprintln!("[whalecode] Gemini OAuth token is expired; refresh not implemented");
        return None;
    }

    json.get("access_token")
        .and_then(|t| t.as_str())
        .filter(|t| !t.is_empty())
        .map(String::from)
}

/// Check if Gemini has any form of authentication (OAuth file, WhaleCode keychain, or env vars).
pub fn has_gemini_auth() -> bool {
    // 1. OAuth creds file (ignoring expiry for auth detection — the file existing counts)
    if let Ok(home) = std::env::var("HOME") {
        let path = std::path::Path::new(&home)
            .join(".gemini")
            .join("oauth_creds.json");
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                let has_access = json
                    .get("access_token")
                    .and_then(|t| t.as_str())
                    .map(|t| !t.is_empty())
                    .unwrap_or(false);
                let has_refresh = json
                    .get("refresh_token")
                    .and_then(|t| t.as_str())
                    .map(|t| !t.is_empty())
                    .unwrap_or(false);
                if has_access || has_refresh {
                    return true;
                }
            }
        }
    }

    if gemini_keychain::has_gemini_api_key() {
        return true;
    }
    if std::env::var("GEMINI_API_KEY")
        .map(|k| !k.is_empty())
        .unwrap_or(false)
    {
        return true;
    }
    if std::env::var("GOOGLE_API_KEY")
        .map(|k| !k.is_empty())
        .unwrap_or(false)
    {
        return true;
    }
    false
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/// OAuth credential data extracted from Codex's auth stores.
pub struct CodexOAuthCredential {
    pub access_token: String,
    pub account_id: Option<String>,
}

/// Try to read Codex OAuth credentials from its auth file locations.
///
/// Checks in order:
/// 1. `$CODEX_HOME/auth.json`
/// 2. `~/.config/codex/auth.json`
/// 3. `~/.codex/auth.json`
///
/// Does NOT check env vars, macOS Keychain "Codex Auth", or WhaleCode's own keychain.
pub fn get_codex_oauth_credential() -> Option<CodexOAuthCredential> {
    let home = std::env::var("HOME").unwrap_or_default();
    let codex_home = std::env::var("CODEX_HOME").ok();

    let paths: Vec<std::path::PathBuf> = vec![
        codex_home
            .as_ref()
            .map(|h| std::path::PathBuf::from(h).join("auth.json")),
        Some(
            std::path::PathBuf::from(&home)
                .join(".config")
                .join("codex")
                .join("auth.json"),
        ),
        Some(
            std::path::PathBuf::from(&home)
                .join(".codex")
                .join("auth.json"),
        ),
    ]
    .into_iter()
    .flatten()
    .collect();

    for path in &paths {
        if let Ok(content) = std::fs::read_to_string(path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(token) = json
                    .pointer("/tokens/access_token")
                    .and_then(|t| t.as_str())
                {
                    if !token.is_empty() {
                        let account_id = json
                            .pointer("/tokens/account_id")
                            .and_then(|a| a.as_str())
                            .map(String::from);
                        return Some(CodexOAuthCredential {
                            access_token: token.to_string(),
                            account_id,
                        });
                    }
                }
            }
        }
    }

    None
}

/// Build the list of Codex auth file paths (shared between auth check and token fetch).
fn codex_auth_paths() -> Vec<std::path::PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    let codex_home = std::env::var("CODEX_HOME").ok();
    vec![
        codex_home
            .as_ref()
            .map(|h| std::path::PathBuf::from(h).join("auth.json")),
        Some(
            std::path::PathBuf::from(&home)
                .join(".config")
                .join("codex")
                .join("auth.json"),
        ),
        Some(
            std::path::PathBuf::from(&home)
                .join(".codex")
                .join("auth.json"),
        ),
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// Check if Codex has any form of authentication (auth files, Keychain, WhaleCode keychain, or env var).
pub fn has_codex_auth() -> bool {
    // Auth file paths
    let paths = codex_auth_paths();
    for path in &paths {
        if path.exists() {
            if let Ok(content) = std::fs::read_to_string(path) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                    let has_token = json
                        .get("tokens")
                        .and_then(|t| t.get("access_token"))
                        .and_then(|t| t.as_str())
                        .map(|t| !t.is_empty())
                        .unwrap_or(false);
                    let has_api_key = json
                        .get("OPENAI_API_KEY")
                        .and_then(|k| k.as_str())
                        .map(|k| !k.is_empty())
                        .unwrap_or(false);
                    if has_token || has_api_key {
                        return true;
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
                return true;
            }
        }
    }

    if codex_keychain::has_codex_api_key() {
        return true;
    }
    if std::env::var("OPENAI_API_KEY")
        .map(|k| !k.is_empty())
        .unwrap_or(false)
    {
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_claude_credential_json_valid() {
        let json = r#"{"claudeAiOauth":{"accessToken":"tok123","subscriptionType":"pro","rateLimitTier":"t1"}}"#;
        let cred = parse_claude_credential_json(json).unwrap();
        assert_eq!(cred.access_token, "tok123");
        assert_eq!(cred.subscription_type.as_deref(), Some("pro"));
        assert_eq!(cred.rate_limit_tier.as_deref(), Some("t1"));
    }

    #[test]
    fn test_parse_claude_credential_json_empty_token() {
        let json = r#"{"claudeAiOauth":{"accessToken":""}}"#;
        assert!(parse_claude_credential_json(json).is_none());
    }

    #[test]
    fn test_parse_claude_credential_json_missing_oauth() {
        let json = r#"{"something":"else"}"#;
        assert!(parse_claude_credential_json(json).is_none());
    }

    #[test]
    fn test_parse_claude_credential_json_invalid() {
        assert!(parse_claude_credential_json("not json").is_none());
    }

    #[test]
    fn test_codex_auth_paths_returns_expected_count() {
        let paths = codex_auth_paths();
        // Should have at least 2 paths (without CODEX_HOME) or 3 (with CODEX_HOME)
        assert!(paths.len() >= 2);
    }
}
