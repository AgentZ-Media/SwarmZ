//! The orchestrator's curated memory: a small, user-editable Markdown file
//! (`orchestrator-memory.md`, next to `swarmz.json` in the app data dir). One
//! entry per line, ISO-date-prefixed. Written through the explicit `remember`
//! tool (no auto-extraction) and read fresh into the system prompt on every
//! thread/start + thread/resume (frozen per session, like Hermes' MEMORY.md).
//!
//! Hard caps on write: at most `MAX_ENTRIES` entries / `MAX_TOTAL_CHARS`
//! characters. Overflow drops the OLDEST entries (FIFO) and the write reports
//! how many it dropped. All IO here is synchronous and small; callers run it
//! through `spawn_blocking` (the sync-command invariant).

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

const MEMORY_FILE: &str = "orchestrator-memory.md";
/// Header written above the entries (skipped on read — not a list line).
const FILE_HEADER: &str = "# Orchestrator memory\n\nCurated facts the orchestrator chose to remember, via the `remember` tool. One entry per line — edit or delete freely; the app reads it fresh each session.\n\n";

/// Max number of entries kept. Overflow drops the oldest (FIFO).
pub const MAX_ENTRIES: usize = 20;
/// Max total characters across all entries. Overflow drops the oldest.
pub const MAX_TOTAL_CHARS: usize = 2000;

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

fn memory_path(dir: &Path) -> PathBuf {
    dir.join(MEMORY_FILE)
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

/// Read every entry (missing/unreadable file → empty, never an error).
pub fn read_entries(dir: &Path) -> Vec<MemoryEntry> {
    match fs::read_to_string(memory_path(dir)) {
        Ok(s) => s.lines().filter_map(parse_line).collect(),
        Err(_) => Vec::new(),
    }
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

/// Write atomically (temp + rename), creating the dir if needed.
fn write_entries(dir: &Path, entries: &[MemoryEntry]) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{MEMORY_FILE}.tmp"));
    fs::write(&tmp, serialize(entries)).map_err(|e| e.to_string())?;
    fs::rename(&tmp, memory_path(dir)).map_err(|e| e.to_string())
}

/// Append one entry (dated `today`), enforce the caps, persist. Empty text is
/// rejected. `today` is passed in (ISO `YYYY-MM-DD`) so tests stay deterministic.
pub fn append(dir: &Path, text: &str, today: &str) -> Result<AppendResult, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("nothing to remember: the text is empty".into());
    }
    let mut entries = read_entries(dir);
    entries.push(MemoryEntry {
        date: today.to_string(),
        text: text.to_string(),
    });
    let dropped = enforce_caps(&mut entries);
    let total = entries.len();
    write_entries(dir, &entries)?;
    let note = if dropped == 0 {
        format!("stored ({total}/{MAX_ENTRIES} entries)")
    } else {
        format!(
            "stored; dropped the {dropped} oldest entr{} to stay within the cap ({total}/{MAX_ENTRIES} entries)",
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

/// Remove the entry at `index` (0-based, as returned by `read_entries`) and
/// persist the rest. Out-of-range index → error.
pub fn remove(dir: &Path, index: usize) -> Result<Vec<MemoryEntry>, String> {
    let mut entries = read_entries(dir);
    if index >= entries.len() {
        return Err(format!(
            "no memory entry at index {index} (have {})",
            entries.len()
        ));
    }
    entries.remove(index);
    write_entries(dir, &entries)?;
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

    #[test]
    fn append_and_read_roundtrip() {
        let dir = temp_dir();
        assert!(read_entries(&dir).is_empty());
        let r = append(&dir, "  reviews go to Opus  ", "2026-07-07").unwrap();
        assert!(r.stored && r.dropped == 0 && r.total == 1);
        let entries = read_entries(&dir);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].date, "2026-07-07");
        assert_eq!(entries[0].text, "reviews go to Opus");
        assert_eq!(render_entries(&entries), "- 2026-07-07 reviews go to Opus");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn empty_text_is_rejected() {
        let dir = temp_dir();
        assert!(append(&dir, "   ", "2026-07-07").is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn count_cap_drops_oldest_fifo() {
        let dir = temp_dir();
        for i in 0..(MAX_ENTRIES + 5) {
            append(&dir, &format!("fact {i}"), "2026-07-07").unwrap();
        }
        let entries = read_entries(&dir);
        assert_eq!(entries.len(), MAX_ENTRIES);
        // oldest (fact 0..4) dropped; newest kept
        assert_eq!(entries.first().unwrap().text, "fact 5");
        assert_eq!(entries.last().unwrap().text, format!("fact {}", MAX_ENTRIES + 4));
        // the last append reported a drop
        let r = append(&dir, "one more", "2026-07-07").unwrap();
        assert!(r.dropped >= 1);
        assert!(r.note.contains("dropped"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn char_cap_drops_oldest() {
        let dir = temp_dir();
        let big = "x".repeat(500);
        for _ in 0..6 {
            append(&dir, &big, "2026-07-07").unwrap();
        }
        let entries = read_entries(&dir);
        assert!(total_chars(&entries) <= MAX_TOTAL_CHARS);
        assert!(entries.len() < 6, "char cap should have dropped some");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn remove_by_index() {
        let dir = temp_dir();
        append(&dir, "a", "2026-07-07").unwrap();
        append(&dir, "b", "2026-07-07").unwrap();
        append(&dir, "c", "2026-07-07").unwrap();
        let left = remove(&dir, 1).unwrap();
        assert_eq!(left.iter().map(|e| e.text.as_str()).collect::<Vec<_>>(), ["a", "c"]);
        assert!(remove(&dir, 9).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parsing_ignores_the_header_and_tolerates_hand_edits() {
        let dir = temp_dir();
        let path = memory_path(&dir);
        fs::write(
            &path,
            "# Orchestrator memory\n\nsome prose that is not a list line\n\n- 2026-07-07 dated entry\n- undated hand-added entry\n* star bullet entry\n",
        )
        .unwrap();
        let entries = read_entries(&dir);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].date, "2026-07-07");
        assert_eq!(entries[1].date, "");
        assert_eq!(entries[1].text, "undated hand-added entry");
        assert_eq!(entries[2].text, "star bullet entry");
        fs::remove_dir_all(&dir).ok();
    }
}
