//! Orchestrator sensing: read-only transcript extraction from the codex
//! rollout jsonl files — actual message CONTENT (user prompts, assistant
//! text) instead of token stats. Also serves the project docs
//! (README/AGENTS/CLAUDE.md) of a repo root. Strictly read-only; no caching
//! — callers pull on demand, and the byte-capped tail read keeps even
//! multi-hundred-MB session files cheap.

use serde::Serialize;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// Defaults for `TranscriptOpts` — tuned so one call returns a useful tail
/// without ever pulling a whole giant file into memory.
const DEFAULT_TAIL_MESSAGES: usize = 20;
const DEFAULT_MAX_BYTES: u64 = 1024 * 1024; // 1 MiB tail window
/// Head window scanned for the session's first real user message.
const HEAD_SCAN_BYTES: u64 = 256 * 1024;
/// Per-message text cap (chars, not bytes — transcripts are full of umlauts).
const MESSAGE_CHAR_CAP: usize = 1500;
/// Cap for the "Ursprungsprompt" (first user message).
const FIRST_MESSAGE_CHAR_CAP: usize = 2000;

#[derive(Clone, Debug)]
pub struct TranscriptOpts {
    /// return the LAST n messages
    pub tail_messages: usize,
    /// hard cap on bytes read from the file end (huge files are seek-tailed)
    pub max_bytes: u64,
    /// also extract the session's first real user message from the file head
    pub include_first_user_message: bool,
}

