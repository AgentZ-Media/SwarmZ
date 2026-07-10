use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

// ---- shared usage types ----
//
// Formerly in usage.rs (the Claude parser, removed in the codex-only
// rebuild). Codex runs on the ChatGPT subscription, so `cost_usd` stays 0 —
// there is no pricing table anymore.

#[derive(Clone, Serialize, Default)]
pub struct ModelUsage {
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub reasoning_output_tokens: u64,
    pub message_count: u64,
    pub cost_usd: f64,
}

#[derive(Clone, Serialize, Default)]
pub struct SessionUsage {
    pub runtime: Option<String>,
    pub activity: Option<String>,
    pub session_id: String,
    pub cwd: Option<String>,
    pub primary_model: Option<String>,
    pub title: Option<String>,
    pub git_branch: Option<String>,
    pub last_activity: Option<String>,
    /// current context occupancy = the latest turn's full prompt
    pub context_tokens: u64,
    /// context window of the model that served that turn
    pub context_limit: u64,
    pub message_count: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub reasoning_output_tokens: u64,
    pub cost_usd: f64,
    pub by_model: Vec<ModelUsage>,
    pub codex_limits: Option<CodexRateLimits>,
}

#[derive(Clone, Serialize, Default)]
pub struct CodexRateLimitWindow {
    pub utilization: Option<f64>,
    pub resets_at: Option<String>,
    pub window_minutes: Option<u64>,
}

#[derive(Clone, Serialize, Default)]
pub struct CodexRateLimits {
    pub primary: Option<CodexRateLimitWindow>,
    pub secondary: Option<CodexRateLimitWindow>,
    pub plan_type: Option<String>,
}

#[derive(Clone, Serialize, Default)]
pub struct UsageTotals {
    pub runtime: Option<String>,
    pub total_cost_usd: f64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub reasoning_output_tokens: u64,
    pub message_count: u64,
    pub session_count: u64,
    pub by_model: Vec<ModelUsage>,
}

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

