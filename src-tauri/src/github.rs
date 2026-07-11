//! GitHub integration over the LOCAL `gh` CLI (rebuild Phase 7) — no OAuth,
//! no login flow, no tokens: SwarmZ only reads (and, opt-in, drives) the
//! user's existing `gh` state. Pattern of `git.rs`: subprocess timeouts
//! (`output_with_timeout`), typed degradation instead of errors — every
//! command answers a `GhOutcome` (`not_installed` / `not_authenticated` /
//! `no_remote` / `error`) so a missing or logged-out `gh` can never crash or
//! hang a caller.
//!
//! Read-only detection (`auth_status`, `repo_info`, `pr_list`, `pr_view`)
//! works unconditionally. WRITE ops (`pr_create`, `pr_comment`, `pr_review`)
//! are double-gated: the webview executors check the Settings master toggle,
//! and Rust re-checks the `INTEGRATION_ENABLED` flag (synced via the
//! `github_set_integration` command) under the `WRITE_GATE` — every write
//! holds a read guard for its duration and disabling drains them first, so a
//! write can never run (or keep running unnoticed past the ack) while the
//! integration is off, whatever the frontend claims. There is deliberately NO
//! merge command: merging/closing PRs stays a human action (and
//! `classify_approval` marks agent-run `gh pr merge` destructive).
//!
//! The PR watcher polls each configured repo's open PRs on a Settings
//! interval and emits `github://pr-changed` on real changes (opened, closed,
//! checks, review decision, draft state) — the Deck ticker and the autonomy
//! loop consume it. No configured repos = no polling.
//!
//! JSON shapes are parsed against gh 2.95.0 (live-verified 2026-07-11 against
//! AgentZ-Media/SwarmZ): `gh auth status --json hosts`, `gh repo view --json
//! name,owner,defaultBranchRef,visibility,url,isPrivate`, `gh pr list/view
//! --json …` with `statusCheckRollup` mixing `CheckRun {status, conclusion,
//! startedAt}` and `StatusContext {state}` entries (the summary fixture below
//! is captured real data).

use once_cell::sync::Lazy;
use parking_lot::{Mutex, RwLock, RwLockReadGuard};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::git::{git_bin, output_with_timeout};

/// Deadline for the read-only gh queries (network calls to the GitHub API).
const GH_TIMEOUT: Duration = Duration::from_secs(30);
/// Deadline for write ops (create includes a `git push`).
const GH_WRITE_TIMEOUT: Duration = Duration::from_secs(120);
/// Whole-diff byte cap for `pr_view` (mirrors the DiffCard per-file cap).
const DIFF_BYTE_CAP: usize = 512 * 1024;
/// PR body cap in `pr_view` responses (the Conductor reads these).
const BODY_CHAR_CAP: usize = 4_000;

// ---- integration gate ----------------------------------------------------

/// The master toggle, mirrored from Settings (`github_set_integration`).
/// FAIL-CLOSED default: writes refuse and agent-run gh write commands
/// classify destructive until the frontend explicitly enables it.
static INTEGRATION_ENABLED: AtomicBool = AtomicBool::new(false);

/// Serializes the DISABLE edge against in-flight writes: every write op holds
/// a read guard for its whole duration; `set_integration(false)` flips the
/// flag FIRST (new writes refuse instantly) and then takes the write guard,
/// which blocks until every running write finished — so when the disable
/// command acks, no gh/git write is running and none can start.
static WRITE_GATE: Lazy<RwLock<()>> = Lazy::new(|| RwLock::new(()));

/// Sync the master toggle. Disabling BLOCKS until in-flight writes drained —
/// call it off the main thread (the Tauri command wraps it in spawn_blocking).
pub fn set_integration(enabled: bool) {
    INTEGRATION_ENABLED.store(enabled, Ordering::SeqCst);
    if !enabled {
        drop(WRITE_GATE.write());
    }
}

pub fn integration_enabled() -> bool {
    INTEGRATION_ENABLED.load(Ordering::SeqCst)
}

/// In-flight gh/git WRITE ops (pr_create/comment/review) — a `git push` or a
/// PR mutation mid-flight. The quit guard reads this so quitting mid-write
/// warns instead of killing a push (`gh_writes` in the QuitConfirm dialog).
static WRITES_IN_FLIGHT: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

/// Number of gh write ops currently running (for the quit guard).
pub fn writes_in_flight() -> usize {
    WRITES_IN_FLIGHT.load(Ordering::SeqCst)
}

/// The guard a write op holds for its whole duration: the WRITE_GATE read lock
/// (draining a disable) PLUS the in-flight counter (the quit guard). Both
/// release together on drop.
struct WriteGuard {
    _read: RwLockReadGuard<'static, ()>,
}

impl Drop for WriteGuard {
    fn drop(&mut self) {
        WRITES_IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Check the gate and return the guard the write op must HOLD until it is
/// done — the flag check happens under the read lock, so it stays consistent
/// with a concurrent draining disable. Also books the in-flight counter.
fn require_integration() -> Result<WriteGuard, String> {
    let guard = WRITE_GATE.read();
    if integration_enabled() {
        WRITES_IN_FLIGHT.fetch_add(1, Ordering::SeqCst);
        Ok(WriteGuard { _read: guard })
    } else {
        Err("GitHub integration is disabled (Settings → GitHub) — write actions refuse".into())
    }
}

// ---- gh binary resolution -------------------------------------------------

/// Settings override wins; GUI apps on macOS launch with a minimal PATH, so
/// otherwise probe the well-known install dirs before trusting PATH.
pub(crate) fn gh_bin(overridden: Option<&str>) -> String {
    if let Some(b) = overridden.map(str::trim) {
        if !b.is_empty() {
            return b.to_string();
        }
    }
    for candidate in ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"] {
        if Path::new(candidate).exists() {
            return candidate.to_string();
        }
    }
    "gh".to_string()
}

// ---- typed degradation ----------------------------------------------------

/// Every gh command's answer: `ok` with data, or a TYPED unavailable state.
/// `{status: "ok", data: …}` / `{status: "not_installed"}` / … on the wire.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", content = "data", rename_all = "snake_case")]
pub enum GhOutcome<T> {
    Ok(T),
    /// the gh binary is not on this machine
    NotInstalled,
    /// gh is installed but not logged in (or the token expired)
    NotAuthenticated,
    /// the folder has no GitHub remote (or is not a git repo)
    NoRemote,
    /// anything else — the trimmed gh stderr
    Error(String),
}

// ---- credential redaction ---------------------------------------------------

/// Is this byte part of an opaque token run? (base64/hex/token alphabets)
fn token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '_' | '-')
}

