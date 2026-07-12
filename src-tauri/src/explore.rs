//! Conductor read-only project exploration — the backing of the `list_files`
//! and `read_file` tools. The Conductor's doctrine forbids shell access, so
//! without these it cannot ground a decomposition in the actual repo layout;
//! these give it a BOUNDED, fail-closed window into the project tree and
//! nothing else:
//!
//! - the project dir comes from the trusted chat context (never the model),
//! - the RELATIVE path is validated component by component (no absolute
//!   paths, no `..`, no empty/`.` components, no backslashes, no NUL) and
//!   walked through anchored NO-FOLLOW `DirHandle`s (fsx.rs) — a symlink
//!   anywhere on the chain refuses, so nothing outside the project root is
//!   ever reachable,
//! - HIDDEN components (a leading `.`) are refused outright: `.env`, `.git`,
//!   `.swarmz`, `.worktrees` and friends are neither listable nor readable
//!   through this surface,
//! - listings never DESCEND into dependency/build dirs (node_modules, target,
//!   …) and are capped; reads are bounded and refuse binary content instead
//!   of dumping it into the model context.

use serde::Serialize;
use std::io::Read;
use std::path::Path;

use crate::fsx::{DirHandle, EntryKind};

/// Max entries one listing returns (the excess sets `truncated`).
pub const MAX_LIST_ENTRIES: usize = 500;
/// Max depth a listing may descend (clamped).
pub const MAX_LIST_DEPTH: u32 = 3;
/// Bounded read cap for one file (the excess sets `truncated`).
pub const MAX_READ_BYTES: usize = 128 * 1024;
/// Max length of the model-supplied relative path.
const MAX_REL_PATH_CHARS: usize = 1024;

/// Dependency/build dirs a listing lists as an entry but never descends
/// into (same family as worktree.rs::SKIP_DIRS — hidden dirs are already
/// excluded by the dot rule).
const NO_DESCEND: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "coverage",
    "venv",
    "__pycache__",
];

