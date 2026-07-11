//! The orchestrator's curated memory (Phase 3: scoped): small, user-editable
//! Markdown files under `orchestrator-memory/` in the app data dir — one
//! `global.md` plus one `<project_id>.md` per project. One entry per line,
//! ISO-date-prefixed. Written through the explicit `remember` tool (no
//! auto-extraction; scope "project" is the default, "global" opt-in) and read
//! fresh into the system prompt on every thread/start + thread/resume (frozen
//! per session, like Hermes' MEMORY.md).
//!
//! Legacy migration: a pre-Phase-3 `orchestrator-memory.md` (the single global
//! file) is moved once to `orchestrator-memory/global.md` — attempted lazily
//! under the file lock; as long as the rename has not verifiably succeeded,
//! reads AND writes keep targeting the legacy file (facts are never lost to a
//! failed migration).
//!
//! Concurrency: every read/append/remove runs the WHOLE transaction (path
//! resolution + migration + read-modify-write) under a process-wide mutex
//! keyed by the target file, and temp files get unique names — parallel
//! `remember` calls can no longer lose entries. All IO here is synchronous
//! and small; callers run it through `spawn_blocking` (the sync-command
//! invariant).
//!
//! Hard caps on write PER FILE: at most `MAX_ENTRIES` entries /
//! `MAX_TOTAL_CHARS` characters. Overflow drops the OLDEST entries (FIFO) and
//! the write reports how many it dropped.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;

/// Folder (under the app data dir) holding the scoped memory files.
const MEMORY_DIR: &str = "orchestrator-memory";
/// Pre-Phase-3 single global file — migrated to `orchestrator-memory/global.md`.
const LEGACY_MEMORY_FILE: &str = "orchestrator-memory.md";
/// Header written above the entries (skipped on read — not a list line).
const FILE_HEADER: &str = "# Orchestrator memory\n\nCurated facts the orchestrator chose to remember, via the `remember` tool. One entry per line — edit or delete freely; the app reads it fresh each session.\n\n";

/// Max number of entries kept per file. Overflow drops the oldest (FIFO).
pub const MAX_ENTRIES: usize = 20;
/// Max total characters across one file's entries. Overflow drops the oldest.
pub const MAX_TOTAL_CHARS: usize = 2000;
/// Max characters of ONE entry's text (audit R11): the total cap never drops
/// the LAST entry, so without a per-entry bound a single giant `remember`
/// call would ride into every future session prompt. Longer texts are
/// rejected with a readable error (the model shortens and retries).
pub const MAX_ENTRY_CHARS: usize = 500;
/// Bounded file read (audit R11): a hand-bloated or foreign memory file is
/// read at most this far — way beyond anything the caps can produce.
const MAX_FILE_BYTES: u64 = 256 * 1024;

/// Which memory file an operation targets.
#[derive(Debug, Clone, PartialEq)]
pub enum MemoryScope {
    Global,
    /// A project's own memory, keyed by the project id.
    Project(String),
}

impl MemoryScope {
    /// Validating constructor for a project scope: project ids must be the
    /// canonical id format (nanoid charset `A-Za-z0-9_-`, 1–64 chars) and may
    /// not alias the reserved "global" file. STRICT on purpose — a munged id
    /// (many-to-one stripping) could collide two projects onto one file.
    pub fn project(id: &str) -> Result<MemoryScope, String> {
        let id = id.trim();
        if id.is_empty() || id.len() > 64 {
            return Err("invalid project id for memory scope (empty or too long)".into());
        }
        if !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err(format!(
                "invalid project id {id:?} for memory scope — only letters, digits, '-' and '_'",
            ));
        }
        if id.eq_ignore_ascii_case("global") {
            return Err("project id \"global\" is reserved for the global memory".into());
        }
        Ok(MemoryScope::Project(id.to_string()))
    }

    /// Parse the wire shape (`scope` + optional `project_id`). Unknown scopes
    /// error; scope "project" without a VALID id errors too.
    pub fn parse(scope: &str, project_id: Option<&str>) -> Result<MemoryScope, String> {
        match scope {
            "global" => Ok(MemoryScope::Global),
            "project" => {
                let id = project_id.map(str::trim).unwrap_or("");
                if id.is_empty() {
                    Err("memory scope \"project\" needs a project_id".into())
                } else {
                    MemoryScope::project(id)
                }
            }
            other => Err(format!(
                "unknown memory scope \"{other}\" — use \"project\" or \"global\""
            )),
        }
    }

    /// Stable lock key (dir-independent part) for this scope.
    fn key(&self) -> String {
        match self {
            MemoryScope::Global => "global".to_string(),
            MemoryScope::Project(id) => format!("project:{id}"),
        }
    }
}

