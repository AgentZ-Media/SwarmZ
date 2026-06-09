use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// Pricing in USD per **million** tokens: (input, output, cache_write, cache_read).
fn pricing(model: &str) -> (f64, f64, f64, f64) {
    let m = model.to_ascii_lowercase();
    if m.contains("opus") {
        (15.0, 75.0, 18.75, 1.5)
    } else if m.contains("haiku") {
        (1.0, 5.0, 1.25, 0.1)
    } else {
        // sonnet + sensible default
        (3.0, 15.0, 3.75, 0.3)
    }
}

#[derive(Clone, Serialize, Default)]
pub struct ModelUsage {
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub message_count: u64,
    pub cost_usd: f64,
}

impl ModelUsage {
    fn recompute_cost(&mut self) {
        let (i, o, cw, cr) = pricing(&self.model);
        self.cost_usd = (self.input_tokens as f64 * i
            + self.output_tokens as f64 * o
            + self.cache_creation_tokens as f64 * cw
            + self.cache_read_tokens as f64 * cr)
            / 1_000_000.0;
    }
}

#[derive(Clone, Serialize, Default)]
pub struct SessionUsage {
    pub session_id: String,
    pub cwd: Option<String>,
    pub primary_model: Option<String>,
    pub service_tier: Option<String>,
    pub git_branch: Option<String>,
    pub last_activity: Option<String>,
    pub message_count: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub cost_usd: f64,
    pub by_model: Vec<ModelUsage>,
}

#[derive(Clone, Serialize, Default)]
pub struct UsageTotals {
    pub total_cost_usd: f64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub message_count: u64,
    pub session_count: u64,
    pub by_model: Vec<ModelUsage>,
}

pub fn claude_projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

/// Claude encodes a project's cwd as the directory name by replacing every
/// `/` and `.` with `-`. e.g. `/Users/x/Desktop/.claude` -> `-Users-x-Desktop--claude`.
fn encode_project_dir(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c == '/' || c == '.' { '-' } else { c })
        .collect()
}

fn parse_ts_ms(v: &serde_json::Value) -> Option<u64> {
    v.get("timestamp")
        .and_then(|t| t.as_str())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.timestamp_millis().max(0) as u64)
}

/// Parse a session file. When `since_ms` is `Some`, only assistant messages with
/// a timestamp at/after that instant are counted (used to scope usage to a single
/// SwarmZ-launched session rather than the whole history).
fn parse_file(path: &Path, since_ms: Option<u64>) -> SessionUsage {
    let mut session = SessionUsage {
        session_id: path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string(),
        ..Default::default()
    };
    let mut models: HashMap<String, ModelUsage> = HashMap::new();

    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return session,
    };
    let reader = BufReader::new(file);
    for line in reader.lines().map_while(Result::ok) {
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            // still capture cwd / branch from any line that has them
            if session.cwd.is_none() {
                if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                    session.cwd = Some(c.to_string());
                }
            }
            if session.git_branch.is_none() {
                if let Some(b) = v.get("gitBranch").and_then(|b| b.as_str()) {
                    if !b.is_empty() {
                        session.git_branch = Some(b.to_string());
                    }
                }
            }
            continue;
        }
        let msg = match v.get("message") {
            Some(m) => m,
            None => continue,
        };
        let usage = match msg.get("usage") {
            Some(u) => u,
            None => continue,
        };
        if let Some(since) = since_ms {
            if parse_ts_ms(&v).unwrap_or(0) < since {
                continue;
            }
        }
        let model = msg
            .get("model")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown")
            .to_string();

        let inp = usage.get("input_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
        let out = usage.get("output_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
        let cc = usage
            .get("cache_creation_input_tokens")
            .and_then(|x| x.as_u64())
            .unwrap_or(0);
        let cr = usage
            .get("cache_read_input_tokens")
            .and_then(|x| x.as_u64())
            .unwrap_or(0);

        let entry = models.entry(model.clone()).or_insert_with(|| ModelUsage {
            model: model.clone(),
            ..Default::default()
        });
        entry.input_tokens += inp;
        entry.output_tokens += out;
        entry.cache_creation_tokens += cc;
        entry.cache_read_tokens += cr;
        entry.message_count += 1;

        session.input_tokens += inp;
        session.output_tokens += out;
        session.cache_creation_tokens += cc;
        session.cache_read_tokens += cr;
        session.message_count += 1;
        session.primary_model = Some(model);

        if let Some(t) = usage.get("service_tier").and_then(|t| t.as_str()) {
            session.service_tier = Some(t.to_string());
        }
        if let Some(ts) = v.get("timestamp").and_then(|t| t.as_str()) {
            session.last_activity = Some(ts.to_string());
        }
        if session.cwd.is_none() {
            if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                session.cwd = Some(c.to_string());
            }
        }
    }

    let mut by_model: Vec<ModelUsage> = models.into_values().collect();
    for m in by_model.iter_mut() {
        m.recompute_cost();
        session.cost_usd += m.cost_usd;
    }
    by_model.sort_by(|a, b| b.cost_usd.partial_cmp(&a.cost_usd).unwrap_or(std::cmp::Ordering::Equal));
    // pick the model with the most messages as "primary"
    if let Some(top) = by_model.iter().max_by_key(|m| m.message_count) {
        session.primary_model = Some(top.model.clone());
    }
    session.by_model = by_model;
    session
}

