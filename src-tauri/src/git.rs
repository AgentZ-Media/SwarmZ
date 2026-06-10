//! Read-only git status for agent panes — repo, branch, ±lines, untracked,
//! remote URL. Shells out to the git binary; keep the queries and parsing in
//! sync with the web engine's `/api/git` in `server/index.mjs`.

use serde::Serialize;
use std::path::Path;
use std::process::Command;

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
fn git_bin(overridden: Option<&str>) -> &str {
    match overridden.map(str::trim) {
        Some(b) if !b.is_empty() => b,
        _ if Path::new("/usr/bin/git").exists() => "/usr/bin/git",
        _ => "git",
    }
}

fn git(bin: &str, cwd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(bin)
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
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
