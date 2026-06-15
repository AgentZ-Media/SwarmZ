use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// The JSONL stores the bare model id even for 1M-context sessions, so the
/// window size has to be inferred: explicit `[1m]` suffix, the user's global
/// default model being the `[1m]` variant of this model, the model having
/// actually been run at 1M before (recorded in `~/.claude.json`), or an
/// observed context that simply doesn't fit into 200k.
fn read_settings_model() -> Option<String> {
    let p = dirs::home_dir()?.join(".claude").join("settings.json");
    let s = fs::read_to_string(p).ok()?;
    let v: serde_json::Value = serde_json::from_str(&s).ok()?;
    v.get("model").and_then(|m| m.as_str()).map(String::from)
}

/// Bare model ids the user has actually run with the 1M window, harvested from
/// `~/.claude.json` → `projects.*.lastModelUsage` keys carrying a `[1m]` suffix
/// (e.g. `claude-opus-4-8[1m]` → `claude-opus-4-8`). The session JSONL only ever
/// stores the bare id and `~/.claude/settings.json` is usually empty (the model
/// is picked via `/model`, not written there), so without this the donut could
/// only flip to 1M *after* a session already crossed 200k. Cached against the
/// file's mtime — re-parsed only when `~/.claude.json` actually changes.
static ONEM_MODELS: Lazy<Mutex<(u64, HashSet<String>)>> =
    Lazy::new(|| Mutex::new((0, HashSet::new())));

fn onem_models() -> HashSet<String> {
    let Some(path) = dirs::home_dir().map(|h| h.join(".claude.json")) else {
        return HashSet::new();
    };
    let mtime = mtime_of(&path);
    {
        let guard = ONEM_MODELS.lock();
        if mtime != 0 && guard.0 == mtime {
            return guard.1.clone();
        }
    }
    let mut set = HashSet::new();
    if let Ok(s) = fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
            if let Some(projects) = v.get("projects").and_then(|p| p.as_object()) {
                for cfg in projects.values() {
                    let Some(lmu) = cfg.get("lastModelUsage").and_then(|m| m.as_object()) else {
                        continue;
                    };
                    for key in lmu.keys() {
                        if let Some(base) = key.strip_suffix("[1m]") {
                            set.insert(base.to_string());
                        }
                    }
                }
            }
        }
    }
    *ONEM_MODELS.lock() = (mtime, set.clone());
    set
}

fn context_limit(
    model: &str,
    settings_model: Option<&str>,
    onem_models: &HashSet<String>,
    context_tokens: u64,
) -> u64 {
    if model.contains("[1m]") {
        return 1_000_000;
    }
    if let Some(s) = settings_model {
        if s.contains("[1m]") && s.starts_with(model) {
            return 1_000_000;
        }
    }
    // the user has actually run this exact model at 1M (per ~/.claude.json) — the
    // reliable below-200k signal, since the JSONL drops the [1m] suffix.
    if onem_models.contains(model) {
        return 1_000_000;
    }
    if context_tokens > 200_000 {
        return 1_000_000;
    }
    200_000
}

/// Fallback pricing in USD per **million** tokens: (input, output, cache_write, cache_read).
/// Only used while the live OpenRouter catalog hasn't loaded (e.g. offline) or
/// for model ids it doesn't know.
fn fallback_pricing(model: &str) -> (f64, f64, f64, f64) {
    let m = model.to_ascii_lowercase();
    if m.contains("fable") {
        (10.0, 50.0, 12.5, 1.0)
    } else if m.contains("opus") {
        (5.0, 25.0, 6.25, 0.5)
    } else if m.contains("haiku") {
        (1.0, 5.0, 1.25, 0.1)
    } else {
        // sonnet + sensible default
        (3.0, 15.0, 3.75, 0.3)
    }
}