#[derive(Serialize, Clone, Debug)]
pub struct FsEntry {
    /// path relative to the project root, `/`-separated
    pub path: String,
    /// "file" | "dir"
    pub kind: &'static str,
    /// file size in bytes (files only)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Serialize, Clone, Debug)]
pub struct FsListing {
    /// the listed folder, relative to the project root ("." = the root)
    pub root: String,
    pub entries: Vec<FsEntry>,
    /// true = the entry cap cut the listing short
    pub truncated: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct FsFile {
    pub path: String,
    pub content: String,
    /// true = the byte cap cut the content short
    pub truncated: bool,
    /// the file's full size in bytes
    pub size: u64,
}

/// Split + validate one model-supplied relative path into components. Fail
/// closed: absolute paths, traversal, empty/`.` components, backslashes,
/// NUL and HIDDEN components (leading `.`) all refuse.
fn components_of(rel: &str) -> Result<Vec<&str>, String> {
    let rel = rel.trim();
    if rel.chars().count() > MAX_REL_PATH_CHARS {
        return Err("path too long".into());
    }
    if rel.starts_with('/') || rel.starts_with('~') {
        return Err(format!(
            "absolute paths are not allowed here — pass a path relative to the project root, got {rel:?}"
        ));
    }
    // ':' is rejected wholesale: on Windows a `C:`-prefixed component makes
    // `PathBuf::join` DISCARD the base path (drive-prefix semantics), and no
    // legitimate project-relative path needs one — fail closed on any colon
    if rel.contains('\\') || rel.contains('\0') || rel.contains(':') {
        return Err(format!("invalid path {rel:?}"));
    }
    let mut out = Vec::new();
    for comp in rel.split('/') {
        if comp.is_empty() || comp == "." {
            continue; // "a//b" and "./a" normalize harmlessly
        }
        if comp == ".." {
            return Err(format!("path traversal is not allowed: {rel:?}"));
        }
        if comp.starts_with('.') {
            return Err(format!(
                "hidden files and folders are not served through this tool: {comp:?}"
            ));
        }
        out.push(comp);
    }
    Ok(out)
}

/// Open the project root as the trusted anchor (plans.rs pattern — the
/// project dir comes from the trusted project record, never the model).
fn open_project_root(project_dir: &str) -> Result<DirHandle, String> {
    let trimmed = project_dir.trim();
    if trimmed.is_empty() || !Path::new(trimmed).is_dir() {
        return Err("no usable project folder".into());
    }
    DirHandle::open_root(Path::new(trimmed))
}

/// Walk `components` from the root, one anchored no-follow hop per
/// component — a symlinked component refuses.
fn walk_dirs(root: &DirHandle, components: &[&str]) -> Result<DirHandle, String> {
    let mut cur = root.try_clone()?;
    for comp in components {
        cur = cur
            .open_dir(comp)
            .map_err(|e| format!("could not enter {comp:?}: {e}"))?;
    }
    Ok(cur)
}

/// Names of one directory's children, sorted, via the display path (the
/// plans.rs enumeration pattern: names come from `read_dir`, every per-entry
/// CHECK and OPEN then runs through the anchored handle).
fn child_names(project_dir: &str, base: &[&str], below: &[String]) -> Vec<String> {
    let mut path = Path::new(project_dir.trim()).to_path_buf();
    for c in base {
        path.push(c);
    }
    for c in below {
        path.push(c);
    }
    let Ok(entries) = std::fs::read_dir(&path) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|n| !n.starts_with('.')) // hidden entries are never served
        .collect();
    names.sort();
    names
}

fn rel_join(components: &[&str]) -> String {
    if components.is_empty() {
        ".".into()
    } else {
        components.join("/")
    }
}

/// List the project tree under `rel` (default the root), bounded: at most
/// `MAX_LIST_ENTRIES` entries, `depth` levels (clamped to `MAX_LIST_DEPTH`),
/// no descent into dependency/build dirs, hidden entries excluded, symlinks
/// skipped (never followed).
pub fn list(project_dir: &str, rel: &str, depth: u32) -> Result<FsListing, String> {
    let base = components_of(rel)?;
    let root = open_project_root(project_dir)?;
    let dir = walk_dirs(&root, &base)?;
    let depth = depth.clamp(1, MAX_LIST_DEPTH);

    let mut entries: Vec<FsEntry> = Vec::new();
    let mut truncated = false;
    // (handle, rel components below `base`, remaining depth)
    let mut queue: Vec<(DirHandle, Vec<String>, u32)> = vec![(dir, Vec::new(), depth)];
    while let Some((dir, below, remaining)) = queue.pop() {
        for name in child_names(project_dir, &base, &below) {
            if entries.len() >= MAX_LIST_ENTRIES {
                truncated = true;
                break;
            }
            // classify ON THE HANDLE (lstat, no-follow) — a symlink or
            // special file is skipped, never followed
            let kind = match dir.kind(&name) {
                Ok(Some(EntryKind::File)) => "file",
                Ok(Some(EntryKind::Dir)) => "dir",
                _ => continue,
            };
            let mut rel_path: Vec<&str> = base.to_vec();
            let below_strs: Vec<&str> = below.iter().map(String::as_str).collect();
            rel_path.extend(below_strs);
            rel_path.push(&name);
            let size = if kind == "file" {
                dir.stat(&name)
                    .ok()
                    .flatten()
                    .map(|st| st.st_size.max(0) as u64)
            } else {
                None
            };
            entries.push(FsEntry {
                path: rel_path.join("/"),
                kind,
                size,
            });
            if kind == "dir"
                && remaining > 1
                && !NO_DESCEND.contains(&name.as_str())
            {
                if let Ok(child) = dir.open_dir(&name) {
                    let mut next = below.clone();
                    next.push(name.clone());
                    queue.push((child, next, remaining - 1));
                }
            }
        }
        if truncated {
            break;
        }
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(FsListing {
        root: rel_join(&base),
        entries,
        truncated,
    })
}

/// Bounded read of one project file: anchored no-follow open, at most
/// `MAX_READ_BYTES` (a larger file truncates on a char boundary and says so),
/// binary content (NUL bytes) refuses instead of flooding the model context.
pub fn read(project_dir: &str, rel: &str) -> Result<FsFile, String> {
    let components = components_of(rel)?;
    let Some((leaf, dirs)) = components.split_last() else {
        return Err("pass a file path relative to the project root".into());
    };
    let root = open_project_root(project_dir)?;
    let dir = walk_dirs(&root, dirs)?;
    let Some(file) = dir
        .open_file(leaf)
        .map_err(|e| format!("could not open {rel:?}: {e}"))?
    else {
        return Err(format!("no such file: {rel:?}"));
    };
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut bytes = Vec::new();
    file.take(MAX_READ_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("could not read {rel:?}: {e}"))?;
    let truncated = bytes.len() > MAX_READ_BYTES;
    if truncated {
        bytes.truncate(MAX_READ_BYTES);
    }
    if bytes.contains(&0) {
        return Err(format!(
            "{rel:?} looks binary — this tool serves text files only"
        ));
    }
    let mut content = String::from_utf8_lossy(&bytes).into_owned();
    if truncated {
        // from_utf8_lossy already healed a cut multibyte char at the boundary
        content.push_str("\n… [truncated]");
    }
    Ok(FsFile {
        path: rel_join(&components),
        content,
        truncated,
        size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_project() -> PathBuf {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "swarmz-explore-test-{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn hostile_paths_are_refused() {
        let project = temp_project();
        let dir = project.to_string_lossy().into_owned();
        fs::write(project.join("ok.txt"), "fine").unwrap();
        for bad in [
            "/etc/passwd",
            "~/secrets",
            "../outside",
            "a/../../outside",
            ".env",
            ".git/config",
            "src/.env",
            "a\\b",
            "C:/outside",
            "C:\\outside",
            "src/C:evil",
            &format!("{}/x", "a/".repeat(600)),
        ] {
            assert!(read(&dir, bad).is_err(), "read({bad:?}) must refuse");
            assert!(list(&dir, bad, 1).is_err(), "list({bad:?}) must refuse");
        }
        // benign normalization still works
        assert!(read(&dir, "./ok.txt").is_ok());
        fs::remove_dir_all(&project).ok();
    }

    #[test]
    fn listing_is_bounded_hidden_free_and_skips_dep_dirs() {
        let project = temp_project();
        let dir = project.to_string_lossy().into_owned();
        fs::create_dir_all(project.join("src/lib")).unwrap();
        fs::write(project.join("src/main.rs"), "fn main() {}").unwrap();
        fs::write(project.join("src/lib/util.rs"), "// util").unwrap();
        fs::write(project.join("README.md"), "# hi").unwrap();
        fs::write(project.join(".env"), "SECRET=1").unwrap();
        fs::create_dir_all(project.join(".git")).unwrap();
        fs::create_dir_all(project.join("node_modules/pkg")).unwrap();
        fs::write(project.join("node_modules/pkg/index.js"), "x").unwrap();

        let l = list(&dir, "", 3).unwrap();
        let paths: Vec<&str> = l.entries.iter().map(|e| e.path.as_str()).collect();
        assert!(paths.contains(&"README.md"));
        assert!(paths.contains(&"src/main.rs"));
        assert!(paths.contains(&"src/lib/util.rs"));
        // hidden entries are absent entirely
        assert!(!paths.iter().any(|p| p.contains(".env") || p.contains(".git")));
        // node_modules shows as a dir but is never descended into
        assert!(paths.contains(&"node_modules"));
        assert!(!paths.iter().any(|p| p.starts_with("node_modules/")));
        // depth 1 stays flat
        let flat = list(&dir, "", 1).unwrap();
        assert!(flat.entries.iter().all(|e| !e.path.contains('/')));
        // subfolder roots work
        let sub = list(&dir, "src", 1).unwrap();
        assert_eq!(sub.root, "src");
        assert!(sub.entries.iter().any(|e| e.path == "src/main.rs"));
        fs::remove_dir_all(&project).ok();
    }

    #[test]
    fn entry_cap_truncates_instead_of_flooding() {
        let project = temp_project();
        let dir = project.to_string_lossy().into_owned();
        for i in 0..(MAX_LIST_ENTRIES + 50) {
            fs::write(project.join(format!("f{i:04}.txt")), "x").unwrap();
        }
        let l = list(&dir, "", 1).unwrap();
        assert_eq!(l.entries.len(), MAX_LIST_ENTRIES);
        assert!(l.truncated);
        fs::remove_dir_all(&project).ok();
    }

    #[test]
    fn symlinks_are_never_followed() {
        let project = temp_project();
        let dir = project.to_string_lossy().into_owned();
        let outside = temp_project();
        fs::write(outside.join("victim.txt"), "secret").unwrap();
        // symlinked file with a safe name: skipped in list, refused in read
        std::os::unix::fs::symlink(outside.join("victim.txt"), project.join("link.txt")).unwrap();
        // symlinked dir: never entered
        std::os::unix::fs::symlink(&outside, project.join("linkdir")).unwrap();
        let l = list(&dir, "", 3).unwrap();
        assert!(l.entries.is_empty(), "symlinks must not be served: {l:?}");
        assert!(read(&dir, "link.txt").is_err());
        assert!(list(&dir, "linkdir", 1).is_err());
        assert!(read(&dir, "linkdir/victim.txt").is_err());
        fs::remove_dir_all(&project).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn reads_are_bounded_and_binary_refuses() {
        let project = temp_project();
        let dir = project.to_string_lossy().into_owned();
        fs::write(project.join("small.txt"), "hello").unwrap();
        let f = read(&dir, "small.txt").unwrap();
        assert_eq!(f.content, "hello");
        assert!(!f.truncated);
        assert_eq!(f.size, 5);

        let big = "y".repeat(MAX_READ_BYTES + 100);
        fs::write(project.join("big.txt"), &big).unwrap();
        let f = read(&dir, "big.txt").unwrap();
        assert!(f.truncated);
        assert!(f.content.ends_with("[truncated]"));
        assert_eq!(f.size, big.len() as u64);

        fs::write(project.join("bin.dat"), [0u8, 159, 146, 150]).unwrap();
        let err = read(&dir, "bin.dat").unwrap_err();
        assert!(err.contains("binary"), "{err}");

        assert!(read(&dir, "missing.txt").is_err());
        assert!(read(&dir, "").is_err());
        fs::remove_dir_all(&project).ok();
    }

    #[cfg(unix)]
    #[test]
    fn fifos_and_special_files_never_hang_a_read() {
        let project = temp_project();
        let dir = project.to_string_lossy().into_owned();
        use std::os::unix::ffi::OsStrExt;
        let fifo = project.join("pipe.txt");
        let c = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        // the FIFO must actually exist, or the assertions below would pass
        // via the unrelated "no such file" path without testing anything
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o644) }, 0);
        assert!(read(&dir, "pipe.txt").is_err());
        assert!(list(&dir, "", 1).unwrap().entries.is_empty());
        fs::remove_dir_all(&project).ok();
    }
}
