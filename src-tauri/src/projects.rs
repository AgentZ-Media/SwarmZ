//! Project discovery (the "open project" recents + the orchestrator's
//! list_projects). Merges every place a project folder can be known from —
//! Codex rollout history (`~/.codex/sessions` session_meta), folders the
//! frontend already knows (open projects, sessions, notes, worktree repos,
//! last used folder) and an optional shallow filesystem scan for git repos —
//! into one deduped, recency-sorted list. Read-only: stat/mtime plus
//! head-reads of single jsonl files, never full parses. Codex-only.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::Path;
use walkdir::WalkDir;

/// Bytes read from a jsonl head when looking for the cwd field.
const HEAD_BYTES: u64 = 64 * 1024;
/// Directories the shallow scan never descends into.
const SCAN_SKIP: &[&str] = &["node_modules", "target", "dist", ".worktrees"];

/// A folder the frontend already knows about, with where it came from
/// (e.g. "project", "session", "notes", "worktree-repo", "last-used").
#[derive(Deserialize, Clone, Debug)]
pub struct KnownFolder {
    pub path: String,
    pub source: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct ProjectEntry {
    pub path: String,
    /// folder basename
    pub name: String,
    /// newest observed activity, epoch ms — None for sources without one
    pub last_activity: Option<i64>,
    /// every source that contributed this folder
    pub sources: Vec<String>,
    /// the folder still exists on disk
    pub exists: bool,
}

fn file_modified_ms(path: &Path) -> Option<i64> {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
}

/// Head-read a Codex rollout jsonl and return the first
/// `session_meta.payload.cwd` found.
fn cwd_from_jsonl_head(path: &Path) -> Option<String> {
    let Ok(f) = fs::File::open(path) else {
        return None;
    };
    let mut buf = Vec::new();
    f.take(HEAD_BYTES).read_to_end(&mut buf).ok()?;
    for line in buf.split(|&b| b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_slice::<serde_json::Value>(line) else {
            continue; // possibly the cut-off last line of the window
        };
        if let Some(c) = v.pointer("/payload/cwd").and_then(|c| c.as_str()) {
            return Some(c.to_string());
        }
    }
    None
}

/// Normalize for dedupe: worktree paths collapse onto the main repo root,
/// existing paths canonicalize (symlinks, trailing slashes).
fn normalize_path(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let collapsed = crate::transcript::collapse_worktree_path(Path::new(trimmed));
    if collapsed.as_os_str().is_empty() {
        return None;
    }
    let canon = fs::canonicalize(&collapsed).unwrap_or(collapsed);
    Some(canon.to_string_lossy().into_owned())
}

fn add_entry(
    map: &mut HashMap<String, ProjectEntry>,
    raw_path: &str,
    last_activity: Option<i64>,
    source: &str,
) {
    let Some(path) = normalize_path(raw_path) else {
        return;
    };
    let entry = map.entry(path.clone()).or_insert_with(|| ProjectEntry {
        name: Path::new(&path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone()),
        exists: Path::new(&path).is_dir(),
        path,
        last_activity: None,
        sources: Vec::new(),
    });
    if !entry.sources.iter().any(|s| s == source) {
        entry.sources.push(source.to_string());
    }
    entry.last_activity = match (entry.last_activity, last_activity) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    };
}

/// Codex source: every rollout under `~/.codex/sessions` carries the cwd in
/// its `session_meta` head line; per-cwd last activity = newest file mtime.
fn add_codex_projects(map: &mut HashMap<String, ProjectEntry>, root: &Path) {
    if !root.is_dir() {
        return;
    }
    for entry in WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
    {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        if let Some(cwd) = cwd_from_jsonl_head(p) {
            add_entry(map, &cwd, file_modified_ms(p), "codex");
        }
    }
}

/// Shallow scan (depth ≤ 2) for dirs containing `.git` — a file counts too
/// (worktrees have a `.git` file). Hidden dirs and heavyweights are skipped;
/// a found repo is not descended into further.
fn scan_dir(map: &mut HashMap<String, ProjectEntry>, dir: &Path, depth: u32) {
    if dir.join(".git").exists() {
        add_entry(map, &dir.to_string_lossy(), None, "scan");
        return;
    }
    if depth >= 2 {
        return;
    }
    let Ok(children) = fs::read_dir(dir) else {
        return;
    };
    for child in children.flatten() {
        let p = child.path();
        if !p.is_dir() {
            continue;
        }
        let name = child.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || SCAN_SKIP.contains(&name.as_ref()) {
            continue;
        }
        scan_dir(map, &p, depth + 1);
    }
}

/// Merge all sources; see the module docs. Roots are injectable for tests —
/// the Tauri command passes the real `~/.codex` location.
pub fn discover(
    codex_sessions_root: Option<&Path>,
    scan_roots: &[String],
    known: &[KnownFolder],
) -> Vec<ProjectEntry> {
    let mut map: HashMap<String, ProjectEntry> = HashMap::new();
    if let Some(root) = codex_sessions_root {
        add_codex_projects(&mut map, root);
    }
    for kf in known {
        add_entry(&mut map, &kf.path, None, &kf.source);
    }
    for root in scan_roots {
        let p = Path::new(root.trim());
        if p.is_dir() {
            scan_dir(&mut map, p, 0);
        }
    }
    let mut entries: Vec<ProjectEntry> = map.into_values().collect();
    sort_entries(&mut entries);
    entries
}

