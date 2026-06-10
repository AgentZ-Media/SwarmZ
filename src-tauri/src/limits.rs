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

pub async fn fetch_limits() -> Option<SubscriptionLimits> {
    let token = read_access_token()?;
    let client = reqwest::Client::new();
    let resp = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<SubscriptionLimits>().await.ok()
}
