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

/// `Command::output()` with a hard deadline. A repo on a disconnected
/// network volume / FUSE mount makes git hang indefinitely — without a
/// timeout one such hang wedges the 7 s status poll (and the worktree
/// scans) for the rest of the app's lifetime.
pub(crate) fn output_with_timeout(cmd: &mut Command, timeout: Duration) -> std::io::Result<Output> {
    use parking_lot::Mutex;
    use std::sync::Arc;

    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn()?;

    // drain the pipes on threads into shared buffers — a chatty child would
    // otherwise deadlock against a full pipe while we only poll try_wait,
    // and shared buffers let us return whatever arrived without joining
    // (a grandchild inheriting the pipe — hooks, daemons — would keep it
    // open past the child's own exit and block a join forever)
    fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> Arc<Mutex<Vec<u8>>> {
        let buf = Arc::new(Mutex::new(Vec::new()));
        if let Some(mut p) = pipe {
            let b = Arc::clone(&buf);
            std::thread::spawn(move || {
                let mut chunk = [0u8; 8192];
                loop {
                    match p.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => b.lock().extend_from_slice(&chunk[..n]),
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
    let out = output_with_timeout(
        Command::new(bin).arg("-C").arg(cwd).args(args),
        GIT_TIMEOUT,
    )
    .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// `git@host:user/repo.git` / `ssh://git@host/user/repo.git` → browsable https URL.
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
    Some(url.trim_end_matches('/').trim_end_matches(".git").to_string())
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

    // staged + unstaged line counts vs HEAD; fails on a repo without commits → 0/0
    let (mut insertions, mut deletions) = (0u64, 0u64);
    if let Some(numstat) = git(bin, cwd, &["diff", "--numstat", "HEAD"]) {
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