/// Redact credentials from subprocess error output BEFORE it reaches the
/// webview / Conductor transcript (pure, unit-tested). Failed `git push`
/// stderr echoes the remote URL — `https://user:TOKEN@github.com/…` or a
/// hostile credential helper would leak tokens otherwise. Three passes, then
/// a char cap:
///   1. URL userinfo (`scheme://user:pass@host`) → `scheme://***@host`
///   2. GitHub token shapes (ghp_/gho_/ghu_/ghs_/ghr_/github_pat_…) → marker
///   3. any ≥40-char opaque run mixing letters and digits (hex/base64) → marker
pub(crate) fn redact_credentials(s: &str, max_chars: usize) -> String {
    // pass 1: URL userinfo
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(pos) = rest.find("://") {
        let (head, tail) = rest.split_at(pos + 3);
        out.push_str(head);
        // userinfo ends at the first '@' BEFORE any path/space boundary
        let boundary = tail
            .find(|c: char| c == '/' || c.is_whitespace())
            .unwrap_or(tail.len());
        match tail[..boundary].rfind('@') {
            Some(at) if at > 0 => {
                out.push_str("***");
                rest = &tail[at..];
            }
            _ => rest = tail,
        }
    }
    out.push_str(rest);
    // pass 2 + 3: token-prefix runs and long opaque runs, in one scan
    const PREFIXES: &[&str] = &["github_pat_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_"];
    let mut redacted = String::with_capacity(out.len());
    let chars: Vec<char> = out.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        // longest run of token chars starting here
        let mut j = i;
        while j < chars.len() && token_char(chars[j]) {
            j += 1;
        }
        if j == i {
            redacted.push(chars[i]);
            i += 1;
            continue;
        }
        let run: String = chars[i..j].iter().collect();
        let lower = run.to_lowercase();
        let has_prefix = PREFIXES.iter().any(|p| lower.contains(p));
        let long_opaque = run.len() >= 40
            && run.chars().any(|c| c.is_ascii_digit())
            && run.chars().any(|c| c.is_ascii_alphabetic());
        if (has_prefix && run.len() >= 12) || long_opaque {
            redacted.push_str("[redacted]");
        } else {
            redacted.push_str(&run);
        }
        i = j;
    }
    // cap
    if redacted.chars().count() <= max_chars {
        redacted
    } else {
        let capped: String = redacted.chars().take(max_chars).collect();
        format!("{capped}…")
    }
}

/// Classify a failed gh invocation from its stderr (pure, unit-tested).
fn classify_gh_stderr<T>(stderr: &str) -> GhOutcome<T> {
    let s = stderr.to_lowercase();
    if s.contains("gh auth login")
        || s.contains("authentication token")
        || s.contains("http 401")
        || s.contains("not logged in")
    {
        return GhOutcome::NotAuthenticated;
    }
    if s.contains("no git remotes")
        || s.contains("not a git repository")
        || s.contains("could not determine base repo")
        || s.contains("none of the git remotes")
        || s.contains("unable to determine base repository")
    {
        return GhOutcome::NoRemote;
    }
    // defense in depth: gh stderr can echo remote URLs too — redact + cap
    let capped = redact_credentials(stderr.trim(), 500);
    GhOutcome::Error(if capped.is_empty() {
        "gh failed without an error message".into()
    } else {
        capped
    })
}

/// Run one gh command in `dir`; classify failures typed. Returns raw stdout.
fn run_gh(
    bin: &str,
    dir: Option<&str>,
    args: &[&str],
    timeout: Duration,
) -> Result<String, GhOutcome<()>> {
    let mut cmd = Command::new(bin);
    cmd.args(args);
    if let Some(d) = dir {
        // validate the cwd OURSELVES: a vanished folder (worktree-removal
        // race) also spawns with ErrorKind::NotFound and would otherwise be
        // misdiagnosed as "gh is not installed"
        if !Path::new(d).is_dir() {
            return Err(GhOutcome::Error(format!(
                "the folder no longer exists: {d}"
            )));
        }
        cmd.current_dir(d);
    }
    // gh must never try to prompt interactively from inside the app
    cmd.env("GH_PROMPT_DISABLED", "1").env("NO_COLOR", "1");
    let out = match output_with_timeout(&mut cmd, timeout) {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(GhOutcome::NotInstalled)
        }
        Err(e) => return Err(GhOutcome::Error(format!("gh did not run: {e}"))),
    };
    if !out.status.success() {
        return Err(classify_gh_stderr(&String::from_utf8_lossy(&out.stderr)));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Re-tag a `GhOutcome` failure to the caller's payload type.
fn retag<S, T>(o: GhOutcome<S>) -> GhOutcome<T> {
    match o {
        GhOutcome::Ok(_) => GhOutcome::Error("unreachable".into()),
        GhOutcome::NotInstalled => GhOutcome::NotInstalled,
        GhOutcome::NotAuthenticated => GhOutcome::NotAuthenticated,
        GhOutcome::NoRemote => GhOutcome::NoRemote,
        GhOutcome::Error(e) => GhOutcome::Error(e),
    }
}

// ---- auth status ----------------------------------------------------------

#[derive(Debug, Clone, Serialize, Default)]
pub struct GhAuthStatus {
    pub installed: bool,
    pub authenticated: bool,
    /// active github.com account login
    pub login: Option<String>,
    /// comma-separated token scopes, as gh reports them
    pub scopes: Option<String>,
    /// `gh --version` first line
    pub version: Option<String>,
    pub error: Option<String>,
}

/// `gh auth status --json hosts` — never errors; degradation is in the flags.
pub fn auth_status(bin_override: Option<&str>) -> GhAuthStatus {
    let bin = gh_bin(bin_override);
    let version = run_gh(&bin, None, &["--version"], GH_TIMEOUT)
        .ok()
        .and_then(|s| s.lines().next().map(|l| l.trim().to_string()));
    if version.is_none() {
        return GhAuthStatus {
            installed: false,
            error: Some("gh is not installed (or not on the app's PATH)".into()),
            ..Default::default()
        };
    }
    // --json makes gh exit 0 even for auth issues; state carries the truth
    match run_gh(&bin, None, &["auth", "status", "--json", "hosts"], GH_TIMEOUT) {
        Ok(stdout) => {
            let v: Value = serde_json::from_str(&stdout).unwrap_or(Value::Null);
            let account = v
                .get("hosts")
                .and_then(|h| h.get("github.com"))
                .and_then(|a| a.as_array())
                .and_then(|accounts| {
                    accounts
                        .iter()
                        .find(|a| a.get("active").and_then(Value::as_bool) == Some(true))
                        .or_else(|| accounts.first())
                })
                .cloned();
            let Some(acc) = account else {
                return GhAuthStatus {
                    installed: true,
                    authenticated: false,
                    version,
                    error: Some("not logged in to github.com — run `gh auth login`".into()),
                    ..Default::default()
                };
            };
            let ok = acc.get("state").and_then(Value::as_str) == Some("success");
            GhAuthStatus {
                installed: true,
                authenticated: ok,
                login: acc
                    .get("login")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                scopes: acc
                    .get("scopes")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                version,
                error: if ok {
                    None
                } else {
                    Some("gh reports an authentication problem — run `gh auth login`".into())
                },
            }
        }
        Err(GhOutcome::NotInstalled) => GhAuthStatus {
            installed: false,
            error: Some("gh is not installed".into()),
            ..Default::default()
        },
        Err(fail) => {
            let (authenticated, error) = match fail {
                GhOutcome::NotAuthenticated => {
                    (false, Some("not logged in — run `gh auth login`".into()))
                }
                GhOutcome::Error(e) => (false, Some(e)),
                _ => (false, Some("gh auth status failed".into())),
            };
            GhAuthStatus {
                installed: true,
                authenticated,
                version,
                error,
                ..Default::default()
            }
        }
    }
}

// ---- repo info -------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct GhRepoInfo {
    pub owner: String,
    pub name: String,
    /// "owner/name"
    pub full_name: String,
    pub url: String,
    pub default_branch: String,
    /// "PUBLIC" | "PRIVATE" | "INTERNAL"
    pub visibility: String,
}

