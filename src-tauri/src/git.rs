//! Read-only git status for agent panes — repo, branch, ±lines, untracked,
//! remote URL. Shells out to the git binary; keep the queries and parsing in
//! sync with the web engine's `/api/git` in `server/index.mjs`.

use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

#[derive(Serialize, Clone, Debug)]
pub struct GitInfo {
    /// repo root folder name
    pub repo: String,
    /// branch name, or the short commit SHA when HEAD is detached
    pub branch: String,
    /// added lines of tracked files (working tree + index vs HEAD)
    pub insertions: u64,
    /// removed lines of tracked files (working tree + index vs HEAD)
    pub deletions: u64,
    /// files git doesn't track yet (.gitignore respected)
    pub untracked: u64,
    /// browsable https URL of the `origin` remote, if one exists
    pub remote_url: Option<String>,
}

/// Settings override wins; GUI apps on macOS launch with a minimal PATH,
/// so otherwise prefer the stock path.
pub(crate) fn git_bin(overridden: Option<&str>) -> &str {
    match overridden.map(str::trim) {
        Some(b) if !b.is_empty() => b,
        _ if Path::new("/usr/bin/git").exists() => "/usr/bin/git",
        _ => "git",
    }
}

/// `-c` overrides suppressing REPOSITORY-CONTROLLED execution — prepended to
/// every backend git invocation (audit R6/C1). The backend's own git
/// subprocesses run UNSANDBOXED while hook bodies / fsmonitor configs are
/// workspace-agent-editable content (a husky-style tracked `hooksPath` makes
/// the hook BODY a plain tracked file): without these, `git worktree add`
/// runs `post-checkout`, `git status` runs a configured `core.fsmonitor`
/// hook, `git update-ref` runs `reference-transaction` — project-controlled
/// code with host authority. Command-line `-c` wins over EVERY config scope
/// (system/global/repo), so:
///   - `core.hooksPath=/dev/null` — no hook is ever found or run (git probes
///     `<hooksPath>/<hook>`, which cannot exist under `/dev/null`),
///   - `core.fsmonitor=false` — no fsmonitor hook/daemon on status queries,
///   - `core.pager=cat` — belt and braces; stdout is piped, but a pager must
///     never be a code path.
///
/// External diff/textconv drivers are additionally disabled per-call where a
/// diff is produced (`--no-ext-diff --no-textconv` in `git_info`).
const GIT_SUPPRESSIONS: &[&str] = &[
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.pager=cat",
];

/// Build a git `Command` for the backend's LOCAL-ONLY operations (status,
/// worktree management, ref queries): repository-controlled execution is
/// suppressed (see `GIT_SUPPRESSIONS`), interactive prompts are off, and —
/// since none of these operations has any business on the network — EVERY
/// transport is refused outright (`protocol.allow=never`; a repo-configured
/// `ext::…` remote URL executes arbitrary commands when a transport touches
/// it). All backend git calls MUST go through this builder or
/// `git_command_net`; never `Command::new(git)` directly.
pub(crate) fn git_command(bin: &str, cwd: &Path) -> Command {
    let mut cmd = Command::new(bin);
    cmd.arg("-C").arg(cwd);
    cmd.args(GIT_SUPPRESSIONS);
    cmd.args(["-c", "protocol.allow=never"]);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd
}

/// Like `git_command`, for the backend's ONE network operation (`git push`
/// in github.rs): transports stay usable, but the EXECUTABLE ones are closed
/// — `ext::` remotes refuse, and ssh is pinned to the stock binary (a
/// repo-local `core.sshCommand` would otherwise run arbitrary project code
/// under the unsandboxed backend on every push). Residual (documented):
/// `credential.helper` from config still runs — suppressing it would break
/// all https auth (keychain); planting one requires writing `.git/config`,
/// which the approval classifier refuses autonomously (fileChanges touching
/// a `.git` component are destructive, and no allowlisted command writes
/// config).
pub(crate) fn git_command_net(bin: &str, cwd: &Path) -> Command {
    let mut cmd = Command::new(bin);
    cmd.arg("-C").arg(cwd);
    cmd.args(GIT_SUPPRESSIONS);
    cmd.args([
        "-c",
        "protocol.ext.allow=never",
        "-c",
        "core.sshCommand=ssh",
    ]);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd
}

