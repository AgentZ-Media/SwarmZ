//! Git worktree management for agent panes — create a worktree under
//! `<repo>/.worktrees/<slug>`, copy the untracked environment over, report
//! whether closing one would lose work, and remove it again. Unlike `git.rs`
//! (strictly read-only) this module deliberately writes: `git worktree
//! add/remove`, the transactional branch deletion (`git update-ref -d` with
//! the expected old OID) and the repo-local `.git/info/exclude` entry (never
//! the tracked `.gitignore`).

use crate::git::{git_bin, output_with_timeout};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Folder of every SwarmZ-managed worktree, directly under the repo root.
const WORKTREES_DIR: &str = ".worktrees";

/// Heavyweight directories the environment copy always skips — caches and
/// build artifacts that each worktree regenerates itself.
const SKIP_DIRS: &[&str] = &[
    WORKTREES_DIR,
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "coverage",
    ".next",
    ".turbo",
    ".cache",
    ".parcel-cache",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    ".gradle",
    ".DS_Store",
];

/// Explicit environment-transfer manifest. Copying every untracked file was
/// both surprising (keys, archives, databases) and unbounded. Only these
/// conventional per-developer runtime files may cross into a worktree.
const ENV_COPY_EXACT_NAMES: &[&str] = &[
    ".env",
    ".npmrc",
    ".yarnrc",
    ".yarnrc.yml",
    ".tool-versions",
    ".node-version",
    ".python-version",
    ".ruby-version",
    ".java-version",
    ".mise.toml",
    "mise.local.toml",
    ".swarmz-setup",
    ".swarmz-setup.sh",
    "setup.local.sh",
    "bootstrap.local.sh",
];
const ENV_COPY_MAX_FILES: u64 = 128;
const ENV_COPY_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const ENV_COPY_MAX_TOTAL_BYTES: u64 = 16 * 1024 * 1024;
const ENV_COPY_TIMEOUT: Duration = Duration::from_secs(5);

fn environment_manifest_allows(name: &str) -> bool {
    ENV_COPY_EXACT_NAMES.contains(&name) || name.starts_with(".env.")
}