/// GitHub remote of one project folder (`gh repo view --json …`). Degrades
/// typed when the folder has no GitHub remote.
pub fn repo_info(dir: &str, bin_override: Option<&str>) -> GhOutcome<GhRepoInfo> {
    let bin = gh_bin(bin_override);
    let stdout = match run_gh(
        &bin,
        Some(dir),
        &[
            "repo",
            "view",
            "--json",
            "name,owner,defaultBranchRef,visibility,url",
        ],
        GH_TIMEOUT,
    ) {
        Ok(s) => s,
        Err(fail) => return retag(fail),
    };
    let v: Value = match serde_json::from_str(&stdout) {
        Ok(v) => v,
        Err(e) => return GhOutcome::Error(format!("unparseable gh repo view output: {e}")),
    };
    let owner = v
        .pointer("/owner/login")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let name = v
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    GhOutcome::Ok(GhRepoInfo {
        full_name: format!("{owner}/{name}"),
        owner,
        name,
        url: v
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        default_branch: v
            .pointer("/defaultBranchRef/name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        visibility: v
            .get("visibility")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    })
}

// ---- PR list / view / checks ------------------------------------------------

/// Aggregated CI state of one PR, derived from `statusCheckRollup`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
pub struct ChecksSummary {
    pub passing: u32,
    pub failing: u32,
    pub pending: u32,
    pub total: u32,
}

/// Collapse a `statusCheckRollup` array into pass/fail/pending counts.
/// Repeated runs of the SAME check (re-runs, force-pushes) count once — the
/// newest `startedAt` wins, like the GitHub UI. Dedupe keys on workflow +
/// check name (same-named jobs in DIFFERENT workflows are different checks —
/// collapsing them could hide a failure); entries with no name at all get a
/// unique key each instead of collapsing onto "". Pure, fixture-tested.
pub(crate) fn summarize_checks(rollup: &Value) -> ChecksSummary {
    let Some(entries) = rollup.as_array() else {
        return ChecksSummary::default();
    };
    // key → (startedAt, bucket); later entries with a newer start replace
    #[derive(Clone, Copy, PartialEq)]
    enum Bucket {
        Pass,
        Fail,
        Pending,
    }
    let mut by_name: HashMap<String, (String, Bucket)> = HashMap::new();
    for (idx, e) in entries.iter().enumerate() {
        let check = e
            .get("name")
            .and_then(Value::as_str)
            .or_else(|| e.get("context").and_then(Value::as_str))
            .unwrap_or("");
        let workflow = e
            .get("workflowName")
            .and_then(Value::as_str)
            .unwrap_or("");
        let name = if check.is_empty() && workflow.is_empty() {
            // nameless: never collapse — a failing anonymous check must not
            // hide behind a passing one
            format!("\u{1}anon-{idx}")
        } else {
            format!("{workflow}\u{1}{check}")
        };
        let started = e
            .get("startedAt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let bucket = if let Some(state) = e.get("state").and_then(Value::as_str) {
            // StatusContext
            match state {
                "SUCCESS" => Bucket::Pass,
                "ERROR" | "FAILURE" => Bucket::Fail,
                _ => Bucket::Pending,
            }
        } else {
            // CheckRun
            let status = e.get("status").and_then(Value::as_str).unwrap_or("");
            if status != "COMPLETED" {
                Bucket::Pending
            } else {
                match e.get("conclusion").and_then(Value::as_str).unwrap_or("") {
                    "SUCCESS" | "NEUTRAL" | "SKIPPED" => Bucket::Pass,
                    _ => Bucket::Fail,
                }
            }
        };
        match by_name.get(&name) {
            // ISO-8601 strings compare chronologically as strings
            Some((prev_started, _)) if *prev_started >= started => {}
            _ => {
                by_name.insert(name, (started, bucket));
            }
        }
    }
    let mut s = ChecksSummary::default();
    for (_, (_, bucket)) in by_name {
        s.total += 1;
        match bucket {
            Bucket::Pass => s.passing += 1,
            Bucket::Fail => s.failing += 1,
            Bucket::Pending => s.pending += 1,
        }
    }
    s
}

/// One open PR (list shape).
#[derive(Debug, Clone, Serialize)]
pub struct GhPr {
    pub number: u64,
    pub title: String,
    pub author: String,
    pub head_ref: String,
    pub base_ref: String,
    pub is_draft: bool,
    /// "MERGEABLE" | "CONFLICTING" | "UNKNOWN"
    pub mergeable: String,
    /// "" | "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED"
    pub review_decision: String,
    pub url: String,
    pub updated_at: String,
    pub checks: ChecksSummary,
}

const PR_LIST_FIELDS: &str =
    "number,title,author,headRefName,baseRefName,isDraft,mergeable,reviewDecision,statusCheckRollup,url,updatedAt";

fn parse_pr(v: &Value) -> GhPr {
    GhPr {
        number: v.get("number").and_then(Value::as_u64).unwrap_or(0),
        title: v
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        author: v
            .pointer("/author/login")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        head_ref: v
            .get("headRefName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        base_ref: v
            .get("baseRefName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        is_draft: v.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        mergeable: v
            .get("mergeable")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        review_decision: v
            .get("reviewDecision")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        url: v
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        updated_at: v
            .get("updatedAt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        checks: summarize_checks(v.get("statusCheckRollup").unwrap_or(&Value::Null)),
    }
}

/// Open PRs of the repo behind `dir` (`gh pr list --json …`).
pub fn pr_list(dir: &str, bin_override: Option<&str>) -> GhOutcome<Vec<GhPr>> {
    let bin = gh_bin(bin_override);
    let stdout = match run_gh(
        &bin,
        Some(dir),
        &[
            "pr",
            "list",
            "--state",
            "open",
            "--limit",
            "50",
            "--json",
            PR_LIST_FIELDS,
        ],
        GH_TIMEOUT,
    ) {
        Ok(s) => s,
        Err(fail) => return retag(fail),
    };
    match serde_json::from_str::<Value>(&stdout) {
        Ok(Value::Array(items)) => GhOutcome::Ok(items.iter().map(parse_pr).collect()),
        Ok(_) => GhOutcome::Error("unexpected gh pr list shape".into()),
        Err(e) => GhOutcome::Error(format!("unparseable gh pr list output: {e}")),
    }
}

/// One changed file of a PR.
#[derive(Debug, Clone, Serialize)]
pub struct GhPrFile {
    pub path: String,
    pub additions: u64,
    pub deletions: u64,
}

/// One submitted review on a PR.
#[derive(Debug, Clone, Serialize)]
pub struct GhPrReview {
    pub author: String,
    /// "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | …
    pub state: String,
}

/// Full PR detail (view shape) incl. the (capped) unified diff.
#[derive(Debug, Clone, Serialize)]
pub struct GhPrDetail {
    #[serde(flatten)]
    pub pr: GhPr,
    /// PR body, char-capped
    pub body: String,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    pub files: Vec<GhPrFile>,
    pub reviews: Vec<GhPrReview>,
    /// unified diff (`gh pr diff`), byte-capped on a line boundary; None when
    /// the caller skipped it
    pub diff: Option<String>,
    pub diff_truncated: bool,
}

const PR_VIEW_FIELDS: &str = "number,title,body,author,headRefName,baseRefName,isDraft,mergeable,reviewDecision,statusCheckRollup,url,updatedAt,additions,deletions,changedFiles,files,reviews";

/// Cap a string on a char boundary.
fn cap_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let capped: String = s.chars().take(max).collect();
        format!("{capped}…")
    }
}

/// Bounded drain of one child pipe on a thread: at most `cap` bytes are KEPT,
/// everything beyond is read and DISCARDED — the child never blocks on a full
/// pipe, and a giant output never fully buffers. `(bytes, clipped)`.
fn drain_capped<R: std::io::Read + Send + 'static>(
    pipe: Option<R>,
    cap: usize,
) -> std::sync::Arc<Mutex<(Vec<u8>, bool)>> {
    use std::sync::Arc;
    let buf = Arc::new(Mutex::new((Vec::new(), false)));
    if let Some(mut p) = pipe {
        let b = Arc::clone(&buf);
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            loop {
                match p.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut g = b.lock();
                        if g.0.len() < cap {
                            let take = n.min(cap - g.0.len());
                            g.0.extend_from_slice(&chunk[..take]);
                            if take < n {
                                g.1 = true;
                            }
                        } else {
                            g.1 = true; // keep draining, drop the excess
                        }
                    }
                }
            }
        });
    }
    buf
}