/// One memory entry: an ISO date (may be empty for hand-edited lines) + text.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MemoryEntry {
    pub date: String,
    pub text: String,
}

/// Outcome of an append — surfaced to the model so it (and the user) learn
/// when the cap dropped older facts.
#[derive(Debug, Clone, Serialize)]
pub struct AppendResult {
    pub stored: bool,
    pub dropped: usize,
    pub total: usize,
    pub note: String,
}

// ---------------------------------------------------------------------------
// Per-file locking + path resolution (incl. the fallible legacy migration)
// ---------------------------------------------------------------------------

/// Process-wide transaction locks, keyed by (data dir, scope). Every public
/// operation holds its file's lock for the WHOLE read-modify-write — parallel
/// `remember` calls on the same file serialize instead of losing entries.
static FILE_LOCKS: Lazy<Mutex<HashMap<String, Arc<Mutex<()>>>>> = Lazy::new(Mutex::default);

fn lock_for(dir: &Path, scope: &MemoryScope) -> Arc<Mutex<()>> {
    let key = format!("{}::{}", dir.display(), scope.key());
    FILE_LOCKS.lock().entry(key).or_default().clone()
}

/// Resolve the file a scope currently lives in. MUST be called with the
/// scope's lock held. For the global scope this attempts the one-time legacy
/// migration (`orchestrator-memory.md` → `orchestrator-memory/global.md`) and
/// is FALLIBLE: the new path is only used once the rename verifiably
/// succeeded — until then reads and writes keep targeting the legacy file, so
/// a failed migration can never lose the legacy facts.
fn memory_path_locked(dir: &Path, scope: &MemoryScope) -> PathBuf {
    let base = dir.join(MEMORY_DIR);
    match scope {
        MemoryScope::Project(id) => base.join(format!("{id}.md")),
        MemoryScope::Global => {
            let global = base.join("global.md");
            let legacy = dir.join(LEGACY_MEMORY_FILE);
            if !legacy.is_file() {
                return global; // migrated (or fresh install)
            }
            if global.is_file() {
                // both exist (crash between rename halves is impossible for
                // rename(2), so this means an externally created global.md):
                // never clobber — keep serving the legacy file until the user
                // resolves it; appends keep landing there too.
                return legacy;
            }
            if fs::create_dir_all(&base).is_err() {
                return legacy;
            }
            match fs::rename(&legacy, &global) {
                Ok(()) if global.is_file() => global,
                _ => legacy, // migration failed — stay on the legacy file
            }
        }
    }
}

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Unique temp path next to `path` (pid + counter — parallel writers on
/// DIFFERENT files never collide on a shared tmp name).
fn unique_tmp(path: &Path) -> PathBuf {
    let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    path.with_extension(format!("md.{}-{n}.tmp", std::process::id()))
}

fn is_iso_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                *c == b'-'
            } else {
                c.is_ascii_digit()
            }
        })
}

/// Parse one file line into an entry. Accepts `- ` / `* ` bullets; a leading
/// ISO date token is split off as `date`. Non-list lines (the header) → None.
fn parse_line(line: &str) -> Option<MemoryEntry> {
    let l = line.trim();
    let body = l.strip_prefix("- ").or_else(|| l.strip_prefix("* "))?;
    let body = body.trim();
    if body.is_empty() {
        return None;
    }
    if let Some((maybe_date, rest)) = body.split_once(char::is_whitespace) {
        if is_iso_date(maybe_date) {
            return Some(MemoryEntry {
                date: maybe_date.to_string(),
                text: rest.trim().to_string(),
            });
        }
    }
    Some(MemoryEntry {
        date: String::new(),
        text: body.to_string(),
    })
}

/// Parse one file's entries (missing/unreadable file → empty, never an
/// error). Bounded (audit R11): at most `MAX_FILE_BYTES` are read — a
/// bloated/foreign file can't flood memory or the prompt.
fn read_at(path: &Path) -> Vec<MemoryEntry> {
    use std::io::Read;
    let Ok(file) = fs::File::open(path) else {
        return Vec::new();
    };
    let mut bytes = Vec::new();
    if file.take(MAX_FILE_BYTES).read_to_end(&mut bytes).is_err() {
        return Vec::new();
    }
    String::from_utf8_lossy(&bytes)
        .lines()
        .filter_map(parse_line)
        .collect()
}