#[derive(Serialize, Clone, Debug)]
pub struct WorktreeInfo {
    /// main repo root the worktree belongs to
    pub root: String,
    /// absolute path of the new worktree (the agent's cwd)
    pub path: String,
    pub branch: String,
    /// untracked/ignored files copied over by the environment transfer
    pub copied: u64,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct WorktreeStatus {
    /// false when the folder vanished (deleted by hand) — nothing left to lose
    pub exists: bool,
    /// uncommitted changes in tracked files or new (non-ignored) files
    pub dirty: bool,
    /// commits reachable only from this branch (not on any other local
    /// branch or any remote) — deleting the branch would lose them
    pub ahead: u64,
    /// the ahead count could NOT be computed (git error/timeout) — callers
    /// gating a deletion on `ahead` must treat this as "may hold work"
    /// (fail closed), never as 0
    pub ahead_unknown: bool,
    pub branch: Option<String>,
}

/// Result of a worktree scan: the entries plus which repo roots actually
/// scanned. The frontend prunes a root from its registry only when it is in
/// `scanned` with zero entries — a root that failed to scan (unmounted
/// volume, broken git override) must never be mistaken for "no worktrees".
#[derive(Serialize, Clone, Debug, Default)]
pub struct WorktreeScan {
    pub entries: Vec<WorktreeEntry>,
    pub scanned: Vec<String>,
}

/// One SwarmZ worktree found on disk (management panel).
#[derive(Serialize, Clone, Debug)]
pub struct WorktreeEntry {
    pub root: String,
    /// repo root folder name, for grouping in the panel
    pub repo: String,
    pub path: String,
    pub branch: String,
    pub dirty: bool,
    pub ahead: u64,
    /// the ahead count could not be computed — treat as "may hold work"
    pub ahead_unknown: bool,
    /// registered with git but the folder is gone (prunable)
    pub missing: bool,
}

fn run(bin: &str, cwd: &Path, args: &[&str]) -> Result<String, String> {
    // generous deadline: `worktree add` checks out a whole tree, but even
    // that must not hang forever on a dead network volume. Every invocation
    // goes through `git_command` (audit C1): hooks/fsmonitor/pager are
    // suppressed — `git worktree add` must never run a repo-controlled
    // `post-checkout`, `git update-ref` never a `reference-transaction`
    // hook, in the unsandboxed backend.
    run_with_timeout(bin, cwd, args, Duration::from_secs(120))
}

fn run_with_timeout(
    bin: &str,
    cwd: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<String, String> {
    let out = output_with_timeout(crate::git::git_command(bin, cwd).args(args), timeout)
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("git {} failed", args.first().unwrap_or(&""))
        } else {
            err
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Main repo root for any path inside it — also when that path is itself a
/// worktree (the common dir always lives at `<main root>/.git`).
fn main_root(bin: &str, cwd: &Path) -> Result<PathBuf, String> {
    let common = run(
        bin,
        cwd,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    let common = PathBuf::from(common);
    if common.file_name().map(|n| n != ".git").unwrap_or(true) {
        return Err("not a regular git repository".into());
    }
    common
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "not a regular git repository".into())
}

/// Make git ignore `.worktrees/` via the repo-local `.git/info/exclude` —
/// same effect as a `.gitignore` entry, but never touches a tracked file.
/// Anchored + no-follow (audit R4): `.git`/`info`/`exclude` are reached
/// through no-follow handles and the exclude file is replaced atomically —
/// a symlink planted anywhere on that chain refuses instead of redirecting
/// the write to a host file.
fn ensure_excluded(root: &Path) -> Result<(), String> {
    crate::fsx::ensure_git_exclude(
        root,
        &["/.worktrees/", "/.worktrees", ".worktrees/", ".worktrees"],
        "# SwarmZ worktrees\n/.worktrees/",
    )
}

/// Worktree folder name from the branch: everything after the last `/`,
/// reduced to filesystem-safe characters.
fn slug(branch: &str) -> String {
    let last = branch.rsplit('/').next().unwrap_or(branch);
    let s: String = last
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() {
        "worktree".into()
    } else {
        s
    }
}

/// Open the chain of directory components below `start`, each hop no-follow
/// (`create` additionally mkdirs missing hops). A symlinked or vanished
/// component refuses — the caller skips that file (fail closed per entry).
fn walk_chain(
    start: &crate::fsx::DirHandle,
    dirs: &[&str],
    create: bool,
) -> Result<crate::fsx::DirHandle, String> {
    let mut cur = start.try_clone()?;
    for d in dirs {
        cur = if create {
            cur.ensure_dir(d)?
        } else {
            cur.open_dir(d)?
        };
    }
    Ok(cur)
}

/// Copy only manifest-approved untracked runtime files into the worktree.
/// The transfer has hard file/count/total/time budgets and writes destination
/// files mode 0600. Symlinks and every non-regular entry are skipped.
///
/// Audit C7: the copy is fd-ANCHORED on both sides. Every path component is
/// opened NO-FOLLOW relative to the repo-root handle (sources) and the
/// verified worktree handle (destinations, `fsx::DirHandle`); regular files
/// are re-checked on the open fd, symlink entries are recreated via
/// readlinkat/symlinkat (their target string copied verbatim, never
/// followed), and nothing is ever overwritten (`create_new`). A concurrent
/// rename/symlink swap anywhere on either chain — including of `.worktrees`
/// itself — makes that entry refuse instead of redirecting a secret to (or
/// reading one from) a foreign host path. Best-effort per file, like before:
/// one unreadable file must not fail the spawn.
fn copy_environment(bin: &str, root: &Path, dest: &crate::fsx::DirHandle) -> u64 {
    use crate::fsx::{DirHandle, EntryKind};
    use std::io::Read as _;
    // Only ignored local files are eligible. An ordinary untracked source
    // file may be unfinished user work and must never be cloned implicitly.
    let started = Instant::now();
    let list = match run_with_timeout(
        bin,
        root,
        &[
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "-z",
        ],
        ENV_COPY_TIMEOUT,
    ) {
        Ok(l) => l,
        Err(_) => return 0,
    };
    let Ok(src_root) = DirHandle::open_root(root) else {
        return 0;
    };
    let mut copied = 0u64;
    let mut total_bytes = 0u64;
    for rel in list.split('\0').filter(|r| !r.is_empty()) {
        if copied >= ENV_COPY_MAX_FILES || started.elapsed() >= ENV_COPY_TIMEOUT {
            break;
        }
        let comps: Vec<&str> = rel
            .split('/')
            .filter(|c| !c.is_empty() && *c != ".")
            .collect();
        let Some((leaf, dirs)) = comps.split_last() else {
            continue;
        };
        if !environment_manifest_allows(leaf) {
            continue;
        }
        if comps.iter().any(|c| *c == ".." || SKIP_DIRS.contains(c)) {
            continue;
        }
        let Ok(src_dir) = walk_chain(&src_root, dirs, false) else {
            continue;
        };
        let Ok(dst_dir) = walk_chain(dest, dirs, true) else {
            continue;
        };
        let ok = match src_dir.kind(leaf) {
            Ok(Some(EntryKind::File)) => match src_dir.open_file(leaf) {
                Ok(Some(mut f)) => {
                    let metadata = match f.metadata() {
                        Ok(m) if m.is_file() => m,
                        _ => continue,
                    };
                    let size = metadata.len();
                    #[cfg(unix)]
                    let destination_mode = {
                        use std::os::unix::fs::PermissionsExt as _;
                        if metadata.permissions().mode() & 0o111 != 0 {
                            0o700
                        } else {
                            0o600
                        }
                    };
                    if size > ENV_COPY_MAX_FILE_BYTES
                        || total_bytes.saturating_add(size) > ENV_COPY_MAX_TOTAL_BYTES
                    {
                        continue;
                    }
                    match dst_dir.create_new_with_mode(leaf, 0o600) {
                        Ok(mut out) => {
                            let remaining = ENV_COPY_MAX_FILE_BYTES
                                .min(ENV_COPY_MAX_TOTAL_BYTES.saturating_sub(total_bytes));
                            let transferred =
                                std::io::copy(&mut f.by_ref().take(remaining + 1), &mut out);
                            match transferred {
                                Ok(n) if n <= remaining => {
                                    #[cfg(unix)]
                                    {
                                        use std::os::unix::fs::PermissionsExt as _;
                                        if out
                                            .set_permissions(fs::Permissions::from_mode(
                                                destination_mode,
                                            ))
                                            .is_err()
                                        {
                                            drop(out);
                                            let _ = dst_dir.unlink(leaf);
                                            continue;
                                        }
                                    }
                                    total_bytes = total_bytes.saturating_add(n);
                                    true
                                }
                                _ => {
                                    drop(out);
                                    let _ = dst_dir.unlink(leaf);
                                    false
                                }
                            }
                        }
                        Err(_) => false,
                    }
                }
                _ => false,
            },
            _ => false,
        };
        if ok {
            copied += 1;
        }
    }
    copied
}

/// Create `<repo>/.worktrees/<slug>` on a new branch off the current HEAD.
pub fn add(
    cwd: &str,
    branch: &str,
    copy_env: bool,
    bin_override: Option<&str>,
) -> Result<WorktreeInfo, String> {
    let bin = git_bin(bin_override);
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("branch name is empty".into());
    }
    let root = main_root(bin, Path::new(cwd))?;
    run(bin, &root, &["check-ref-format", "--branch", branch])
        .map_err(|_| format!("\"{branch}\" is not a valid branch name"))?;

    // audit R4 + final hardening F8: a symlinked `.worktrees` would redirect
    // the whole checkout (and the env copy — .env files included) to an
    // arbitrary host folder. The container is created/opened through an
    // ANCHORED no-follow handle (`fsx::DirHandle`) — a pre-planted symlink
    // refuses — and kept open across the git call: after `git worktree add`,
    // the slug is re-verified THROUGH the anchored fd. A concurrent swap of
    // `.worktrees` between the open and the (path-based) git checkout lands
    // the worktree somewhere else — the anchored re-check then finds no slug
    // under the REAL container, the add rolls back and refuses BEFORE any
    // env file (.env, keys) is copied.
    let container = root.join(WORKTREES_DIR);
    let container_handle = {
        let root_handle = crate::fsx::DirHandle::open_root(&root)?;
        root_handle
            .ensure_dir(WORKTREES_DIR)
            .map_err(|e| format!("refusing {}: {e}", container.display()))?
    };
    let slug_name = slug(branch);
    let path = container.join(&slug_name);
    if path.exists() {
        return Err(format!(
            "worktree folder already exists: {}",
            path.display()
        ));
    }
    ensure_excluded(&root)?;

    // C5: the failed-add rollback deletes the fresh branch TRANSACTIONALLY —
    // `-b` creates it at the current HEAD, so that OID (captured BEFORE the
    // add) is the only tip the rollback may delete. A tip that moved in the
    // race window (a commit landing on the fresh branch) survives.
    let expected_branch_oid = run(bin, &root, &["rev-parse", "--verify", "HEAD"])
        .ok()
        .filter(|s| !s.is_empty());
    let rollback = |path_str: &str| {
        let _ = run(bin, &root, &["worktree", "remove", "--force", path_str]);
        let _ = run(bin, &root, &["worktree", "prune"]);
        if let Some(oid) = &expected_branch_oid {
            let _ = delete_branch_transactional(bin, &root, branch, oid);
        }
    };

    let path_str = path.to_string_lossy().into_owned();
    run(bin, &root, &["worktree", "add", "-b", branch, &path_str])?;

    // F8 post-add verification through the ANCHORED handle: the checkout
    // must exist as a real directory under the container fd opened above —
    // not under whatever `.worktrees` resolves to NOW. Failure = the
    // container was swapped mid-add; roll the checkout back (fresh branch,
    // no commits yet — and the rollback delete is OID-guarded) and refuse.
    let slug_handle = match container_handle.open_dir(&slug_name) {
        Ok(h) => h,
        Err(_) => {
            rollback(&path_str);
            return Err(format!(
                "refusing: {} was redirected while the worktree was created (symlink swap?)",
                container.display()
            ));
        }
    };
    // C7: the path-resolved worktree and the anchored handle must be the SAME
    // directory (dev+inode) — a `.worktrees` swap between the git add and now
    // would leave the pathname pointing elsewhere; refuse before any env file
    // (.env, keys) could be copied through it.
    match slug_handle.identity() {
        Ok(anchored) => {
            let by_path = fs::metadata(&path)
                .map(|m| {
                    use std::os::unix::fs::MetadataExt;
                    (m.dev(), m.ino())
                })
                .ok();
            if by_path != Some(anchored) {
                rollback(&path_str);
                return Err(format!(
                    "refusing: {} was redirected after the worktree was created (symlink swap?)",
                    container.display()
                ));
            }
        }
        Err(e) => {
            rollback(&path_str);
            return Err(format!(
                "refusing: could not verify the created worktree: {e}"
            ));
        }
    }

    let copied = if copy_env {
        // C7: the env copy is fd-ANCHORED on both sides — sources are read
        // through a no-follow handle chain rooted at the repo, destinations
        // written through the verified slug handle. A concurrent rename/
        // symlink of `.worktrees` (or of a subfolder on either side) can no
        // longer redirect a copied secret to or from a foreign host path.
        copy_environment(bin, &root, &slug_handle)
    } else {
        0
    };

    Ok(WorktreeInfo {
        root: root.to_string_lossy().into_owned(),
        path: path_str,
        branch: branch.to_string(),
        copied,
    })
}

/// Current tip OID of a local branch (None = branch missing/unreadable).
fn branch_oid(bin: &str, root: &Path, branch: &str) -> Option<String> {
    run(
        bin,
        root,
        &["rev-parse", "--verify", &format!("refs/heads/{branch}")],
    )
    .ok()
    .filter(|s| !s.is_empty())
}

/// Is `branch` currently checked out in ANY worktree (incl. the main
/// checkout)? Unreadable state counts as checked out (fail closed) — a
/// branch we can't verify is never deleted.
fn branch_checked_out_somewhere(bin: &str, root: &Path, branch: &str) -> bool {
    match run(bin, root, &["worktree", "list", "--porcelain"]) {
        Ok(p) => {
            let needle = format!("branch refs/heads/{branch}");
            p.lines().any(|l| l.trim() == needle)
        }
        Err(_) => true,
    }
}

/// TRANSACTIONAL branch deletion (final hardening F3): delete
/// `refs/heads/<branch>` ONLY if its tip still equals `expected_oid` — via
/// `git update-ref -d <ref> <expected-old-oid>`, which fails atomically when
/// the OID moved. This closes the check/delete race `git branch -D` had:
/// after the ahead/dirty re-check, another process could land a fresh commit
/// (making the worktree clean enough for `git worktree remove` to accept),
/// and an unconditional `branch -D` would then delete the branch WITH that
/// new commit. With the expected-OID delete, a moved tip survives — losing a
/// branch pointer is recoverable annoyance, losing a commit is data loss.
/// Also refuses while the branch is checked out anywhere (`update-ref -d`
/// does not protect checkouts the way `branch -D` does).
fn delete_branch_transactional(
    bin: &str,
    root: &Path,
    branch: &str,
    expected_oid: &str,
) -> Result<(), String> {
    if branch_checked_out_somewhere(bin, root, branch) {
        return Err(format!(
            "branch \"{branch}\" is checked out in a worktree — not deleting it"
        ));
    }
    run(
        bin,
        root,
        &[
            "update-ref",
            "-d",
            &format!("refs/heads/{branch}"),
            expected_oid,
        ],
    )
    .map(|_| ())
}

/// Commits reachable only from `branch` — not from any other local branch
/// and not from any remote. Works from any directory of the repo. None =
/// could not compute (git error/timeout) — callers must FAIL CLOSED, never
/// substitute 0.
fn branch_ahead(bin: &str, cwd: &Path, branch: &str) -> Option<u64> {
    run(
        bin,
        cwd,
        &[
            "rev-list",
            "--count",
            &format!("refs/heads/{branch}"),
            "--not",
            &format!("--exclude={branch}"),
            "--branches",
            "--remotes",
        ],
    )
    .ok()
    .and_then(|s| s.parse().ok())
}

/// Would closing this worktree lose anything? Uncommitted changes (tracked
/// edits or new non-ignored files — the copied, gitignored env files don't
/// count) or commits no other branch/remote can reach.
pub fn status(path: &str, bin_override: Option<&str>) -> WorktreeStatus {
    let bin = git_bin(bin_override);
    let p = Path::new(path);
    if !p.exists() {
        return WorktreeStatus::default();
    }
    let branch = run(bin, p, &["symbolic-ref", "--short", "-q", "HEAD"])
        .ok()
        .filter(|b| !b.is_empty());
    let dirty = run(bin, p, &["status", "--porcelain"])
        .map(|s| !s.is_empty())
        // a worktree we can't read counts as dirty — never silent-delete it
        .unwrap_or(true);
    // commits reachable only from this branch: not from any other local
    // branch and not from any remote (a pushed branch is safe to delete).
    // An UNCOMPUTABLE count is surfaced as ahead_unknown (fail closed at the
    // deletion gates), never silently as 0.
    let ahead = match &branch {
        Some(b) => branch_ahead(bin, p, b),
        None => run(
            bin,
            p,
            &[
                "rev-list",
                "--count",
                "HEAD",
                "--not",
                "--branches",
                "--remotes",
            ],
        )
        .ok()
        .and_then(|s| s.parse().ok()),
    };

    WorktreeStatus {
        exists: true,
        dirty,
        ahead: ahead.unwrap_or(0),
        ahead_unknown: ahead.is_none(),
        branch,
    }
}

/// Resolve which SwarmZ worktree of `root` sits at `path` — from `git
/// worktree list --porcelain`, never from caller-supplied claims. Returns
/// `(canonical_path, branch_from_git, prunable)`; `None` when git lists no
/// worktree at that path.
fn find_registered_worktree(
    bin: &str,
    root: &Path,
    path: &str,
) -> Option<(String, Option<String>, bool)> {
    let porcelain = run(bin, root, &["worktree", "list", "--porcelain"]).ok()?;
    let wanted = crate::fsx::canonicalize_lenient(Path::new(path.trim()))?;
    for block in porcelain.split("\n\n") {
        let mut wt_path = None;
        let mut branch = None;
        let mut prunable = false;
        for line in block.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                wt_path = Some(p.to_string());
            } else if let Some(b) = line.strip_prefix("branch ") {
                branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
            } else if line.starts_with("prunable") {
                prunable = true;
            }
        }
        let Some(wt_path) = wt_path else { continue };
        let Some(listed) = crate::fsx::canonicalize_lenient(Path::new(&wt_path)) else {
            continue;
        };
        if listed == wanted {
            return Some((wt_path, branch, prunable));
        }
    }
    None
}

