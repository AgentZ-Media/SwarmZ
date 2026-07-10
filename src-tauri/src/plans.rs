//! Conductor plan documents — the ONE place the orchestrator may write files.
//! Documents live under `<project>/.swarmz/plans/<slug>.md`; everything else
//! on the machine stays out of reach by construction:
//!
//! - the project dir comes from the trusted chat context (never the model),
//! - the SLUG is derived here from the title (lowercase `a-z0-9-` only, no
//!   dots, no separators), so a path can never climb out of the plans dir,
//! - `read`/`list` resolve strictly inside the plans dir and re-validate the
//!   slug on the way in,
//! - the WHOLE surface is NO-FOLLOW: a symlink anywhere on the path
//!   (`.swarmz`, `plans`, the document itself) refuses — an agent could plant
//!   `.swarmz/plans/x.md → ../../src/main.rs` in its workspace, and neither a
//!   write may follow it out nor a read may leak through it. Writes go to a
//!   fresh temp file and rename over the target (atomic, replaces a planted
//!   symlink instead of following it); reads open with `O_NOFOLLOW` and are
//!   BOUNDED (a FIFO/device or oversized foreign file never hangs or floods).
//!
//! `.swarmz/` is excluded from git via the repo-local `.git/info/exclude`
//! (best-effort, same mechanism as worktree.rs — never the tracked
//! .gitignore), so plan documents don't dirty the user's `git status`.

use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

/// Hard cap on one document's Markdown (256 KiB) — a plan is a working note,
/// not a data dump.
pub const MAX_PLAN_BYTES: usize = 256 * 1024;
/// Max slug length (filesystem friendliness).
const MAX_SLUG_LEN: usize = 64;
/// Max title length — a title is a heading, not a document.
pub const MAX_TITLE_CHARS: usize = 200;
/// How much of a file's head the title scan reads (bounded, never the whole
/// file).
const TITLE_SCAN_BYTES: u64 = 4 * 1024;

