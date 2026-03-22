/// Usage data fetcher — queries real usage APIs for Claude, Gemini, and Codex.
/// Based on openusage (github.com/robinebers/openusage) plugin logic.

use crate::detection::credentials;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct UsageLine {
    pub line_type: String,  // "progress" | "text" | "badge"
    pub label: String,
    pub value: Option<String>,
    pub used: Option<f64>,
    pub limit: Option<f64>,
    pub format_kind: Option<String>, // "percent" | "dollars" | "count"
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AgentUsage {
    pub agent: String,
    pub plan: Option<String>,
    pub lines: Vec<UsageLine>,
    pub error: Option<String>,
}

/// Fetch usage for all agents that have valid credentials.
pub async fn fetch_all_usage() -> Vec<AgentUsage> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let (claude, codex, gemini) = tokio::join!(
        fetch_claude_usage(&client),
        fetch_codex_usage(&client),
        fetch_gemini_usage(&client),
    );
    vec![claude, codex, gemini]
}

// ---------------------------------------------------------------------------
// Claude Usage — api.anthropic.com/api/oauth/usage
// ---------------------------------------------------------------------------

async fn fetch_claude_usage(client: &reqwest::Client) -> AgentUsage {
    let token = match get_claude_token() {
        Some(t) => t,
        None => return AgentUsage {
            agent: "claude".into(), plan: None, lines: vec![],
            error: Some("Not authenticated".into()),
        },
    };

    let resp = match client.get("https://api.anthropic.com/api/oauth/usage")
        .header("Authorization", format!("Bearer {}", token.access_token))
        .header("Accept", "application/json")
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("User-Agent", format!("WhaleCode/{}", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return AgentUsage {
            agent: "claude".into(), plan: None, lines: vec![],
            error: Some(format!("Request failed: {}", e)),
        },
    };

    if !resp.status().is_success() {
        return AgentUsage {
            agent: "claude".into(), plan: None, lines: vec![],
            error: Some(format!("HTTP {}", resp.status())),
        };
    }

    let body: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => return AgentUsage {
            agent: "claude".into(), plan: None, lines: vec![],
            error: Some(format!("Invalid response: {}", e)),
        },
    };

    let mut lines = Vec::new();

    // Session (5h window)
    if let Some(five_hour) = body.get("five_hour") {
        if let Some(util) = five_hour.get("utilization").and_then(|u| u.as_f64()) {
            lines.push(UsageLine {
                line_type: "progress".into(), label: "Session".into(),
                value: None, used: Some(util), limit: Some(100.0),
                format_kind: Some("percent".into()),
                resets_at: five_hour.get("resets_at").and_then(|r| r.as_str()).map(String::from),
            });
        }
    }

    // Weekly (7d window)
    if let Some(seven_day) = body.get("seven_day") {
        if let Some(util) = seven_day.get("utilization").and_then(|u| u.as_f64()) {
            lines.push(UsageLine {
                line_type: "progress".into(), label: "Weekly".into(),
                value: None, used: Some(util), limit: Some(100.0),
                format_kind: Some("percent".into()),
                resets_at: seven_day.get("resets_at").and_then(|r| r.as_str()).map(String::from),
            });
        }
    }

    // Sonnet (7d window)
    if let Some(sonnet) = body.get("seven_day_sonnet") {
        if let Some(util) = sonnet.get("utilization").and_then(|u| u.as_f64()) {
            lines.push(UsageLine {
                line_type: "progress".into(), label: "Sonnet".into(),
                value: None, used: Some(util), limit: Some(100.0),
                format_kind: Some("percent".into()),
                resets_at: sonnet.get("resets_at").and_then(|r| r.as_str()).map(String::from),
            });
        }
    }

    // Extra usage
    if let Some(extra) = body.get("extra_usage") {
        if extra.get("is_enabled").and_then(|e| e.as_bool()).unwrap_or(false) {
            let used_cents = extra.get("used_credits").and_then(|u| u.as_f64()).unwrap_or(0.0);
            let limit_cents = extra.get("monthly_limit").and_then(|l| l.as_f64()).unwrap_or(0.0);
            lines.push(UsageLine {
                line_type: "progress".into(), label: "Extra usage spent".into(),
                value: None, used: Some(used_cents / 100.0), limit: Some(limit_cents / 100.0),
                format_kind: Some("dollars".into()), resets_at: None,
            });
        }
    }

    let plan = token.plan;

    AgentUsage { agent: "claude".into(), plan, lines, error: None }
}