/// Remove the worktree folder and delete its branch.
///
/// Hardened surface (audit R5) — the raw command can no longer be steered at
/// foreign paths or branches:
///   - `path` must resolve STRICTLY inside `<root>/.worktrees` (canonical,
///     symlink-resolving) — anything else refuses,
///   - the worktree must be REGISTERED with git at that path, and the branch
///     to delete is DERIVED from `git worktree list` — a caller-supplied
///     `branch` must match it exactly or the call refuses (`git branch -D
///     main` via a spoofed branch argument is impossible),
///   - `force: true` discards uncommitted changes / local-only commits — for
///     explicitly user-confirmed deletions only. `force: false` is the GATED
///     path (the Conductor's cleanup_worktree and the silent clean-safe
///     flows): the status is re-checked HERE, inside the same call as the
///     removal — dirty, local-only commits or an UNCOMPUTABLE ahead count
///     refuse — and the `git worktree remove` runs WITHOUT `--force`, so git
///     itself refuses work that appeared between the check and the removal
///     (the TOCTOU net; copied gitignored env files don't block it),
///   - the branch deletion is TRANSACTIONAL (final hardening F3): the tip
///     OID is captured BEFORE the removal and the delete runs as
///     `git update-ref -d <ref> <expected-oid>` — a commit that lands in the
///     race window moves the tip, the delete fails and the branch (with the
///     new commit) survives. A branch still checked out anywhere is never
///     deleted either.
pub fn remove(
    root: &str,
    path: &str,
    branch: &str,
    force: bool,
    bin_override: Option<&str>,
) -> Result<(), String> {
    let bin = git_bin(bin_override);
    // normalize the root through git itself — also verifies it IS a repo
    let root_p = main_root(bin, Path::new(root))?;
    let container = root_p.join(WORKTREES_DIR);
    // R5 confinement: only paths strictly inside <root>/.worktrees are ever
    // removable through this surface — `/`, the repo itself, a home folder
    // or a foreign repo all refuse before any git write runs
    if !crate::fsx::path_strictly_within(&container.to_string_lossy(), path) {
        return Err(format!(
            "refused: {path:?} is not inside this repo's .worktrees folder"
        ));
    }
    // R5 identity: the worktree must be git-registered at that path, and the
    // branch comes from git — the caller's claim is only cross-checked
    let Some((registered_path, derived_branch, _prunable)) =
        find_registered_worktree(bin, &root_p, path)
    else {
        return Err(format!(
            "refused: git lists no worktree at {path:?} — nothing to remove"
        ));
    };
    let caller_branch = branch.trim();
    if let Some(derived) = &derived_branch {
        if !caller_branch.is_empty() && caller_branch != derived {
            return Err(format!(
                "refused: branch mismatch — the worktree at {path:?} is on \"{derived}\", not \"{caller_branch}\""
            ));
        }
    }
    // F3: capture the branch tip BEFORE any check/removal — the branch
    // deletion at the end is transactional against exactly this OID, so a
    // commit landing anywhere in the race window keeps the branch alive.
    let expected_oid = derived_branch
        .as_ref()
        .and_then(|b| branch_oid(bin, &root_p, b));

    if Path::new(&registered_path).exists() {
        if force {
            run(
                bin,
                &root_p,
                &["worktree", "remove", "--force", &registered_path],
            )?;
        } else {
            // final re-check + removal in ONE call — unknown status = refusal
            let st = status(&registered_path, bin_override);
            if st.dirty {
                return Err("refused: the worktree has uncommitted changes".into());
            }
            if st.ahead_unknown {
                return Err(
                    "refused: could not verify the branch's commits — resolve manually".into(),
                );
            }
            if st.ahead > 0 {
                return Err(format!(
                    "refused: branch \"{}\" holds {} local-only commit(s)",
                    derived_branch.as_deref().unwrap_or("(detached)"),
                    st.ahead
                ));
            }
            run(bin, &root_p, &["worktree", "remove", &registered_path])
                .map_err(|e| format!("git refused the removal (worktree not clean?): {e}"))?;
        }
    } else {
        let _ = run(bin, &root_p, &["worktree", "prune"]);
        if !force {
            // a hand-deleted FOLDER may leave a branch holding commits
            // nothing else reaches — the gated path refuses to -D it then
            let Some(derived) = &derived_branch else {
                return Ok(()); // detached, folder gone — nothing to delete
            };
            match branch_ahead(bin, &root_p, derived) {
                Some(0) => {}
                Some(n) => {
                    return Err(format!(
                        "refused: branch \"{derived}\" holds {n} local-only commit(s) — the folder is gone but the branch stays"
                    ))
                }
                None => {
                    // branch already gone entirely? then nothing to delete
                    if run(bin, &root_p, &["rev-parse", "--verify", &format!("refs/heads/{derived}")]).is_ok() {
                        return Err(
                            "refused: could not verify the branch's commits — resolve manually".into(),
                        );
                    }
                    return Ok(());
                }
            }
        }
    }
    // best-effort, DERIVED branch only, TRANSACTIONAL (F3): deleted via
    // `update-ref -d` against the tip captured BEFORE the removal — a tip
    // that moved in between (fresh commit from another process) survives,
    // as does a branch still checked out somewhere. A caller-named branch
    // is never deleted on its own.
    if let (Some(derived), Some(oid)) = (&derived_branch, &expected_oid) {
        let _ = delete_branch_transactional(bin, &root_p, derived, oid);
    }
    Ok(())
}

