//! Independent, read-only evidence for a Mission task attempt.
//!
//! Worker JSON is an assertion. This module observes the actual checkout
//! through the hardened backend git path and hashes canonical diff bytes so a
//! successful report can be bound to a real commit before it settles.

use crate::git::{git_bin, git_command, output_with_timeout, DRAIN_CAP_BYTES};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(20);
const MAX_FILES: usize = 2_000;

#[derive(Debug, Clone, Serialize)]
pub struct MissionGitEvidence {
    pub base_sha: String,
    pub head_sha: String,
    pub diff_sha256: String,
    pub files_changed: Vec<String>,
    pub dirty: bool,
}

fn valid_sha(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn run(cwd: &Path, bin: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    let mut command = git_command(bin, cwd);
    command.args(args);
    let output = output_with_timeout(&mut command, TIMEOUT)
        .map_err(|error| format!("git evidence failed: {error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git evidence command failed: {}", detail.trim()));
    }
    Ok(output.stdout)
}

fn line(bytes: Vec<u8>, label: &str) -> Result<String, String> {
    let value = String::from_utf8(bytes)
        .map_err(|_| format!("{label} is not UTF-8"))?
        .trim()
        .to_owned();
    if !valid_sha(&value) {
        return Err(format!("{label} is not a commit SHA"));
    }
    Ok(value.to_ascii_lowercase())
}

pub fn collect(
    cwd: &str,
    base_sha: Option<&str>,
    overridden_bin: Option<&str>,
) -> Result<MissionGitEvidence, String> {
    let cwd = Path::new(cwd);
    if !cwd.is_absolute() {
        return Err("mission evidence cwd must be absolute".into());
    }
    let bin = git_bin(overridden_bin);
    let head = line(run(cwd, bin, &["rev-parse", "HEAD"])?, "HEAD")?;
    let base = match base_sha.map(str::trim) {
        Some(value) => {
            if !valid_sha(value) {
                return Err("base SHA is invalid".into());
            }
            let object = format!("{value}^{{commit}}");
            run(cwd, bin, &["cat-file", "-e", &object])?;
            value.to_ascii_lowercase()
        }
        None => head.clone(),
    };
    let range = format!("{base}..{head}");
    let names = run(
        cwd,
        bin,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--name-only",
            "-z",
            &range,
        ],
    )?;
    let mut files = names
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            String::from_utf8(entry.to_vec()).map_err(|_| "changed path is not UTF-8".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    if files.len() > MAX_FILES {
        return Err(format!("mission diff changes more than {MAX_FILES} files"));
    }
    files.sort();
    files.dedup();

    let diff = run(
        cwd,
        bin,
        &["diff", "--no-ext-diff", "--no-textconv", "--binary", &range],
    )?;
    if diff.len() >= DRAIN_CAP_BYTES {
        return Err("mission diff exceeds the independent evidence limit".into());
    }
    let diff_sha = format!("{:x}", Sha256::digest(&diff));
    let dirty = !run(
        cwd,
        bin,
        &["status", "--porcelain=v1", "--untracked-files=normal"],
    )?
    .is_empty();

    Ok(MissionGitEvidence {
        base_sha: base,
        head_sha: head,
        diff_sha256: diff_sha,
        files_changed: files,
        dirty,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_commit_ids() {
        assert!(valid_sha(&"a".repeat(40)));
        assert!(valid_sha(&"F".repeat(64)));
        assert!(!valid_sha("HEAD"));
        assert!(!valid_sha(&"g".repeat(40)));
    }
}