/// Trim a CLIPPED diff to its last complete line so the parser still sees
/// well-formed hunks; pass-through when nothing was clipped. (The lossy UTF-8
/// conversion upstream may leave a mangled partial last line — dropping to
/// the last newline removes it either way.) Pure, unit-tested.
fn finish_capped_diff(raw: String, clipped: bool) -> (String, bool) {
    if !clipped {
        return (raw, false);
    }
    let text = match raw.rfind('\n') {
        Some(nl) if nl > 0 => raw[..nl].to_string(),
        _ => raw,
    };
    (text, true)
}

/// `gh pr diff N` with stdout STREAMED into a bounded buffer — the diff is
/// capped WHILE reading, never after fully buffering (a monster PR diff must
/// not exhaust memory). Best-effort like before: any failure → None.
fn gh_diff_capped(bin: &str, dir: &str, n: &str, cap: usize) -> Option<(String, bool)> {
    use std::process::Stdio;
    if !Path::new(dir).is_dir() {
        return None;
    }
    let mut cmd = Command::new(bin);
    cmd.args(["pr", "diff", n])
        .current_dir(dir)
        .env("GH_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().ok()?;
    let out_buf = drain_capped(child.stdout.take(), cap);
    let deadline = Instant::now() + GH_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return None,
        }
    };
    if !status.success() {
        return None;
    }
    // grace period for the drain thread to hit EOF (strong_count == 1 means
    // it finished and dropped its clone — the output_with_timeout pattern)
    let grace = Instant::now() + Duration::from_secs(2);
    while std::sync::Arc::strong_count(&out_buf) > 1 && Instant::now() < grace {
        std::thread::sleep(Duration::from_millis(10));
    }
    let (bytes, clipped) = {
        let g = out_buf.lock();
        (g.0.clone(), g.1)
    };
    Some(finish_capped_diff(
        String::from_utf8_lossy(&bytes).into_owned(),
        clipped,
    ))
}