/// All SwarmZ worktrees (under `.worktrees/`) of the given repo roots, with
/// their live would-lose-work state — feeds the title-bar management panel.
pub fn list(roots: &[String], bin_override: Option<&str>) -> WorktreeScan {
    let bin = git_bin(bin_override);
    let mut scan = WorktreeScan::default();
    for root in roots {
        let root_p = Path::new(root);
        let repo = match root_p.file_name() {
            Some(n) => n.to_string_lossy().into_owned(),
            None => continue,
        };
        let Ok(porcelain) = run(bin, root_p, &["worktree", "list", "--porcelain"]) else {
            continue;
        };
        scan.scanned.push(root.clone());
        let prefix = root_p.join(WORKTREES_DIR);
        // porcelain output: blocks separated by blank lines, first line
        // `worktree <path>`, then `branch refs/heads/<b>` / `prunable …`
        for block in porcelain.split("\n\n") {
            let mut path = None;
            let mut branch = None;
            let mut prunable = false;
            for line in block.lines() {
                if let Some(p) = line.strip_prefix("worktree ") {
                    path = Some(p.to_string());
                } else if let Some(b) = line.strip_prefix("branch ") {
                    branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
                } else if line.starts_with("prunable") {
                    prunable = true;
                }
            }
            let Some(path) = path else { continue };
            if !Path::new(&path).starts_with(&prefix) {
                continue;
            }
            let st = if prunable {
                // folder gone, but the branch may still hold commits nothing
                // else reaches — compute ahead from the main repo so the
                // panel treats the row as risky instead of one-click cleanup
                let ahead = branch.as_deref().and_then(|b| branch_ahead(bin, root_p, b));
                WorktreeStatus {
                    ahead: ahead.unwrap_or(0),
                    ahead_unknown: ahead.is_none(),
                    ..WorktreeStatus::default()
                }
            } else {
                status(&path, bin_override)
            };
            scan.entries.push(WorktreeEntry {
                root: root.clone(),
                repo: repo.clone(),
                path,
                branch: branch.or(st.branch).unwrap_or_else(|| "(detached)".into()),
                dirty: st.dirty,
                ahead: st.ahead,
                ahead_unknown: st.ahead_unknown,
                missing: prunable || !st.exists,
            });
        }
    }
    scan
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_copy_manifest_is_explicit() {
        for allowed in [
            ".env",
            ".env.local",
            ".env.test.local",
            ".npmrc",
            ".tool-versions",
            "setup.local.sh",
        ] {
            assert!(environment_manifest_allows(allowed), "{allowed}");
        }
        for refused in [
            "id_rsa",
            "database.sqlite",
            "archive.zip",
            "config.json",
            "secret.key",
        ] {
            assert!(!environment_manifest_allows(refused), "{refused}");
        }
    }

    #[test]
    #[cfg(unix)]
    fn environment_git_listing_obeys_its_own_deadline() {
        use std::os::unix::fs::PermissionsExt as _;

        let root = std::env::temp_dir().join(format!(
            "swarmz-env-deadline-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let fake = root.join("slow-git");
        fs::write(&fake, "#!/bin/sh\nsleep 5\n").unwrap();
        fs::set_permissions(&fake, fs::Permissions::from_mode(0o700)).unwrap();
        let started = Instant::now();
        let err = run_with_timeout(
            &fake.to_string_lossy(),
            &root,
            &["ls-files"],
            Duration::from_millis(100),
        )
        .unwrap_err();
        assert!(err.contains("timed out"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(2));
        fs::remove_dir_all(root).ok();
    }

    /// Throwaway repo with one commit, a gitignored .env and a node_modules dir.
    fn temp_repo() -> PathBuf {
        // timestamp + counter: parallel tests can start in the same clock
        // tick, and a shared dir makes them destroy each other's fixtures
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "swarmz-wt-test-{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        ));
        fs::create_dir_all(&dir).unwrap();
        // git reports canonical paths (macOS /tmp is a symlink) — match that
        let dir = dir.canonicalize().unwrap();
        let git = |args: &[&str]| run(git_bin(None), &dir, args).unwrap();
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.email", "t@t"]);
        git(&["config", "user.name", "t"]);
        fs::write(dir.join("a.txt"), "hi").unwrap();
        fs::write(dir.join(".gitignore"), ".env*\nsetup.local.sh\n").unwrap();
        fs::write(dir.join(".env"), "SECRET=1").unwrap();
        fs::create_dir_all(dir.join("node_modules")).unwrap();
        fs::write(dir.join("node_modules/big.js"), "x").unwrap();
        git(&["add", "a.txt", ".gitignore"]);
        git(&["commit", "-qm", "init"]);
        dir
    }

    #[test]
    fn add_status_remove_roundtrip() {
        let repo = temp_repo();
        let cwd = repo.to_string_lossy().into_owned();

        let info = add(&cwd, "test/brave-falcon-7341", true, None).unwrap();
        assert_eq!(info.root, cwd);
        assert!(info.path.ends_with(".worktrees/brave-falcon-7341"));
        // env copied, heavyweights skipped
        assert!(Path::new(&info.path).join(".env").exists());
        assert!(!Path::new(&info.path).join("node_modules").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(
                fs::metadata(Path::new(&info.path).join(".env"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        // .worktrees is excluded locally, main repo stays clean
        assert!(fs::read_to_string(repo.join(".git/info/exclude"))
            .unwrap()
            .contains("/.worktrees/"));

        // fresh worktree: nothing to lose (the copied .env is gitignored)
        let st = status(&info.path, None);
        assert!(st.exists && !st.dirty && st.ahead == 0);

        // dirty tracked file → dirty; own commit → ahead
        fs::write(Path::new(&info.path).join("a.txt"), "changed").unwrap();
        assert!(status(&info.path, None).dirty);
        run(
            git_bin(None),
            Path::new(&info.path),
            &["commit", "-qam", "wt"],
        )
        .unwrap();
        let st = status(&info.path, None);
        assert!(!st.dirty && st.ahead == 1);

        // list finds it under the repo root and reports the root as scanned
        let scan = list(std::slice::from_ref(&cwd), None);
        assert_eq!(scan.scanned, vec![cwd.clone()]);
        assert_eq!(scan.entries.len(), 1);
        assert_eq!(scan.entries[0].branch, "test/brave-falcon-7341");
        assert_eq!(scan.entries[0].ahead, 1);

        // the GATED removal refuses local-only work…
        let err = remove(&cwd, &info.path, &info.branch, false, None).unwrap_err();
        assert!(err.contains("local-only commit"), "{err}");
        assert!(Path::new(&info.path).exists());
        // …force deletes folder + branch even with local-only work
        remove(&cwd, &info.path, &info.branch, true, None).unwrap();
        assert!(!Path::new(&info.path).exists());
        assert!(run(
            git_bin(None),
            &repo,
            &["rev-parse", "--verify", "refs/heads/test/brave-falcon-7341"],
        )
        .is_err());
        assert!(list(&[cwd], None).entries.is_empty());

        fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn oversized_manifest_file_is_never_partially_materialized() {
        let repo = temp_repo();
        fs::write(
            repo.join(".env"),
            vec![b'x'; ENV_COPY_MAX_FILE_BYTES as usize + 1],
        )
        .unwrap();
        let cwd = repo.to_string_lossy().into_owned();
        let info = add(&cwd, "test/oversized-env", true, None).unwrap();
        assert!(!Path::new(&info.path).join(".env").exists());
        assert_eq!(info.copied, 0);
        fs::remove_dir_all(repo).ok();
    }

    #[test]
    fn gated_remove_refuses_dirt_and_unknown_state() {
        let repo = temp_repo();
        let cwd = repo.to_string_lossy().into_owned();
        let info = add(&cwd, "test/gated", true, None).unwrap();

        // dirty tracked file → the gated removal refuses, force succeeds
        fs::write(Path::new(&info.path).join("a.txt"), "changed").unwrap();
        let err = remove(&cwd, &info.path, &info.branch, false, None).unwrap_err();
        assert!(err.contains("uncommitted"), "{err}");
        assert!(Path::new(&info.path).exists());

        // clean again → the gated removal passes (the copied gitignored .env
        // does NOT block a non-force `git worktree remove`)
        fs::write(Path::new(&info.path).join("a.txt"), "hi").unwrap();
        assert!(Path::new(&info.path).join(".env").exists());
        remove(&cwd, &info.path, &info.branch, false, None).unwrap();
        assert!(!Path::new(&info.path).exists());

        // hand-deleted folder + local-only commits → gated refuses branch -D
        let info2 = add(&cwd, "test/gated2", false, None).unwrap();
        fs::write(Path::new(&info2.path).join("a.txt"), "wt").unwrap();
        run(
            git_bin(None),
            Path::new(&info2.path),
            &["commit", "-qam", "wt"],
        )
        .unwrap();
        fs::remove_dir_all(&info2.path).unwrap();
        let err = remove(&cwd, &info2.path, &info2.branch, false, None).unwrap_err();
        assert!(err.contains("local-only"), "{err}");
        assert!(
            run(
                git_bin(None),
                &repo,
                &["rev-parse", "--verify", "refs/heads/test/gated2"],
            )
            .is_ok(),
            "the branch must survive the refused gated cleanup"
        );

        fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn status_marks_uncomputable_ahead_as_unknown() {
        // a plain directory that is NOT a git repo: dirty (can't read) and
        // ahead unknown — the gates must refuse, never treat this as clean
        let dir = std::env::temp_dir().join(format!("swarmz-wt-nogit-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let st = status(&dir.to_string_lossy(), None);
        assert!(st.exists);
        assert!(st.dirty, "unreadable state must count as dirty");
        assert!(st.ahead_unknown, "uncomputable ahead must be flagged");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unscannable_root_is_not_reported_as_scanned() {
        let scan = list(&["/nonexistent/swarmz-test-root".into()], None);
        assert!(scan.entries.is_empty());
        assert!(scan.scanned.is_empty());
    }

    #[test]
    fn missing_folder_still_reports_local_only_commits_as_ahead() {
        let repo = temp_repo();
        let cwd = repo.to_string_lossy().into_owned();
        let info = add(&cwd, "test/orphan", false, None).unwrap();
        // commit in the worktree, then delete the folder by hand — the
        // branch now holds a commit nothing else reaches
        fs::write(Path::new(&info.path).join("a.txt"), "wt change").unwrap();
        run(
            git_bin(None),
            Path::new(&info.path),
            &["commit", "-qam", "wt"],
        )
        .unwrap();
        fs::remove_dir_all(&info.path).unwrap();

        let scan = list(std::slice::from_ref(&cwd), None);
        assert_eq!(scan.entries.len(), 1);
        let entry = &scan.entries[0];
        assert!(entry.missing);
        // the panel uses ahead > 0 as its "risky, two-step confirm" gate —
        // a hand-deleted folder must not turn branch deletion into one click
        assert_eq!(entry.ahead, 1);

        fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn add_from_inside_a_worktree_targets_the_main_repo() {
        let repo = temp_repo();
        let cwd = repo.to_string_lossy().into_owned();
        let first = add(&cwd, "test/one", false, None).unwrap();
        // splitting from a worktree pane passes the root, but be safe anyway
        let second = add(&first.path, "test/two", false, None).unwrap();
        assert_eq!(second.root, cwd);
        assert!(second.path.starts_with(&cwd));
        fs::remove_dir_all(&repo).ok();
    }

    /// Audit R5 (frozen): the raw remove surface cannot be steered at
    /// foreign paths or branches — confinement to `<root>/.worktrees`, git
    /// as the identity source, caller branch cross-checked.
    #[test]
    fn remove_refuses_foreign_paths_and_branch_spoofing() {
        let repo = temp_repo();
        let cwd = repo.to_string_lossy().into_owned();
        let info = add(&cwd, "test/confined", false, None).unwrap();

        // (a) paths outside .worktrees refuse — even with force
        for target in [
            cwd.as_str(), // the repo itself
            "/tmp",       // arbitrary host folder
            "/",          // root
            repo.join("src").to_string_lossy().as_ref(),
        ] {
            let err = remove(&cwd, target, "whatever", true, None).unwrap_err();
            assert!(err.contains("refused"), "{target}: {err}");
        }
        // traversal out of .worktrees refuses too
        let sneaky = format!("{}/.worktrees/../..", cwd);
        assert!(remove(&cwd, &sneaky, "x", true, None).is_err());

        // (b) an in-container path git does NOT list refuses
        let fake = repo.join(".worktrees/never-created");
        let err = remove(&cwd, &fake.to_string_lossy(), "x", true, None).unwrap_err();
        assert!(err.contains("no worktree"), "{err}");

        // (c) branch spoofing: the caller naming a FOREIGN branch refuses,
        //     and `main` survives untouched
        let err = remove(&cwd, &info.path, "main", true, None).unwrap_err();
        assert!(err.contains("branch mismatch"), "{err}");
        assert!(run(
            git_bin(None),
            &repo,
            &["rev-parse", "--verify", "refs/heads/main"]
        )
        .is_ok());
        assert!(
            Path::new(&info.path).exists(),
            "the worktree must survive the refusals"
        );

        // (d) the honest call (matching or empty branch) still works
        remove(&cwd, &info.path, "", true, None).unwrap();
        assert!(!Path::new(&info.path).exists());
        assert!(
            run(
                git_bin(None),
                &repo,
                &["rev-parse", "--verify", "refs/heads/test/confined"]
            )
            .is_err(),
            "the derived branch is deleted with the worktree"
        );

        fs::remove_dir_all(&repo).ok();
    }

    /// The env copy is fd-anchored and manifest-only: escaping symlinks and
    /// unrelated untracked files are skipped; an approved regular file is
    /// copied with private permissions.
    #[test]
    #[cfg(unix)]
    fn env_copy_is_anchored_and_never_follows_symlinks() {
        let repo = temp_repo();
        let cwd = repo.to_string_lossy().into_owned();
        // an out-of-tree secret and an in-tree UNTRACKED symlink to it
        let outside = std::env::temp_dir().join(format!("swarmz-c7-out-{}", std::process::id()));
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret"), "s3cr3t").unwrap();
        std::os::unix::fs::symlink(outside.join("secret"), repo.join("link-to-secret")).unwrap();
        // a normal untracked (gitignored) env file — must copy
        fs::write(repo.join(".env.local"), "TOKEN=xyz").unwrap();
        fs::write(repo.join("setup.local.sh"), "#!/bin/sh\necho ready\n").unwrap();
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(
            repo.join("setup.local.sh"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();

        let info = add(&cwd, "test/c7-anchored", true, None).unwrap();
        let dest = Path::new(&info.path);
        // The unrelated symlink is outside the manifest and never appears.
        let copied_link = dest.join("link-to-secret");
        assert!(
            !copied_link.exists(),
            "non-manifest symlinks must not cross into a worktree"
        );
        // the regular untracked file copied through
        assert_eq!(
            fs::read_to_string(dest.join(".env.local")).unwrap(),
            "TOKEN=xyz"
        );
        assert_eq!(
            fs::metadata(dest.join("setup.local.sh"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700,
            "a user-executable runtime file keeps execute, without group/world bits"
        );
        fs::remove_dir_all(&repo).ok();
        fs::remove_dir_all(&outside).ok();
    }

    /// Audit R4 (frozen): a symlinked `.worktrees` container refuses the add
    /// — the checkout and env copy must never be redirected to a host folder.
    #[test]
    fn add_refuses_a_symlinked_worktrees_container() {
        let repo = temp_repo();
        let cwd = repo.to_string_lossy().into_owned();
        let outside = std::env::temp_dir().join(format!("swarmz-wt-out-{}", std::process::id()));
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, repo.join(".worktrees")).unwrap();
        let err = add(&cwd, "test/redirected", true, None).unwrap_err();
        assert!(err.contains("symlink"), "{err}");
        fs::remove_dir_all(&repo).ok();
        fs::remove_dir_all(&outside).ok();
    }

    /// Audits C5+C7 (frozen): the concurrent-attacker simulation. A git
    /// wrapper swaps `.worktrees` for a symlink to a foreign folder right
    /// AFTER `git worktree add` succeeded — and lands a racing commit on the
    /// fresh branch. The add must refuse (the post-add identity
    /// re-verification against the ANCHORED container handle catches the
    /// swap — the pathname now resolves into the evil target), NO env file
    /// may have crossed the swapped path, and the rollback's branch deletion
    /// is transactional — the racing commit survives (C5).
    #[test]
    #[cfg(unix)]
    fn add_refuses_swap_after_checkout_and_rollback_is_transactional() {
        use std::os::unix::fs::PermissionsExt;
        let repo = temp_repo();
        let cwd = repo.to_string_lossy().into_owned();
        let root = repo.to_string_lossy().into_owned();
        let scratch = std::env::temp_dir().join(format!(
            "swarmz-c7-swap-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&scratch).unwrap();
        let evil = scratch.join("evil-target");
        fs::create_dir_all(&evil).unwrap();
        // a would-be exfil sink inside evil — if any env copy crossed the
        // swapped path it would land here
        let marker = scratch.join("swapped");
        let real = git_bin(None);
        let branch = "test/swapped";
        let evil_s = evil.to_string_lossy().into_owned();
        let marker_s = marker.to_string_lossy().into_owned();
        // an untracked env file the copy WOULD move if the add didn't refuse
        fs::write(repo.join(".env.local"), "TOKEN=xyz").unwrap();
        let wrapper = scratch.join("git-wrapper.sh");
        // the wrapper passes everything through to real git; on the FIRST
        // `worktree add` it runs it, then swaps `.worktrees` for a symlink to
        // `evil` and lands a racing commit on the new branch (moving its tip)
        let script = format!(
            "#!/bin/sh\n\
             REAL='{real}'\n\
             for a in \"$@\"; do\n\
             \x20 if [ \"$a\" = add ]; then IS_ADD=1; fi\n\
             done\n\
             \"$REAL\" \"$@\"\n\
             RC=$?\n\
             if [ \"$IS_ADD\" = 1 ] && [ ! -f '{marker_s}' ]; then\n\
             \x20 : > '{marker_s}'\n\
             \x20 mv '{root}/.worktrees' '{root}/.wt-moved'\n\
             \x20 ln -s '{evil_s}' '{root}/.worktrees'\n\
             \x20 WT='{root}/.wt-moved/swapped'\n\
             \x20 echo racing > \"$WT/a.txt\"\n\
             \x20 \"$REAL\" -C \"$WT\" commit -qam racing\n\
             fi\n\
             exit $RC\n"
        );
        fs::write(&wrapper, script).unwrap();
        let mut perm = fs::metadata(&wrapper).unwrap().permissions();
        perm.set_mode(0o755);
        fs::set_permissions(&wrapper, perm).unwrap();

        let err = add(&cwd, branch, true, Some(&wrapper.to_string_lossy())).unwrap_err();
        assert!(err.contains("redirected"), "{err}");
        // C7: no env file crossed into the evil target
        assert!(
            !evil.join("swapped/.env.local").exists() && !evil.join(".env.local").exists(),
            "an env file was copied through the swapped path"
        );
        // C5: the racing commit survives — the transactional rollback delete
        // (expected-OID = HEAD before the add) refused because the branch tip
        // moved. The branch still exists and holds the racing commit.
        let tip = branch_oid(real, &repo, branch);
        assert!(
            tip.is_some(),
            "the rollback must not delete a branch whose tip moved (racing commit lost)"
        );
        // restore a sane .worktrees for cleanup, then drop everything
        let _ = fs::remove_file(repo.join(".worktrees"));
        fs::remove_dir_all(&repo).ok();
        fs::remove_dir_all(&scratch).ok();
    }

    /// Final hardening F3 (frozen): the branch deletion is transactional —
    /// a tip that MOVED after the OID capture (the race: another process
    /// lands a commit between the ahead re-check and the delete) survives;
    /// only the expected OID deletes.
    #[test]
    fn branch_delete_is_transactional_against_oid_movement() {
        let repo = temp_repo();
        let bin = git_bin(None);
        let g = |args: &[&str]| run(bin, &repo, args).unwrap();
        g(&["branch", "swarm/txn"]);
        let oid_a = branch_oid(bin, &repo, "swarm/txn").expect("branch tip");
        // the race: a fresh commit moves the branch tip after the capture
        fs::write(repo.join("a.txt"), "moved").unwrap();
        g(&["add", "a.txt"]);
        g(&["commit", "-qm", "race commit"]);
        g(&["branch", "-f", "swarm/txn", "HEAD"]);
        let oid_b = branch_oid(bin, &repo, "swarm/txn").expect("moved tip");
        assert_ne!(oid_a, oid_b, "the tip must have moved");
        // deleting against the STALE oid fails — the branch (and the new
        // commit) survive
        assert!(
            delete_branch_transactional(bin, &repo, "swarm/txn", &oid_a).is_err(),
            "a moved tip must refuse the delete"
        );
        assert_eq!(
            branch_oid(bin, &repo, "swarm/txn").as_deref(),
            Some(oid_b.as_str()),
            "the branch with the racing commit must survive"
        );
        // against the CURRENT oid the delete goes through
        delete_branch_transactional(bin, &repo, "swarm/txn", &oid_b).unwrap();
        assert!(branch_oid(bin, &repo, "swarm/txn").is_none());
        fs::remove_dir_all(&repo).ok();
    }

    /// F3 companion: a branch checked out ANYWHERE (worktree or the main
    /// checkout) is never deleted — `update-ref -d` would not protect that
    /// the way `branch -D` did, so the transactional path re-checks it.
    #[test]
    fn branch_delete_refuses_checked_out_branches() {
        let repo = temp_repo();
        let bin = git_bin(None);
        let cwd = repo.to_string_lossy().into_owned();
        let info = add(&cwd, "test/checkedout", false, None).unwrap();
        let oid = branch_oid(bin, &repo, &info.branch).expect("worktree branch tip");
        let err = delete_branch_transactional(bin, &repo, &info.branch, &oid).unwrap_err();
        assert!(err.contains("checked out"), "{err}");
        assert!(
            branch_oid(bin, &repo, &info.branch).is_some(),
            "branch survives"
        );
        // the main checkout's branch refuses too
        let main_oid = branch_oid(bin, &repo, "main").expect("main tip");
        assert!(delete_branch_transactional(bin, &repo, "main", &main_oid).is_err());
        assert!(branch_oid(bin, &repo, "main").is_some());
        fs::remove_dir_all(&repo).ok();
    }

    /// Final hardening F9 (frozen): an exclude file beyond the bounded-read
    /// cap refuses the rewrite — a truncated-prefix rewrite would silently
    /// drop later exclude rules (potentially exposing ignored secrets).
    #[test]
    fn oversized_exclude_refuses_rewrite() {
        let repo = temp_repo();
        let cwd = repo.to_string_lossy().into_owned();
        // an entry-less exclude just beyond 1 MiB
        let big = format!("# padding\n{}\n", "x".repeat(1024 * 1024));
        fs::write(repo.join(".git/info/exclude"), &big).unwrap();
        let err = add(&cwd, "test/too-big", false, None).unwrap_err();
        assert!(err.contains("refusing to rewrite"), "{err}");
        // the exclude file was NOT truncated
        assert_eq!(
            fs::metadata(repo.join(".git/info/exclude")).unwrap().len(),
            big.len() as u64,
            "the oversized exclude must stay untouched"
        );
        // an oversized exclude that ALREADY has the entry needs no rewrite —
        // the add passes
        let big_with_entry = format!("/.worktrees/\n{}\n", "x".repeat(1024 * 1024));
        fs::write(repo.join(".git/info/exclude"), &big_with_entry).unwrap();
        add(&cwd, "test/big-but-present", false, None).unwrap();
        fs::remove_dir_all(&repo).ok();
    }

    /// Audit C1 (frozen): the backend's own git NEVER executes repository-
    /// controlled code. The chain this closes: a repo sets `core.hooksPath`
    /// at a TRACKED folder (husky style), a workspace agent edits the hook
    /// body (a plain sandbox-permitted file edit), and an autonomous
    /// `create_worktree` would then run `post-checkout` UNSANDBOXED in the
    /// Tauri backend; `git status` would run a configured `core.fsmonitor`
    /// hook; the branch cleanup would run `reference-transaction`. With the
    /// `git_command` suppressions none of them ever fires.
    #[test]
    #[cfg(unix)]
    fn backend_git_never_fires_repo_hooks() {
        use std::os::unix::fs::PermissionsExt;
        let repo = temp_repo();
        let cwd = repo.to_string_lossy().into_owned();
        let marker = repo.join("HOOK_FIRED");
        let hook_body = format!("#!/bin/sh\n: > \"{}\"\n", marker.display());
        // hooks in BOTH the default dir and a husky-style tracked hooksPath
        let tracked_hooks = repo.join("hooks");
        for dir in [repo.join(".git/hooks"), tracked_hooks.clone()] {
            fs::create_dir_all(&dir).unwrap();
            for name in [
                "post-checkout",
                "post-commit",
                "pre-push",
                "reference-transaction",
                "post-index-change",
            ] {
                let p = dir.join(name);
                fs::write(&p, &hook_body).unwrap();
                let mut perm = fs::metadata(&p).unwrap().permissions();
                perm.set_mode(0o755);
                fs::set_permissions(&p, perm).unwrap();
            }
        }
        let git_raw = |args: &[&str]| {
            // RAW git, deliberately WITHOUT the suppressions — the positive
            // control and the config setup
            let out = std::process::Command::new(git_bin(None))
                .arg("-C")
                .arg(&repo)
                .args(args)
                .output()
                .unwrap();
            assert!(out.status.success(), "raw git {args:?} failed");
        };
        git_raw(&["config", "core.hooksPath", "hooks"]);
        // positive control: without suppression the fixture DOES fire —
        // otherwise this test would prove nothing
        git_raw(&["commit", "--allow-empty", "-qm", "control"]);
        assert!(
            marker.exists(),
            "fixture broken: the raw-git positive control did not fire the hook"
        );
        fs::remove_file(&marker).unwrap();
        // a repo-config fsmonitor "hook" (the `git status` execution vector)
        git_raw(&[
            "config",
            "core.fsmonitor",
            &tracked_hooks.join("post-checkout").to_string_lossy(),
        ]);

        // the suppressed surface: worktree add (post-checkout), status
        // (fsmonitor), gated remove incl. transactional branch delete
        // (reference-transaction) — none may fire a hook. copy_env=false so
        // the untracked `hooks/` fixture doesn't dirty the worktree; the
        // status query still exercises the fsmonitor vector.
        let info = add(&cwd, "test/hooks-suppressed", false, None).unwrap();
        let st = status(&info.path, None);
        assert!(st.exists && st.ahead == 0, "{st:?}");
        remove(&cwd, &info.path, &info.branch, false, None).unwrap();
        assert!(
            !marker.exists(),
            "a repository-controlled hook ran inside the unsandboxed backend"
        );
        fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn invalid_branch_and_duplicate_folder_are_rejected() {
        let repo = temp_repo();
        let cwd = repo.to_string_lossy().into_owned();
        assert!(add(&cwd, "bad..name", false, None).is_err());
        add(&cwd, "test/dup", false, None).unwrap();
        // same slug → same folder → must refuse, not clobber
        assert!(add(&cwd, "other/dup", false, None).is_err());
        fs::remove_dir_all(&repo).ok();
    }
}