impl Default for TranscriptOpts {
    fn default() -> Self {
        Self {
            tail_messages: DEFAULT_TAIL_MESSAGES,
            max_bytes: DEFAULT_MAX_BYTES,
            include_first_user_message: true,
        }
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct TranscriptMessage {
    /// "user" | "assistant"
    pub role: String,
    pub text: String,
    /// rfc3339 timestamp of the line, when present
    pub at: Option<String>,
    /// "text" | "tool" — tool_use/tool_result one-liners are kind "tool"
    pub kind: String,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct TranscriptView {
    /// the session's first real user message (the "Ursprungsprompt"), capped
    pub first_user_message: Option<String>,
    /// compaction summaries seen in the window (unused for codex rollouts —
    /// kept for shape stability)
    pub summaries: Vec<String>,
    pub messages: Vec<TranscriptMessage>,
    /// true when the byte cap cut the file or the tail limit dropped messages
    pub truncated: bool,
}

// ---- shared small helpers ----

/// Char-boundary-safe truncation with an explicit "…" marker.
fn truncate_chars(s: &str, max: usize) -> String {
    let mut it = s.char_indices();
    match it.nth(max) {
        Some((idx, _)) => {
            let mut out = s[..idx].to_string();
            out.push('…');
            out
        }
        None => s.to_string(),
    }
}

/// Read up to `max_bytes` from the END of the file. When the cap cuts the
/// file, the window starts at the first complete line inside it. Returns
/// (bytes, was_byte_truncated).
fn read_tail_window(path: &Path, max_bytes: u64) -> Result<(Vec<u8>, bool), String> {
    let mut f =
        fs::File::open(path).map_err(|e| format!("cannot open {}: {e}", path.display()))?;
    let size = f.metadata().map_err(|e| e.to_string())?.len();
    let cap = max_bytes.max(4096); // a uselessly small cap would return nothing
    if size <= cap {
        let mut buf = Vec::with_capacity(size as usize);
        f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        return Ok((buf, false));
    }
    f.seek(SeekFrom::Start(size - cap)).map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(cap as usize);
    f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    // drop the partial first line — parse only complete lines
    let start = buf
        .iter()
        .position(|&b| b == b'\n')
        .map(|i| i + 1)
        .unwrap_or(buf.len());
    Ok((buf.split_off(start), true))
}

/// Read up to `cap` bytes from the file HEAD, cut back to the last complete line.
fn read_head_window(path: &Path, cap: u64) -> Vec<u8> {
    let Ok(f) = fs::File::open(path) else {
        return Vec::new();
    };
    let mut buf = Vec::new();
    if f.take(cap).read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    if buf.len() as u64 >= cap {
        if let Some(last_nl) = buf.iter().rposition(|&b| b == b'\n') {
            buf.truncate(last_nl + 1);
        }
    }
    buf
}

// ---- Codex rollout jsonl (~/.codex/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl) ----

/// `response_item` user texts that are injected context, not typed input
/// (AGENTS.md instructions, permissions/app-context wrappers, …). Only used
/// on the fallback path — `event_msg/user_message` carries clean input.
fn is_codex_wrapper_text(t: &str) -> bool {
    let t = t.trim_start();
    t.starts_with('<') || t.starts_with("# AGENTS.md")
}

/// Parse a codex rollout window into two candidate streams: the `event_msg`
/// chat stream (clean user/agent messages — present in every rollout observed
/// in the wild) and a `response_item` fallback for files without event_msgs.
fn parse_codex_lines(bytes: &[u8]) -> (Vec<TranscriptMessage>, Vec<TranscriptMessage>) {
    let mut events = Vec::new();
    let mut items = Vec::new();
    for line in bytes.split(|&b| b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_slice::<serde_json::Value>(line) else {
            continue;
        };
        let at = v
            .get("timestamp")
            .and_then(|t| t.as_str())
            .map(String::from);
        let Some(payload) = v.get("payload") else {
            continue;
        };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("event_msg") => {
                let role = match payload.get("type").and_then(|t| t.as_str()) {
                    Some("user_message") => "user",
                    // includes both "commentary" and "final_answer" phases —
                    // all of it is the assistant's visible chat text
                    Some("agent_message") => "assistant",
                    _ => continue,
                };
                if let Some(m) = payload.get("message").and_then(|m| m.as_str()) {
                    if !m.trim().is_empty() {
                        events.push(TranscriptMessage {
                            role: role.to_string(),
                            text: m.trim().to_string(),
                            at,
                            kind: "text".to_string(),
                        });
                    }
                }
            }
            Some("response_item") => {
                if payload.get("type").and_then(|t| t.as_str()) != Some("message") {
                    continue;
                }
                let role = match payload.get("role").and_then(|r| r.as_str()) {
                    Some("user") => "user",
                    Some("assistant") => "assistant",
                    _ => continue, // developer/system context
                };
                let Some(blocks) = payload.get("content").and_then(|c| c.as_array()) else {
                    continue;
                };
                let text: Vec<&str> = blocks
                    .iter()
                    .filter(|b| {
                        matches!(
                            b.get("type").and_then(|t| t.as_str()),
                            Some("input_text") | Some("output_text") | Some("text")
                        )
                    })
                    .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                    .filter(|t| !t.trim().is_empty())
                    .filter(|t| role != "user" || !is_codex_wrapper_text(t))
                    .collect();
                if !text.is_empty() {
                    items.push(TranscriptMessage {
                        role: role.to_string(),
                        text: text.join("\n\n").trim().to_string(),
                        at,
                        kind: "text".to_string(),
                    });
                }
            }
            _ => {}
        }
    }
    (events, items)
}

fn codex_first_user_message(path: &Path) -> Option<String> {
    let bytes = read_head_window(path, HEAD_SCAN_BYTES);
    let (events, items) = parse_codex_lines(&bytes);
    let stream = if events.is_empty() { items } else { events };
    stream
        .into_iter()
        .find(|m| m.role == "user")
        .map(|m| truncate_chars(&m.text, FIRST_MESSAGE_CHAR_CAP))
}

/// Find a codex rollout file by session id under `root`. The uuid is the
/// filename tail (`rollout-<date>T<time>-<uuid>.jsonl`), so a suffix match is
/// enough; a head-scan for the `session_meta` id covers renamed files.
pub(crate) fn codex_session_path(root: &Path, session_id: &str) -> Option<PathBuf> {
    if session_id.is_empty() || !root.is_dir() {
        return None;
    }
    let files: Vec<PathBuf> = WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("jsonl"))
        .collect();
    if let Some(p) = files.iter().find(|p| {
        p.file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.ends_with(session_id))
            .unwrap_or(false)
    }) {
        return Some(p.clone());
    }
    // fallback: match the session_meta id in the first lines
    let needle_a = format!("\"session_id\":\"{session_id}\"");
    let needle_b = format!("\"id\":\"{session_id}\"");
    files.into_iter().find(|p| {
        let head = read_head_window(p, 8192);
        let head = String::from_utf8_lossy(&head);
        head.contains(&needle_a) || head.contains(&needle_b)
    })
}

// ---- entry points ----

/// Locate the codex rollout file for a session id.
fn resolve_session_path(session_id: &str) -> Result<PathBuf, String> {
    if session_id.trim().is_empty() {
        return Err("session id is empty".into());
    }
    let root = dirs::home_dir()
        .map(|h| h.join(".codex").join("sessions"))
        .ok_or("no home directory")?;
    codex_session_path(&root, session_id)
        .ok_or_else(|| format!("no Codex session file for {session_id}"))
}