/// Read every entry of one scope under its file lock (missing/unreadable file
/// → empty, never an error). Attempts the legacy migration for the global
/// scope; a not-yet-migrated legacy file is read in place.
pub fn read_entries(dir: &Path, scope: &MemoryScope) -> Vec<MemoryEntry> {
    let lock = lock_for(dir, scope);
    let _guard = lock.lock();
    read_at(&memory_path_locked(dir, scope))
}

/// Render the entries as prompt-ready list lines (no header). Empty → "".
pub fn render_entries(entries: &[MemoryEntry]) -> String {
    entries
        .iter()
        .map(render_one)
        .collect::<Vec<_>>()
        .join("\n")
}

fn render_one(e: &MemoryEntry) -> String {
    if e.date.is_empty() {
        format!("- {}", e.text)
    } else {
        format!("- {} {}", e.date, e.text)
    }
}

fn total_chars(entries: &[MemoryEntry]) -> usize {
    entries.iter().map(|e| render_one(e).chars().count()).sum()
}

/// Drop the oldest entries until both caps hold. Never drops the last entry to
/// zero on an over-long single line (that lone entry stays, over cap). Returns
/// how many were dropped.
fn enforce_caps(entries: &mut Vec<MemoryEntry>) -> usize {
    let mut dropped = 0;
    while entries.len() > MAX_ENTRIES
        || (total_chars(entries) > MAX_TOTAL_CHARS && entries.len() > 1)
    {
        entries.remove(0);
        dropped += 1;
    }
    dropped
}

fn serialize(entries: &[MemoryEntry]) -> String {
    let mut s = String::from(FILE_HEADER);
    for e in entries {
        s.push_str(&render_one(e));
        s.push('\n');
    }
    s
}

/// Write atomically (unique temp + rename) to the RESOLVED path. MUST be
/// called with the scope's lock held.
fn write_at(path: &Path, entries: &[MemoryEntry]) -> Result<(), String> {
    let parent = path.parent().ok_or("memory path has no parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = unique_tmp(path);
    fs::write(&tmp, serialize(entries)).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Append one entry (dated `today`) to a scope, enforce the caps, persist.
/// The whole read-modify-write runs under the scope's file lock. Empty text
/// is rejected. `today` is passed in (ISO `YYYY-MM-DD`) so tests stay
/// deterministic.
pub fn append(
    dir: &Path,
    scope: &MemoryScope,
    text: &str,
    today: &str,
) -> Result<AppendResult, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("nothing to remember: the text is empty".into());
    }
    // R11: strict per-entry bound BEFORE persisting — the FIFO total cap
    // never drops the last entry, so one giant entry would otherwise ride
    // into every future session prompt
    let chars = text.chars().count();
    if chars > MAX_ENTRY_CHARS {
        return Err(format!(
            "memory entry too long ({chars} chars — the cap is {MAX_ENTRY_CHARS}); store one concise sentence"
        ));
    }
    let lock = lock_for(dir, scope);
    let _guard = lock.lock();
    let path = memory_path_locked(dir, scope);
    let mut entries = read_at(&path);
    entries.push(MemoryEntry {
        date: today.to_string(),
        text: text.to_string(),
    });
    let dropped = enforce_caps(&mut entries);
    let total = entries.len();
    write_at(&path, &entries)?;
    let where_ = match scope {
        MemoryScope::Global => "global memory",
        MemoryScope::Project(_) => "project memory",
    };
    let note = if dropped == 0 {
        format!("stored in {where_} ({total}/{MAX_ENTRIES} entries)")
    } else {
        format!(
            "stored in {where_}; dropped the {dropped} oldest entr{} to stay within the cap ({total}/{MAX_ENTRIES} entries)",
            if dropped == 1 { "y" } else { "ies" }
        )
    };
    Ok(AppendResult {
        stored: true,
        dropped,
        total,
        note,
    })
}