struct ClaudeToken { access_token: String, plan: Option<String> }

fn get_claude_token() -> Option<ClaudeToken> {
    let cred = credentials::get_claude_oauth_credential()?;
    let plan = cred.subscription_type.as_deref().map(|sub| {
        let tier_suffix = cred.rate_limit_tier.as_deref()
            .map(|t| format!(" {}", t))
            .unwrap_or_default();
        format!("{}{}", capitalize(sub), tier_suffix)
    });
    Some(ClaudeToken { access_token: cred.access_token, plan })
}

// ---------------------------------------------------------------------------
// Codex Usage — chatgpt.com/backend-api/wham/usage
// ---------------------------------------------------------------------------

async fn fetch_codex_usage(client: &reqwest::Client) -> AgentUsage {
    let token = match get_codex_token() {
        Some(t) => t,
        None => return AgentUsage {
            agent: "codex".into(), plan: None, lines: vec![],
            error: Some("Not authenticated".into()),
        },
    };

    let mut req = client.get("https://chatgpt.com/backend-api/wham/usage")
        .header("Authorization", format!("Bearer {}", token.access_token))
        .header("Accept", "application/json")
        .header("User-Agent", "OpenUsage")
        .timeout(std::time::Duration::from_secs(10));

    if let Some(ref account_id) = token.account_id {
        req = req.header("ChatGPT-Account-Id", account_id);
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => return AgentUsage {
            agent: "codex".into(), plan: None, lines: vec![],
            error: Some(format!("Request failed: {}", e)),
        },
    };

    if !resp.status().is_success() {
        return AgentUsage {
            agent: "codex".into(), plan: None, lines: vec![],
            error: Some(format!("HTTP {}", resp.status())),
        };
    }

    // Read headers before consuming body
    let primary_pct = resp.headers().get("x-codex-primary-used-percent")
        .and_then(|v| v.to_str().ok()).and_then(|s| s.parse::<f64>().ok());
    let secondary_pct = resp.headers().get("x-codex-secondary-used-percent")
        .and_then(|v| v.to_str().ok()).and_then(|s| s.parse::<f64>().ok());
    let credits_balance = resp.headers().get("x-codex-credits-balance")
        .and_then(|v| v.to_str().ok()).and_then(|s| s.parse::<f64>().ok());

    let body: serde_json::Value = resp.json().await.unwrap_or_default();

    let mut lines = Vec::new();

    // Session — prefer header, fallback to body
    let session_used = primary_pct.or_else(|| {
        body.pointer("/rate_limit/primary_window/used_percent").and_then(|v| v.as_f64())
    });
    if let Some(used) = session_used {
        lines.push(UsageLine {
            line_type: "progress".into(), label: "Session".into(),
            value: None, used: Some(used), limit: Some(100.0),
            format_kind: Some("percent".into()), resets_at: None,
        });
    }

    // Weekly — prefer header, fallback to body
    let weekly_used = secondary_pct.or_else(|| {
        body.pointer("/rate_limit/secondary_window/used_percent").and_then(|v| v.as_f64())
    });
    if let Some(used) = weekly_used {
        lines.push(UsageLine {
            line_type: "progress".into(), label: "Weekly".into(),
            value: None, used: Some(used), limit: Some(100.0),
            format_kind: Some("percent".into()), resets_at: None,
        });
    }

    // Credits — report remaining as-is; we don't know the actual total/limit
    let credits = credits_balance.or_else(|| {
        body.pointer("/credits/balance").and_then(|v| v.as_f64())
    });
    if let Some(remaining) = credits {
        lines.push(UsageLine {
            line_type: "badge".into(), label: "Credits remaining".into(),
            value: Some(format!("{:.0}", remaining)), used: None,
            limit: None,
            format_kind: Some("count".into()), resets_at: None,
        });
    }

    let plan = body.get("plan_type").and_then(|p| p.as_str()).map(|p| capitalize(p));

    AgentUsage { agent: "codex".into(), plan, lines, error: None }
}

struct CodexToken { access_token: String, account_id: Option<String> }

fn get_codex_token() -> Option<CodexToken> {
    let cred = credentials::get_codex_oauth_credential()?;
    Some(CodexToken { access_token: cred.access_token, account_id: cred.account_id })
}

