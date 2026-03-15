use super::models::{AuthStatus, DetectedAgent};
use crate::credentials::{
    codex_keychain, gemini_keychain, keychain,
};
use std::time::Duration;
use tokio::process::Command;

/// Maximum time to wait for a CLI command before giving up.
const CLI_TIMEOUT: Duration = Duration::from_secs(5);

/// Scan for all known CLI agents and return their detection results.
pub async fn scan_agents() -> Vec<DetectedAgent> {
    let mut agents = Vec::new();

    agents.push(scan_claude().await);
    agents.push(scan_gemini().await);
    agents.push(scan_codex().await);

    agents
}

async fn scan_claude() -> DetectedAgent {
    let (installed, binary_path, version) = check_cli("claude").await;
    let auth_status = if !installed {
        AuthStatus::NotInstalled
    } else {
        check_claude_auth().await
    };

    DetectedAgent {
        tool_name: "claude".to_string(),
        display_name: "Claude Code".to_string(),
        installed,
        binary_path,
        version,
        auth_status,
    }
}

async fn scan_gemini() -> DetectedAgent {
    let (installed, binary_path, version) = check_cli("gemini").await;
    let auth_status = if !installed {
        AuthStatus::NotInstalled
    } else {
        check_gemini_auth().await
    };

    DetectedAgent {
        tool_name: "gemini".to_string(),
        display_name: "Gemini CLI".to_string(),
        installed,
        binary_path,
        version,
        auth_status,
    }
}

async fn scan_codex() -> DetectedAgent {
    let (installed, binary_path, version) = check_cli("codex").await;
    let auth_status = if !installed {
        AuthStatus::NotInstalled
    } else {
        check_codex_auth().await
    };

    DetectedAgent {
        tool_name: "codex".to_string(),
        display_name: "Codex CLI".to_string(),
        installed,
        binary_path,
        version,
        auth_status,
    }
}

/// Check if a CLI tool is installed by running `which <name>` and `<name> --version`.
/// Returns (installed, binary_path, version).
async fn check_cli(name: &str) -> (bool, Option<String>, Option<String>) {
    // Find the binary path via `which`
    let binary_path = match run_with_timeout("which", &[name]).await {
        Some(output) => {
            let path = output.trim().to_string();
            if path.is_empty() { None } else { Some(path) }
        }
        None => None,
    };

    if binary_path.is_none() {
        return (false, None, None);
    }

    // Get the version string
    let version = match run_with_timeout(name, &["--version"]).await {
        Some(output) => {
            let v = output.trim().to_string();
            if v.is_empty() { None } else { Some(v) }
        }
        None => None,
    };

    (true, binary_path, version)
}

/// Run a command with a timeout and return its stdout as a String, or None on failure/timeout.
async fn run_with_timeout(program: &str, args: &[&str]) -> Option<String> {
    let result = tokio::time::timeout(
        CLI_TIMEOUT,
        Command::new(program).args(args).output(),
    )
    .await;

    match result {
        Ok(Ok(output)) if output.status.success() => {
            Some(String::from_utf8_lossy(&output.stdout).to_string())
        }
        _ => None,
    }
}

/// Check Claude auth: keychain API key, actual CLI auth test, or env var.
async fn check_claude_auth() -> AuthStatus {
    // First check the keychain
    if keychain::has_api_key() {
        return AuthStatus::Authenticated;
    }

    // Check ANTHROPIC_API_KEY env var
    if std::env::var("ANTHROPIC_API_KEY").is_ok() {
        return AuthStatus::Authenticated;
    }

    // Quick CLI auth probe — run claude with a minimal prompt to check if authenticated
    if let Ok(output) = tokio::process::Command::new("claude")
        .args(&["-p", "hi", "--output-format", "stream-json", "--verbose", "--max-turns", "1"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        if stdout.contains("authentication_failed") || stdout.contains("Not logged in") {
            return AuthStatus::NeedsAuth;
        }
        if output.status.success() || stdout.contains("\"type\":\"result\"") {
            return AuthStatus::Authenticated;
        }
    }

    AuthStatus::NeedsAuth
}

/// Check Gemini auth: keychain API key, ~/.gemini/oauth_creds.json, or env vars.
async fn check_gemini_auth() -> AuthStatus {
    // Check keychain
    if gemini_keychain::has_gemini_api_key() {
        return AuthStatus::Authenticated;
    }

    // Check for Gemini CLI OAuth credentials (~/.gemini/oauth_creds.json)
    if let Ok(home) = std::env::var("HOME") {
        let oauth_creds = std::path::Path::new(&home).join(".gemini").join("oauth_creds.json");
        if oauth_creds.exists() {
            return AuthStatus::Authenticated;
        }
    }

    // Check env vars
    if std::env::var("GEMINI_API_KEY").is_ok() || std::env::var("GOOGLE_API_KEY").is_ok() {
        return AuthStatus::Authenticated;
    }

    AuthStatus::NeedsAuth
}

/// Check Codex auth: keychain API key or OPENAI_API_KEY env var.
async fn check_codex_auth() -> AuthStatus {
    // Check keychain
    if codex_keychain::has_codex_api_key() {
        return AuthStatus::Authenticated;
    }

    // Check env var
    if std::env::var("OPENAI_API_KEY").is_ok() {
        return AuthStatus::Authenticated;
    }

    AuthStatus::NeedsAuth
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_run_with_timeout_succeeds() {
        // `echo` should always work
        let result = run_with_timeout("echo", &["hello"]).await;
        assert!(result.is_some());
        assert_eq!(result.unwrap().trim(), "hello");
    }

    #[tokio::test]
    async fn test_run_with_timeout_fails_for_nonexistent() {
        let result = run_with_timeout("nonexistent_binary_xyz_999", &[]).await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_check_cli_nonexistent() {
        let (installed, path, version) = check_cli("nonexistent_binary_xyz_999").await;
        assert!(!installed);
        assert!(path.is_none());
        assert!(version.is_none());
    }

    #[tokio::test]
    async fn test_scan_agents_returns_three() {
        let agents = scan_agents().await;
        assert_eq!(agents.len(), 3);
        assert_eq!(agents[0].tool_name, "claude");
        assert_eq!(agents[1].tool_name, "gemini");
        assert_eq!(agents[2].tool_name, "codex");
    }
}
