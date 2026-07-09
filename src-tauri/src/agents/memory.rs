//! A custom agent's curated memory: `memory.md` inside the agent's own folder
//! (`~/.swarmz/agents/<slug>/memory.md`). Same file mechanic as the
//! orchestrator's memory (`crate::orchestrator::memory`) — one ISO-dated entry
//! per line, atomic temp+rename writes, FIFO caps — but scoped per agent and
//! with GENEROUSER caps: a specialist's domain memory is less sensitive than
//! the fleet-global orchestrator memory, so it may hold more.
//!
//! This is a deliberate COPY of the orchestrator pattern, not a refactor of it:
//! the orchestrator memory carries guardrail content tests and must not move.
//!
//! All IO here is synchronous and small; callers run it through
//! `spawn_blocking` (the sync-command invariant).

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

const MEMORY_FILE: &str = "memory.md";
/// Header written above the entries (skipped on read — not a list line).
const FILE_HEADER: &str = "# Agent memory\n\nCurated facts this agent chose to remember. One entry per line — edit or delete freely; the agent reads it fresh each session.\n\n";

/// Max number of entries kept. Overflow drops the oldest (FIFO). Generouser
/// than the orchestrator's 20 (domain facts, not global fleet facts).
pub const MAX_ENTRIES: usize = 40;
/// Max total characters across all entries. Overflow drops the oldest.
pub const MAX_TOTAL_CHARS: usize = 6000;

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
            "swarmz-agent-memory-test-{}-{}",
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
        let r = append(&dir, "  retention beats reach  ", "2026-07-08").unwrap();
        assert!(r.stored && r.dropped == 0 && r.total == 1);
        let entries = read_entries(&dir);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].date, "2026-07-08");
        assert_eq!(entries[0].text, "retention beats reach");
        assert_eq!(render_entries(&entries), "- 2026-07-08 retention beats reach");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn caps_are_generouser_than_the_orchestrator() {
        // sanity: this module keeps more than the orchestrator's 20/2000
        assert!(MAX_ENTRIES > 20);
        assert!(MAX_TOTAL_CHARS > 2000);
    }

    #[test]
    fn count_cap_drops_oldest_fifo() {
        let dir = temp_dir();
        for i in 0..(MAX_ENTRIES + 5) {
            append(&dir, &format!("fact {i}"), "2026-07-08").unwrap();
        }
        let entries = read_entries(&dir);
        assert_eq!(entries.len(), MAX_ENTRIES);
        assert_eq!(entries.first().unwrap().text, "fact 5");
        assert_eq!(
            entries.last().unwrap().text,
            format!("fact {}", MAX_ENTRIES + 4)
        );
        let r = append(&dir, "one more", "2026-07-08").unwrap();
        assert!(r.dropped >= 1);
        assert!(r.note.contains("dropped"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn remove_by_index() {
        let dir = temp_dir();
        append(&dir, "a", "2026-07-08").unwrap();
        append(&dir, "b", "2026-07-08").unwrap();
        append(&dir, "c", "2026-07-08").unwrap();
        let left = remove(&dir, 1).unwrap();
        assert_eq!(
            left.iter().map(|e| e.text.as_str()).collect::<Vec<_>>(),
            ["a", "c"]
        );
        assert!(remove(&dir, 9).is_err());
        fs::remove_dir_all(&dir).ok();
    }
}
