//! Git worktree management for agent panes — create a worktree under
//! `<repo>/.worktrees/<slug>`, copy the untracked environment over, report
//! whether closing one would lose work, and remove it again. Unlike `git.rs`
//! (strictly read-only) this module deliberately writes: `git worktree
//! add/remove`, `git branch -D` and the repo-local `.git/info/exclude` entry
//! (never the tracked `.gitignore`).

use crate::git::{git_bin, output_with_timeout};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

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
    // that must not hang forever on a dead network volume
    let out = output_with_timeout(
        Command::new(bin).arg("-C").arg(cwd).args(args),
        Duration::from_secs(120),
    )
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
    use crate::fsx::DirHandle;
    use std::io::{Read as _, Write as _};
    let handle = DirHandle::open_root(root)?;
    let git = handle
        .open_dir(".git")
        .map_err(|e| format!("refusing the .git component (symlink?): {e}"))?;
    let info = git
        .ensure_dir("info")
        .map_err(|e| format!("refusing the .git/info component (symlink?): {e}"))?;
    let current = match info.open_file("exclude") {
        Ok(Some(file)) => {
            let mut s = String::new();
            // bounded — an exclude file is small; 1 MiB of it is plenty
            std::io::Read::take(file, 1024 * 1024)
                .read_to_string(&mut s)
                .map_err(|e| e.to_string())?;
            s
        }
        Ok(None) => String::new(),
        Err(e) => return Err(format!("refusing the exclude file (symlink?): {e}")),
    };
    let has_entry = current.lines().any(|l| {
        matches!(l.trim(), "/.worktrees/" | "/.worktrees" | ".worktrees/" | ".worktrees")
    });
    if has_entry {
        return Ok(());
    }
    let mut next = current;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str("# SwarmZ worktrees\n/.worktrees/\n");
    let tmp_name = format!(
        ".exclude.tmp-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let mut tmp = info.create_new(&tmp_name)?;
    if let Err(e) = tmp.write_all(next.as_bytes()) {
        let _ = info.unlink(&tmp_name);
        return Err(e.to_string());
    }
    drop(tmp);
    if let Err(e) = info.rename(&tmp_name, "exclude") {
        let _ = info.unlink(&tmp_name);
        return Err(e);
    }
    Ok(())
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
    if s.is_empty() { "worktree".into() } else { s }
}

/// Copy every untracked file of the main repo into the worktree — `.env`s,
/// local configs, keys — skipping the heavyweight cache/build dirs. This is
/// what makes a fresh worktree "just work" like the main checkout.
fn copy_environment(bin: &str, root: &Path, dest: &Path) -> u64 {
    // --others without --exclude-standard = ALL untracked files, including
    // gitignored ones (which is the point: .env etc. are usually ignored)
    let list = match run(bin, root, &["ls-files", "--others", "-z"]) {
        Ok(l) => l,
        Err(_) => return 0,
    };
    let mut copied = 0u64;
    for rel in list.split('\0').filter(|r| !r.is_empty()) {
        let skip = Path::new(rel)
            .components()
            .any(|c| SKIP_DIRS.contains(&c.as_os_str().to_string_lossy().as_ref()));
        if skip {
            continue;
        }
        let src = root.join(rel);
        let dst = dest.join(rel);
        let Ok(meta) = src.symlink_metadata() else {
            continue;
        };
        if let Some(parent) = dst.parent() {
            if fs::create_dir_all(parent).is_err() {
                continue;
            }
        }
        // best-effort per file — one unreadable file must not fail the spawn
        let ok = if meta.file_type().is_symlink() {
            fs::read_link(&src)
                .and_then(|t| std::os::unix::fs::symlink(t, &dst))
                .is_ok()
        } else {
            fs::copy(&src, &dst).is_ok()
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

    // audit R4: a symlinked `.worktrees` would redirect the whole checkout
    // (and the env copy — .env files included) to an arbitrary host folder
    let container = root.join(WORKTREES_DIR);
    if container
        .symlink_metadata()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(format!(
            "refusing: {} is a symlink — worktrees must live in a real folder",
            container.display()
        ));
    }
    let path = container.join(slug(branch));
    if path.exists() {
        return Err(format!(
            "worktree folder already exists: {}",
            path.display()
        ));
    }
    ensure_excluded(&root)?;

    let path_str = path.to_string_lossy().into_owned();
    run(bin, &root, &["worktree", "add", "-b", branch, &path_str])?;

    let copied = if copy_env {
        copy_environment(bin, &root, &path)
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
            &["rev-list", "--count", "HEAD", "--not", "--branches", "--remotes"],
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
///     (the TOCTOU net; copied gitignored env files don't block it).
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

    if Path::new(&registered_path).exists() {
        if force {
            run(bin, &root_p, &["worktree", "remove", "--force", &registered_path])?;
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
    // best-effort, DERIVED branch only: it may be checked out elsewhere or
    // already gone; a caller-named branch is never deleted on its own
    if let Some(derived) = &derived_branch {
        let _ = run(bin, &root_p, &["branch", "-D", derived]);
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
        fs::write(dir.join(".gitignore"), ".env\n").unwrap();
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
        run(git_bin(None), Path::new(&info.path), &["commit", "-qam", "wt"]).unwrap();
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
        run(git_bin(None), Path::new(&info2.path), &["commit", "-qam", "wt"]).unwrap();
        fs::remove_dir_all(&info2.path).unwrap();
        let err = remove(&cwd, &info2.path, &info2.branch, false, None).unwrap_err();
        assert!(err.contains("local-only"), "{err}");
        assert!(run(
            git_bin(None),
            &repo,
            &["rev-parse", "--verify", "refs/heads/test/gated2"],
        )
        .is_ok(), "the branch must survive the refused gated cleanup");

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
        run(git_bin(None), Path::new(&info.path), &["commit", "-qam", "wt"]).unwrap();
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
            cwd.as_str(),                       // the repo itself
            "/tmp",                             // arbitrary host folder
            "/",                                // root
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
        assert!(run(git_bin(None), &repo, &["rev-parse", "--verify", "refs/heads/main"]).is_ok());
        assert!(Path::new(&info.path).exists(), "the worktree must survive the refusals");

        // (d) the honest call (matching or empty branch) still works
        remove(&cwd, &info.path, "", true, None).unwrap();
        assert!(!Path::new(&info.path).exists());
        assert!(
            run(git_bin(None), &repo, &["rev-parse", "--verify", "refs/heads/test/confined"]).is_err(),
            "the derived branch is deleted with the worktree"
        );

        fs::remove_dir_all(&repo).ok();
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