/// Remove the entry at `index` (0-based, as returned by `read_entries`) from a
/// scope and persist the rest, all under the scope's file lock. Out-of-range
/// index → error.
pub fn remove(dir: &Path, scope: &MemoryScope, index: usize) -> Result<Vec<MemoryEntry>, String> {
    let lock = lock_for(dir, scope);
    let _guard = lock.lock();
    let path = memory_path_locked(dir, scope);
    let mut entries = read_at(&path);
    if index >= entries.len() {
        return Err(format!(
            "no memory entry at index {index} (have {})",
            entries.len()
        ));
    }
    entries.remove(index);
    write_at(&path, &entries)?;
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "swarmz-memory-test-{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    const G: MemoryScope = MemoryScope::Global;

    fn proj(id: &str) -> MemoryScope {
        MemoryScope::Project(id.to_string())
    }

    #[test]
    fn append_and_read_roundtrip() {
        let dir = temp_dir();
        assert!(read_entries(&dir, &G).is_empty());
        let r = append(&dir, &G, "  reviews go to Opus  ", "2026-07-07").unwrap();
        assert!(r.stored && r.dropped == 0 && r.total == 1);
        let entries = read_entries(&dir, &G);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].date, "2026-07-07");
        assert_eq!(entries[0].text, "reviews go to Opus");
        assert_eq!(render_entries(&entries), "- 2026-07-07 reviews go to Opus");
        // the file landed in the scoped layout
        assert!(dir.join("orchestrator-memory/global.md").is_file());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scopes_are_isolated_files() {
        let dir = temp_dir();
        append(&dir, &G, "global fact", "2026-07-10").unwrap();
        append(&dir, &proj("abc12345"), "project fact", "2026-07-10").unwrap();
        append(&dir, &proj("xyz98765"), "other project fact", "2026-07-10").unwrap();
        assert_eq!(read_entries(&dir, &G).len(), 1);
        assert_eq!(read_entries(&dir, &proj("abc12345")).len(), 1);
        assert_eq!(
            read_entries(&dir, &proj("abc12345"))[0].text,
            "project fact"
        );
        assert_eq!(read_entries(&dir, &proj("xyz98765")).len(), 1);
        assert!(dir.join("orchestrator-memory/abc12345.md").is_file());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn legacy_file_migrates_to_global_once() {
        let dir = temp_dir();
        fs::write(
            dir.join("orchestrator-memory.md"),
            "# Orchestrator memory\n\n- 2026-07-01 legacy fact\n",
        )
        .unwrap();
        // first read migrates the legacy file into the scoped layout
        let entries = read_entries(&dir, &G);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].text, "legacy fact");
        assert!(!dir.join("orchestrator-memory.md").exists(), "legacy moved");
        assert!(dir.join("orchestrator-memory/global.md").is_file());
        // appends land in the migrated file
        append(&dir, &G, "new fact", "2026-07-10").unwrap();
        assert_eq!(read_entries(&dir, &G).len(), 2);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scope_parsing_defaults_and_errors() {
        assert_eq!(MemoryScope::parse("global", None).unwrap(), G);
        assert_eq!(
            MemoryScope::parse("project", Some("p1")).unwrap(),
            proj("p1")
        );
        assert!(MemoryScope::parse("project", None).is_err());
        assert!(MemoryScope::parse("project", Some("  ")).is_err());
        assert!(MemoryScope::parse("everything", Some("p1")).is_err());
    }

    #[test]
    fn project_ids_are_validated_strictly_not_munged() {
        // canonical nanoid-style ids pass
        assert!(MemoryScope::project("aB3-_x").is_ok());
        // path-ish / non-canonical ids are REJECTED (stripping would be
        // many-to-one: "a/b" and "ab" must never share a file)
        assert!(MemoryScope::project("../../etc/passwd").is_err());
        assert!(MemoryScope::project("a/b").is_err());
        assert!(MemoryScope::project("a b").is_err());
        assert!(MemoryScope::project(&"x".repeat(65)).is_err());
        // "global" is reserved — a project id must never alias global.md
        assert!(MemoryScope::project("global").is_err());
        assert!(MemoryScope::project("GLOBAL").is_err());
    }

    #[test]
    fn parallel_appends_lose_no_entries() {
        let dir = temp_dir();
        let dir = Arc::new(dir);
        let mut handles = Vec::new();
        for i in 0..8 {
            let dir = dir.clone();
            handles.push(std::thread::spawn(move || {
                append(&dir, &MemoryScope::Global, &format!("fact {i}"), "2026-07-10").unwrap();
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        let entries = read_entries(&dir, &G);
        assert_eq!(entries.len(), 8, "a parallel append lost entries");
        for i in 0..8 {
            assert!(
                entries.iter().any(|e| e.text == format!("fact {i}")),
                "fact {i} missing"
            );
        }
        fs::remove_dir_all(&*dir).ok();
    }

    #[test]
    fn unmigratable_legacy_keeps_serving_reads_and_writes() {
        let dir = temp_dir();
        // both files exist → the migration must NOT clobber either; the
        // legacy file keeps serving until the user resolves it
        fs::write(
            dir.join("orchestrator-memory.md"),
            "# Orchestrator memory\n\n- 2026-07-01 legacy fact\n",
        )
        .unwrap();
        fs::create_dir_all(dir.join("orchestrator-memory")).unwrap();
        fs::write(
            dir.join("orchestrator-memory/global.md"),
            "# Orchestrator memory\n\n- 2026-07-02 foreign fact\n",
        )
        .unwrap();
        let entries = read_entries(&dir, &G);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].text, "legacy fact");
        // appends land in the legacy file (never a list missing legacy facts)
        append(&dir, &G, "new fact", "2026-07-10").unwrap();
        let after = read_entries(&dir, &G);
        assert_eq!(after.len(), 2);
        assert!(after.iter().any(|e| e.text == "legacy fact"));
        assert!(after.iter().any(|e| e.text == "new fact"));
        // the foreign global.md is untouched
        let foreign = fs::read_to_string(dir.join("orchestrator-memory/global.md")).unwrap();
        assert!(foreign.contains("foreign fact"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn empty_text_is_rejected() {
        let dir = temp_dir();
        assert!(append(&dir, &G, "   ", "2026-07-07").is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn count_cap_drops_oldest_fifo() {
        let dir = temp_dir();
        let p = proj("p1");
        for i in 0..(MAX_ENTRIES + 5) {
            append(&dir, &p, &format!("fact {i}"), "2026-07-07").unwrap();
        }
        let entries = read_entries(&dir, &p);
        assert_eq!(entries.len(), MAX_ENTRIES);
        // oldest (fact 0..4) dropped; newest kept
        assert_eq!(entries.first().unwrap().text, "fact 5");
        assert_eq!(entries.last().unwrap().text, format!("fact {}", MAX_ENTRIES + 4));
        // the last append reported a drop
        let r = append(&dir, &p, "one more", "2026-07-07").unwrap();
        assert!(r.dropped >= 1);
        assert!(r.note.contains("dropped"));
        fs::remove_dir_all(&dir).ok();
    }

    /// Audit R11 (frozen): one giant entry is rejected up front — the total
    /// cap never drops the last entry, so without this bound a single
    /// injection-sized `remember` would ride into every future prompt.
    #[test]
    fn oversized_single_entries_are_rejected() {
        let dir = temp_dir();
        let err = append(&dir, &G, &"x".repeat(MAX_ENTRY_CHARS + 1), "2026-07-10").unwrap_err();
        assert!(err.contains("too long"), "{err}");
        assert!(read_entries(&dir, &G).is_empty(), "nothing may have been stored");
        // exactly at the cap still stores
        assert!(append(&dir, &G, &"y".repeat(MAX_ENTRY_CHARS), "2026-07-10").is_ok());
        // a hand-bloated file is read bounded, never slurped whole
        let path = dir.join("orchestrator-memory/global.md");
        let mut giant = String::from("# Orchestrator memory\n\n");
        giant.push_str(&"z".repeat(2 * MAX_FILE_BYTES as usize));
        fs::write(&path, &giant).unwrap();
        let entries = read_entries(&dir, &G);
        let total: usize = entries.iter().map(|e| e.text.len()).sum();
        assert!(total <= MAX_FILE_BYTES as usize, "bounded read");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn char_cap_drops_oldest() {
        let dir = temp_dir();
        let big = "x".repeat(500);
        for _ in 0..6 {
            append(&dir, &G, &big, "2026-07-07").unwrap();
        }
        let entries = read_entries(&dir, &G);
        assert!(total_chars(&entries) <= MAX_TOTAL_CHARS);
        assert!(entries.len() < 6, "char cap should have dropped some");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn remove_by_index() {
        let dir = temp_dir();
        append(&dir, &G, "a", "2026-07-07").unwrap();
        append(&dir, &G, "b", "2026-07-07").unwrap();
        append(&dir, &G, "c", "2026-07-07").unwrap();
        let left = remove(&dir, &G, 1).unwrap();
        assert_eq!(left.iter().map(|e| e.text.as_str()).collect::<Vec<_>>(), ["a", "c"]);
        assert!(remove(&dir, &G, 9).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parsing_ignores_the_header_and_tolerates_hand_edits() {
        let dir = temp_dir();
        let path = dir.join("orchestrator-memory/global.md");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            "# Orchestrator memory\n\nsome prose that is not a list line\n\n- 2026-07-07 dated entry\n- undated hand-added entry\n* star bullet entry\n",
        )
        .unwrap();
        let entries = read_entries(&dir, &G);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].date, "2026-07-07");
        assert_eq!(entries[1].date, "");
        assert_eq!(entries[1].text, "undated hand-added entry");
        assert_eq!(entries[2].text, "star bullet entry");
        fs::remove_dir_all(&dir).ok();
    }
}
