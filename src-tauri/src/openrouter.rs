//! OpenRouter integration for voice dictation: speech-to-text via the
//! transcription endpoint, optional transcript cleanup via chat completions
//! (structured output), and the live model catalog for the Settings picker.
//!
//! The API key lives in the macOS Keychain (service "SwarmZ-OpenRouter"),
//! accessed through the Security framework: the key never appears in a
//! subprocess argv (the old `security` CLI write left it readable via `ps`
//! and gave the item an ACL that let any process read it back silently),
//! and items created this way are ACLed to the SwarmZ binary. Items written
//! by older builds via the CLI still resolve — reading them just raises the
//! one-time macOS consent prompt.

use security_framework::passwords::{
    delete_generic_password, get_generic_password, set_generic_password,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

const API: &str = "https://openrouter.ai/api/v1";
const KEYCHAIN_SERVICE: &str = "SwarmZ-OpenRouter";
const KEYCHAIN_ACCOUNT: &str = "openrouter";

fn read_key() -> Option<String> {
    let bytes = get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).ok()?;
    let s = String::from_utf8(bytes).ok()?;
    let s = s.trim();
    (!s.is_empty()).then(|| s.to_string())
}

pub fn set_key(key: &str) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("empty key".into());
    }
    set_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, key.as_bytes())
        .map_err(|e| e.to_string())
}

pub fn clear_key() -> Result<(), String> {
    match delete_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        Ok(()) => Ok(()),
        // "not found" counts as cleared (errSecItemNotFound)
        Err(e) if e.code() == -25300 => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// `valid: None` = key present but verification failed for a transient reason
/// (offline, 5xx) — the frontend keeps dictation enabled then; only an
/// explicit rejection (401/403) turns it off.
#[derive(Serialize, Clone)]
pub struct KeyStatus {
    pub present: bool,
    pub valid: Option<bool>,
}

/// `read_key` for async contexts — the keychain call can block on the
/// one-time macOS consent prompt, so it must not pin a runtime core thread.
async fn read_key_blocking() -> Option<String> {
    tauri::async_runtime::spawn_blocking(read_key)
        .await
        .ok()
        .flatten()
}

pub async fn key_status() -> KeyStatus {
    let Some(key) = read_key_blocking().await else {
        return KeyStatus {
            present: false,
            valid: Some(false),
        };
    };
    let resp = reqwest::Client::new()
        .get(format!("{API}/key"))
        .bearer_auth(&key)
        .timeout(Duration::from_secs(15))
        .send()
        .await;
    let valid = match resp {
        Ok(r) if r.status().is_success() => Some(true),
        Ok(r) if r.status().as_u16() == 401 || r.status().as_u16() == 403 => Some(false),
        _ => None,
    };
    KeyStatus {
        present: true,
        valid,
    }
}

/// Pull a useful error message out of an OpenRouter error body.
fn api_error(status: reqwest::StatusCode, body: &str) -> String {
    let msg = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v.get("error")?
                .get("message")?
                .as_str()
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| body.chars().take(200).collect());
    format!("OpenRouter {status}: {msg}")
}

#[derive(Serialize, Clone)]
pub struct TranscriptionResult {
    pub text: String,
    pub seconds: f64,
    pub cost: f64,
}

/// One ≤60s audio segment (base64-encoded bytes) → plain transcript text.
pub async fn transcribe(
    audio_b64: String,
    format: String,
    model: String,
    language: Option<String>,
) -> Result<TranscriptionResult, String> {
    let key = read_key_blocking().await.ok_or("No OpenRouter API key set")?;
    let mut body = json!({
        "model": model,
        "input_audio": { "data": audio_b64, "format": format },
    });
    if let Some(lang) = language {
        body["language"] = json!(lang);
    }
    let resp = reqwest::Client::new()
        .post(format!("{API}/audio/transcriptions"))
        .bearer_auth(&key)
        .json(&body)
        .timeout(Duration::from_secs(90))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(api_error(status, &text));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(TranscriptionResult {
        text: v
            .get("text")
            .and_then(|t| t.as_str())
            .unwrap_or_default()
            .to_string(),
        seconds: v
            .pointer("/usage/seconds")
            .and_then(|s| s.as_f64())
            .unwrap_or(0.0),
        cost: v
            .pointer("/usage/cost")
            .and_then(|c| c.as_f64())
            .unwrap_or(0.0),
    })
}