// ---------------------------------------------------------------------------
// Gemini Usage — cloudcode-pa.googleapis.com
// ---------------------------------------------------------------------------

async fn fetch_gemini_usage(client: &reqwest::Client) -> AgentUsage {
    let token = match get_gemini_token() {
        Some(t) => t,
        None => return AgentUsage {
            agent: "gemini".into(), plan: None, lines: vec![],
            error: Some("Not authenticated".into()),
        },
    };

    // Step 1: loadCodeAssist to discover project + tier
    let load_resp = client.post("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist")
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "metadata": { "ideType": "IDE_UNSPECIFIED", "platform": "PLATFORM_UNSPECIFIED", "pluginType": "GEMINI", "duetProject": "default" }
        }))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await;

    let (project_id, plan) = match load_resp {
        Ok(r) if r.status().is_success() => {
            let body: serde_json::Value = r.json().await.unwrap_or_default();
            let project = deep_find_string(&body, "cloudaicompanionProject", 0);
            let tier = deep_find_string(&body, "tier", 0)
                .or_else(|| deep_find_string(&body, "userTier", 0))
                .or_else(|| deep_find_string(&body, "subscriptionTier", 0));
            let plan = tier.map(|t| match t.as_str() {
                "standard-tier" => "Paid".to_string(),
                "legacy-tier" => "Legacy".to_string(),
                "free-tier" => "Free".to_string(),
                other => capitalize(other),
            });
            (project, plan)
        }
        _ => (None, None),
    };

    // Step 2: retrieveUserQuota
    let quota_body = if let Some(ref pid) = project_id {
        serde_json::json!({ "project": pid })
    } else {
        serde_json::json!({})
    };

    let quota_resp = client.post("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota")
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .json(&quota_body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await;

    let mut lines = Vec::new();

    if let Ok(r) = quota_resp {
        if r.status().is_success() {
            if let Ok(body) = r.json::<serde_json::Value>().await {
                let buckets = collect_quota_buckets(&body, 0);
                // Group by model family
                let mut pro_worst: Option<(f64, Option<String>)> = None;
                let mut flash_worst: Option<(f64, Option<String>)> = None;
                for (remaining, model, reset) in &buckets {
                    let model_lower = model.to_lowercase();
                    let target = if model_lower.contains("pro") { &mut pro_worst }
                                 else if model_lower.contains("flash") { &mut flash_worst }
                                 else { &mut pro_worst }; // default to pro
                    if target.is_none() || *remaining < target.as_ref().unwrap().0 {
                        *target = Some((*remaining, reset.clone()));
                    }
                }
                if let Some((remaining, reset)) = pro_worst {
                    let used = ((1.0 - remaining) * 100.0).round();
                    lines.push(UsageLine {
                        line_type: "progress".into(), label: "Pro".into(),
                        value: None, used: Some(used), limit: Some(100.0),
                        format_kind: Some("percent".into()), resets_at: reset,
                    });
                }
                if let Some((remaining, reset)) = flash_worst {
                    let used = ((1.0 - remaining) * 100.0).round();
                    lines.push(UsageLine {
                        line_type: "progress".into(), label: "Flash".into(),
                        value: None, used: Some(used), limit: Some(100.0),
                        format_kind: Some("percent".into()), resets_at: reset,
                    });
                }
            }
        }
    }

    AgentUsage { agent: "gemini".into(), plan, lines, error: None }
}

/// Read the Gemini OAuth access token from ~/.gemini/oauth_creds.json.
///
/// LIMITATION: This reads the stored access_token but does not implement
/// OAuth refresh. If the token has an `expiry` field in the past, we return
/// None and log a warning. A full refresh flow would require the client_id,
/// client_secret, and refresh_token dance with Google's OAuth2 endpoint.
fn get_gemini_token() -> Option<String> {
    credentials::get_gemini_oauth_token()
}

/// Recursively walk JSON to find objects with remainingFraction.
fn collect_quota_buckets(val: &serde_json::Value, depth: u32) -> Vec<(f64, String, Option<String>)> {
    if depth > 32 { return Vec::new(); }
    let mut buckets = Vec::new();
    match val {
        serde_json::Value::Object(map) => {
            if let Some(remaining) = map.get("remainingFraction").and_then(|r| r.as_f64()) {
                let model = map.get("modelId").or(map.get("model_id"))
                    .and_then(|m| m.as_str()).unwrap_or("unknown").to_string();
                let reset = map.get("resetTime").or(map.get("reset_time"))
                    .and_then(|r| r.as_str().map(String::from).or(r.as_f64().map(|n| n.to_string())));
                buckets.push((remaining, model, reset));
            }
            for (_, v) in map { buckets.extend(collect_quota_buckets(v, depth + 1)); }
        }
        serde_json::Value::Array(arr) => {
            for v in arr { buckets.extend(collect_quota_buckets(v, depth + 1)); }
        }
        _ => {}
    }
    buckets
}

