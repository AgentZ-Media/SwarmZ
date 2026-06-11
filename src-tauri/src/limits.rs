//! Claude subscription usage limits (5h / 7d windows), fetched from the
//! Anthropic OAuth usage endpoint with the Claude Code login on this machine.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RateLimitWindow {
    pub utilization: Option<f64>,
    pub resets_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct SubscriptionLimits {
    pub five_hour: Option<RateLimitWindow>,
    pub seven_day: Option<RateLimitWindow>,
    pub seven_day_sonnet: Option<RateLimitWindow>,
    pub seven_day_opus: Option<RateLimitWindow>,
}

/// Claude Code stores its OAuth credentials in the macOS Keychain
/// ("Claude Code-credentials"); on other setups a plain file exists at
/// `~/.claude/.credentials.json`. Both hold `{"claudeAiOauth":{"accessToken":…}}`.
fn read_access_token() -> Option<String> {
    let raw = read_keychain_credentials().or_else(read_credentials_file)?;
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    json.get("claudeAiOauth")?
        .get("accessToken")?
        .as_str()
        .map(|s| s.to_string())
}

fn read_keychain_credentials() -> Option<String> {
    let out = std::process::Command::new("security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8(out.stdout).ok()?;
    let s = s.trim();
    (!s.is_empty()).then(|| s.to_string())
}

fn read_credentials_file() -> Option<String> {
    let path = dirs::home_dir()?.join(".claude").join(".credentials.json");
    std::fs::read_to_string(path).ok()
}

/// `Ok(None)` means "no usable Claude login on this machine" (UI hides the
/// meters) — that covers both missing credentials and an expired/revoked
/// token (401/403): showing stale utilization forever would be worse than
/// hiding. Transient problems (network, 5xx, parse) are `Err` so the
/// frontend can keep showing the last known values instead of blanking out.
pub async fn fetch_limits() -> Result<Option<SubscriptionLimits>, String> {
    // keychain read shells out to `security` (and can raise the macOS
    // consent prompt) — keep it off the async runtime's core threads
    let token = tauri::async_runtime::spawn_blocking(read_access_token)
        .await
        .map_err(|e| e.to_string())?;
    let Some(token) = token else {
        return Ok(None);
    };
    let client = reqwest::Client::new();
    let resp = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(format!("usage endpoint returned {status}"));
    }
    resp.json::<SubscriptionLimits>()
        .await
        .map(Some)
        .map_err(|e| e.to_string())
}