/// Live pricing from the free, key-less OpenRouter model catalog, keyed by
/// normalized model id (vendor prefix stripped, dots → dashes, no `[1m]` or
/// date-snapshot suffix).
static LIVE_PRICING: Lazy<Mutex<HashMap<String, (f64, f64, f64, f64)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn normalize_model_id(id: &str) -> String {
    let mut s = id.to_ascii_lowercase().replace('.', "-");
    if let Some(stripped) = s.strip_suffix("[1m]") {
        s = stripped.to_string();
    }
    // date-suffixed snapshot ids, e.g. `claude-haiku-4-5-20251001`
    // (boundary check: the id comes from arbitrary jsonl content — a
    // multi-byte char at the split point must not panic the parser)
    if s.len() > 9 && s.is_char_boundary(s.len() - 9) {
        let (head, tail) = s.split_at(s.len() - 9);
        if tail.starts_with('-') && tail[1..].chars().all(|c| c.is_ascii_digit()) {
            return head.to_string();
        }
    }
    s
}

/// Fetch current Anthropic model pricing. Returns whether the table was
/// updated (callers retry on `false` and re-emit usage on `true`).
pub async fn refresh_pricing() -> bool {
    let body = match reqwest::get("https://openrouter.ai/api/v1/models").await {
        Ok(resp) => match resp.text().await {
            Ok(b) => b,
            Err(_) => return false,
        },
        Err(_) => return false,
    };
    let v: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let per_mtok = |p: &serde_json::Value, key: &str| -> Option<f64> {
        let raw = p.get(key)?;
        let n = raw.as_f64().or_else(|| raw.as_str()?.parse().ok())?;
        (n >= 0.0).then(|| n * 1e6) // skips "-1" placeholder entries
    };
    let mut map = HashMap::new();
    for m in v
        .get("data")
        .and_then(|d| d.as_array())
        .into_iter()
        .flatten()
    {
        let Some(name) = m
            .get("id")
            .and_then(|i| i.as_str())
            .and_then(|i| i.strip_prefix("anthropic/"))
        else {
            continue;
        };
        let Some(p) = m.get("pricing") else { continue };
        let (Some(input), Some(output)) = (per_mtok(p, "prompt"), per_mtok(p, "completion"))
        else {
            continue;
        };
        let cw = per_mtok(p, "input_cache_write").unwrap_or(input * 1.25);
        let cr = per_mtok(p, "input_cache_read").unwrap_or(input * 0.1);
        map.insert(normalize_model_id(name), (input, output, cw, cr));
    }
    if map.is_empty() {
        return false;
    }
    // no cache invalidation needed: costs are recomputed from the cached
    // token counters on every read, so the new table applies immediately
    *LIVE_PRICING.lock() = map;
    true
}

/// Pricing in USD per **million** tokens: (input, output, cache_write, cache_read).
fn pricing(model: &str) -> (f64, f64, f64, f64) {
    if let Some(p) = LIVE_PRICING.lock().get(&normalize_model_id(model)) {
        return *p;
    }
    fallback_pricing(model)
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
    /// `attributionAgent` for subagent files (e.g. "Explore"); `None` for the
    /// main session.
    pub agent_type: Option<String>,
    /// current context occupancy = full prompt of the latest main-chain turn
    pub context_tokens: u64,
    /// context window of the model that served that turn (200k, or 1m variants)
    pub context_limit: u64,
    pub message_count: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub cost_usd: f64,
    pub by_model: Vec<ModelUsage>,
    /// Subagents (Task tool) spawned by this session, each with its own context
    /// window. Only populated by `usage_for_session`; empty otherwise.
    #[serde(default)]
    pub subagents: Vec<SubagentUsage>,
}

