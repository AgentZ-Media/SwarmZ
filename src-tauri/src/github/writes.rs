use serde::Serialize;
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

use crate::git::{git_bin, output_with_timeout};

use super::process::{
    gh_bin, redact_credentials, require_integration, retag, run_gh, GhOutcome, GH_WRITE_TIMEOUT,
};
use super::reads::repo_info;

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
pub(crate) fn ensure_lane_branch(branch: &str, default_branch: &str) -> Result<(), String> {
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

    // the branch actually checked out in the given folder (C1: through the
    // suppression builder — local read, no transports, no hooks)
    let branch_out = output_with_timeout(
        crate::git::git_command(git, Path::new(dir)).args([
            "symbolic-ref",
            "--short",
            "-q",
            "HEAD",
        ]),
        Duration::from_secs(10),
    )
    .map_err(|e| format!("git did not run: {e}"))?;
    let branch = String::from_utf8_lossy(&branch_out.stdout)
        .trim()
        .to_string();
    if branch.is_empty() {
        return Err("the folder has no checked-out branch (detached HEAD?)".into());
    }

    // never push the default branch — a PR comes from a lane branch
    let default_branch = match repo_info(dir, bin_override) {
        GhOutcome::Ok(info) => info.default_branch,
        fail => return Ok(retag(fail)),
    };
    ensure_lane_branch(&branch, &default_branch)?;

    // push the branch (plain push, NEVER --force). C1: the NET builder —
    // hooks (pre-push!) suppressed, `ext::` remotes refused, ssh pinned to
    // the stock binary; a repo config must not gain code execution through
    // the backend's one network operation.
    let push = output_with_timeout(
        crate::git::git_command_net(git_bin(git_override), Path::new(dir))
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
        other => {
            return Err(format!(
                "unknown review action {other:?} — use approve | request_changes | comment"
            ))
        }
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