/// Most recent first; folders without any observed activity last.
fn sort_entries(entries: &mut [ProjectEntry]) {
    entries.sort_by(|a, b| match (a.last_activity, b.last_activity) {
        (Some(x), Some(y)) => y.cmp(&x),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.name.cmp(&b.name),
    });
}

/// Command-level entry with the real home-dir root.
pub fn discover_default(scan_roots: &[String], known: &[KnownFolder]) -> Vec<ProjectEntry> {
    let codex = dirs::home_dir()
        .map(|h| h.join(".codex").join("sessions"))
        .filter(|d| d.is_dir());
    discover(codex.as_deref(), scan_roots, known)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir() -> PathBuf {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "swarmz-projects-test-{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        ));
        fs::create_dir_all(&dir).unwrap();
        // canonicalize: macOS temp dirs live behind /var → /private/var
        dir.canonicalize().unwrap()
    }

    fn known(path: &Path, source: &str) -> KnownFolder {
        KnownFolder {
            path: path.to_string_lossy().into_owned(),
            source: source.to_string(),
        }
    }

    #[test]
    fn merges_dedupes_and_collapses_worktrees() {
        let dir = temp_dir();
        let repo = dir.join("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        let wt = repo.join(".worktrees").join("slug");
        fs::create_dir_all(&wt).unwrap();

        let entries = discover(
            None,
            &[],
            &[
                known(&repo, "workspace"),
                known(&wt, "notes"),                    // collapses onto repo
                known(&repo.join("trailing/"), "x"),    // nonexistent → own entry
                known(&repo, "workspace"),              // exact duplicate
            ],
        );
        let repo_entry = entries
            .iter()
            .find(|e| e.path == repo.to_string_lossy())
            .unwrap();
        assert_eq!(repo_entry.sources, vec!["workspace", "notes"]);
        assert!(repo_entry.exists);
        assert_eq!(repo_entry.name, "repo");
        // the worktree path itself never shows up
        assert!(!entries.iter().any(|e| e.path.contains(".worktrees")));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn shallow_scan_finds_repos_to_depth_two_and_skips_noise() {
        let dir = temp_dir();
        // depth 1 repo with a .git DIR
        fs::create_dir_all(dir.join("one/.git")).unwrap();
        // depth 2 repo with a .git FILE (worktree-style)
        fs::create_dir_all(dir.join("group/two")).unwrap();
        fs::write(dir.join("group/two/.git"), "gitdir: elsewhere").unwrap();
        // depth 3 repo — beyond the shallow limit
        fs::create_dir_all(dir.join("a/b/three/.git")).unwrap();
        // noise that must be skipped
        fs::create_dir_all(dir.join("node_modules/pkg/.git")).unwrap();
        fs::create_dir_all(dir.join(".hidden/repo/.git")).unwrap();

        let entries = discover(None, &[dir.to_string_lossy().into_owned()], &[]);
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
        assert!(paths.contains(&dir.join("one").to_string_lossy().as_ref()));
        assert!(paths.contains(&dir.join("group/two").to_string_lossy().as_ref()));
        assert_eq!(entries.len(), 2, "unexpected entries: {paths:?}");
        assert!(entries.iter().all(|e| e.sources == vec!["scan"]));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn codex_source_reads_cwd_from_session_meta() {
        let dir = temp_dir();
        let proj = dir.join("codex-proj");
        fs::create_dir_all(&proj).unwrap();
        let sessions = dir.join("sessions/2026/01/02");
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            sessions.join("rollout-2026-01-02T09-00-00-019fabc.jsonl"),
            format!(
                r#"{{"timestamp":"2026-01-02T09:00:00Z","type":"session_meta","payload":{{"session_id":"019fabc","cwd":"{}"}}}}"#,
                proj.to_string_lossy()
            ) + "\n",
        )
        .unwrap();

        let entries = discover(Some(&dir.join("sessions")), &[], &[]);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, proj.to_string_lossy());
        assert_eq!(entries[0].sources, vec!["codex"]);
        assert!(entries[0].last_activity.is_some());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sorted_by_recency_with_unknown_activity_last() {
        let dir = temp_dir();
        let old = dir.join("old-proj");
        let new = dir.join("new-proj");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&new).unwrap();

        let mut map = HashMap::new();
        add_entry(&mut map, &old.to_string_lossy(), Some(1000), "codex");
        add_entry(&mut map, &new.to_string_lossy(), Some(2000), "codex");
        add_entry(&mut map, &dir.join("no-activity").to_string_lossy(), None, "workspace");
        let mut entries: Vec<ProjectEntry> = map.into_values().collect();
        sort_entries(&mut entries);
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["new-proj", "old-proj", "no-activity"]);
        // activity merge takes the max
        let mut map = HashMap::new();
        add_entry(&mut map, &old.to_string_lossy(), Some(1000), "codex");
        add_entry(&mut map, &old.to_string_lossy(), Some(5000), "session");
        let e = map.into_values().next().unwrap();
        assert_eq!(e.last_activity, Some(5000));
        assert_eq!(e.sources, vec!["codex", "session"]);
        fs::remove_dir_all(&dir).ok();
    }
}