/// One subagent (Task tool) run, parsed from
/// `<project>/<session>/subagents/agent-<id>.jsonl`. Every line there is
/// `isSidechain:true`, so context is computed by forcing the context gate open.
#[derive(Clone, Serialize, Default)]
pub struct SubagentUsage {
    pub agent_id: String,
    /// agent type from `attributionAgent`, e.g. "Explore" / "general-purpose"
    pub agent_type: Option<String>,
    pub model: Option<String>,
    /// this subagent's own current context occupancy + its model's window
    pub context_tokens: u64,
    pub context_limit: u64,
    pub message_count: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub cost_usd: f64,
    pub last_activity: Option<String>,
    /// heuristic: the subagent file was modified within the last few seconds
    pub running: bool,
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

// ---- Incremental per-file parsing ----
//
// Session files are append-only JSONL, so we remember how many bytes of
// complete lines were already consumed per (file, since-filter) and only
// parse what was appended since the previous call. Costs and the by_model
// breakdown are derived from the running counters on every call, so live
// pricing updates apply without invalidating cached state.

struct ParseState {
    mtime: u64,
    size: u64,
    /// bytes consumed so far (always ends on a line boundary)
    offset: u64,
    session: SessionUsage,
    models: HashMap<String, ModelUsage>,
}

static CACHE: Lazy<Mutex<HashMap<(PathBuf, Option<u64>), ParseState>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn process_line(
    line: &[u8],
    session: &mut SessionUsage,
    models: &mut HashMap<String, ModelUsage>,
    since_ms: Option<u64>,
    settings_model: Option<&str>,
    onem_models: &HashSet<String>,
    force_context: bool,
) {
    let v: serde_json::Value = match serde_json::from_slice(line) {
        Ok(v) => v,
        Err(_) => return,
    };
    // `attributionAgent` is present on every line of a subagent file; capture it
    // once so subagents can be labelled by their type (e.g. "Explore").
    if session.agent_type.is_none() {
        if let Some(a) = v.get("attributionAgent").and_then(|a| a.as_str()) {
            if !a.is_empty() {
                session.agent_type = Some(a.to_string());
            }
        }
    }
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
        return;
    }
    let msg = match v.get("message") {
        Some(m) => m,
        None => return,
    };
    let usage = match msg.get("usage") {
        Some(u) => u,
        None => return,
    };
    if let Some(since) = since_ms {
        if parse_ts_ms(&v).unwrap_or(0) < since {
            return;
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

    // context occupancy: full prompt of the latest main-chain turn.
    // Sidechain (subagent) turns run in their own, smaller context — skipped for
    // the main session, but `force_context` opens the gate when this file IS a
    // subagent (every line sidechain) so its own window is tracked.
    if force_context || v.get("isSidechain").and_then(|s| s.as_bool()) != Some(true) {
        session.context_tokens = inp + cc + cr;
        session.context_limit =
            context_limit(&model, settings_model, onem_models, session.context_tokens);
    }

    session.input_tokens += inp;
    session.output_tokens += out;
    session.cache_creation_tokens += cc;
    session.cache_read_tokens += cr;
    session.message_count += 1;

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

/// Snapshot of the accumulated state with costs / by_model / primary model
/// recomputed from the running counters.
fn finalize(state: &ParseState) -> SessionUsage {
    let mut session = state.session.clone();
    let mut by_model: Vec<ModelUsage> = state.models.values().cloned().collect();
    session.cost_usd = 0.0;
    for m in by_model.iter_mut() {
        m.recompute_cost();
        session.cost_usd += m.cost_usd;
    }
    by_model.sort_by(|a, b| {
        b.cost_usd
            .partial_cmp(&a.cost_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    // pick the model with the most messages as "primary"
    if let Some(top) = by_model.iter().max_by_key(|m| m.message_count) {
        session.primary_model = Some(top.model.clone());
    }
    session.by_model = by_model;
    session
}

/// Parse a session file. When `since_ms` is `Some`, only assistant messages with
/// a timestamp at/after that instant are counted (used to scope usage to a single
/// SwarmZ-launched session rather than the whole history).
fn parse_file(path: &Path, since_ms: Option<u64>, force_context: bool) -> SessionUsage {
    let new_session = || SessionUsage {
        session_id: path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string(),
        ..Default::default()
    };
    let size = match fs::metadata(path) {
        Ok(m) => m.len(),
        Err(_) => return new_session(),
    };
    let mtime = mtime_of(path);

    let mut cache = CACHE.lock();
    let key = (path.to_path_buf(), since_ms);
    // a shrunken file was truncated or replaced — start over
    if cache.get(&key).map(|s| size < s.offset).unwrap_or(false) {
        cache.remove(&key);
    }
    let state = cache.entry(key).or_insert_with(|| ParseState {
        mtime: 0,
        size: u64::MAX,
        offset: 0,
        session: new_session(),
        models: HashMap::new(),
    });

    if state.mtime != mtime || state.size != size {
        let ParseState {
            session,
            models,
            offset,
            ..
        } = state;
        if let Ok(mut f) = fs::File::open(path) {
            let mut bytes = Vec::new();
            if f.seek(SeekFrom::Start(*offset)).is_ok() && f.read_to_end(&mut bytes).is_ok() {
                // only consume complete lines; a partially-written tail line
                // is picked up on a later call once its newline arrives
                if let Some(last_nl) = bytes.iter().rposition(|&b| b == b'\n') {
                    let settings_model = read_settings_model();
                    let onem = onem_models();
                    for line in bytes[..=last_nl].split(|&b| b == b'\n') {
                        if line.is_empty() {
                            continue;
                        }
                        process_line(
                            line,
                            session,
                            models,
                            since_ms,
                            settings_model.as_deref(),
                            &onem,
                            force_context,
                        );
                    }
                    *offset += (last_nl + 1) as u64;
                }
            }
        }
        state.mtime = mtime;
        state.size = size;
    }
    finalize(state)
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
    Some(parse_file(&path, None, false))
}

fn file_created_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.created())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
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

/// The session file in `dir` created at/after `since_ms` (i.e. born during this
/// agent's life). With several agents in the same folder, multiple files
/// qualify — the agent's own session is the EARLIEST-born one (later births
/// belong to younger panes), and sessions already latched by other agents
/// (`exclude`) are never matched.
fn pick_new_session(dir: &Path, since_ms: u64, exclude: &[String]) -> Option<PathBuf> {
    let floor = since_ms.saturating_sub(3000); // small clock-skew tolerance
    let mut oldest: Option<(u64, PathBuf)> = None;
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
            if exclude.iter().any(|e| e == stem) {
                continue; // another agent's session
            }
        }
        let born = file_created_ms(&p);
        if born < floor {
            continue; // pre-existing session — not ours
        }
        if oldest.as_ref().map(|(b, _)| born < *b).unwrap_or(true) {
            oldest = Some((born, p));
        }
    }
    oldest.map(|(_, p)| p)
}

/// Fallback for manually resumed sessions: `claude --resume` appends to the
/// pre-existing jsonl (same session id, old birth time), so `pick_new_session`
/// never sees it. Match the non-excluded file most recently MODIFIED at/after
/// `since_ms` instead — it only becomes a candidate once the resumed session
/// actually writes new turns inside this pane's lifetime. A concurrently
/// active external session in the same folder could in principle be matched
/// too; the exclude list and the mtime floor keep that window small.
fn pick_resumed_session(dir: &Path, since_ms: u64, exclude: &[String]) -> Option<PathBuf> {
    let floor = since_ms.saturating_sub(3000); // small clock-skew tolerance
    let mut newest: Option<(u64, PathBuf)> = None;
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
            if exclude.iter().any(|e| e == stem) {
                continue; // another agent's session
            }
        }
        let modified = file_modified_ms(&p);
        if modified < floor {
            continue; // idle since before this pane went busy — not ours
        }
        if newest.as_ref().map(|(m, _)| modified > *m).unwrap_or(true) {
            newest = Some((modified, p));
        }
    }
    newest.map(|(_, p)| p)
}

/// Subagents (Task tool) of a session live in a sibling directory:
/// `<project>/<session_id>/subagents/agent-<id>.jsonl`. Each file is one
/// subagent with its OWN context window — every line there is sidechain, so we
/// parse with `force_context` to track that window (the normal gate would leave
/// it at 0). Reuses `parse_file`'s incremental cache, so polling stays cheap.
fn subagents_for_session_file(session_path: &Path) -> Vec<SubagentUsage> {
    let Some(stem) = session_path.file_stem().and_then(|s| s.to_str()) else {
        return Vec::new();
    };
    let dir = match session_path.parent() {
        Some(p) => p.join(stem).join("subagents"),
        None => return Vec::new(),
    };
    if !dir.is_dir() {
        return Vec::new();
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).into_iter().flatten().flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let s = parse_file(&p, None, true);
        if s.message_count == 0 {
            continue;
        }
        let fstem = p.file_stem().and_then(|x| x.to_str()).unwrap_or("");
        let agent_id = fstem.strip_prefix("agent-").unwrap_or(fstem).to_string();
        out.push(SubagentUsage {
            agent_id,
            agent_type: s.agent_type.clone(),
            model: s.primary_model.clone(),
            context_tokens: s.context_tokens,
            context_limit: s.context_limit,
            message_count: s.message_count,
            input_tokens: s.input_tokens,
            output_tokens: s.output_tokens,
            cache_creation_tokens: s.cache_creation_tokens,
            cache_read_tokens: s.cache_read_tokens,
            cost_usd: s.cost_usd,
            last_activity: s.last_activity.clone(),
            running: now.saturating_sub(file_modified_ms(&p)) < 8000,
        });
    }
    // running first, then most-recently active
    out.sort_by(|a, b| {
        b.running
            .cmp(&a.running)
            .then(b.last_activity.cmp(&a.last_activity))
    });
    out
}

