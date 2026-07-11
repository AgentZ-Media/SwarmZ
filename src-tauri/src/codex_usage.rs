//! Account-level Codex rate limits for the Deck meters: a bounded
//! newest-first tail scan over `~/.codex/sessions` rollouts. The pre-rebuild
//! per-session usage aggregation (usage_for_dir/_session/_totals) was
//! removed in the final audit (R13) — session accounting mirrors codex
//! `token_usage` events frontend-side, so those commands had no caller.

use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

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

fn sessions_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".codex").join("sessions"))
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
    files.sort_by_key(|a| std::cmp::Reverse(a.0));
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

// The pre-rebuild per-session usage aggregation (usage_for_dir /
// usage_for_session / usage_totals + the title index) was REMOVED in the
// final audit (R13): the frontend mirrors codex `token_usage` events live,
// so these commands had no caller. This module now serves exactly one job —
// the account-level rate limits above (`account_limits`).

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
