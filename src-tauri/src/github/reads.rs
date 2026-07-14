use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use super::process::{gh_bin, retag, run_gh, GhOutcome, GH_TIMEOUT};

/// Whole-diff byte cap for `pr_view`.
const DIFF_BYTE_CAP: usize = 512 * 1024;
/// Character cap for GitHub-authored issue and PR bodies.
pub(crate) const BODY_CHAR_CAP: usize = 4_000;
/// Maximum accepted bytes from `gh issue list`.
pub(crate) const ISSUE_JSON_BYTE_CAP: usize = 8 * 1024 * 1024;

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
    match run_gh(
        &bin,
        None,
        &["auth", "status", "--json", "hosts"],
        GH_TIMEOUT,
    ) {
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
                login: acc.get("login").and_then(Value::as_str).map(str::to_string),
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
        let workflow = e.get("workflowName").and_then(Value::as_str).unwrap_or("");
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

/// One GitHub issue available for read-only mission intake.
#[derive(Debug, Clone, Serialize)]
pub struct GhIssue {
    pub number: u64,
    pub title: String,
    pub body: String,
    pub labels: Vec<String>,
    /// "OPEN" | "CLOSED"
    pub state: String,
    pub url: String,
}

const ISSUE_LIST_FIELDS: &str = "number,title,body,labels,state,url";
pub(crate) const ISSUE_LIST_MAX: usize = 500;

/// Parse and bound GitHub-authored data before it crosses into the webview.
/// Malformed records are skipped rather than partially invented.
fn parse_issue(v: &Value) -> Option<GhIssue> {
    let number = v.get("number")?.as_u64()?;
    if number == 0 {
        return None;
    }
    let title = v.get("title")?.as_str()?.trim();
    if title.is_empty() {
        return None;
    }
    let state = match v.get("state")?.as_str()?.to_ascii_uppercase().as_str() {
        "OPEN" => "OPEN",
        "CLOSED" => "CLOSED",
        _ => return None,
    };
    let mut seen_labels = HashSet::new();
    let labels = v
        .get("labels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|label| label.get("name").and_then(Value::as_str))
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| cap_chars(name, 80))
        .filter(|name| seen_labels.insert(name.clone()))
        .take(30)
        .collect();

    Some(GhIssue {
        number,
        title: cap_chars(title, 300),
        body: cap_chars(
            v.get("body").and_then(Value::as_str).unwrap_or("").trim(),
            BODY_CHAR_CAP,
        ),
        labels,
        state: state.to_string(),
        url: cap_chars(
            v.get("url").and_then(Value::as_str).unwrap_or("").trim(),
            2_000,
        ),
    })
}

/// Up to 500 open and closed issues of the repo behind `dir`.
/// This is an unconditional READ operation over the user's local `gh` CLI;
/// it never enables or crosses the GitHub write gate.
pub fn issue_list(dir: &str, bin_override: Option<&str>) -> GhOutcome<Vec<GhIssue>> {
    let bin = gh_bin(bin_override);
    let stdout = match run_gh(
        &bin,
        Some(dir),
        &[
            "issue",
            "list",
            "--state",
            "all",
            "--limit",
            "500",
            "--json",
            ISSUE_LIST_FIELDS,
        ],
        GH_TIMEOUT,
    ) {
        Ok(s) => s,
        Err(fail) => return retag(fail),
    };
    parse_issue_list_output(&stdout)
}

pub(crate) fn parse_issue_list_output(stdout: &str) -> GhOutcome<Vec<GhIssue>> {
    if stdout.len() > ISSUE_JSON_BYTE_CAP {
        return GhOutcome::Error("gh issue list output exceeded the 8 MiB safety limit".into());
    }
    match serde_json::from_str::<Value>(stdout) {
        Ok(Value::Array(items)) => GhOutcome::Ok(
            items
                .iter()
                .filter_map(parse_issue)
                .take(ISSUE_LIST_MAX)
                .collect(),
        ),
        Ok(_) => GhOutcome::Error("unexpected gh issue list shape".into()),
        Err(e) => GhOutcome::Error(format!("unparseable gh issue list output: {e}")),
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
pub(crate) fn drain_capped<R: std::io::Read + Send + 'static>(
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
pub(crate) fn finish_capped_diff(raw: String, clipped: bool) -> (String, bool) {
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
    gh_diff_capped_with_timeout(bin, dir, n, cap, GH_TIMEOUT)
}

pub(crate) fn gh_diff_capped_with_timeout(
    bin: &str,
    dir: &str,
    n: &str,
    cap: usize,
    timeout: Duration,
) -> Option<(String, bool)> {
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
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        // Match `output_with_timeout`: isolate gh and every helper it may
        // spawn, so a timeout cannot leave descendants holding pipes or
        // network activity after the parent is killed.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
    }
    let mut child = cmd.spawn().ok()?;
    #[cfg(unix)]
    let child_pid = child.id() as libc::pid_t;
    let out_buf = drain_capped(child.stdout.take(), cap);
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    #[cfg(unix)]
                    unsafe {
                        libc::killpg(child_pid, libc::SIGKILL);
                    }
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => {
                #[cfg(unix)]
                unsafe {
                    libc::killpg(child_pid, libc::SIGKILL);
                }
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
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
