use crate::usage::{CodexRateLimitWindow, CodexRateLimits, ModelUsage, SessionUsage, UsageTotals};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[derive(Clone)]
struct CachedSession {
    mtime: u64,
    size: u64,
    session: SessionUsage,
    first_ts_ms: u64,
}

static CACHE: Lazy<Mutex<HashMap<PathBuf, CachedSession>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn sessions_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".codex").join("sessions"))
}

fn session_index_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".codex").join("session_index.jsonl"))
}

fn parse_ts_ms_str(s: &str) -> Option<u64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp_millis().max(0) as u64)
}

fn parse_ts_ms(v: &Value) -> Option<u64> {
    v.get("timestamp")
        .and_then(|t| t.as_str())
        .and_then(parse_ts_ms_str)
}

fn mtime_of(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn file_modified_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn all_session_files() -> Vec<PathBuf> {
    let Some(root) = sessions_dir() else {
        return Vec::new();
    };
    if !root.is_dir() {
        return Vec::new();
    }
    WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("jsonl"))
        .collect()
}

fn session_id_from_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .and_then(|s| s.rsplit('-').next())
        .unwrap_or("")
        .to_string()
}

fn token(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(|x| x.as_u64()).unwrap_or(0)
}

fn unix_secs_to_rfc3339(secs: u64) -> Option<String> {
    chrono::DateTime::<chrono::Utc>::from_timestamp(secs as i64, 0).map(|dt| dt.to_rfc3339())
}

fn parse_limit_window(v: &Value) -> Option<CodexRateLimitWindow> {
    Some(CodexRateLimitWindow {
        utilization: v.get("used_percent").and_then(|x| x.as_f64()),
        resets_at: v
            .get("resets_at")
            .and_then(|x| x.as_u64())
            .and_then(unix_secs_to_rfc3339),
        window_minutes: v.get("window_minutes").and_then(|x| x.as_u64()),
    })
}

fn parse_codex_limits(v: &Value) -> Option<CodexRateLimits> {
    Some(CodexRateLimits {
        primary: v.get("primary").and_then(parse_limit_window),
        secondary: v.get("secondary").and_then(parse_limit_window),
        plan_type: v
            .get("plan_type")
            .and_then(|x| x.as_str())
            .map(String::from),
    })
}

fn add_usage(model: &str, usage: &Value, session: &mut SessionUsage, models: &mut HashMap<String, ModelUsage>) {
    let input_total = token(usage, "input_tokens");
    let cached = token(usage, "cached_input_tokens").min(input_total);
    let input_uncached = input_total.saturating_sub(cached);
    let output = token(usage, "output_tokens");
    let reasoning = token(usage, "reasoning_output_tokens");

    session.input_tokens += input_uncached;
    session.cache_read_tokens += cached;
    session.output_tokens += output;
    session.reasoning_output_tokens += reasoning;
    session.message_count += 1;

    let entry = models.entry(model.to_string()).or_insert_with(|| ModelUsage {
        model: model.to_string(),
        ..Default::default()
    });
    entry.input_tokens += input_uncached;
    entry.cache_read_tokens += cached;
    entry.output_tokens += output;
    entry.reasoning_output_tokens += reasoning;
    entry.message_count += 1;
}