#[derive(Serialize, Clone, Debug)]
pub struct PlanInfo {
    pub slug: String,
    /// first `# ` heading if present, else the slug
    pub title: String,
    /// absolute file path (hand this to agents)
    pub path: String,
    /// last modified, epoch ms
    pub modified_ms: u64,
    pub size: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct PlanDocument {
    pub slug: String,
    pub path: String,
    pub content: String,
}

/// Derive the file slug from a title: NFKD-free ASCII fold (non-ASCII drops),
/// lowercase, runs of anything else collapse to single hyphens. Empty → "plan".
pub fn slugify(title: &str) -> String {
    let mut out = String::new();
    let mut last_hyphen = true; // trims leading hyphens
    for c in title.chars() {
        let c = c.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            out.push(c);
            last_hyphen = false;
        } else if !last_hyphen {
            out.push('-');
            last_hyphen = true;
        }
        if out.len() >= MAX_SLUG_LEN {
            break;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "plan".into()
    } else {
        out
    }
}

/// A slug is safe iff it is exactly what `slugify` produces: non-empty,
/// `a-z0-9-` only, no leading/trailing hyphen. Anything else (dots, slashes,
/// `..`, unicode) is rejected — reads re-validate through this too.
pub fn is_valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= MAX_SLUG_LEN
        && !slug.starts_with('-')
        && !slug.ends_with('-')
        && slug.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Refuse when `path` exists as a symlink (no-follow confinement) — a
/// missing or regular entry passes.
fn assert_no_symlink(path: &Path) -> Result<(), String> {
    match path.symlink_metadata() {
        Ok(m) if m.file_type().is_symlink() => Err(format!(
            "refusing to follow the symlink at {}",
            path.display()
        )),
        _ => Ok(()),
    }
}

/// The project's plans dir, with the `.swarmz` and `plans` components checked
/// no-follow. The project dir itself must exist (it comes from the trusted
/// project record, not the model).
fn plans_dir(project_dir: &str) -> Result<PathBuf, String> {
    let root = Path::new(project_dir.trim());
    if project_dir.trim().is_empty() || !root.is_dir() {
        return Err("no usable project folder for plan documents".into());
    }
    let swarmz = root.join(".swarmz");
    assert_no_symlink(&swarmz)?;
    let dir = swarmz.join("plans");
    assert_no_symlink(&dir)?;
    Ok(dir)
}

/// Open a plan file read-only WITHOUT following a symlink at the leaf, after
/// confirming it is a regular file (a FIFO/device would hang the open or the
/// read). Returns None when the file is missing.
fn open_plan_nofollow(path: &Path) -> Result<Option<fs::File>, String> {
    match path.symlink_metadata() {
        Err(_) => return Ok(None), // missing
        Ok(m) if m.file_type().is_symlink() => {
            return Err(format!(
                "refusing to follow the symlink at {}",
                path.display()
            ))
        }
        Ok(m) if !m.is_file() => {
            return Err(format!("not a regular file: {}", path.display()))
        }
        Ok(_) => {}
    }
    #[cfg(unix)]
    let file = {
        use std::os::unix::fs::OpenOptionsExt;
        fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
    };
    #[cfg(not(unix))]
    let file = fs::OpenOptions::new().read(true).open(path);
    file.map(Some)
        .map_err(|e| format!("could not open the plan: {e}"))
}

/// Bounded read of a plan file (no-follow): at most `max` bytes; a larger
/// file errors instead of flooding memory. None = missing file.
fn read_bounded(path: &Path, max: usize) -> Result<Option<String>, String> {
    let Some(file) = open_plan_nofollow(path)? else {
        return Ok(None);
    };
    let mut buf = String::new();
    let read = file
        .take(max as u64 + 1)
        .read_to_string(&mut buf)
        .map_err(|e| format!("could not read the plan: {e}"))?;
    if read > max {
        return Err(format!(
            "plan file too large ({read}+ bytes — the cap is {max})"
        ));
    }
    Ok(Some(buf))
}

/// Make git ignore `.swarmz/` via the repo-local `.git/info/exclude` —
/// best-effort: a non-repo project simply skips this.
fn ensure_excluded(project_dir: &Path) {
    let info = project_dir.join(".git").join("info");
    if !project_dir.join(".git").exists() {
        return;
    }
    let exclude = info.join("exclude");
    let current = fs::read_to_string(&exclude).unwrap_or_default();
    let has_entry = current.lines().any(|l| {
        matches!(l.trim(), "/.swarmz/" | "/.swarmz" | ".swarmz/" | ".swarmz")
    });
    if has_entry {
        return;
    }
    if fs::create_dir_all(&info).is_err() {
        return;
    }
    let mut next = current;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str("# SwarmZ conductor plans\n/.swarmz/\n");
    let _ = fs::write(&exclude, next);
}

/// First `# ` heading of a file's head (bounded, no-follow), else None.
fn read_title(path: &Path) -> Option<String> {
    let file = open_plan_nofollow(path).ok().flatten()?;
    let mut head = String::new();
    // a bounded read may cut a multibyte char at the boundary — read bytes,
    // convert lossily (the title scan only needs the first lines)
    let mut bytes = Vec::new();
    file.take(TITLE_SCAN_BYTES).read_to_end(&mut bytes).ok()?;
    head.push_str(&String::from_utf8_lossy(&bytes));
    for line in head.lines().take(10) {
        if let Some(t) = line.trim().strip_prefix("# ") {
            let t = t.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    None
}

/// Short stable hash suffix for slug collisions of DIFFERENT titles.
fn hash8(s: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    format!("{:08x}", h.finish() & 0xffff_ffff)
}

fn modified_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Write (or replace) one plan document. Returns the written document's info.
///
/// Same title → same slug → replace. A DIFFERENT title that collides on the
/// same slug gets a stable hash suffix instead of silently overwriting the
/// other document. The write is atomic: fresh temp file + rename (a planted
/// symlink at the target is REPLACED, never followed).
pub fn write(project_dir: &str, title: &str, markdown: &str) -> Result<PlanInfo, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("plan title must not be empty".into());
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(format!(
            "plan title too long ({} chars — the cap is {MAX_TITLE_CHARS})",
            title.chars().count()
        ));
    }
    if markdown.trim().is_empty() {
        return Err("plan content must not be empty".into());
    }
    if markdown.len() > MAX_PLAN_BYTES {
        return Err(format!(
            "plan content too large ({} bytes — the cap is {MAX_PLAN_BYTES})",
            markdown.len()
        ));
    }
    let dir = plans_dir(project_dir)?;
    fs::create_dir_all(&dir).map_err(|e| format!("could not create the plans folder: {e}"))?;
    ensure_excluded(Path::new(project_dir.trim()));

    // ensure a leading H1 title so list() can show it (## alone is not one)
    let content = if markdown.trim_start().starts_with("# ") {
        markdown.to_string()
    } else {
        format!("# {title}\n\n{markdown}")
    };
    // the document's effective heading — the identity list() shows and the
    // collision check compares
    let effective_title = content
        .lines()
        .take(10)
        .find_map(|l| l.trim().strip_prefix("# ").map(|t| t.trim().to_string()))
        .unwrap_or_else(|| title.to_string());

    // slug collision of DIFFERENT titles → deterministic hash suffix
    let mut slug = slugify(title);
    debug_assert!(is_valid_slug(&slug));
    let candidate = dir.join(format!("{slug}.md"));
    if let Some(existing_title) = read_title(&candidate) {
        if existing_title != effective_title {
            let base_max = MAX_SLUG_LEN - 9; // room for "-xxxxxxxx"
            let mut base = slug.clone();
            base.truncate(base_max);
            while base.ends_with('-') {
                base.pop();
            }
            slug = format!("{base}-{}", hash8(title));
            debug_assert!(is_valid_slug(&slug));
            let suffixed = dir.join(format!("{slug}.md"));
            if let Some(t) = read_title(&suffixed) {
                if t != effective_title {
                    return Err(format!(
                        "slug collision: \"{slug}\" already holds a different plan — pick a more distinct title"
                    ));
                }
            }
        }
    }

    let path = dir.join(format!("{slug}.md"));
    // no-follow: a planted symlink (or FIFO) at the target refuses — the
    // rename below would replace it, but never write THROUGH it either way
    match path.symlink_metadata() {
        Ok(m) if !m.is_file() => {
            return Err(format!(
                "refusing to replace the non-regular file at {}",
                path.display()
            ))
        }
        _ => {}
    }
    // atomic replace: fresh temp file in the same dir + rename over
    let tmp = dir.join(format!(
        ".{slug}.tmp-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    fs::write(&tmp, &content).map_err(|e| format!("could not write the plan: {e}"))?;
    if let Err(e) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("could not write the plan: {e}"));
    }
    let meta = path.symlink_metadata().map_err(|e| e.to_string())?;
    Ok(PlanInfo {
        slug,
        title: effective_title,
        path: path.to_string_lossy().into_owned(),
        modified_ms: modified_ms(&meta),
        size: meta.len(),
    })
}

/// All plan documents of a project, newest modified first. Only regular
/// `<valid-slug>.md` files are served — symlinks and foreign files never.
pub fn list(project_dir: &str) -> Result<Vec<PlanInfo>, String> {
    let dir = plans_dir(project_dir)?;
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(Vec::new()); // no plans yet
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if path.extension().and_then(|e| e.to_str()) != Some("md") || !is_valid_slug(stem) {
            continue; // foreign files in the folder are ignored, never served
        }
        // no-follow: DirEntry::file_type() does NOT traverse symlinks — a
        // safe-named symlink to a host file is skipped, not leaked
        let Ok(ft) = entry.file_type() else { continue };
        if !ft.is_file() {
            continue;
        }
        let Ok(meta) = path.symlink_metadata() else { continue };
        out.push(PlanInfo {
            slug: stem.to_string(),
            title: read_title(&path).unwrap_or_else(|| stem.to_string()),
            path: path.to_string_lossy().into_owned(),
            modified_ms: modified_ms(&meta),
            size: meta.len(),
        });
    }
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    Ok(out)
}

