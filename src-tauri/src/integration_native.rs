//! Hardened native execution boundary for the Integration Train and its
//! human-approved Acceptance Runner.
//!
//! Git writes are deliberately limited to registered SwarmZ worktrees below
//! `<main-repo>/.worktrees/`. Every mutation is compare-and-swap-like: the
//! caller supplies the complete expected HEAD and branch, and the backend
//! verifies both again immediately before writing. All git processes use the
//! shared local-only command builder (hooks/fsmonitor/transports disabled).

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const GIT_TIMEOUT: Duration = Duration::from_secs(120);
const ACCEPTANCE_DEFAULT_TIMEOUT_MS: u64 = 120_000;
const ACCEPTANCE_MIN_TIMEOUT_MS: u64 = 100;
const ACCEPTANCE_MAX_TIMEOUT_MS: u64 = 15 * 60 * 1_000;
const ACCEPTANCE_OUTPUT_CAP: usize = 1024 * 1024;
const ACCEPTANCE_MAX_ARGS: usize = 128;
const ACCEPTANCE_MAX_ARG_BYTES: usize = 4 * 1024;
const ACCEPTANCE_MAX_ARGV_BYTES: usize = 32 * 1024;
const ACCEPTANCE_MAX_ENV: usize = 32;
const ACCEPTANCE_MAX_ENV_VALUE_BYTES: usize = 4 * 1024;
const ACCEPTANCE_MAX_ENV_BYTES: usize = 16 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IntegrationStrategy {
    CherryPick,
    Merge,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationApplyRequest {
    pub root: String,
    pub worktree_path: String,
    pub integration_branch: String,
    pub expected_head: String,
    pub commit: String,
    pub strategy: IntegrationStrategy,
    pub git_bin: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IntegrationApplyStatus {
    Applied,
    AlreadyApplied,
    Blocked,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationApplyResult {
    pub status: IntegrationApplyStatus,
    pub strategy: IntegrationStrategy,
    pub commit: String,
    pub head_before: String,
    pub head_after: String,
    pub conflict_files: Vec<String>,
    pub checkout_restored: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationRollbackRequest {
    pub root: String,
    pub worktree_path: String,
    pub integration_branch: String,
    pub expected_head: String,
    pub checkpoint_sha: String,
    /// Durable approval/evidence identifier created by the human-facing
    /// controller. Required here so destructive calls cannot be anonymous.
    pub approval_id: String,
    pub git_bin: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationRollbackResult {
    pub head_before: String,
    pub head_after: String,
    pub checkpoint_sha: String,
    pub approval_id: String,
    pub reflog_head: String,
    pub reflog_subject: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptanceCommandRequest {
    pub run_id: String,
    pub approval_id: String,
    pub cwd: String,
    pub approved_roots: Vec<String>,
    pub argv: Vec<String>,
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AcceptanceCommandStatus {
    Completed,
    TimedOut,
    Cancelled,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptanceCommandResult {
    pub run_id: String,
    pub status: AcceptanceCommandStatus,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

struct ManagedWorktree {
    path: PathBuf,
    branch: String,
}

fn git_output(bin: &str, cwd: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    crate::git::output_with_timeout(crate::git::git_command(bin, cwd).args(args), GIT_TIMEOUT)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::TimedOut {
                "git operation timed out".to_string()
            } else {
                format!("could not run git: {error}")
            }
        })
}

fn git_ok(bin: &str, cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = git_output(bin, cwd, args)?;
    if !output.status.success() {
        // Do not surface repository-controlled stderr here. Config, refs and
        // filenames can contain credentials; the UI gets a stable error and
        // conflict paths are collected through a separate bounded command.
        return Err(format!(
            "git {} failed (exit {})",
            args.first().copied().unwrap_or("operation"),
            output.status.code().unwrap_or(-1)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn full_sha(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim().to_ascii_lowercase();
    if !matches!(value.len(), 40 | 64) || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!(
            "refused: {label} must be a complete 40- or 64-character commit SHA"
        ));
    }
    Ok(value)
}

fn checked_id(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
    {
        return Err(format!("refused: invalid {label}"));
    }
    Ok(value.to_string())
}

fn resolve_exact_commit(bin: &str, cwd: &Path, value: &str, label: &str) -> Result<String, String> {
    let expected = full_sha(value, label)?;
    let expression = format!("{expected}^{{commit}}");
    let resolved = git_ok(bin, cwd, &["rev-parse", "--verify", &expression])?
        .trim()
        .to_ascii_lowercase();
    if resolved != expected {
        return Err(format!("refused: {label} does not resolve exactly"));
    }
    Ok(expected)
}

fn parse_registered_worktree(porcelain: &str, wanted: &Path) -> Option<(PathBuf, Option<String>)> {
    for block in porcelain.split("\n\n") {
        let mut path = None;
        let mut branch = None;
        let mut prunable = false;
        for line in block.lines() {
            if let Some(value) = line.strip_prefix("worktree ") {
                path = fs::canonicalize(value).ok();
            } else if let Some(value) = line.strip_prefix("branch ") {
                branch = Some(
                    value
                        .strip_prefix("refs/heads/")
                        .unwrap_or(value)
                        .to_string(),
                );
            } else if line.starts_with("prunable") {
                prunable = true;
            }
        }
        if !prunable && path.as_deref() == Some(wanted) {
            return path.map(|path| (path, branch));
        }
    }
    None
}

fn managed_worktree(
    root: &str,
    worktree_path: &str,
    expected_branch: &str,
    bin: &str,
) -> Result<ManagedWorktree, String> {
    let root = fs::canonicalize(root.trim())
        .map_err(|_| "refused: project root does not exist".to_string())?;
    let worktree = fs::canonicalize(worktree_path.trim())
        .map_err(|_| "refused: integration worktree does not exist".to_string())?;
    let container = root.join(".worktrees");
    let container_metadata = fs::symlink_metadata(&container)
        .map_err(|_| "refused: this repository has no managed .worktrees folder".to_string())?;
    if container_metadata.file_type().is_symlink() || !container_metadata.is_dir() {
        return Err("refused: the managed .worktrees folder is not a real directory".into());
    }
    if !crate::fsx::path_strictly_within(&container.to_string_lossy(), &worktree.to_string_lossy())
    {
        return Err(
            "refused: integration checkout is not inside this repo's .worktrees folder".into(),
        );
    }

    let common = PathBuf::from(git_ok(
        bin,
        &worktree,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?);
    let common = fs::canonicalize(common)
        .map_err(|_| "refused: invalid git common directory".to_string())?;
    let expected_common = fs::canonicalize(root.join(".git"))
        .map_err(|_| "refused: project root is not a regular git repository".to_string())?;
    if common != expected_common {
        return Err("refused: worktree belongs to a different repository".into());
    }

    let porcelain = git_ok(bin, &root, &["worktree", "list", "--porcelain"])?;
    let Some((path, branch)) = parse_registered_worktree(&porcelain, &worktree) else {
        return Err("refused: checkout is not a live git-registered worktree".into());
    };
    let branch = branch.ok_or_else(|| "refused: integration worktree is detached".to_string())?;
    if !branch.starts_with("swarmz/integration/") {
        return Err("refused: checkout is not a SwarmZ integration branch".into());
    }
    if expected_branch.trim().is_empty() || branch != expected_branch.trim() {
        return Err("refused: integration branch mismatch".into());
    }
    Ok(ManagedWorktree { path, branch })
}

fn current_head(bin: &str, cwd: &Path) -> Result<String, String> {
    full_sha(&git_ok(bin, cwd, &["rev-parse", "HEAD"])?, "current HEAD")
}

fn require_expected_head(bin: &str, cwd: &Path, expected: &str) -> Result<String, String> {
    let expected = resolve_exact_commit(bin, cwd, expected, "expected HEAD")?;
    if current_head(bin, cwd)? != expected {
        return Err("refused: integration HEAD changed since this operation was planned".into());
    }
    Ok(expected)
}

fn status_porcelain(bin: &str, cwd: &Path) -> Result<String, String> {
    git_ok(
        bin,
        cwd,
        &[
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "--no-renames",
        ],
    )
}

fn is_ancestor(bin: &str, cwd: &Path, ancestor: &str, descendant: &str) -> Result<bool, String> {
    let output = git_output(
        bin,
        cwd,
        &["merge-base", "--is-ancestor", ancestor, descendant],
    )?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err("git merge-base failed".into()),
    }
}

fn patch_already_applied(bin: &str, cwd: &Path, commit: &str) -> Result<bool, String> {
    // Cherry-pick creates a different object id, so ancestry alone cannot
    // identify a replay. `git cherry` compares stable patch ids and reports
    // `- <sha>` when an equivalent patch is already reachable from HEAD.
    let output = git_ok(bin, cwd, &["cherry", "HEAD", commit])?;
    Ok(output
        .lines()
        .any(|line| line.strip_prefix("- ").is_some_and(|sha| sha == commit)))
}

fn conflict_files(bin: &str, cwd: &Path) -> Vec<String> {
    git_ok(
        bin,
        cwd,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--name-only",
            "--diff-filter=U",
        ],
    )
    .unwrap_or_default()
    .lines()
    .take(200)
    .filter_map(|line| {
        let clean: String = line
            .chars()
            .filter(|character| !character.is_control())
            .take(512)
            .collect();
        (!clean.is_empty()).then_some(clean)
    })
    .collect()
}

pub fn integration_apply(
    request: IntegrationApplyRequest,
) -> Result<IntegrationApplyResult, String> {
    let bin = crate::git::git_bin(request.git_bin.as_deref());
    let worktree = managed_worktree(
        &request.root,
        &request.worktree_path,
        &request.integration_branch,
        bin,
    )?;
    // Retain the branch proof in the same validated object. This also makes
    // accidental weakening of managed_worktree visible to the compiler.
    if worktree.branch != request.integration_branch.trim() {
        return Err("refused: integration branch changed".into());
    }
    let head_before = require_expected_head(bin, &worktree.path, &request.expected_head)?;
    let commit = resolve_exact_commit(bin, &worktree.path, &request.commit, "source commit")?;
    if !status_porcelain(bin, &worktree.path)?.is_empty() {
        return Err("refused: integration worktree is not clean".into());
    }
    if is_ancestor(bin, &worktree.path, &commit, &head_before)?
        || (request.strategy == IntegrationStrategy::CherryPick
            && patch_already_applied(bin, &worktree.path, &commit)?)
    {
        return Ok(IntegrationApplyResult {
            status: IntegrationApplyStatus::AlreadyApplied,
            strategy: request.strategy,
            commit,
            head_before: head_before.clone(),
            head_after: head_before,
            conflict_files: Vec::new(),
            checkout_restored: true,
        });
    }

    let args: &[&str] = match request.strategy {
        IntegrationStrategy::CherryPick => &["cherry-pick", &commit],
        IntegrationStrategy::Merge => &["merge", "--no-edit", "--no-ff", &commit],
    };
    let output = git_output(bin, &worktree.path, args)?;
    if output.status.success() {
        let head_after = current_head(bin, &worktree.path)?;
        if head_after == head_before || !status_porcelain(bin, &worktree.path)?.is_empty() {
            return Err("integration operation did not leave a clean new HEAD".into());
        }
        return Ok(IntegrationApplyResult {
            status: IntegrationApplyStatus::Applied,
            strategy: request.strategy,
            commit,
            head_before,
            head_after,
            conflict_files: Vec::new(),
            checkout_restored: true,
        });
    }

    let conflicts = conflict_files(bin, &worktree.path);
    // Every unsuccessful operation is aborted, including empty/redundant
    // cherry-picks that have no unmerged paths. That keeps an error from
    // stranding CHERRY_PICK_HEAD/MERGE_HEAD behind an apparently clean tree.
    let abort = match request.strategy {
        IntegrationStrategy::CherryPick => git_ok(bin, &worktree.path, &["cherry-pick", "--abort"]),
        IntegrationStrategy::Merge => git_ok(bin, &worktree.path, &["merge", "--abort"]),
    };
    let checkout_restored = abort.is_ok()
        && current_head(bin, &worktree.path).ok().as_deref() == Some(head_before.as_str())
        && status_porcelain(bin, &worktree.path).ok().as_deref() == Some("");
    if conflicts.is_empty() {
        return Err(if checkout_restored {
            format!(
                "git integration operation failed (exit {})",
                output.status.code().unwrap_or(-1)
            )
        } else {
            "git integration operation failed and its incomplete state could not be restored".into()
        });
    }
    // A blocked train must be safely retryable. The abort above uses no
    // force, then proves the exact pre-operation state was restored. If an
    // abort itself fails, the result advertises that loudly and every later
    // apply refuses on the dirty precondition.
    Ok(IntegrationApplyResult {
        status: IntegrationApplyStatus::Blocked,
        strategy: request.strategy,
        commit,
        head_before: head_before.clone(),
        head_after: current_head(bin, &worktree.path).unwrap_or(head_before),
        conflict_files: conflicts,
        checkout_restored,
    })
}

pub fn integration_rollback(
    request: IntegrationRollbackRequest,
) -> Result<IntegrationRollbackResult, String> {
    let approval_id = checked_id(&request.approval_id, "approval id")?;
    let bin = crate::git::git_bin(request.git_bin.as_deref());
    let worktree = managed_worktree(
        &request.root,
        &request.worktree_path,
        &request.integration_branch,
        bin,
    )?;
    let head_before = require_expected_head(bin, &worktree.path, &request.expected_head)?;
    let checkpoint = resolve_exact_commit(
        bin,
        &worktree.path,
        &request.checkpoint_sha,
        "checkpoint SHA",
    )?;
    if !is_ancestor(bin, &worktree.path, &checkpoint, &head_before)? {
        return Err(
            "refused: checkpoint is not an ancestor of the current integration HEAD".into(),
        );
    }
    // `reset --hard` intentionally handles tracked conflict residue, but it
    // cannot remove untracked files. Refuse those so rollback never silently
    // leaves an impure checkout or needs `git clean`.
    if status_porcelain(bin, &worktree.path)?
        .lines()
        .any(|line| line.starts_with("??"))
    {
        return Err("refused: rollback checkout contains untracked files".into());
    }

    let mut command = crate::git::git_command(bin, &worktree.path);
    command
        .env(
            "GIT_REFLOG_ACTION",
            format!("SwarmZ integration rollback {approval_id}"),
        )
        .args(["reset", "--hard", &checkpoint]);
    let output = crate::git::output_with_timeout(&mut command, GIT_TIMEOUT)
        .map_err(|error| format!("rollback failed: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "git rollback failed (exit {})",
            output.status.code().unwrap_or(-1)
        ));
    }
    let head_after = current_head(bin, &worktree.path)?;
    if head_after != checkpoint || !status_porcelain(bin, &worktree.path)?.is_empty() {
        return Err("rollback did not restore the approved clean checkpoint".into());
    }
    let reflog = git_ok(bin, &worktree.path, &["reflog", "-1", "--format=%H%x00%gs"])?;
    let (reflog_head, reflog_subject) = reflog
        .split_once('\0')
        .map(|(head, subject)| (head.to_string(), subject.to_string()))
        .unwrap_or_else(|| (head_after.clone(), "SwarmZ integration rollback".into()));
    Ok(IntegrationRollbackResult {
        head_before,
        head_after,
        checkpoint_sha: checkpoint,
        approval_id,
        reflog_head,
        reflog_subject: reflog_subject.chars().take(240).collect(),
    })
}

struct Capture {
    bytes: Vec<u8>,
    truncated: bool,
}

fn drain_bounded<R: Read + Send + 'static>(pipe: Option<R>) -> Arc<Mutex<Capture>> {
    let capture = Arc::new(Mutex::new(Capture {
        bytes: Vec::new(),
        truncated: false,
    }));
    if let Some(mut pipe) = pipe {
        let shared = Arc::clone(&capture);
        std::thread::spawn(move || {
            let mut chunk = [0_u8; 8192];
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        let mut capture = shared.lock();
                        let remaining = ACCEPTANCE_OUTPUT_CAP.saturating_sub(capture.bytes.len());
                        let take = remaining.min(read);
                        capture.bytes.extend_from_slice(&chunk[..take]);
                        capture.truncated |= take < read;
                    }
                }
            }
        });
    }
    capture
}

fn scrub_output(bytes: Vec<u8>) -> String {
    let text = String::from_utf8_lossy(&bytes);
    let mut scrubbed = text
        .lines()
        .map(|line| {
            let uppercase = line.to_ascii_uppercase();
            if [
                "TOKEN=",
                "TOKEN:",
                "SECRET=",
                "SECRET:",
                "PASSWORD=",
                "PASSWORD:",
                "API_KEY=",
                "API_KEY:",
                "PRIVATE_KEY=",
                "PRIVATE_KEY:",
            ]
            .iter()
            .any(|marker| uppercase.contains(marker))
            {
                "[redacted sensitive output]".to_string()
            } else {
                line.chars()
                    .filter(|character| *character == '\t' || !character.is_control())
                    .collect()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    if scrubbed.len() > ACCEPTANCE_OUTPUT_CAP {
        let mut end = ACCEPTANCE_OUTPUT_CAP;
        while end > 0 && !scrubbed.is_char_boundary(end) {
            end -= 1;
        }
        scrubbed.truncate(end);
    }
    scrubbed
}

fn kill_process_group(child: &mut std::process::Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn validate_acceptance(
    request: &AcceptanceCommandRequest,
) -> Result<(PathBuf, PathBuf, u64), String> {
    checked_id(&request.run_id, "run id")?;
    checked_id(&request.approval_id, "approval id")?;
    if request.argv.is_empty() || request.argv.len() > ACCEPTANCE_MAX_ARGS {
        return Err("refused: acceptance argv must contain 1-128 entries".into());
    }
    let mut argv_bytes = 0_usize;
    for argument in &request.argv {
        if argument.is_empty()
            || argument.len() > ACCEPTANCE_MAX_ARG_BYTES
            || argument.contains('\0')
        {
            return Err("refused: invalid or oversized acceptance argument".into());
        }
        argv_bytes = argv_bytes.saturating_add(argument.len());
    }
    if argv_bytes > ACCEPTANCE_MAX_ARGV_BYTES {
        return Err("refused: acceptance argv exceeds 32 KiB".into());
    }
    if !Path::new(request.cwd.trim()).is_absolute()
        || request
            .approved_roots
            .iter()
            .any(|root| !Path::new(root.trim()).is_absolute())
    {
        return Err("refused: acceptance cwd and approved roots must be absolute".into());
    }
    let cwd = fs::canonicalize(request.cwd.trim())
        .map_err(|_| "refused: acceptance cwd does not exist".to_string())?;
    if !cwd.is_dir() || request.approved_roots.is_empty() {
        return Err("refused: acceptance cwd is not inside an approved root".into());
    }
    let approved_root = request
        .approved_roots
        .iter()
        .filter_map(|root| fs::canonicalize(root.trim()).ok())
        .filter(|root| root.is_dir() && cwd.starts_with(root))
        // Narrowest matching authority wins when callers supplied nested roots.
        .max_by_key(|root| root.components().count())
        .ok_or_else(|| "refused: acceptance cwd is not inside an approved root".to_string())?;
    let timeout_ms = request.timeout_ms.unwrap_or(ACCEPTANCE_DEFAULT_TIMEOUT_MS);
    if !(ACCEPTANCE_MIN_TIMEOUT_MS..=ACCEPTANCE_MAX_TIMEOUT_MS).contains(&timeout_ms) {
        return Err("refused: acceptance timeout must be between 100 ms and 15 minutes".into());
    }
    if request.env.len() > ACCEPTANCE_MAX_ENV {
        return Err("refused: too many acceptance environment variables".into());
    }
    let mut env_bytes = 0_usize;
    for (key, value) in &request.env {
        let valid_key = !key.is_empty()
            && key.len() <= 64
            && key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_');
        let upper = key.to_ascii_uppercase();
        let dangerous = upper.starts_with("DYLD_")
            || upper.starts_with("LD_")
            || upper.starts_with("GIT_")
            || upper.starts_with("SSH_")
            || matches!(
                upper.as_str(),
                "BASH_ENV" | "ENV" | "NODE_OPTIONS" | "PYTHONPATH" | "RUSTC_WRAPPER"
            );
        if !valid_key
            || dangerous
            || value.len() > ACCEPTANCE_MAX_ENV_VALUE_BYTES
            || value.contains('\0')
        {
            return Err(
                "refused: invalid, dangerous or oversized acceptance environment variable".into(),
            );
        }
        env_bytes = env_bytes.saturating_add(key.len() + value.len());
    }
    if env_bytes > ACCEPTANCE_MAX_ENV_BYTES {
        return Err("refused: acceptance environment exceeds 16 KiB".into());
    }
    Ok((approved_root, cwd, timeout_ms))
}

#[cfg(unix)]
fn open_acceptance_cwd(cwd: &Path) -> Result<std::fs::File, String> {
    use std::ffi::CString;
    use std::os::fd::FromRawFd;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;

    let expected = fs::metadata(cwd)
        .map_err(|_| "refused: acceptance cwd vanished before execution".to_string())?;
    let path = CString::new(cwd.as_os_str().as_bytes())
        .map_err(|_| "refused: acceptance cwd contains NUL".to_string())?;
    let fd = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err("refused: acceptance cwd could not be opened safely".into());
    }
    let file = unsafe { std::fs::File::from_raw_fd(fd) };
    let observed = file
        .metadata()
        .map_err(|_| "refused: acceptance cwd could not be verified".to_string())?;
    if expected.dev() != observed.dev() || expected.ino() != observed.ino() {
        return Err("refused: acceptance cwd changed during validation".into());
    }
    Ok(file)
}

static ACTIVE_ACCEPTANCE: Lazy<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

pub fn acceptance_command_cancel(run_id: &str) -> bool {
    let Some(cancelled) = ACTIVE_ACCEPTANCE.lock().get(run_id.trim()).cloned() else {
        return false;
    };
    cancelled.store(true, Ordering::Release);
    true
}

pub fn acceptance_command_run(
    request: AcceptanceCommandRequest,
) -> Result<AcceptanceCommandResult, String> {
    let (_approved_root, cwd, timeout_ms) = validate_acceptance(&request)?;
    #[cfg(unix)]
    let _cwd_handle = open_acceptance_cwd(&cwd)?;
    let run_id = checked_id(&request.run_id, "run id")?;
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut active = ACTIVE_ACCEPTANCE.lock();
        if active.contains_key(&run_id) {
            return Err("refused: acceptance run id is already active".into());
        }
        active.insert(run_id.clone(), Arc::clone(&cancelled));
    }

    let result = (|| {
        let started = Instant::now();
        // Authority validation above proves cwd is inside an approved root,
        // but runtime authority is intentionally narrower: only this exact
        // checkout/worktree is writable. A gate in `.worktrees/x` cannot
        // mutate the main checkout or a sibling worktree.
        let mut child = crate::runtime_native::spawn_sandboxed_process(
            &cwd,
            &cwd,
            &request.argv,
            &request.env,
            false,
        )
        .map_err(|error| format!("could not start approved acceptance command: {error}"))?;
        let stdout = drain_bounded(child.stdout.take());
        let stderr = drain_bounded(child.stderr.take());
        let deadline = started + Duration::from_millis(timeout_ms);
        let (status, exit): (AcceptanceCommandStatus, Option<ExitStatus>) = loop {
            if cancelled.load(Ordering::Acquire) {
                kill_process_group(&mut child);
                break (AcceptanceCommandStatus::Cancelled, None);
            }
            if let Some(exit) = child
                .try_wait()
                .map_err(|error| format!("could not observe acceptance command: {error}"))?
            {
                break (AcceptanceCommandStatus::Completed, Some(exit));
            }
            if Instant::now() >= deadline {
                kill_process_group(&mut child);
                break (AcceptanceCommandStatus::TimedOut, None);
            }
            std::thread::sleep(Duration::from_millis(20));
        };

        let grace = Instant::now() + Duration::from_secs(1);
        while (Arc::strong_count(&stdout) > 1 || Arc::strong_count(&stderr) > 1)
            && Instant::now() < grace
        {
            std::thread::sleep(Duration::from_millis(5));
        }
        let mut stdout = stdout.lock();
        let mut stderr = stderr.lock();
        Ok(AcceptanceCommandResult {
            run_id: run_id.clone(),
            status,
            exit_code: exit.and_then(|status| status.code()),
            duration_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
            stdout: scrub_output(std::mem::take(&mut stdout.bytes)),
            stderr: scrub_output(std::mem::take(&mut stderr.bytes)),
            stdout_truncated: stdout.truncated,
            stderr_truncated: stderr.truncated,
        })
    })();
    ACTIVE_ACCEPTANCE.lock().remove(&run_id);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

    static SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn run_git(cwd: &Path, args: &[&str]) -> String {
        git_ok(crate::git::git_bin(None), cwd, args).unwrap()
    }

    fn temp_repo() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "swarmz-integration-native-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        let path = path.canonicalize().unwrap();
        run_git(&path, &["init", "-q", "-b", "main"]);
        run_git(&path, &["config", "user.email", "swarmz@example.invalid"]);
        run_git(&path, &["config", "user.name", "SwarmZ Test"]);
        fs::write(path.join("file.txt"), "base\n").unwrap();
        run_git(&path, &["add", "file.txt"]);
        run_git(&path, &["commit", "-qm", "base"]);
        path
    }

    fn fixture() -> (PathBuf, PathBuf, String, String) {
        let repo = temp_repo();
        let base = run_git(&repo, &["rev-parse", "HEAD"]);
        run_git(&repo, &["switch", "-qc", "worker"]);
        fs::write(repo.join("worker.txt"), "worker\n").unwrap();
        run_git(&repo, &["add", "worker.txt"]);
        run_git(&repo, &["commit", "-qm", "worker"]);
        let source = run_git(&repo, &["rev-parse", "HEAD"]);
        run_git(&repo, &["switch", "-q", "main"]);
        let worktree = repo.join(".worktrees/integration-test");
        fs::create_dir_all(repo.join(".worktrees")).unwrap();
        run_git(
            &repo,
            &[
                "worktree",
                "add",
                "-qb",
                "swarmz/integration/test",
                worktree.to_str().unwrap(),
                "main",
            ],
        );
        (repo, worktree, base, source)
    }

    fn apply_request(
        repo: &Path,
        worktree: &Path,
        expected_head: String,
        commit: String,
    ) -> IntegrationApplyRequest {
        IntegrationApplyRequest {
            root: repo.to_string_lossy().into_owned(),
            worktree_path: worktree.to_string_lossy().into_owned(),
            integration_branch: "swarmz/integration/test".into(),
            expected_head,
            commit,
            strategy: IntegrationStrategy::CherryPick,
            git_bin: None,
        }
    }

    #[test]
    fn apply_is_exact_clean_and_idempotent() {
        let (repo, worktree, base, source) = fixture();
        let first =
            integration_apply(apply_request(&repo, &worktree, base, source.clone())).unwrap();
        assert_eq!(first.status, IntegrationApplyStatus::Applied);
        assert!(Path::new(&worktree).join("worker.txt").exists());
        let second = integration_apply(apply_request(
            &repo,
            &worktree,
            first.head_after.clone(),
            source,
        ))
        .unwrap();
        assert_eq!(second.status, IntegrationApplyStatus::AlreadyApplied);
        assert_eq!(second.head_after, first.head_after);
        fs::remove_dir_all(repo).ok();
    }

    #[test]
    fn apply_conflict_is_typed_and_restores_checkout() {
        let repo = temp_repo();
        run_git(&repo, &["switch", "-qc", "worker"]);
        fs::write(repo.join("file.txt"), "worker\n").unwrap();
        run_git(&repo, &["commit", "-qam", "worker"]);
        let source = run_git(&repo, &["rev-parse", "HEAD"]);
        run_git(&repo, &["switch", "-q", "main"]);
        fs::write(repo.join("file.txt"), "integration\n").unwrap();
        run_git(&repo, &["commit", "-qam", "integration"]);
        let head = run_git(&repo, &["rev-parse", "HEAD"]);
        let worktree = repo.join(".worktrees/integration-test");
        fs::create_dir_all(repo.join(".worktrees")).unwrap();
        run_git(
            &repo,
            &[
                "worktree",
                "add",
                "-qb",
                "swarmz/integration/test",
                worktree.to_str().unwrap(),
                "main",
            ],
        );
        let result =
            integration_apply(apply_request(&repo, &worktree, head.clone(), source)).unwrap();
        assert_eq!(result.status, IntegrationApplyStatus::Blocked);
        assert_eq!(result.conflict_files, vec!["file.txt"]);
        assert!(result.checkout_restored);
        assert_eq!(run_git(&worktree, &["rev-parse", "HEAD"]), head);
        assert!(status_porcelain(crate::git::git_bin(None), &worktree)
            .unwrap()
            .is_empty());
        fs::remove_dir_all(repo).ok();
    }

    #[test]
    fn apply_rejects_foreign_path_dirty_state_and_short_sha() {
        let (repo, worktree, base, source) = fixture();
        let err = integration_apply(apply_request(&repo, &repo, base.clone(), source.clone()))
            .unwrap_err();
        assert!(err.contains(".worktrees"), "{err}");
        fs::write(worktree.join("dirty.txt"), "dirty").unwrap();
        let err =
            integration_apply(apply_request(&repo, &worktree, base.clone(), source)).unwrap_err();
        assert!(err.contains("not clean"), "{err}");
        fs::remove_file(worktree.join("dirty.txt")).unwrap();
        let err =
            integration_apply(apply_request(&repo, &worktree, base[..7].into(), base)).unwrap_err();
        assert!(err.contains("complete"), "{err}");
        fs::remove_dir_all(repo).ok();
    }

    #[test]
    fn rollback_only_moves_to_approved_ancestor_and_writes_reflog() {
        let (repo, worktree, checkpoint, source) = fixture();
        let applied =
            integration_apply(apply_request(&repo, &worktree, checkpoint.clone(), source)).unwrap();
        let result = integration_rollback(IntegrationRollbackRequest {
            root: repo.to_string_lossy().into_owned(),
            worktree_path: worktree.to_string_lossy().into_owned(),
            integration_branch: "swarmz/integration/test".into(),
            expected_head: applied.head_after,
            checkpoint_sha: checkpoint.clone(),
            approval_id: "approval:test-1".into(),
            git_bin: None,
        })
        .unwrap();
        assert_eq!(result.head_after, checkpoint);
        assert_eq!(result.reflog_head, result.head_after);
        assert!(result
            .reflog_subject
            .contains("SwarmZ integration rollback"));
        fs::remove_dir_all(repo).ok();
    }

    fn acceptance_request(run_id: &str, cwd: &Path, argv: Vec<String>) -> AcceptanceCommandRequest {
        AcceptanceCommandRequest {
            run_id: run_id.into(),
            approval_id: "approval:test".into(),
            cwd: cwd.to_string_lossy().into_owned(),
            approved_roots: vec![cwd.to_string_lossy().into_owned()],
            argv,
            timeout_ms: Some(2_000),
            env: BTreeMap::new(),
        }
    }

    #[test]
    fn acceptance_is_argv_only_root_confined_and_captures_exit() {
        let dir = temp_repo();
        let result = acceptance_command_run(acceptance_request(
            "run-output",
            &dir,
            vec!["/usr/bin/printf".into(), "hello %s".into(), "world".into()],
        ))
        .unwrap();
        assert_eq!(result.status, AcceptanceCommandStatus::Completed);
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.stdout, "hello world");

        let outside = std::env::temp_dir().canonicalize().unwrap();
        let mut refused = acceptance_request("run-refused", &outside, vec!["/usr/bin/true".into()]);
        refused.approved_roots = vec![dir.to_string_lossy().into_owned()];
        assert!(acceptance_command_run(refused)
            .unwrap_err()
            .contains("approved root"));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn acceptance_process_cannot_write_outside_its_canonical_sandbox_root() {
        let dir = temp_repo();
        let checkout = dir.join(".worktrees").join("candidate");
        fs::create_dir_all(&checkout).unwrap();
        let outside = dir.join("main-checkout-mutation.txt");
        fs::remove_file(&outside).ok();
        let mut request = acceptance_request(
            "run-sandbox-escape",
            &checkout,
            vec![
                "/usr/bin/touch".into(),
                outside.to_string_lossy().into_owned(),
            ],
        );
        request.approved_roots = vec![dir.to_string_lossy().into_owned()];
        let result = acceptance_command_run(request).unwrap();
        assert_eq!(result.status, AcceptanceCommandStatus::Completed);
        assert_ne!(result.exit_code, Some(0));
        assert!(!outside.exists());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn acceptance_timeout_and_output_are_bounded() {
        let dir = temp_repo();
        let mut request = acceptance_request("run-timeout", &dir, vec!["/usr/bin/yes".into()]);
        request.timeout_ms = Some(150);
        let result = acceptance_command_run(request).unwrap();
        assert_eq!(result.status, AcceptanceCommandStatus::TimedOut);
        assert!(result.stdout_truncated);
        assert!(result.stdout.len() <= ACCEPTANCE_OUTPUT_CAP);
        assert!(result.duration_ms < 2_000);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn acceptance_run_can_be_cancelled_by_id() {
        let dir = temp_repo();
        let request = acceptance_request("run-cancel", &dir, vec!["/bin/sleep".into(), "5".into()]);
        let handle = std::thread::spawn(move || acceptance_command_run(request).unwrap());
        let deadline = Instant::now() + Duration::from_secs(2);
        while !acceptance_command_cancel("run-cancel") && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let result = handle.join().unwrap();
        assert_eq!(result.status, AcceptanceCommandStatus::Cancelled);
        fs::remove_dir_all(dir).ok();
    }
}