/// PR detail: `gh pr view N --json …` plus (optionally) `gh pr diff N`.
pub fn pr_view(
    dir: &str,
    number: u64,
    include_diff: bool,
    bin_override: Option<&str>,
) -> GhOutcome<GhPrDetail> {
    let bin = gh_bin(bin_override);
    let n = number.to_string();
    let stdout = match run_gh(
        &bin,
        Some(dir),
        &["pr", "view", &n, "--json", PR_VIEW_FIELDS],
        GH_TIMEOUT,
    ) {
        Ok(s) => s,
        Err(fail) => return retag(fail),
    };
    let v: Value = match serde_json::from_str(&stdout) {
        Ok(v) => v,
        Err(e) => return GhOutcome::Error(format!("unparseable gh pr view output: {e}")),
    };
    let files = v
        .get("files")
        .and_then(Value::as_array)
        .map(|fs| {
            fs.iter()
                .map(|f| GhPrFile {
                    path: f
                        .get("path")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    additions: f.get("additions").and_then(Value::as_u64).unwrap_or(0),
                    deletions: f.get("deletions").and_then(Value::as_u64).unwrap_or(0),
                })
                .collect()
        })
        .unwrap_or_default();
    let reviews = v
        .get("reviews")
        .and_then(Value::as_array)
        .map(|rs| {
            rs.iter()
                .map(|r| GhPrReview {
                    author: r
                        .pointer("/author/login")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    state: r
                        .get("state")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    // the diff is best-effort: a failed diff never sinks the whole view
    let (diff, diff_truncated) = if include_diff {
        match gh_diff_capped(&bin, dir, &n, DIFF_BYTE_CAP) {
            Some((text, truncated)) => (Some(text), truncated),
            None => (None, false),
        }
    } else {
        (None, false)
    };
    GhOutcome::Ok(GhPrDetail {
        pr: parse_pr(&v),
        body: cap_chars(
            v.get("body").and_then(Value::as_str).unwrap_or(""),
            BODY_CHAR_CAP,
        ),
        additions: v.get("additions").and_then(Value::as_u64).unwrap_or(0),
        deletions: v.get("deletions").and_then(Value::as_u64).unwrap_or(0),
        changed_files: v.get("changedFiles").and_then(Value::as_u64).unwrap_or(0),
        files,
        reviews,
        diff,
        diff_truncated,
    })
}

// ---- write ops (Rust-gated on the integration flag) -------------------------

#[derive(Debug, Clone, Serialize)]
pub struct GhPrCreated {
    pub url: String,
    pub branch: String,
}

/// The default-branch protection is only as good as the default-branch VALUE:
/// an unknown/empty default (missing `defaultBranchRef` in a malformed gh
/// answer) must REFUSE, never fall open past the check into `git push`.
/// Pure, unit-tested.
fn ensure_lane_branch(branch: &str, default_branch: &str) -> Result<(), String> {
    if default_branch.trim().is_empty() {
        return Err(format!(
            "refused: could not determine the repository's default branch (gh repo view returned no defaultBranchRef) — not pushing \"{branch}\" without that guard"
        ));
    }
    if branch == default_branch {
        return Err(format!(
            "refused: \"{branch}\" is the repository's default branch — create the PR from a lane branch (worktree), never by pushing {branch} directly"
        ));
    }
    Ok(())
}

/// Create a PR from the branch checked out in `dir` (an agent's worktree):
/// `git push -u origin <branch>` (never force) + `gh pr create --head …`.
/// Refuses the repo's default branch — a lane lives on its own branch; the
/// default branch is never pushed silently.
pub fn pr_create(
    dir: &str,
    title: &str,
    body: &str,
    base: Option<&str>,
    draft: bool,
    bin_override: Option<&str>,
    git_override: Option<&str>,
) -> Result<GhOutcome<GhPrCreated>, String> {
    // the guard is HELD for the whole op — a concurrent disable drains it
    let _gate = require_integration()?;
    let title = title.trim();
    if title.is_empty() {
        return Err("title must not be empty".into());
    }
    let bin = gh_bin(bin_override);
    let git = git_bin(git_override);

    // the branch actually checked out in the given folder
    let branch_out = output_with_timeout(
        Command::new(git)
            .arg("-C")
            .arg(dir)
            .args(["symbolic-ref", "--short", "-q", "HEAD"]),
        Duration::from_secs(10),
    )
    .map_err(|e| format!("git did not run: {e}"))?;
    let branch = String::from_utf8_lossy(&branch_out.stdout).trim().to_string();
    if branch.is_empty() {
        return Err("the folder has no checked-out branch (detached HEAD?)".into());
    }

    // never push the default branch — a PR comes from a lane branch
    let default_branch = match repo_info(dir, bin_override) {
        GhOutcome::Ok(info) => info.default_branch,
        fail => return Ok(retag(fail)),
    };
    ensure_lane_branch(&branch, &default_branch)?;

    // push the branch (plain push, NEVER --force)
    let push = output_with_timeout(
        Command::new(git_bin(git_override))
            .arg("-C")
            .arg(dir)
            .args(["push", "-u", "origin", &branch]),
        GH_WRITE_TIMEOUT,
    )
    .map_err(|e| format!("git push did not run: {e}"))?;
    if !push.status.success() {
        // NEVER return raw push stderr: it echoes the remote URL — a PAT in
        // the URL or a hostile credential helper would leak tokens into the
        // webview / Conductor transcript
        return Err(format!(
            "git push failed: {}",
            redact_credentials(String::from_utf8_lossy(&push.stderr).trim(), 800)
        ));
    }

    let mut args: Vec<&str> = vec![
        "pr", "create", "--head", &branch, "--title", title, "--body", body,
    ];
    if let Some(b) = base.map(str::trim).filter(|b| !b.is_empty()) {
        args.push("--base");
        args.push(b);
    }
    if draft {
        args.push("--draft");
    }
    match run_gh(&bin, Some(dir), &args, GH_WRITE_TIMEOUT) {
        Ok(stdout) => {
            // gh prints the PR URL as the last non-empty stdout line
            let url = stdout
                .lines()
                .rev()
                .find(|l| l.trim().starts_with("https://"))
                .unwrap_or("")
                .trim()
                .to_string();
            Ok(GhOutcome::Ok(GhPrCreated { url, branch }))
        }
        Err(fail) => Ok(retag(fail)),
    }
}

/// Comment on a PR (`gh pr comment N --body …`).
pub fn pr_comment(
    dir: &str,
    number: u64,
    body: &str,
    bin_override: Option<&str>,
) -> Result<GhOutcome<Value>, String> {
    // the guard is HELD for the whole op — a concurrent disable drains it
    let _gate = require_integration()?;
    if body.trim().is_empty() {
        return Err("comment body must not be empty".into());
    }
    let bin = gh_bin(bin_override);
    let n = number.to_string();
    match run_gh(
        &bin,
        Some(dir),
        &["pr", "comment", &n, "--body", body],
        GH_WRITE_TIMEOUT,
    ) {
        Ok(stdout) => Ok(GhOutcome::Ok(
            serde_json::json!({ "commented": true, "url": stdout.trim() }),
        )),
        Err(fail) => Ok(retag(fail)),
    }
}

/// Submit a PR review (`gh pr review N --approve|--request-changes|--comment`).
pub fn pr_review(
    dir: &str,
    number: u64,
    action: &str,
    body: Option<&str>,
    bin_override: Option<&str>,
) -> Result<GhOutcome<Value>, String> {
    // the guard is HELD for the whole op — a concurrent disable drains it
    let _gate = require_integration()?;
    let flag = match action {
        "approve" => "--approve",
        "request_changes" => "--request-changes",
        "comment" => "--comment",
        other => return Err(format!("unknown review action {other:?} — use approve | request_changes | comment")),
    };
    let body = body.unwrap_or("").trim();
    // GitHub requires a body for comment/request-changes reviews
    if body.is_empty() && action != "approve" {
        return Err("a comment / request_changes review needs a body".into());
    }
    let bin = gh_bin(bin_override);
    let n = number.to_string();
    let mut args: Vec<&str> = vec!["pr", "review", &n, flag];
    if !body.is_empty() {
        args.push("--body");
        args.push(body);
    }
    match run_gh(&bin, Some(dir), &args, GH_WRITE_TIMEOUT) {
        Ok(_) => Ok(GhOutcome::Ok(
            serde_json::json!({ "reviewed": true, "action": action }),
        )),
        Err(fail) => Ok(retag(fail)),
    }
}

// ---- PR watcher --------------------------------------------------------------

/// One repo the watcher polls.
#[derive(Debug, Clone, Deserialize)]
pub struct WatchRepo {
    pub project_id: String,
    pub dir: String,
}

/// Comparable signature of one PR — a change in any field is a reportable event.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PrSig {
    pub title: String,
    pub url: String,
    pub is_draft: bool,
    pub mergeable: String,
    pub review_decision: String,
    pub checks: ChecksSummary,
}

impl PrSig {
    fn of(pr: &GhPr) -> Self {
        PrSig {
            title: pr.title.clone(),
            url: pr.url.clone(),
            is_draft: pr.is_draft,
            mergeable: pr.mergeable.clone(),
            review_decision: pr.review_decision.clone(),
            checks: pr.checks.clone(),
        }
    }
}

/// One detected change, emitted in `github://pr-changed`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PrChange {
    pub number: u64,
    pub title: String,
    pub url: String,
    /// "opened" | "closed" | "checks" | "review" | "draft" | "updated"
    pub kind: String,
    /// short human note ("checks: 1 failing", "review: APPROVED", …)
    pub note: String,
}

/// Diff two PR snapshots into reportable changes (pure, unit-tested).
/// `first_poll` = the repo's FIRST poll — nothing is reported (a baseline,
/// not a change). The flag is EXPLICIT because an empty `old` map is
/// ambiguous: a repo whose baseline had ZERO open PRs must still report the
/// first PR opened after it.
pub(crate) fn diff_pr_sets(
    old: &HashMap<u64, PrSig>,
    new_prs: &[GhPr],
    first_poll: bool,
) -> Vec<PrChange> {
    if first_poll {
        return Vec::new();
    }
    let mut changes = Vec::new();
    for pr in new_prs {
        let Some(prev) = old.get(&pr.number) else {
            changes.push(PrChange {
                number: pr.number,
                title: pr.title.clone(),
                url: pr.url.clone(),
                kind: "opened".into(),
                note: "opened".into(),
            });
            continue;
        };
        let now = PrSig::of(pr);
        if *prev == now {
            continue;
        }
        let (kind, note) = if prev.checks != now.checks {
            (
                "checks",
                format!(
                    "checks: {} passing, {} failing, {} pending",
                    now.checks.passing, now.checks.failing, now.checks.pending
                ),
            )
        } else if prev.review_decision != now.review_decision {
            (
                "review",
                format!(
                    "review: {}",
                    if now.review_decision.is_empty() {
                        "(cleared)"
                    } else {
                        &now.review_decision
                    }
                ),
            )
        } else if prev.is_draft != now.is_draft {
            (
                "draft",
                if now.is_draft {
                    "converted to draft".to_string()
                } else {
                    "marked ready for review".to_string()
                },
            )
        } else if prev.mergeable != now.mergeable {
            ("updated", format!("mergeable: {}", now.mergeable))
        } else {
            ("updated", "updated".to_string())
        };
        changes.push(PrChange {
            number: pr.number,
            title: pr.title.clone(),
            url: pr.url.clone(),
            kind: kind.into(),
            note,
        });
    }
    let live: std::collections::HashSet<u64> = new_prs.iter().map(|p| p.number).collect();
    for (number, sig) in old {
        if !live.contains(number) {
            changes.push(PrChange {
                number: *number,
                title: sig.title.clone(),
                url: sig.url.clone(),
                kind: "closed".into(),
                note: "closed or merged".into(),
            });
        }
    }
    changes.sort_by_key(|c| c.number);
    changes
}

struct WatchState {
    repos: Vec<WatchRepo>,
    interval: Duration,
    bin: Option<String>,
    /// per project id: last seen PR signatures
    sigs: HashMap<String, HashMap<u64, PrSig>>,
    last_poll: HashMap<String, Instant>,
    ticker_running: bool,
    /// bumped on every (re)configure — an in-flight poll from an OLDER config
    /// discards its result (no cache mutation, no event) instead of emitting
    /// for a repo that was just un-watched / disabled
    generation: u64,
}

static WATCH: Lazy<Mutex<WatchState>> = Lazy::new(|| {
    Mutex::new(WatchState {
        repos: Vec::new(),
        interval: Duration::from_secs(120),
        bin: None,
        sigs: HashMap::new(),
        last_poll: HashMap::new(),
        ticker_running: false,
        generation: 0,
    })
});

/// How often the ticker wakes to see whether any repo is due.
const TICK_SECS: u64 = 15;
/// Floor for the poll interval (Settings can't melt the API).
const MIN_INTERVAL_SECS: u64 = 30;

/// Declaratively (re)configure the watcher: the given repos are polled every
/// `interval_secs`; an EMPTY list stops all polling. State of repos no longer
/// in the list is DROPPED — and since the frontend configures an empty list
/// on disable, a re-enable starts from a fresh SILENT baseline (no replayed
/// changes, no phantom "opened" events). Spawns the ticker once.
pub fn watch_configure(
    app: &AppHandle,
    repos: Vec<WatchRepo>,
    interval_secs: u64,
    bin: Option<String>,
) {
    let mut w = WATCH.lock();
    // drop state of repos no longer watched (a re-add starts from a baseline)
    let keep: std::collections::HashSet<&str> =
        repos.iter().map(|r| r.project_id.as_str()).collect();
    w.sigs.retain(|pid, _| keep.contains(pid.as_str()));
    w.last_poll.retain(|pid, _| keep.contains(pid.as_str()));
    w.generation = w.generation.wrapping_add(1);
    w.repos = repos;
    w.interval = Duration::from_secs(interval_secs.max(MIN_INTERVAL_SECS));
    w.bin = bin;
    if !w.ticker_running {
        w.ticker_running = true;
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(TICK_SECS)).await;
                tick(&app).await;
            }
        });
    }
}