/// Read one plan by slug — the slug is re-validated, the open is no-follow
/// and the read bounded, so only regular files the Conductor itself wrote
/// are reachable.
pub fn read(project_dir: &str, slug: &str) -> Result<PlanDocument, String> {
    let slug = slug.trim();
    if !is_valid_slug(slug) {
        return Err(format!(
            "invalid plan slug {slug:?} — slugs are lowercase a-z0-9- (from list_plans)"
        ));
    }
    let dir = plans_dir(project_dir)?;
    let path = dir.join(format!("{slug}.md"));
    let content = read_bounded(&path, MAX_PLAN_BYTES)?
        .ok_or_else(|| format!("no plan \"{slug}\" in this project (see list_plans)"))?;
    Ok(PlanDocument {
        slug: slug.to_string(),
        path: path.to_string_lossy().into_owned(),
        content,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project() -> PathBuf {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "swarmz-plans-test-{}-{}",
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
    fn slugs_are_filesystem_safe_and_stable() {
        assert_eq!(slugify("Checkout Rewrite — Phase 2!"), "checkout-rewrite-phase-2");
        assert_eq!(slugify("  ../../etc/passwd  "), "etc-passwd");
        assert_eq!(slugify("...."), "plan");
        assert_eq!(slugify("Zoë's Plan"), "zo-s-plan");
        assert!(slugify(&"x".repeat(200)).len() <= MAX_SLUG_LEN);
        assert!(is_valid_slug("checkout-rewrite"));
        assert!(!is_valid_slug("../escape"));
        assert!(!is_valid_slug("a/b"));
        assert!(!is_valid_slug("a.b"));
        assert!(!is_valid_slug(""));
        assert!(!is_valid_slug("-x"));
        // every slugify output passes the validator (a few samples)
        for t in ["Hello World", "ÄÖÜ", "a__b", "9 lives", "--"] {
            assert!(is_valid_slug(&slugify(t)), "slugify({t:?}) invalid");
        }
    }

    #[test]
    fn write_list_read_roundtrip_confined_to_the_plans_dir() {
        let project = temp_project();
        let dir = project.to_string_lossy().into_owned();
        let info = write(&dir, "Checkout Rewrite", "## Tasks\n- a\n- b\n").unwrap();
        assert_eq!(info.slug, "checkout-rewrite");
        assert!(info.path.ends_with(".swarmz/plans/checkout-rewrite.md"));
        assert!(Path::new(&info.path).starts_with(project.join(".swarmz/plans")));

        // a heading is prepended when the content has none
        let doc = read(&dir, "checkout-rewrite").unwrap();
        assert!(doc.content.starts_with("# Checkout Rewrite\n"));
        assert!(doc.content.contains("## Tasks"));

        let plans = list(&dir).unwrap();
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].title, "Checkout Rewrite");

        // same title replaces
        write(&dir, "Checkout Rewrite", "# Checkout Rewrite\nv2\n").unwrap();
        assert_eq!(list(&dir).unwrap().len(), 1);
        assert!(read(&dir, "checkout-rewrite").unwrap().content.contains("v2"));
        // no temp files left behind
        let leftovers: Vec<_> = fs::read_dir(project.join(".swarmz/plans"))
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty());

        fs::remove_dir_all(&project).ok();
    }

    #[test]
    fn path_escapes_are_impossible() {
        let project = temp_project();
        let dir = project.to_string_lossy().into_owned();
        // a hostile title cannot climb out — it slugs into the plans dir
        let info = write(&dir, "../../../../tmp/evil", "content").unwrap();
        assert!(Path::new(&info.path).starts_with(project.join(".swarmz/plans")));
        assert_eq!(info.slug, "tmp-evil");
        // hostile read slugs are rejected outright
        assert!(read(&dir, "../secrets").is_err());
        assert!(read(&dir, "a/b").is_err());
        assert!(read(&dir, "plan.md").is_err());
        fs::remove_dir_all(&project).ok();
    }

    #[test]
    fn symlinks_are_never_followed() {
        let project = temp_project();
        let dir = project.to_string_lossy().into_owned();
        let plans = project.join(".swarmz/plans");
        fs::create_dir_all(&plans).unwrap();

        // (a) a planted document symlink → write REFUSES (never follows,
        //     never silently replaces), read errs, list skips it
        let victim = project.join("victim.rs");
        fs::write(&victim, "fn main() {}").unwrap();
        std::os::unix::fs::symlink(&victim, plans.join("attack.md")).unwrap();
        assert!(read(&dir, "attack").is_err(), "read must not follow");
        assert!(
            list(&dir).unwrap().iter().all(|p| p.slug != "attack"),
            "list must not serve symlinks"
        );
        let err = write(&dir, "Attack", "harmless plan").unwrap_err();
        assert!(err.contains("non-regular"), "{err}");
        // the victim file is UNTOUCHED
        assert_eq!(fs::read_to_string(&victim).unwrap(), "fn main() {}");
        assert!(plans
            .join("attack.md")
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink());

        // (b) a symlinked plans dir must refuse everything
        let project2 = temp_project();
        let dir2 = project2.to_string_lossy().into_owned();
        let outside = temp_project();
        fs::create_dir_all(project2.join(".swarmz")).unwrap();
        std::os::unix::fs::symlink(&outside, project2.join(".swarmz/plans")).unwrap();
        assert!(write(&dir2, "Plan", "content").is_err());
        assert!(list(&dir2).is_err());
        assert!(read(&dir2, "plan").is_err());

        // (c) a symlinked .swarmz dir refuses too
        let project3 = temp_project();
        let dir3 = project3.to_string_lossy().into_owned();
        std::os::unix::fs::symlink(&outside, project3.join(".swarmz")).unwrap();
        assert!(write(&dir3, "Plan", "content").is_err());

        fs::remove_dir_all(&project).ok();
        fs::remove_dir_all(&project2).ok();
        fs::remove_dir_all(&project3).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn slug_collisions_of_different_titles_do_not_overwrite() {
        let project = temp_project();
        let dir = project.to_string_lossy().into_owned();
        // two titles that slug identically
        let a = write(&dir, "Phase 2!", "plan a").unwrap();
        let b = write(&dir, "Phase-2", "plan b").unwrap();
        assert_eq!(a.slug, "phase-2");
        assert_ne!(a.slug, b.slug, "the second title must get its own slug");
        assert!(b.slug.starts_with("phase-2-"));
        assert!(is_valid_slug(&b.slug));
        // both documents live side by side and read back their own content
        assert!(read(&dir, &a.slug).unwrap().content.contains("plan a"));
        assert!(read(&dir, &b.slug).unwrap().content.contains("plan b"));
        assert_eq!(list(&dir).unwrap().len(), 2);
        // re-writing either title replaces ITS document only
        write(&dir, "Phase-2", "plan b v2").unwrap();
        assert!(read(&dir, &b.slug).unwrap().content.contains("plan b v2"));
        assert!(read(&dir, &a.slug).unwrap().content.contains("plan a"));
        fs::remove_dir_all(&project).ok();
    }

    #[test]
    fn missing_project_and_caps_are_enforced() {
        assert!(write("/definitely/not/here-91823", "t", "x").is_err());
        assert!(write("", "t", "x").is_err());
        let project = temp_project();
        let dir = project.to_string_lossy().into_owned();
        assert!(write(&dir, "  ", "x").is_err());
        assert!(write(&dir, "t", "  ").is_err());
        let big = "x".repeat(MAX_PLAN_BYTES + 1);
        assert!(write(&dir, "t", &big).is_err());
        // title cap
        let long_title = "t".repeat(MAX_TITLE_CHARS + 1);
        assert!(write(&dir, &long_title, "x").is_err());
        // no plans yet → empty list, unknown slug → readable error
        assert!(list(&dir).unwrap().is_empty());
        let err = read(&dir, "nope").unwrap_err();
        assert!(err.contains("no plan"), "{err}");
        fs::remove_dir_all(&project).ok();
    }

    #[test]
    fn oversized_and_non_regular_files_are_refused_bounded() {
        let project = temp_project();
        let dir = project.to_string_lossy().into_owned();
        let plans = project.join(".swarmz/plans");
        fs::create_dir_all(&plans).unwrap();
        // an oversized foreign file with a safe name errors instead of
        // flooding memory
        let huge = "y".repeat(MAX_PLAN_BYTES + 10);
        fs::write(plans.join("huge.md"), &huge).unwrap();
        let err = read(&dir, "huge").unwrap_err();
        assert!(err.contains("too large"), "{err}");
        // a FIFO with a safe name is refused before the open can hang
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            let fifo = plans.join("pipe.md");
            let c_path = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
            unsafe { libc::mkfifo(c_path.as_ptr(), 0o644) };
            assert!(read(&dir, "pipe").is_err());
            assert!(list(&dir).unwrap().iter().all(|p| p.slug != "pipe"));
        }
        fs::remove_dir_all(&project).ok();
    }

    #[test]
    fn swarmz_dir_is_git_excluded_in_repos() {
        let project = temp_project();
        // make it a repo
        std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&project)
            .status()
            .unwrap();
        let dir = project.to_string_lossy().into_owned();
        write(&dir, "Plan", "content").unwrap();
        let exclude = fs::read_to_string(project.join(".git/info/exclude")).unwrap();
        assert!(exclude.contains("/.swarmz/"));
        // idempotent — a second write doesn't duplicate the entry
        write(&dir, "Plan 2", "content").unwrap();
        let exclude2 = fs::read_to_string(project.join(".git/info/exclude")).unwrap();
        assert_eq!(exclude2.matches("/.swarmz/").count(), 1);
        fs::remove_dir_all(&project).ok();
    }

    #[test]
    fn foreign_files_in_the_plans_dir_are_never_served() {
        let project = temp_project();
        let dir = project.to_string_lossy().into_owned();
        let plans = project.join(".swarmz/plans");
        fs::create_dir_all(&plans).unwrap();
        fs::write(plans.join("NOTES.txt"), "x").unwrap();
        fs::write(plans.join("Weird.Name.md"), "x").unwrap();
        write(&dir, "Real Plan", "content").unwrap();
        let listed = list(&dir).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].slug, "real-plan");
        fs::remove_dir_all(&project).ok();
    }
}