/// Deep search for a string value by key name.
fn deep_find_string(val: &serde_json::Value, key: &str, depth: u32) -> Option<String> {
    if depth > 32 { return None; }
    match val {
        serde_json::Value::Object(map) => {
            if let Some(v) = map.get(key).and_then(|v| v.as_str()) {
                return Some(v.to_string());
            }
            for (_, v) in map {
                if let Some(found) = deep_find_string(v, key, depth + 1) { return Some(found); }
            }
            None
        }
        serde_json::Value::Array(arr) => {
            for v in arr {
                if let Some(found) = deep_find_string(v, key, depth + 1) { return Some(found); }
            }
            None
        }
        _ => None,
    }
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        None => String::new(),
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_capitalize_normal() {
        assert_eq!(capitalize("hello"), "Hello");
    }

    #[test]
    fn test_capitalize_already_upper() {
        assert_eq!(capitalize("Hello"), "Hello");
    }

    #[test]
    fn test_capitalize_empty() {
        assert_eq!(capitalize(""), "");
    }

    #[test]
    fn test_capitalize_single_char() {
        assert_eq!(capitalize("a"), "A");
    }

    #[test]
    fn test_deep_find_string_top_level() {
        let json: serde_json::Value = serde_json::json!({
            "name": "test",
            "value": 42
        });
        assert_eq!(deep_find_string(&json, "name", 0), Some("test".to_string()));
        assert_eq!(deep_find_string(&json, "missing", 0), None);
    }

    #[test]
    fn test_deep_find_string_nested() {
        let json: serde_json::Value = serde_json::json!({
            "outer": {
                "middle": {
                    "deep_key": "found_it"
                }
            }
        });
        assert_eq!(deep_find_string(&json, "deep_key", 0), Some("found_it".to_string()));
    }

    #[test]
    fn test_deep_find_string_in_array() {
        let json: serde_json::Value = serde_json::json!({
            "items": [
                { "id": "first" },
                { "id": "second", "target": "winner" }
            ]
        });
        assert_eq!(deep_find_string(&json, "target", 0), Some("winner".to_string()));
    }

    #[test]
    fn test_deep_find_string_non_string_value() {
        let json: serde_json::Value = serde_json::json!({
            "count": 42
        });
        // "count" exists but is not a string, should return None
        assert_eq!(deep_find_string(&json, "count", 0), None);
    }

    #[test]
    fn test_collect_quota_buckets_empty() {
        let json: serde_json::Value = serde_json::json!({});
        assert!(collect_quota_buckets(&json, 0).is_empty());
    }

    #[test]
    fn test_collect_quota_buckets_with_fraction() {
        let json: serde_json::Value = serde_json::json!({
            "quotas": [
                {
                    "remainingFraction": 0.75,
                    "modelId": "gemini-pro",
                    "resetTime": "2025-01-01T00:00:00Z"
                },
                {
                    "remainingFraction": 0.5,
                    "modelId": "gemini-flash",
                    "resetTime": "2025-01-01T00:00:00Z"
                }
            ]
        });
        let buckets = collect_quota_buckets(&json, 0);
        assert_eq!(buckets.len(), 2);
        assert_eq!(buckets[0].1, "gemini-pro");
        assert!((buckets[0].0 - 0.75).abs() < f64::EPSILON);
        assert_eq!(buckets[1].1, "gemini-flash");
        assert!((buckets[1].0 - 0.5).abs() < f64::EPSILON);
    }

    #[test]
    fn test_collect_quota_buckets_nested() {
        let json: serde_json::Value = serde_json::json!({
            "data": {
                "inner": {
                    "remainingFraction": 0.3,
                    "model_id": "deep-model"
                }
            }
        });
        let buckets = collect_quota_buckets(&json, 0);
        assert_eq!(buckets.len(), 1);
        assert_eq!(buckets[0].1, "deep-model");
    }
}