fn session_files_in(root: &Path) -> Vec<PathBuf> {
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

fn all_session_files() -> Vec<PathBuf> {
    let Some(root) = sessions_dir() else {
        return Vec::new();
    };
    session_files_in(&root)
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

// ---- Account-level rate limits (the Deck's Codex meters) ----

/// The newest `rate_limits` payload found across ALL Codex session rollouts —
/// rate limits are account-scoped (ChatGPT plan), so the most recent event
/// anywhere is the current truth, independent of which pane produced it.
/// `as_of_ms` is the emitting event's timestamp (fallback: file mtime) so the
/// frontend can annotate stale data instead of presenting it as live.
#[derive(serde::Serialize, Clone, Default)]
pub struct CodexAccountLimits {
    pub limits: Option<CodexRateLimits>,
    pub as_of_ms: Option<i64>,
}

/// Only this many bytes from the END of a rollout are scanned per file.
/// `token_count` events fire on every turn, so the newest one lives in the
/// tail of any recently-active file; a bounded read keeps the worst case at
/// (number of session files) × 256 KiB instead of re-parsing years of history.
const LIMITS_TAIL_BYTES: u64 = 256 * 1024;

pub fn account_limits() -> CodexAccountLimits {
    match sessions_dir() {
        Some(root) => account_limits_in(&root),
        None => CodexAccountLimits::default(),
    }
}

/// Iterate session files newest-mtime-first and stop at the first file whose
/// tail yields a usable `rate_limits` event — in steady state that is one
/// stat pass over the tree plus a single 256 KiB tail read.
fn account_limits_in(root: &Path) -> CodexAccountLimits {
    let mut files: Vec<(u64, PathBuf)> = session_files_in(root)
        .into_iter()
        .map(|p| (file_modified_ms(&p), p))
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (mtime_ms, path) in files {
        if let Some((limits, event_ts_ms)) = tail_rate_limits(&path) {
            return CodexAccountLimits {
                limits: Some(limits),
                as_of_ms: Some(event_ts_ms.unwrap_or(mtime_ms) as i64),
            };
        }
    }
    CodexAccountLimits::default()
}

/// Newest `token_count.rate_limits` event within the file's bounded tail.
/// Returns the parsed limits plus the event's own timestamp (ms), if any.
/// Malformed lines (torn writes, truncation at the tail boundary) are skipped.
fn tail_rate_limits(path: &Path) -> Option<(CodexRateLimits, Option<u64>)> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(LIMITS_TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.lines().collect();
    // a mid-file seek almost certainly landed inside a record — drop it
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    for line in lines.iter().rev().filter(|l| !l.trim().is_empty()) {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("event_msg") {
            continue;
        }
        let Some(payload) = v.get("payload") else {
            continue;
        };
        if payload.get("type").and_then(|t| t.as_str()) != Some("token_count") {
            continue;
        }
        let Some(raw) = payload.get("rate_limits") else {
            continue;
        };
        let Some(limits) = parse_codex_limits(raw) else {
            continue;
        };
        // an empty rate_limits object must not shadow older real data
        if limits.primary.is_none() && limits.secondary.is_none() {
            continue;
        }
        return Some((limits, parse_ts_ms(&v)));
    }
    None
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    fn temp_dir() -> PathBuf {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "swarmz-codex-limits-test-{}-{}",
            SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_session(dir: &Path, name: &str, lines: &[&str], age_secs: u64) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, lines.join("\n")).unwrap();
        // explicit mtimes make the newest-first ordering deterministic
        let mtime = SystemTime::now() - Duration::from_secs(age_secs);
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(mtime)
            .unwrap();
        path
    }

    fn limits_line(ts: &str, used_percent: f64) -> String {
        format!(
            r#"{{"timestamp":"{ts}","type":"event_msg","payload":{{"type":"token_count","rate_limits":{{"primary":{{"used_percent":{used_percent},"window_minutes":300,"resets_at":1751882400}},"secondary":{{"used_percent":10.0,"window_minutes":10080}},"plan_type":"plus"}}}}}}"#
        )
    }

    #[test]
    fn newest_file_wins() {
        let dir = temp_dir();
        let old = limits_line("2026-07-06T09:00:00Z", 80.0);
        let new = limits_line("2026-07-07T10:00:00Z", 42.5);
        write_session(&dir, "old.jsonl", &[&old], 3600);
        write_session(&dir, "new.jsonl", &[&new], 10);

        let out = account_limits_in(&dir);
        let limits = out.limits.expect("limits found");
        assert_eq!(limits.primary.as_ref().unwrap().utilization, Some(42.5));
        assert_eq!(limits.plan_type.as_deref(), Some("plus"));
        // as_of comes from the event timestamp, not the file mtime
        assert_eq!(
            out.as_of_ms,
            Some(
                chrono::DateTime::parse_from_rfc3339("2026-07-07T10:00:00Z")
                    .unwrap()
                    .timestamp_millis()
            )
        );
    }

    #[test]
    fn newest_rate_limits_line_within_a_file_wins() {
        let dir = temp_dir();
        let older = limits_line("2026-07-07T08:00:00Z", 20.0);
        let newer = limits_line("2026-07-07T09:00:00Z", 55.0);
        write_session(&dir, "s.jsonl", &[&older, &newer], 10);

        let out = account_limits_in(&dir);
        assert_eq!(
            out.limits.unwrap().primary.unwrap().utilization,
            Some(55.0)
        );
    }

    #[test]
    fn file_without_rate_limits_falls_through_to_older_file() {
        let dir = temp_dir();
        let data = limits_line("2026-07-06T09:00:00Z", 33.0);
        write_session(
            &dir,
            "newer-no-limits.jsonl",
            &[r#"{"timestamp":"2026-07-07T10:00:00Z","type":"event_msg","payload":{"type":"task_started"}}"#],
            10,
        );
        write_session(&dir, "older-with-limits.jsonl", &[&data], 3600);

        let out = account_limits_in(&dir);
        assert_eq!(
            out.limits.unwrap().primary.unwrap().utilization,
            Some(33.0)
        );
    }

    #[test]
    fn malformed_lines_are_skipped() {
        let dir = temp_dir();
        let good = limits_line("2026-07-07T10:00:00Z", 12.0);
        write_session(
            &dir,
            "s.jsonl",
            &[
                &good,
                "{not json at all",
                r#"{"type":"event_msg","payload":{"type":"token_count","rate_limits":{}}}"#,
                "",
            ],
            10,
        );

        let out = account_limits_in(&dir);
        // the trailing garbage + empty rate_limits are skipped; the good line wins
        assert_eq!(
            out.limits.unwrap().primary.unwrap().utilization,
            Some(12.0)
        );
    }

    #[test]
    fn no_data_yields_null() {
        let dir = temp_dir();
        write_session(
            &dir,
            "s.jsonl",
            &[r#"{"timestamp":"2026-07-07T10:00:00Z","type":"session_meta","payload":{"id":"x"}}"#],
            10,
        );

        let out = account_limits_in(&dir);
        assert!(out.limits.is_none());
        assert!(out.as_of_ms.is_none());

        // and an entirely empty tree behaves the same
        let empty = temp_dir();
        let out = account_limits_in(&empty);
        assert!(out.limits.is_none());
        assert!(out.as_of_ms.is_none());
    }

    #[test]
    fn as_of_falls_back_to_file_mtime_without_event_timestamp() {
        let dir = temp_dir();
        // same payload shape but no timestamp field on the line
        let line = r#"{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":5.0,"window_minutes":300},"secondary":null,"plan_type":"plus"}}}"#;
        let path = write_session(&dir, "s.jsonl", &[line], 10);

        let out = account_limits_in(&dir);
        assert!(out.limits.is_some());
        assert_eq!(out.as_of_ms, Some(file_modified_ms(&path) as i64));
    }
}