/// One watcher tick: poll every repo whose interval elapsed; emit changes.
async fn tick(app: &AppHandle) {
    let (due, config_gen): (Vec<(WatchRepo, Option<String>)>, u64) = {
        let w = WATCH.lock();
        if !integration_enabled() {
            return; // master toggle off — the watcher stays silent
        }
        let now = Instant::now();
        let due = w
            .repos
            .iter()
            .filter(|r| match w.last_poll.get(&r.project_id) {
                Some(at) => now.duration_since(*at) >= w.interval,
                None => true,
            })
            .map(|r| (r.clone(), w.bin.clone()))
            .collect();
        (due, w.generation)
    };
    for (repo, bin) in due {
        // stamp BEFORE the poll so a slow/failing gh doesn't re-poll every tick
        WATCH
            .lock()
            .last_poll
            .insert(repo.project_id.clone(), Instant::now());
        let dir = repo.dir.clone();
        let result = tauri::async_runtime::spawn_blocking(move || pr_list(&dir, bin.as_deref()))
            .await
            .ok();
        let Some(GhOutcome::Ok(prs)) = result else {
            continue; // typed unavailability / transient error — try next round
        };
        let outcome = {
            let mut w = WATCH.lock();
            // re-check AFTER the await: the config changed (project removed,
            // list reconfigured) or the toggle dropped while gh was in flight
            // → discard the stale poll — no cache mutation, no event
            if w.generation != config_gen
                || !integration_enabled()
                || !w.repos.iter().any(|r| r.project_id == repo.project_id)
            {
                None
            } else {
                let old = w.sigs.get(&repo.project_id).cloned().unwrap_or_default();
                let first = !w.sigs.contains_key(&repo.project_id);
                let changes = diff_pr_sets(&old, &prs, first);
                w.sigs.insert(
                    repo.project_id.clone(),
                    prs.iter().map(|p| (p.number, PrSig::of(p))).collect(),
                );
                Some((changes, first))
            }
        };
        let Some((changes, first_poll)) = outcome else {
            continue;
        };
        // the first poll is a baseline; later polls emit only on real change —
        // but the PR snapshot itself always reaches the frontend cache
        if !changes.is_empty() || first_poll {
            let _ = app.emit(
                "github://pr-changed",
                serde_json::json!({
                    "project_id": repo.project_id,
                    "dir": repo.dir,
                    "prs": prs,
                    "changes": changes,
                    "baseline": first_poll && changes.is_empty(),
                }),
            );
        }
    }
}