/// Usage for a single SwarmZ-launched session only. Latches onto `session_id`
/// once known; otherwise discovers the session file born after `since_ms` —
/// or, as a fallback for manual `claude --resume` in a fresh pane, the
/// pre-existing file modified after `since_ms` (see `pick_resumed_session`).
/// A latched file is parsed WITHOUT the since-filter: the whole file is this
/// pane's session, and after a restart + `--resume` the pre-restart turns must
/// still count (stats popover, context donut) even though the agent's
/// `createdAt` was reset to launch time.
pub fn usage_for_session(
    cwd: &str,
    since_ms: u64,
    session_id: Option<&str>,
    exclude: &[String],
) -> Option<SessionUsage> {
    let dir = claude_projects_dir()?.join(encode_project_dir(cwd));
    if !dir.is_dir() {
        return None;
    }
    let discover = || {
        pick_new_session(&dir, since_ms, exclude)
            .or_else(|| pick_resumed_session(&dir, since_ms, exclude))
    };
    let (path, since) = match session_id.filter(|s| !s.is_empty()) {
        Some(sid) => {
            let p = dir.join(format!("{}.jsonl", sid));
            if p.is_file() {
                (p, None)
            } else {
                (discover()?, Some(since_ms))
            }
        }
        None => (discover()?, Some(since_ms)),
    };
    let mut session = parse_file(&path, since, false);
    session.subagents = subagents_for_session_file(&path);
    Some(session)
}

// ---- Aggregate totals (parse_file's incremental cache keeps this cheap) ----

pub fn usage_totals() -> UsageTotals {
    let mut totals = UsageTotals::default();
    let mut models: HashMap<String, ModelUsage> = HashMap::new();
    let root = match claude_projects_dir() {
        Some(r) if r.is_dir() => r,
        _ => return totals,
    };

    // every jsonl seen this walk — used below to evict cache entries of
    // deleted/rotated files (the cache would otherwise grow forever)
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();

    for entry in WalkDir::new(&root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
    {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        seen.insert(path.to_path_buf());
        let session = parse_file(path, None, false);

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

    // evict parse states of files that no longer exist on disk
    CACHE.lock().retain(|(path, _), _| seen.contains(path));

    let mut by_model: Vec<ModelUsage> = models.into_values().collect();
    by_model.sort_by(|a, b| {
        b.cost_usd
            .partial_cmp(&a.cost_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    totals.by_model = by_model;
    totals
}
