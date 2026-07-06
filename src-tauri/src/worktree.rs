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
fn ensure_excluded(root: &Path) -> Result<(), String> {
    let info = root.join(".git").join("info");
    let exclude = info.join("exclude");
    let current = fs::read_to_string(&exclude).unwrap_or_default();
    let has_entry = current.lines().any(|l| {
        matches!(l.trim(), "/.worktrees/" | "/.worktrees" | ".worktrees/" | ".worktrees")
    });
    if has_entry {
        return Ok(());
    }
    fs::create_dir_all(&info).map_err(|e| e.to_string())?;
    let mut next = current;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str("# SwarmZ worktrees\n/.worktrees/\n");
    fs::write(&exclude, next).map_err(|e| e.to_string())
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

    let path = root.join(WORKTREES_DIR).join(slug(branch));
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
/// and not from any remote. Works from any directory of the repo.
fn branch_ahead(bin: &str, cwd: &Path, branch: &str) -> u64 {
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
    .unwrap_or(0)
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
    // branch and not from any remote (a pushed branch is safe to delete)
    let ahead = match &branch {
        Some(b) => branch_ahead(bin, p, b),
        None => run(
            bin,
            p,
            &["rev-list", "--count", "HEAD", "--not", "--branches", "--remotes"],
        )
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0),
    };

    WorktreeStatus {
        exists: true,
        dirty,
        ahead,
        branch,
    }
}

/// Remove the worktree folder and delete its branch. `force` discards
/// uncommitted changes / local-only commits — callers gate it on `status` or an
/// explicit user confirmation. A hand-deleted folder is pruned instead.
pub fn remove(
    root: &str,
    path: &str,
    branch: &str,
    bin_override: Option<&str>,
) -> Result<(), String> {
    let bin = git_bin(bin_override);
    let root_p = Path::new(root);
    if Path::new(path).exists() {
        // --force always: the copied env files are untracked, and our own
        // status check / the user's confirmation is the actual safety gate
        run(bin, root_p, &["worktree", "remove", "--force", path])?;
    } else {
        let _ = run(bin, root_p, &["worktree", "prune"]);
    }
    // best-effort: the branch may be checked out elsewhere or already gone
    let _ = run(bin, root_p, &["branch", "-D", branch]);
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
                WorktreeStatus {
                    ahead: branch
                        .as_deref()
                        .map(|b| branch_ahead(bin, root_p, b))
                        .unwrap_or(0),
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
        let scan = list(&[cwd.clone()], None);
        assert_eq!(scan.scanned, vec![cwd.clone()]);
        assert_eq!(scan.entries.len(), 1);
        assert_eq!(scan.entries[0].branch, "test/brave-falcon-7341");
        assert_eq!(scan.entries[0].ahead, 1);

        // remove deletes folder + branch even with local-only work (force)
        remove(&cwd, &info.path, &info.branch, None).unwrap();
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

        let scan = list(&[cwd.clone()], None);
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