fn parse_file_uncached(path: &Path) -> CachedSession {
    let mut session = SessionUsage {
        runtime: Some("codex".to_string()),
        session_id: session_id_from_path(path),
        ..Default::default()
    };
    let mut first_ts_ms = u64::MAX;
    let mut current_model = "unknown".to_string();
    let mut models: HashMap<String, ModelUsage> = HashMap::new();

    if let Ok(text) = fs::read_to_string(path) {
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            let Ok(v) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if let Some(ts) = parse_ts_ms(&v) {
                first_ts_ms = first_ts_ms.min(ts);
                if let Some(s) = v.get("timestamp").and_then(|t| t.as_str()) {
                    session.last_activity = Some(s.to_string());
                }
            }
            let Some(payload) = v.get("payload") else {
                continue;
            };
            match v.get("type").and_then(|t| t.as_str()) {
                Some("session_meta") => {
                    if let Some(id) = payload.get("session_id").and_then(|s| s.as_str()) {
                        session.session_id = id.to_string();
                    } else if let Some(id) = payload.get("id").and_then(|s| s.as_str()) {
                        session.session_id = id.to_string();
                    }
                    if session.cwd.is_none() {
                        session.cwd = payload
                            .get("cwd")
                            .and_then(|c| c.as_str())
                            .map(String::from);
                    }
                    if let Some(branch) = payload
                        .get("git")
                        .and_then(|g| g.get("branch"))
                        .and_then(|b| b.as_str())
                    {
                        if !branch.is_empty() {
                            session.git_branch = Some(branch.to_string());
                        }
                    }
                }
                Some("turn_context") => {
                    if let Some(model) = payload.get("model").and_then(|m| m.as_str()) {
                        current_model = model.to_string();
                        session.primary_model = Some(model.to_string());
                    }
                    if session.cwd.is_none() {
                        session.cwd = payload
                            .get("cwd")
                            .and_then(|c| c.as_str())
                            .map(String::from);
                    }
                }
                Some("event_msg") => {
                    match payload.get("type").and_then(|t| t.as_str()) {
                        Some("task_started") => session.activity = Some("busy".to_string()),
                        Some("task_complete") | Some("turn_aborted") => {
                            session.activity = Some("idle".to_string())
                        }
                        Some("token_count") => {
                            if let Some(limits) = payload.get("rate_limits") {
                                session.codex_limits = parse_codex_limits(limits);
                            }
                            if let Some(info) = payload.get("info") {
                                if let Some(last) = info.get("last_token_usage") {
                                    add_usage(&current_model, last, &mut session, &mut models);
                                    session.context_tokens = token(last, "input_tokens");
                                }
                                if let Some(limit) =
                                    info.get("model_context_window").and_then(|l| l.as_u64())
                                {
                                    session.context_limit = limit;
                                }
                            }
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
    }

    if first_ts_ms == u64::MAX {
        first_ts_ms = file_modified_ms(path);
    }
    let mut by_model: Vec<ModelUsage> = models.into_values().collect();
    by_model.sort_by(|a, b| b.message_count.cmp(&a.message_count));
    if session.primary_model.is_none() {
        session.primary_model = by_model.first().map(|m| m.model.clone());
    }
    session.by_model = by_model;
    CachedSession {
        mtime: mtime_of(path),
        size: fs::metadata(path).map(|m| m.len()).unwrap_or(0),
        session,
        first_ts_ms,
    }
}

fn parse_file(path: &Path) -> CachedSession {
    let mtime = mtime_of(path);
    let size = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    {
        let cache = CACHE.lock();
        if let Some(cached) = cache.get(path) {
            if cached.mtime == mtime && cached.size == size {
                return cached.clone();
            }
        }
    }
    let parsed = parse_file_uncached(path);
    CACHE.lock().insert(path.to_path_buf(), parsed.clone());
    parsed
}

fn indexed_titles() -> HashMap<String, String> {
    let Some(path) = session_index_path() else {
        return HashMap::new();
    };
    let Ok(text) = fs::read_to_string(path) else {
        return HashMap::new();
    };
    let mut out = HashMap::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(id) = v.get("id").and_then(|x| x.as_str()) else {
            continue;
        };
        if let Some(title) = v.get("thread_name").and_then(|x| x.as_str()) {
            if !title.is_empty() {
                out.insert(id.to_string(), title.to_string());
            }
        }
    }
    out
}

fn path_for_session(session_id: &str) -> Option<PathBuf> {
    all_session_files().into_iter().find(|p| {
        let parsed = parse_file(p);
        parsed.session.session_id == session_id
    })
}

pub fn usage_for_session(
    cwd: &str,
    since_ms: u64,
    session_id: Option<&str>,
    exclude: &[String],
) -> Option<SessionUsage> {
    let exclude: HashSet<&str> = exclude.iter().map(String::as_str).collect();
    let path = if let Some(id) = session_id.filter(|s| !s.is_empty()) {
        path_for_session(id)
    } else {
        all_session_files()
            .into_iter()
            .map(|p| {
                let parsed = parse_file(&p);
                (p, parsed)
            })
            .filter(|(_, parsed)| parsed.session.cwd.as_deref() == Some(cwd))
            .filter(|(_, parsed)| !exclude.contains(parsed.session.session_id.as_str()))
            .filter(|(p, parsed)| {
                parsed.first_ts_ms >= since_ms.saturating_sub(3000)
                    || file_modified_ms(p) >= since_ms.saturating_sub(3000)
            })
            .min_by_key(|(_, parsed)| parsed.first_ts_ms)
            .map(|(p, _)| p)
    }?;

    let mut session = parse_file(&path).session;
    if let Some(title) = indexed_titles().get(&session.session_id) {
        session.title = Some(title.clone());
    }
    Some(session)
}

pub fn usage_for_dir(cwd: &str) -> Option<SessionUsage> {
    all_session_files()
        .into_iter()
        .map(|p| {
            let modified = file_modified_ms(&p);
            let parsed = parse_file(&p).session;
            (modified, parsed)
        })
        .filter(|(_, session)| session.cwd.as_deref() == Some(cwd))
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, session)| session)
}

pub fn usage_totals() -> UsageTotals {
    let mut totals = UsageTotals {
        runtime: Some("codex".to_string()),
        ..Default::default()
    };
    let mut models: HashMap<String, ModelUsage> = HashMap::new();
    let files = all_session_files();
    let seen: HashSet<PathBuf> = files.iter().cloned().collect();
    for path in files {
        let session = parse_file(&path).session;
        if session.message_count == 0 {
            continue;
        }
        totals.session_count += 1;
        totals.input_tokens += session.input_tokens;
        totals.output_tokens += session.output_tokens;
        totals.cache_read_tokens += session.cache_read_tokens;
        totals.reasoning_output_tokens += session.reasoning_output_tokens;
        totals.message_count += session.message_count;
        for m in session.by_model {
            let e = models.entry(m.model.clone()).or_insert_with(|| ModelUsage {
                model: m.model.clone(),
                ..Default::default()
            });
            e.input_tokens += m.input_tokens;
            e.output_tokens += m.output_tokens;
            e.cache_read_tokens += m.cache_read_tokens;
            e.reasoning_output_tokens += m.reasoning_output_tokens;
            e.message_count += m.message_count;
        }
    }
    CACHE.lock().retain(|path, _| seen.contains(path));
    let mut by_model: Vec<ModelUsage> = models.into_values().collect();
    by_model.sort_by(|a, b| b.message_count.cmp(&a.message_count));
    totals.by_model = by_model;
    totals
}