async fn cleanup_request(key: &str, body: &Value) -> Result<String, String> {
    let resp = reqwest::Client::new()
        .post(format!("{API}/chat/completions"))
        .bearer_auth(key)
        .json(body)
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let raw = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(api_error(status, &raw));
    }
    let v: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let content = v
        .pointer("/choices/0/message/content")
        .and_then(|c| c.as_str())
        .ok_or("cleanup response had no content")?;
    // strict schema → content IS the JSON object; fall back to the raw text
    // if a provider ignored the schema anyway
    let cleaned = serde_json::from_str::<Value>(content)
        .ok()
        .and_then(|c| c.get("cleaned")?.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| content.trim().to_string());
    Ok(cleaned)
}

/// Polish a raw transcript with an LLM. Structured output (json_schema)
/// guarantees the model returns exactly `{ "cleaned": "…" }` — no prose
/// around it; `require_parameters` keeps routing to providers that honor it.
///
/// This pass sits in the dictation hot path, so reasoning is requested at
/// `effort: "minimal"` (verified: 0 reasoning tokens on Gemini 3.5 Flash).
/// `enabled: false` is NOT usable — Gemini rejects it outright ("Reasoning is
/// mandatory … cannot be disabled"). Models that don't know "minimal" get one
/// retry without the reasoning field at their default behavior.
pub async fn cleanup(text: String, model: String, prompt: String) -> Result<String, String> {
    let key = read_key_blocking().await.ok_or("No OpenRouter API key set")?;
    let mut body = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": prompt },
            { "role": "user", "content": text },
        ],
        "reasoning": { "effort": "minimal" },
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "transcript_cleanup",
                "strict": true,
                "schema": {
                    "type": "object",
                    "properties": { "cleaned": { "type": "string" } },
                    "required": ["cleaned"],
                    "additionalProperties": false
                }
            }
        },
        "provider": { "require_parameters": true },
    });
    match cleanup_request(&key, &body).await {
        Ok(cleaned) => Ok(cleaned),
        // retry without the reasoning field only when the model plausibly
        // rejected it (provider wording varies: "reasoning", "effort",
        // "unsupported value: 'minimal'", "unknown parameter") — repeating
        // a timeout/429/5xx would double the worst-case latency and mask
        // the real error
        Err(e) => {
            let msg = e.to_ascii_lowercase();
            if msg.contains("reasoning")
                || msg.contains("parameter")
                || msg.contains("effort")
                || msg.contains("minimal")
            {
                body.as_object_mut().unwrap().remove("reasoning");
                cleanup_request(&key, &body).await
            } else {
                Err(e)
            }
        }
    }
}

#[derive(Serialize, Clone)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
}

static MODELS_CACHE: once_cell::sync::Lazy<parking_lot::Mutex<Option<(Instant, Vec<ModelInfo>)>>> =
    once_cell::sync::Lazy::new(|| parking_lot::Mutex::new(None));

/// Text→text chat models from the public catalog (for the cleanup-model
/// picker in Settings). Cached for an hour — the list is large and static.
pub async fn models() -> Result<Vec<ModelInfo>, String> {
    if let Some((at, list)) = MODELS_CACHE.lock().as_ref() {
        if at.elapsed() < Duration::from_secs(60 * 60) {
            return Ok(list.clone());
        }
    }
    let resp = reqwest::Client::new()
        .get(format!("{API}/models"))
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("models endpoint returned {}", resp.status()));
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    let mut list: Vec<ModelInfo> = v
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|m| {
                    let has = |key: &str, val: &str| {
                        m.pointer(&format!("/architecture/{key}"))
                            .and_then(|x| x.as_array())
                            .map(|a| a.iter().any(|i| i.as_str() == Some(val)))
                            .unwrap_or(false)
                    };
                    has("input_modalities", "text") && has("output_modalities", "text")
                })
                .filter_map(|m| {
                    Some(ModelInfo {
                        id: m.get("id")?.as_str()?.to_string(),
                        name: m
                            .get("name")
                            .and_then(|n| n.as_str())
                            .unwrap_or_default()
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    list.sort_by(|a, b| a.id.cmp(&b.id));
    if list.is_empty() {
        return Err("models endpoint returned an empty catalog".into());
    }
    *MODELS_CACHE.lock() = Some((Instant::now(), list.clone()));
    Ok(list)
}