/// Parse one codex rollout file into a `TranscriptView` (see `TranscriptOpts`).
pub fn read_transcript_file(path: &Path, opts: &TranscriptOpts) -> Result<TranscriptView, String> {
    let (bytes, byte_truncated) = read_tail_window(path, opts.max_bytes)?;
    let mut messages = {
        let (events, items) = parse_codex_lines(&bytes);
        if events.is_empty() { items } else { events }
    };
    let tail = opts.tail_messages.max(1);
    let dropped = messages.len() > tail;
    if dropped {
        messages.drain(..messages.len() - tail);
    }
    for m in &mut messages {
        m.text = truncate_chars(&m.text, MESSAGE_CHAR_CAP);
    }
    let first_user_message = if opts.include_first_user_message {
        codex_first_user_message(path)
    } else {
        None
    };
    Ok(TranscriptView {
        first_user_message,
        summaries: Vec::new(),
        messages,
        truncated: byte_truncated || dropped,
    })
}

/// Command-level entry: resolve the rollout file, then parse it.
pub fn read(session_id: &str, opts: &TranscriptOpts) -> Result<TranscriptView, String> {
    let path = resolve_session_path(session_id)?;
    read_transcript_file(&path, opts)
}

// ---- project docs ----

const DOC_FILES: &[&str] = &["README.md", "AGENTS.md", "CLAUDE.md"];
const DOC_FILE_CAP: usize = 8 * 1024; // per file
const DOC_TOTAL_CAP: usize = 20 * 1024; // across all files

#[derive(Serialize, Clone, Debug)]
pub struct ProjectDocFile {
    pub name: String,
    pub content: String,
    pub truncated: bool,
    /// full on-disk size in bytes
    pub size: u64,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct ProjectDocs {
    pub files: Vec<ProjectDocFile>,
    /// the root the docs were read from (worktree paths resolve to the main repo)
    pub root_used: String,
}

/// A SwarmZ worktree path (`<repo>/.worktrees/<slug>/…`) resolves to the main
/// repo root — docs belong to the project, not the throwaway worktree folder.
pub(crate) fn collapse_worktree_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        if c.as_os_str() == ".worktrees" {
            return out;
        }
        out.push(c);
    }
    out
}

