use once_cell::sync::Lazy;
use parking_lot::{RwLock, RwLockReadGuard};
use serde::Serialize;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::git::output_with_timeout;

/// Deadline for read-only `gh` API queries.
pub(crate) const GH_TIMEOUT: Duration = Duration::from_secs(30);
/// Deadline for write operations, including a branch push.
pub(crate) const GH_WRITE_TIMEOUT: Duration = Duration::from_secs(120);

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

/// The AUTONOMOUS-writes opt-in, mirrored from Settings
/// (`github_set_autonomous_writes`) — final hardening F2. FAIL-CLOSED
/// default: even with the integration master toggle ON, agent-run gh WRITE
/// approvals (`gh pr comment`/`gh pr review`) classify destructive and the
/// Conductor's strict `decide_approval` path refuses them until the user
/// explicitly opts in to autonomous GitHub writes. A prompt-injected agent
/// can therefore never get a PR approved/commented autonomously while the
/// opt-in is off — the human decides.
static AUTONOMOUS_GH_WRITES: AtomicBool = AtomicBool::new(false);

/// Sync the autonomous-writes opt-in (plain atomic — the strict approval
/// path re-reads it LIVE at respond time, so a flip applies immediately).
pub fn set_autonomous_writes(enabled: bool) {
    AUTONOMOUS_GH_WRITES.store(enabled, Ordering::SeqCst);
}

pub fn autonomous_gh_writes() -> bool {
    AUTONOMOUS_GH_WRITES.load(Ordering::SeqCst)
}

/// The Rust-side gate for AGENT-run gh writes (classification + the strict
/// Conductor respond path): master toggle AND autonomous opt-in — both must
/// be on for a gh write approval to be routine-decidable by the Conductor.
pub fn agent_gh_writes_allowed() -> bool {
    integration_enabled() && autonomous_gh_writes()
}

/// In-flight gh/git WRITE ops (pr_create/comment/review) — a `git push` or a
/// PR mutation mid-flight. The quit guard reads this so quitting mid-write
/// warns instead of killing a push (`gh_writes` in the QuitConfirm dialog).
static WRITES_IN_FLIGHT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Number of gh write ops currently running (for the quit guard).
pub fn writes_in_flight() -> usize {
    WRITES_IN_FLIGHT.load(Ordering::SeqCst)
}

/// The guard a write op holds for its whole duration: the WRITE_GATE read lock
/// (draining a disable) PLUS the in-flight counter (the quit guard). Both
/// release together on drop.
pub(crate) struct WriteGuard {
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
pub(crate) fn require_integration() -> Result<WriteGuard, String> {
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
pub(crate) fn classify_gh_stderr<T>(stderr: &str) -> GhOutcome<T> {
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
pub(crate) fn run_gh(
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
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(GhOutcome::NotInstalled),
        Err(e) => return Err(GhOutcome::Error(format!("gh did not run: {e}"))),
    };
    if !out.status.success() {
        return Err(classify_gh_stderr(&String::from_utf8_lossy(&out.stderr)));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Re-tag a `GhOutcome` failure to the caller's payload type.
pub(crate) fn retag<S, T>(o: GhOutcome<S>) -> GhOutcome<T> {
    match o {
        GhOutcome::Ok(_) => GhOutcome::Error("unreachable".into()),
        GhOutcome::NotInstalled => GhOutcome::NotInstalled,
        GhOutcome::NotAuthenticated => GhOutcome::NotAuthenticated,
        GhOutcome::NoRemote => GhOutcome::NoRemote,
        GhOutcome::Error(e) => GhOutcome::Error(e),
    }
}