/// Hard cap per drained pipe (audit R12): a pathological child spewing
/// gigabytes must not grow an unbounded buffer — the excess is read and
/// discarded (the pipe keeps draining so the child never blocks on it).
const DRAIN_CAP_BYTES: usize = 32 * 1024 * 1024;

/// `Command::output()` with a hard deadline. A repo on a disconnected
/// network volume / FUSE mount makes git hang indefinitely — without a
/// timeout one such hang wedges the 7 s status poll (and the worktree
/// scans) for the rest of the app's lifetime.
///
/// Audit R12 hardening: on unix the child gets its OWN process group
/// (`setsid`), and the timeout kill signals the WHOLE group — grandchildren
/// (hooks, credential helpers, daemons a hostile repo config spawns) die
/// with the git process instead of surviving the kill. Pipe drains are
/// BOUNDED (see `DRAIN_CAP_BYTES`).
pub(crate) fn output_with_timeout(cmd: &mut Command, timeout: Duration) -> std::io::Result<Output> {
    use parking_lot::Mutex;
    use std::sync::Arc;

    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // own session + process group → the group kill below reaches
        // every descendant
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    let mut child = cmd.spawn()?;
    #[cfg(unix)]
    let child_pid = child.id() as libc::pid_t;

    // drain the pipes on threads into shared buffers — a chatty child would
    // otherwise deadlock against a full pipe while we only poll try_wait,
    // and shared buffers let us return whatever arrived without joining
    // (a grandchild inheriting the pipe — hooks, daemons — would keep it
    // open past the child's own exit and block a join forever). Buffers are
    // capped; excess bytes are drained and dropped.
    fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> Arc<Mutex<Vec<u8>>> {
        let buf = Arc::new(Mutex::new(Vec::new()));
        if let Some(mut p) = pipe {
            let b = Arc::clone(&buf);
            std::thread::spawn(move || {
                let mut chunk = [0u8; 8192];
                loop {
                    match p.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let mut g = b.lock();
                            let room = DRAIN_CAP_BYTES.saturating_sub(g.len());
                            let take = room.min(n);
                            if take > 0 {
                                g.extend_from_slice(&chunk[..take]);
                            }
                            // beyond the cap: keep reading, drop the excess
                        }
                    }
                }
            });
        }
        buf
    }
    let out_buf = drain(child.stdout.take());
    let err_buf = drain(child.stderr.take());

    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            // grace period for the readers to hit EOF (strong_count == 1
            // means the drain thread finished and dropped its clone)
            let grace = Instant::now() + Duration::from_secs(2);
            while (Arc::strong_count(&out_buf) > 1 || Arc::strong_count(&err_buf) > 1)
                && Instant::now() < grace
            {
                std::thread::sleep(Duration::from_millis(10));
            }
            let stdout = std::mem::take(&mut *out_buf.lock());
            let stderr = std::mem::take(&mut *err_buf.lock());
            return Ok(Output {
                status,
                stdout,
                stderr,
            });
        }
        if Instant::now() >= deadline {
            // kill the WHOLE process group first (unix), then the child
            #[cfg(unix)]
            unsafe {
                libc::kill(-child_pid, libc::SIGKILL);
            }
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "git timed out",
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// Deadline for the quick read-only status queries below.
const GIT_TIMEOUT: Duration = Duration::from_secs(10);

fn git(bin: &str, cwd: &str, args: &[&str]) -> Option<String> {
    let out = output_with_timeout(git_command(bin, Path::new(cwd)).args(args), GIT_TIMEOUT).ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// `git@host:user/repo.git` / `ssh://git@host/user/repo.git` → browsable https URL.
/// Audit R9: userinfo (`https://user:TOKEN@github.com/…` — PATs live there),
/// query strings and fragments are STRIPPED before the URL crosses the Rust
/// boundary — the frontend renders/link-ifies this value.
fn to_https(remote: &str) -> Option<String> {
    let r = remote.trim();
    let url = if let Some(rest) = r.strip_prefix("git@") {
        let (host, path) = rest.split_once(':')?;
        format!("https://{}/{}", host, path)
    } else if let Some(rest) = r.strip_prefix("ssh://") {
        format!("https://{}", rest.strip_prefix("git@").unwrap_or(rest))
    } else if r.starts_with("http://") || r.starts_with("https://") {
        r.to_string()
    } else {
        return None;
    };
    // strip query + fragment, then credentials in the authority
    let url = url.split(['?', '#']).next().unwrap_or(&url);
    let url = match url.split_once("://") {
        Some((scheme, rest)) => {
            let authority_end = rest.find('/').unwrap_or(rest.len());
            let (authority, path) = rest.split_at(authority_end);
            // drop everything up to the LAST '@' in the authority (userinfo)
            let host = authority.rsplit('@').next().unwrap_or(authority);
            format!("{scheme}://{host}{path}")
        }
        None => url.to_string(),
    };
    Some(
        url.trim_end_matches('/')
            .trim_end_matches(".git")
            .to_string(),
    )
}

pub fn git_info(cwd: &str, bin_override: Option<&str>) -> Option<GitInfo> {
    let bin = git_bin(bin_override);
    let toplevel = git(bin, cwd, &["rev-parse", "--show-toplevel"])?;
    let repo = Path::new(&toplevel)
        .file_name()?
        .to_string_lossy()
        .into_owned();

    let branch = match git(bin, cwd, &["symbolic-ref", "--short", "-q", "HEAD"]) {
        Some(b) if !b.is_empty() => b,
        // detached HEAD → short SHA; unborn branch (fresh repo) has neither
        _ => git(bin, cwd, &["rev-parse", "--short", "HEAD"])
            .unwrap_or_else(|| "(no commits)".to_string()),
    };

    // staged + unstaged line counts vs HEAD; fails on a repo without commits
    // → 0/0. `--no-ext-diff --no-textconv` (C1): a repo-configured external
    // diff/textconv driver must never execute during the backend's poll.
    let (mut insertions, mut deletions) = (0u64, 0u64);
    if let Some(numstat) = git(
        bin,
        cwd,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--numstat",
            "HEAD",
        ],
    ) {
        for line in numstat.lines() {
            let mut cols = line.split('\t');
            // binary files report "-" in both columns → count as 0
            insertions += cols.next().and_then(|c| c.parse().ok()).unwrap_or(0);
            deletions += cols.next().and_then(|c| c.parse().ok()).unwrap_or(0);
        }
    }

    let untracked = git(bin, cwd, &["ls-files", "--others", "--exclude-standard"])
        .map(|s| s.lines().filter(|l| !l.is_empty()).count() as u64)
        .unwrap_or(0);

    let remote_url = git(bin, cwd, &["remote", "get-url", "origin"])
        .as_deref()
        .and_then(to_https);

    Some(GitInfo {
        repo,
        branch,
        insertions,
        deletions,
        untracked,
        remote_url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Audit R9 (frozen): credentials in the origin URL never cross the Rust
    /// boundary — userinfo, query and fragment are stripped.
    #[test]
    fn remote_urls_are_normalized_and_credentials_redacted() {
        // the classic PAT-in-URL shapes
        assert_eq!(
            to_https("https://user:ghp_SECRET123@github.com/org/repo.git").as_deref(),
            Some("https://github.com/org/repo")
        );
        assert_eq!(
            to_https("https://x-access-token:TOKEN@github.com/org/repo").as_deref(),
            Some("https://github.com/org/repo")
        );
        assert_eq!(
            to_https("http://user@host.example/repo.git").as_deref(),
            Some("http://host.example/repo")
        );
        // query/fragment smuggling
        assert_eq!(
            to_https("https://github.com/org/repo.git?token=SECRET#frag").as_deref(),
            Some("https://github.com/org/repo")
        );
        // ssh forms keep working
        assert_eq!(
            to_https("git@github.com:org/repo.git").as_deref(),
            Some("https://github.com/org/repo")
        );
        assert_eq!(
            to_https("ssh://git@github.com/org/repo.git").as_deref(),
            Some("https://github.com/org/repo")
        );
        // plain https unchanged, non-URLs rejected
        assert_eq!(
            to_https("https://github.com/org/repo").as_deref(),
            Some("https://github.com/org/repo")
        );
        assert!(to_https("/local/bare/repo.git").is_none());
        // nothing secret-shaped survives in any output
        for input in [
            "https://user:ghp_SECRET123@github.com/org/repo.git",
            "https://github.com/org/repo?access_token=SECRET",
        ] {
            let out = to_https(input).unwrap();
            assert!(!out.contains("SECRET"), "{input} → {out}");
        }
    }
}