/// Read one doc file NO-FOLLOW and BOUNDED (audit R4): a symlinked
/// README/AGENTS (planted by an agent to exfiltrate a host file) is refused,
/// a FIFO/device never hangs the reader, and at most `cap + 1` bytes are
/// pulled off disk (never the whole file). Returns (lossy content, on-disk
/// size, was_cut).
#[cfg(unix)]
fn read_doc_bounded(dir: &Path, name: &str, cap: usize) -> Option<(String, u64, bool)> {
    let handle = crate::fsx::DirHandle::open_root(dir).ok()?;
    let file = handle.open_file(name).ok()??; // symlink/FIFO → None via Err
    let size = file.metadata().ok()?.len();
    let mut bytes = Vec::new();
    (&file)
        .take(cap as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    let cut = bytes.len() > cap;
    if cut {
        bytes.truncate(cap);
    }
    Some((String::from_utf8_lossy(&bytes).into_owned(), size, cut))
}

#[cfg(not(unix))]
fn read_doc_bounded(dir: &Path, name: &str, cap: usize) -> Option<(String, u64, bool)> {
    let p = dir.join(name);
    let meta = p.symlink_metadata().ok()?;
    if !meta.is_file() {
        return None;
    }
    let file = fs::File::open(&p).ok()?;
    let mut bytes = Vec::new();
    file.take(cap as u64 + 1).read_to_end(&mut bytes).ok()?;
    let cut = bytes.len() > cap;
    if cut {
        bytes.truncate(cap);
    }
    Some((String::from_utf8_lossy(&bytes).into_owned(), meta.len(), cut))
}

pub fn project_docs(root: &str) -> ProjectDocs {
    let root_used = collapse_worktree_path(Path::new(root.trim()));
    let mut docs = ProjectDocs {
        files: Vec::new(),
        root_used: root_used.to_string_lossy().into_owned(),
    };
    if !root_used.is_dir() {
        return docs;
    }
    let mut budget = DOC_TOTAL_CAP;
    for name in DOC_FILES {
        let cap = DOC_FILE_CAP.min(budget);
        if cap == 0 {
            break;
        }
        // no-follow + bounded (audit R4): missing, symlinked or non-regular
        // files are simply omitted, oversized ones are cut at the cap
        let Some((raw, size, byte_cut)) = read_doc_bounded(&root_used, name, cap) else {
            continue;
        };
        // caps are byte-ish but enforced on chars — close enough and safe
        let content = truncate_chars(&raw, cap);
        let truncated = byte_cut || content.len() != raw.len();
        budget = budget.saturating_sub(content.chars().count());
        docs.files.push(ProjectDocFile {
            name: name.to_string(),
            content,
            truncated,
            size,
        });
    }
    docs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "swarmz-transcript-test-{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_file(dir: &Path, name: &str, content: &str) -> PathBuf {
        let p = dir.join(name);
        fs::write(&p, content).unwrap();
        p
    }

    const CODEX_FIXTURE: &str = r#"{"timestamp":"2026-01-02T09:00:00Z","type":"session_meta","payload":{"session_id":"019fabc","cwd":"/tmp/proj"}}
{"timestamp":"2026-01-02T09:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<permissions instructions>sandbox…</permissions instructions>"}]}}
{"timestamp":"2026-01-02T09:00:02Z","type":"event_msg","payload":{"type":"user_message","message":"Fix the bug"}}
{"timestamp":"2026-01-02T09:00:03Z","type":"event_msg","payload":{"type":"agent_message","message":"Looking into it.","phase":"commentary"}}
{"timestamp":"2026-01-02T09:00:04Z","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{}"}}
{"timestamp":"2026-01-02T09:00:09Z","type":"event_msg","payload":{"type":"agent_message","message":"Fixed.","phase":"final_answer"}}
"#;

    #[test]
    fn codex_user_and_agent_messages() {
        let dir = temp_dir();
        let p = write_file(&dir, "rollout-2026-01-02T09-00-00-019fabc.jsonl", CODEX_FIXTURE);
        let view = read_transcript_file(&p, &TranscriptOpts::default()).unwrap();
        let texts: Vec<(&str, &str)> = view
            .messages
            .iter()
            .map(|m| (m.role.as_str(), m.text.as_str()))
            .collect();
        assert_eq!(
            texts,
            vec![
                ("user", "Fix the bug"),
                ("assistant", "Looking into it."),
                ("assistant", "Fixed."),
            ]
        );
        assert_eq!(view.first_user_message.as_deref(), Some("Fix the bug"));
        assert!(view.summaries.is_empty());
        assert_eq!(
            view.messages[0].at.as_deref(),
            Some("2026-01-02T09:00:02Z")
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tail_limit_keeps_the_last_messages() {
        let dir = temp_dir();
        let p = write_file(&dir, "rollout-2026-01-02T09-00-00-019fabc.jsonl", CODEX_FIXTURE);
        let view = read_transcript_file(
            &p,
            &TranscriptOpts {
                tail_messages: 2,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(view.messages.len(), 2);
        assert_eq!(view.messages[0].text, "Looking into it.");
        assert_eq!(view.messages[1].text, "Fixed.");
        assert!(view.truncated);
        // the first prompt still comes from the head read
        assert_eq!(view.first_user_message.as_deref(), Some("Fix the bug"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn byte_cap_tails_from_the_first_complete_line() {
        let dir = temp_dir();
        let filler = "x".repeat(6000);
        let filler_line = format!(
            r#"{{"timestamp":"2026-01-02T09:00:01Z","type":"event_msg","payload":{{"type":"user_message","message":"{filler}"}}}}"#
        );
        let content = format!(
            "{}\n{}\n{}\n",
            r#"{"timestamp":"2026-01-02T09:00:00Z","type":"event_msg","payload":{"type":"user_message","message":"FIRST message"}}"#,
            filler_line,
            r#"{"timestamp":"2026-01-02T09:00:02Z","type":"event_msg","payload":{"type":"agent_message","message":"tail marker"}}"#,
        );
        let p = write_file(&dir, "rollout-2026-01-02T09-00-00-019feee.jsonl", &content);
        // 4096-byte window lands inside the filler line → only the complete
        // last line is parsed; the whole file is never read
        let view = read_transcript_file(
            &p,
            &TranscriptOpts {
                max_bytes: 4096,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(view.messages.len(), 1);
        assert_eq!(view.messages[0].text, "tail marker");
        assert!(view.truncated);
        // first user message is read separately from the head
        assert_eq!(view.first_user_message.as_deref(), Some("FIRST message"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn per_message_text_is_capped_with_marker() {
        let dir = temp_dir();
        let long = "ä".repeat(3000); // multi-byte chars: truncation must not panic
        let content = format!(
            r#"{{"timestamp":"2026-01-02T09:00:00Z","type":"event_msg","payload":{{"type":"user_message","message":"{long}"}}}}"#
        );
        let p = write_file(&dir, "rollout-2026-01-02T09-00-00-019fddd.jsonl", &format!("{content}\n"));
        let view = read_transcript_file(&p, &TranscriptOpts::default()).unwrap();
        assert_eq!(view.messages.len(), 1);
        assert_eq!(view.messages[0].text.chars().count(), 1501);
        assert!(view.messages[0].text.ends_with('…'));
        // the first-user-message cap is the larger 2000-char one
        assert_eq!(
            view.first_user_message.as_ref().unwrap().chars().count(),
            2001
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn codex_falls_back_to_response_items_without_event_msgs() {
        let dir = temp_dir();
        let content = r##"{"timestamp":"2026-01-02T09:00:00Z","type":"session_meta","payload":{"session_id":"019fdef","cwd":"/tmp/proj"}}
{"timestamp":"2026-01-02T09:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /tmp/proj"}]}}
{"timestamp":"2026-01-02T09:00:02Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Real question"}]}}
{"timestamp":"2026-01-02T09:00:03Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Real answer"}]}}
"##;
        let p = write_file(&dir, "rollout-2026-01-02T09-00-00-019fdef.jsonl", content);
        let view = read_transcript_file(&p, &TranscriptOpts::default()).unwrap();
        let texts: Vec<(&str, &str)> = view
            .messages
            .iter()
            .map(|m| (m.role.as_str(), m.text.as_str()))
            .collect();
        assert_eq!(
            texts,
            vec![("user", "Real question"), ("assistant", "Real answer")]
        );
        assert_eq!(view.first_user_message.as_deref(), Some("Real question"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn codex_session_file_is_found_by_id_suffix() {
        let dir = temp_dir();
        let sub = dir.join("2026").join("01").join("02");
        fs::create_dir_all(&sub).unwrap();
        write_file(&sub, "rollout-2026-01-02T09-00-00-019fabc.jsonl", CODEX_FIXTURE);
        let found = codex_session_path(&dir, "019fabc").unwrap();
        assert!(found.ends_with("rollout-2026-01-02T09-00-00-019fabc.jsonl"));
        assert!(codex_session_path(&dir, "does-not-exist").is_none());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn project_docs_reads_caps_and_resolves_worktrees() {
        let dir = temp_dir();
        fs::write(dir.join("README.md"), "# Readme\nhello").unwrap();
        fs::write(dir.join("AGENTS.md"), "a".repeat(10_000)).unwrap();
        // no CLAUDE.md — must simply be omitted
        let wt = dir.join(".worktrees").join("slug");
        fs::create_dir_all(&wt).unwrap();

        let docs = project_docs(&wt.to_string_lossy());
        assert_eq!(docs.root_used, dir.to_string_lossy());
        assert_eq!(docs.files.len(), 2);
        assert_eq!(docs.files[0].name, "README.md");
        assert!(!docs.files[0].truncated);
        assert_eq!(docs.files[1].name, "AGENTS.md");
        assert!(docs.files[1].truncated);
        assert_eq!(docs.files[1].size, 10_000);
        assert!(docs.files[1].content.chars().count() <= DOC_FILE_CAP + 1);
        fs::remove_dir_all(&dir).ok();
    }

    /// Audit R4 (frozen): project docs are read NO-FOLLOW and bounded — a
    /// symlinked README (host-file exfiltration) is omitted, a FIFO with a
    /// doc name never hangs the reader, and an oversized file is cut at the
    /// cap instead of being slurped whole.
    #[cfg(unix)]
    #[test]
    fn project_docs_never_follow_symlinks_or_read_fifos() {
        let dir = temp_dir();
        let outside = temp_dir();
        fs::write(outside.join("secret.txt"), "HOST SECRET").unwrap();
        // README is a symlink to a host file → omitted, never leaked
        std::os::unix::fs::symlink(outside.join("secret.txt"), dir.join("README.md")).unwrap();
        // AGENTS.md is a FIFO → omitted without hanging
        {
            use std::os::unix::ffi::OsStrExt;
            let fifo = dir.join("AGENTS.md");
            let c = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
            unsafe { libc::mkfifo(c.as_ptr(), 0o644) };
        }
        // CLAUDE.md is a regular, oversized file → served, cut at the cap
        fs::write(dir.join("CLAUDE.md"), "c".repeat(DOC_FILE_CAP * 3)).unwrap();

        let docs = project_docs(&dir.to_string_lossy());
        assert_eq!(docs.files.len(), 1, "only the regular file is served");
        assert_eq!(docs.files[0].name, "CLAUDE.md");
        assert!(docs.files[0].truncated);
        assert!(docs.files[0].content.len() <= DOC_FILE_CAP + 4);
        assert!(
            !docs.files.iter().any(|f| f.content.contains("HOST SECRET")),
            "a symlinked doc must never leak host content"
        );
        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(&outside).ok();
    }
}