fn mtime_of(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Find the most-recently modified session file for a given working directory.
pub fn newest_session_for_dir(cwd: &str) -> Option<PathBuf> {
    let dir = claude_projects_dir()?.join(encode_project_dir(cwd));
    if !dir.is_dir() {
        return None;
    }
    let mut newest: Option<(u64, PathBuf)> = None;
    for entry in fs::read_dir(&dir).ok()?.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let mt = mtime_of(&p);
        if newest.as_ref().map(|(m, _)| mt > *m).unwrap_or(true) {
            newest = Some((mt, p));
        }
    }
    newest.map(|(_, p)| p)
}

pub fn usage_for_dir(cwd: &str) -> Option<SessionUsage> {
    let path = newest_session_for_dir(cwd)?;
    Some(parse_file(&path, None))
}

fn file_created_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.created())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The session file in `dir` created at/after `since_ms` (i.e. born during this
/// agent's life), preferring the most recently active one.
fn pick_new_session(dir: &Path, since_ms: u64) -> Option<PathBuf> {
    let floor = since_ms.saturating_sub(3000); // small clock-skew tolerance
    let mut newest: Option<(u64, PathBuf)> = None;
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        if file_created_ms(&p) < floor {
            continue; // pre-existing session — not ours
        }
        let mt = mtime_of(&p);
        if newest.as_ref().map(|(m, _)| mt > *m).unwrap_or(true) {
            newest = Some((mt, p));
        }
    }
    newest.map(|(_, p)| p)
}

/// Usage for a single SwarmZ-launched session only. Latches onto `session_id`
/// once known; otherwise discovers the session file born after `since_ms`.
pub fn usage_for_session(
    cwd: &str,
    since_ms: u64,
    session_id: Option<&str>,
) -> Option<SessionUsage> {
    let dir = claude_projects_dir()?.join(encode_project_dir(cwd));
    if !dir.is_dir() {
        return None;
    }
    let path = match session_id.filter(|s| !s.is_empty()) {
        Some(sid) => {
            let p = dir.join(format!("{}.jsonl", sid));
            if p.is_file() {
                p
            } else {
                pick_new_session(&dir, since_ms)?
            }
        }
        None => pick_new_session(&dir, since_ms)?,
    };
    Some(parse_file(&path, Some(since_ms)))
}

// ---- Aggregate totals with an mtime-keyed cache so we don't re-read everything ----

struct CachedFile {
    mtime: u64,
    usage: SessionUsage,
}

static CACHE: Lazy<Mutex<HashMap<PathBuf, CachedFile>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

pub fn usage_totals() -> UsageTotals {
    let mut totals = UsageTotals::default();
    let mut models: HashMap<String, ModelUsage> = HashMap::new();
    let root = match claude_projects_dir() {
        Some(r) if r.is_dir() => r,
        _ => return totals,
    };

    let mut cache = CACHE.lock();
    for entry in WalkDir::new(&root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
    {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let mt = mtime_of(path);
        let session = match cache.get(path) {
            Some(c) if c.mtime == mt => c.usage.clone(),
            _ => {
                let parsed = parse_file(path, None);
                cache.insert(
                    path.to_path_buf(),
                    CachedFile {
                        mtime: mt,
                        usage: parsed.clone(),
                    },
                );
                parsed
            }
        };

        if session.message_count == 0 {
            continue;
        }
        totals.session_count += 1;
        totals.input_tokens += session.input_tokens;
        totals.output_tokens += session.output_tokens;
        totals.cache_creation_tokens += session.cache_creation_tokens;
        totals.cache_read_tokens += session.cache_read_tokens;
        totals.message_count += session.message_count;
        totals.total_cost_usd += session.cost_usd;

        for m in &session.by_model {
            let e = models.entry(m.model.clone()).or_insert_with(|| ModelUsage {
                model: m.model.clone(),
                ..Default::default()
            });
            e.input_tokens += m.input_tokens;
            e.output_tokens += m.output_tokens;
            e.cache_creation_tokens += m.cache_creation_tokens;
            e.cache_read_tokens += m.cache_read_tokens;
            e.message_count += m.message_count;
            e.cost_usd += m.cost_usd;
        }
    }

    let mut by_model: Vec<ModelUsage> = models.into_values().collect();
    by_model.sort_by(|a, b| {
        b.cost_usd
            .partial_cmp(&a.cost_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    totals.by_model = by_model;
    totals
}