// ---- tests --------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The integration flag + write gate are process-global — tests that
    /// toggle them must not interleave.
    static GATE_TEST_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

    #[test]
    fn gh_outcome_serializes_typed() {
        let ok: GhOutcome<u32> = GhOutcome::Ok(7);
        assert_eq!(
            serde_json::to_value(&ok).unwrap(),
            json!({ "status": "ok", "data": 7 })
        );
        let ni: GhOutcome<u32> = GhOutcome::NotInstalled;
        assert_eq!(
            serde_json::to_value(&ni).unwrap(),
            json!({ "status": "not_installed" })
        );
        let na: GhOutcome<u32> = GhOutcome::NotAuthenticated;
        assert_eq!(
            serde_json::to_value(&na).unwrap(),
            json!({ "status": "not_authenticated" })
        );
        let nr: GhOutcome<u32> = GhOutcome::NoRemote;
        assert_eq!(
            serde_json::to_value(&nr).unwrap(),
            json!({ "status": "no_remote" })
        );
        let err: GhOutcome<u32> = GhOutcome::Error("boom".into());
        assert_eq!(
            serde_json::to_value(&err).unwrap(),
            json!({ "status": "error", "data": "boom" })
        );
    }

    #[test]
    fn stderr_classification_is_typed() {
        match classify_gh_stderr::<()>("To get started with GitHub CLI, please run:  gh auth login") {
            GhOutcome::NotAuthenticated => {}
            other => panic!("expected NotAuthenticated, got {other:?}"),
        }
        match classify_gh_stderr::<()>("HTTP 401: Bad credentials") {
            GhOutcome::NotAuthenticated => {}
            other => panic!("expected NotAuthenticated, got {other:?}"),
        }
        match classify_gh_stderr::<()>("no git remotes found") {
            GhOutcome::NoRemote => {}
            other => panic!("expected NoRemote, got {other:?}"),
        }
        match classify_gh_stderr::<()>(
            "fatal: not a git repository (or any of the parent directories): .git",
        ) {
            GhOutcome::NoRemote => {}
            other => panic!("expected NoRemote, got {other:?}"),
        }
        match classify_gh_stderr::<()>("could not determine base repo: whatever") {
            GhOutcome::NoRemote => {}
            other => panic!("expected NoRemote, got {other:?}"),
        }
        match classify_gh_stderr::<()>("GraphQL: something exploded") {
            GhOutcome::Error(e) => assert!(e.contains("exploded")),
            other => panic!("expected Error, got {other:?}"),
        }
        match classify_gh_stderr::<()>("") {
            GhOutcome::Error(e) => assert!(e.contains("without an error message")),
            other => panic!("expected Error, got {other:?}"),
        }
    }

    /// Frozen against REAL gh 2.95.0 output (AgentZ-Media/SwarmZ PR #2,
    /// 2026-07-11): the same check name appears once per workflow RUN — the
    /// newest run must win, mixed CheckRun/StatusContext entries both count.
    #[test]
    fn checks_summary_dedupes_reruns_by_newest_start() {
        let rollup = json!([
            { "__typename": "CheckRun", "name": "Type-check & build frontend",
              "status": "COMPLETED", "conclusion": "SUCCESS", "startedAt": "2026-07-09T17:42:31Z" },
            { "__typename": "CheckRun", "name": "Type-check & build frontend",
              "status": "COMPLETED", "conclusion": "SUCCESS", "startedAt": "2026-07-08T17:14:07Z" },
            { "__typename": "CheckRun", "name": "Rust tests",
              "status": "COMPLETED", "conclusion": "SUCCESS", "startedAt": "2026-07-09T17:42:32Z" },
            { "__typename": "CheckRun", "name": "Rust tests",
              "status": "COMPLETED", "conclusion": "SUCCESS", "startedAt": "2026-07-08T17:14:08Z" },
            { "__typename": "StatusContext", "context": "CodeRabbit",
              "state": "SUCCESS", "startedAt": "2026-07-09T17:58:14Z" }
        ]);
        let s = summarize_checks(&rollup);
        assert_eq!(
            s,
            ChecksSummary { passing: 3, failing: 0, pending: 0, total: 3 }
        );
    }

    #[test]
    fn checks_summary_buckets_failures_and_pending() {
        let rollup = json!([
            { "name": "build", "status": "COMPLETED", "conclusion": "FAILURE", "startedAt": "b" },
            { "name": "lint", "status": "IN_PROGRESS", "conclusion": null, "startedAt": "b" },
            { "name": "deploy", "status": "COMPLETED", "conclusion": "CANCELLED", "startedAt": "b" },
            { "name": "docs", "status": "COMPLETED", "conclusion": "SKIPPED", "startedAt": "b" },
            { "context": "external", "state": "ERROR", "startedAt": "b" },
            { "context": "pending-ext", "state": "PENDING", "startedAt": "b" }
        ]);
        let s = summarize_checks(&rollup);
        assert_eq!(
            s,
            ChecksSummary { passing: 1, failing: 3, pending: 2, total: 6 }
        );
        // a rerun that flips pass → fail must surface the failure
        let flipped = json!([
            { "name": "build", "status": "COMPLETED", "conclusion": "SUCCESS", "startedAt": "2026-01-01T00:00:00Z" },
            { "name": "build", "status": "COMPLETED", "conclusion": "FAILURE", "startedAt": "2026-01-02T00:00:00Z" }
        ]);
        assert_eq!(summarize_checks(&flipped).failing, 1);
        // empty / missing rollup
        assert_eq!(summarize_checks(&Value::Null), ChecksSummary::default());
        assert_eq!(summarize_checks(&json!([])), ChecksSummary::default());
    }

    /// Double-review LOW 11: same-named jobs in DIFFERENT workflows are
    /// different checks — collapsing them could hide a failure — and
    /// nameless entries never collapse onto each other.
    #[test]
    fn checks_summary_keys_by_workflow_and_keeps_nameless_apart() {
        let two_workflows = json!([
            { "name": "test", "workflowName": "CI", "status": "COMPLETED", "conclusion": "SUCCESS", "startedAt": "b" },
            { "name": "test", "workflowName": "Nightly", "status": "COMPLETED", "conclusion": "FAILURE", "startedAt": "b" }
        ]);
        let s = summarize_checks(&two_workflows);
        assert_eq!(s, ChecksSummary { passing: 1, failing: 1, pending: 0, total: 2 });
        // a rerun WITHIN one workflow still dedupes (newest start wins)
        let rerun = json!([
            { "name": "test", "workflowName": "CI", "status": "COMPLETED", "conclusion": "FAILURE", "startedAt": "2026-01-01T00:00:00Z" },
            { "name": "test", "workflowName": "CI", "status": "COMPLETED", "conclusion": "SUCCESS", "startedAt": "2026-01-02T00:00:00Z" }
        ]);
        assert_eq!(summarize_checks(&rerun), ChecksSummary { passing: 1, failing: 0, pending: 0, total: 1 });
        // nameless entries: a failing anonymous check must not hide behind a
        // passing one
        let nameless = json!([
            { "status": "COMPLETED", "conclusion": "SUCCESS", "startedAt": "b" },
            { "status": "COMPLETED", "conclusion": "FAILURE", "startedAt": "b" }
        ]);
        let s = summarize_checks(&nameless);
        assert_eq!(s, ChecksSummary { passing: 1, failing: 1, pending: 0, total: 2 });
    }

    fn pr(number: u64, title: &str, checks: ChecksSummary) -> GhPr {
        GhPr {
            number,
            title: title.into(),
            author: "x".into(),
            head_ref: "feat".into(),
            base_ref: "main".into(),
            is_draft: false,
            mergeable: "MERGEABLE".into(),
            review_decision: String::new(),
            url: format!("https://example.com/pull/{number}"),
            updated_at: String::new(),
            checks,
        }
    }

    #[test]
    fn pr_diffing_reports_opened_closed_and_field_changes() {
        let ok = ChecksSummary { passing: 2, failing: 0, pending: 0, total: 2 };
        let bad = ChecksSummary { passing: 1, failing: 1, pending: 0, total: 2 };

        // first poll = baseline, silent
        assert!(diff_pr_sets(&HashMap::new(), &[pr(1, "a", ok.clone())], true).is_empty());

        let mut old = HashMap::new();
        old.insert(1, PrSig::of(&pr(1, "a", ok.clone())));
        old.insert(2, PrSig::of(&pr(2, "b", ok.clone())));

        // unchanged → silent
        assert!(
            diff_pr_sets(&old, &[pr(1, "a", ok.clone()), pr(2, "b", ok.clone())], false)
                .is_empty()
        );

        // checks flip + a new PR + a closed PR, sorted by number
        let changes = diff_pr_sets(&old, &[pr(1, "a", bad.clone()), pr(3, "c", ok.clone())], false);
        assert_eq!(changes.len(), 3);
        assert_eq!(changes[0].number, 1);
        assert_eq!(changes[0].kind, "checks");
        assert!(changes[0].note.contains("1 failing"), "{}", changes[0].note);
        assert_eq!(changes[1].number, 2);
        assert_eq!(changes[1].kind, "closed");
        assert_eq!(changes[2].number, 3);
        assert_eq!(changes[2].kind, "opened");

        // review decision change
        let mut approved = pr(1, "a", ok.clone());
        approved.review_decision = "APPROVED".into();
        let changes = diff_pr_sets(&old, &[approved, pr(2, "b", ok.clone())], false);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].kind, "review");
        assert!(changes[0].note.contains("APPROVED"));

        // draft flip
        let mut drafted = pr(2, "b", ok.clone());
        drafted.is_draft = true;
        let changes = diff_pr_sets(&old, &[pr(1, "a", ok.clone()), drafted], false);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].kind, "draft");
        assert!(changes[0].note.contains("draft"));
    }

    /// A ZERO-PR baseline is not the same as "never polled": the first PR
    /// opened after an empty baseline MUST report — the explicit `first_poll`
    /// flag disambiguates the empty old map (double-review MEDIUM 7).
    #[test]
    fn first_pr_after_a_zero_pr_baseline_reports_opened() {
        let ok = ChecksSummary { passing: 1, failing: 0, pending: 0, total: 1 };
        // baseline with zero PRs: silent
        assert!(diff_pr_sets(&HashMap::new(), &[], true).is_empty());
        // next poll (NOT first): a PR appeared against the empty known set
        let changes = diff_pr_sets(&HashMap::new(), &[pr(7, "first", ok)], false);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].number, 7);
        assert_eq!(changes[0].kind, "opened");
    }

    #[test]
    fn integration_gate_refuses_writes_when_off() {
        let _serial = GATE_TEST_LOCK.lock();
        set_integration(false);
        assert!(require_integration().is_err());
        // the write entry points refuse BEFORE touching gh
        assert!(pr_comment("/nonexistent", 1, "hi", None).is_err());
        assert!(pr_review("/nonexistent", 1, "approve", None, None).is_err());
        assert!(
            pr_create("/nonexistent", "t", "b", None, false, None, None).is_err()
        );
        set_integration(true);
        assert!(require_integration().is_ok());
        // input validation still guards
        assert!(pr_comment("/nonexistent", 1, "   ", None).is_err());
        assert!(pr_review("/nonexistent", 1, "merge", None, None).is_err());
        assert!(pr_review("/nonexistent", 1, "comment", None, None).is_err(), "comment review needs a body");
        set_integration(false);
    }

    /// Double-review HIGH 3: disabling drains in-flight writes — a write
    /// holding the gate delays `set_integration(false)` until it finishes,
    /// and after the ack no new write can pass.
    #[test]
    fn disable_waits_for_in_flight_writes() {
        let _serial = GATE_TEST_LOCK.lock();
        set_integration(true);
        let guard = require_integration().expect("gate must open while enabled");
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let handle = std::thread::spawn(move || {
            set_integration(false); // blocks on the held read guard
            tx.send(()).unwrap();
        });
        // the disable must NOT complete while the write guard is held
        assert!(
            rx.recv_timeout(Duration::from_millis(150)).is_err(),
            "set_integration(false) returned while a write was in flight"
        );
        drop(guard); // the write finishes → the disable drains through
        rx.recv_timeout(Duration::from_secs(5))
            .expect("set_integration(false) must complete once writes drained");
        handle.join().unwrap();
        assert!(require_integration().is_err());
    }

    #[test]
    fn capped_diff_reader_streams_and_trims_lines() {
        // bounded drain: only `cap` bytes are kept, the excess is discarded
        let big = "x".repeat(64 * 1024);
        let buf = drain_capped(Some(std::io::Cursor::new(big.into_bytes())), 1000);
        let grace = Instant::now() + Duration::from_secs(2);
        while std::sync::Arc::strong_count(&buf) > 1 && Instant::now() < grace {
            std::thread::sleep(Duration::from_millis(5));
        }
        let (bytes, clipped) = { let g = buf.lock(); (g.0.clone(), g.1) };
        assert_eq!(bytes.len(), 1000);
        assert!(clipped);
        // line trimming of a clipped diff
        let (text, truncated) = finish_capped_diff("line one\nline tw".into(), true);
        assert_eq!(text, "line one");
        assert!(truncated);
        // unclipped passes through untouched
        let (text, truncated) = finish_capped_diff("a\nb\n".into(), false);
        assert_eq!(text, "a\nb\n");
        assert!(!truncated);
    }

    /// Double-review HIGH 4: failed-push stderr is redacted before it can
    /// reach the webview / Conductor transcript.
    #[test]
    fn credential_redaction_scrubs_tokens_and_userinfo() {
        // URL userinfo (user:token@) → ***@
        let s = redact_credentials(
            "fatal: unable to access 'https://user:hunter2@github.com/o/r.git/'",
            800,
        );
        assert!(!s.contains("hunter2"), "{s}");
        assert!(s.contains("https://***@github.com/o/r.git"), "{s}");
        // GitHub token shapes
        let s = redact_credentials("remote: https://ghp_abcDEF123456789012345678@x.test failed", 800);
        assert!(!s.contains("ghp_abc"), "{s}");
        let s = redact_credentials("token github_pat_11ABCDEF0_abcdefghij was rejected", 800);
        assert!(!s.contains("github_pat_11"), "{s}");
        assert!(s.contains("[redacted]"), "{s}");
        // long opaque hex/base64 runs
        let hex = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef42";
        let s = redact_credentials(&format!("helper printed {hex} here"), 800);
        assert!(!s.contains(hex), "{s}");
        // ordinary output survives: branch names, hints, short words
        let plain = "error: failed to push some refs to 'origin'\nhint: Updates were rejected (fetch first)";
        assert_eq!(redact_credentials(plain, 800), plain);
        // the cap applies last
        let long = "e".repeat(2000);
        assert!(redact_credentials(&long, 100).chars().count() <= 101);
    }

    /// Double-review MEDIUM 5: an UNKNOWN default branch fails closed.
    #[test]
    fn lane_branch_guard_fails_closed_on_unknown_default() {
        assert!(ensure_lane_branch("feature/x", "main").is_ok());
        let err = ensure_lane_branch("main", "main").unwrap_err();
        assert!(err.contains("default branch"), "{err}");
        // missing/malformed defaultBranchRef → refuse, never fall open
        let err = ensure_lane_branch("feature/x", "").unwrap_err();
        assert!(err.contains("could not determine"), "{err}");
        assert!(ensure_lane_branch("feature/x", "  ").is_err());
    }

    /// LIVE spike (read-only): parse REAL gh output against this repo —
    /// `cd src-tauri && cargo test github_live_spike -- --ignored --nocapture`.
    /// Requires an installed, logged-in gh and the SwarmZ checkout's GitHub
    /// remote (AgentZ-Media/SwarmZ). Runs no write commands.
    #[test]
    #[ignore = "live spike — needs the codex CLI, a login and network"]
    fn github_live_spike() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_string_lossy()
            .into_owned();

        let auth = auth_status(None);
        println!("auth: {auth:?}");
        assert!(auth.installed, "gh must be installed for the live spike");
        assert!(auth.authenticated, "gh must be logged in for the live spike");
        assert!(auth.login.is_some());
        assert!(auth.version.unwrap().starts_with("gh version"));

        let repo = match repo_info(&dir, None) {
            GhOutcome::Ok(r) => r,
            other => panic!("repo_info failed: {other:?}"),
        };
        println!("repo: {repo:?}");
        assert_eq!(repo.full_name, "AgentZ-Media/SwarmZ");
        assert!(!repo.default_branch.is_empty());
        assert!(repo.url.starts_with("https://github.com/"));

        let prs = match pr_list(&dir, None) {
            GhOutcome::Ok(p) => p,
            other => panic!("pr_list failed: {other:?}"),
        };
        println!("{} open PRs", prs.len());
        for pr in &prs {
            println!(
                "  #{} {:?} by {} [{} → {}] draft={} mergeable={} review={:?} checks={:?}",
                pr.number, pr.title, pr.author, pr.head_ref, pr.base_ref,
                pr.is_draft, pr.mergeable, pr.review_decision, pr.checks
            );
            assert!(pr.number > 0);
            assert!(!pr.title.is_empty());
            assert!(pr.url.starts_with("https://github.com/"));
            // every check lands in exactly one bucket
            assert_eq!(
                pr.checks.total,
                pr.checks.passing + pr.checks.failing + pr.checks.pending
            );
        }

        if let Some(first) = prs.first() {
            let detail = match pr_view(&dir, first.number, true, None) {
                GhOutcome::Ok(d) => d,
                other => panic!("pr_view failed: {other:?}"),
            };
            println!(
                "detail #{}: {} files, +{} −{}, {} reviews, diff {} bytes (truncated {})",
                detail.pr.number,
                detail.files.len(),
                detail.additions,
                detail.deletions,
                detail.reviews.len(),
                detail.diff.as_deref().map(str::len).unwrap_or(0),
                detail.diff_truncated,
            );
            assert_eq!(detail.pr.number, first.number);
            assert!(!detail.files.is_empty());
            assert!(detail.diff.is_some(), "the live PR diff must parse");
        }
    }

    #[test]
    fn gh_bin_prefers_override_then_known_paths() {
        assert_eq!(gh_bin(Some("/custom/gh")), "/custom/gh");
        assert!(!gh_bin(Some("  ")).is_empty());
        let resolved = gh_bin(None);
        assert!(resolved.ends_with("gh"), "{resolved}");
    }
}
