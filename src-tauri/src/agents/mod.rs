//! Custom Agents — the "Agent-Baukasten" (Phase A: anatomy + discovery +
//! context compilation). A custom agent is a FOLDER on disk under
//! `~/.swarmz/agents/<slug>/`; the folder is the single source of truth (the
//! frontend store only caches it). Anatomy:
//!
//! ```text
//! ~/.swarmz/agents/<slug>/
//! ├── agent.json    identity + start defaults (the machine-readable card)
//! ├── soul.md       the voice: self-image, tone, values, limits
//! ├── memory.md     curated memory the agent maintains itself (caps: 40 / 6 KB)
//! └── knowledge/    optional reference files (only a TOC is ever injected)
//! ```
//!
//! This module generalizes the orchestrator's `persona.rs` + `memory.rs`
//! pattern to many on-disk agents. It never touches the orchestrator's own
//! files — Maestro stays the built-in "Agent #0" living in the app data dir.
//!
//! All IO is synchronous and small; the Tauri commands (in `lib.rs`) wrap every
//! call in `spawn_blocking` (the sync-command invariant).

pub mod builder;
pub mod context;
pub mod memory;

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub use context::CompiledContext;
pub use memory::{AppendResult, MemoryEntry};

const AGENT_FILE: &str = "agent.json";
const SOUL_FILE: &str = "soul.md";
const KNOWLEDGE_DIR: &str = "knowledge";

fn default_runtime() -> String {
    "vibe".into()
}

/// The identity + start defaults of a custom agent — the `agent.json` payload.
/// Camel-cased on disk (hand-editable, matches the frontend types). Missing
/// fields are tolerated so a partly hand-written file still loads.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentDef {
    pub name: String,
    /// Folder identity (kebab-case). Authoritative even if agent.json disagrees.
    pub slug: String,
    #[serde(default)]
    pub emoji: String,
    /// Identity color (hex). IDENTITY, never status (DESIGN.md).
    #[serde(default)]
    pub accent: String,
    /// Short role line, e.g. "strategy & scripts".
    #[serde(default)]
    pub role: String,
    /// Voice / directness hint.
    #[serde(default)]
    pub tone: String,
    #[serde(default)]
    pub principles: Vec<String>,
    /// "vibe" | "claude" | "codex" — the suggested start runtime.
    #[serde(default = "default_runtime")]
    pub default_runtime: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<String>,
    /// e.g. "workspace" | "full" (native sessions) — free-form for now.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_access: Option<String>,
    #[serde(default)]
    pub created_at: String,
}

/// A library-card summary: the def plus cheap, on-disk-derived counts and a
/// one-line description lifted from soul.md. Returned by `list`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSummary {
    #[serde(flatten)]
    pub def: AgentDef,
    /// One-line blurb taken from the first prose line of soul.md (capped).
    pub description: String,
    pub memory_count: usize,
    pub memory_max: usize,
    pub knowledge_count: usize,
    /// Absolute path of the agent folder (for the "Files" reveal action).
    pub dir: String,
}

/// Full detail for the editor: def + soul text + memory entries + knowledge
/// filenames. Returned by `read`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDetail {
    #[serde(flatten)]
    pub def: AgentDef,
    pub soul: String,
    pub memory: Vec<MemoryEntry>,
    pub knowledge: Vec<String>,
    pub dir: String,
}

// ---- slug ----

/// Validate a slug: non-empty kebab-case (`[a-z0-9-]`, no leading/trailing/
/// double dash). Also the guard that keeps every path operation inside the
/// agents root (no traversal).
pub fn is_valid_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && !s.starts_with('-')
        && !s.ends_with('-')
        && !s.contains("--")
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn require_slug(slug: &str) -> Result<(), String> {
    if is_valid_slug(slug) {
        Ok(())
    } else {
        Err(format!(
            "invalid agent slug '{slug}' (use lowercase letters, digits and single dashes)"
        ))
    }
}

// ---- paths ----

fn agent_dir(root: &Path, slug: &str) -> PathBuf {
    root.join(slug)
}

fn agent_file(dir: &Path) -> PathBuf {
    dir.join(AGENT_FILE)
}

fn soul_file(dir: &Path) -> PathBuf {
    dir.join(SOUL_FILE)
}

/// Write `bytes` atomically (temp + rename) inside `dir`, creating it if needed.
fn write_atomic(dir: &Path, file: &str, bytes: &str) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{file}.tmp"));
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, dir.join(file)).map_err(|e| e.to_string())
}

// ---- def IO ----

/// Parse an `agent.json` defensively. The folder name (`slug`) is authoritative
/// and stamped onto the def regardless of the file's own `slug` field.
fn parse_def(bytes: &str, slug: &str) -> Result<AgentDef, String> {
    let mut def: AgentDef =
        serde_json::from_str(bytes).map_err(|e| format!("agent.json: {e}"))?;
    def.slug = slug.to_string();
    Ok(def)
}

fn read_def(dir: &Path, slug: &str) -> Result<AgentDef, String> {
    let raw = fs::read_to_string(agent_file(dir))
        .map_err(|e| format!("cannot read agent.json: {e}"))?;
    parse_def(&raw, slug)
}

fn serialize_def(def: &AgentDef) -> Result<String, String> {
    serde_json::to_string_pretty(def).map_err(|e| e.to_string())
}

// ---- soul / knowledge ----

/// Lift a one-line description from soul.md: the first non-empty, non-heading
/// line, capped. Empty when there is no prose.
fn soul_description(soul: &str) -> String {
    let line = soul
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with("---"))
        .unwrap_or("");
    let mut out: String = line.chars().take(140).collect();
    if line.chars().count() > 140 {
        out.push('…');
    }
    out
}

/// List the filenames in `knowledge/` (files only, non-recursive). Missing dir
/// → empty. Hidden/temp files (leading `.`) are skipped.
fn knowledge_files(dir: &Path) -> Vec<String> {
    let kdir = dir.join(KNOWLEDGE_DIR);
    let mut names: Vec<String> = match fs::read_dir(&kdir) {
        Ok(rd) => rd
            .filter_map(Result::ok)
            .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| !n.starts_with('.'))
            .collect(),
        Err(_) => Vec::new(),
    };
    names.sort();
    names
}

// ---- public API ----

/// Discover every agent under `root`. One broken `agent.json` costs only itself
/// (skipped) — the chat-store philosophy. Missing root → empty list.
pub fn list(root: &Path) -> Vec<AgentSummary> {
    let mut out: Vec<AgentSummary> = Vec::new();
    let rd = match fs::read_dir(root) {
        Ok(rd) => rd,
        Err(_) => return out,
    };
    for entry in rd.filter_map(Result::ok) {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let slug = entry.file_name().to_string_lossy().to_string();
        if !is_valid_slug(&slug) {
            continue;
        }
        let dir = entry.path();
        let def = match read_def(&dir, &slug) {
            Ok(def) => def,
            Err(_) => continue, // a broken agent is skipped, never fatal
        };
        let soul = fs::read_to_string(soul_file(&dir)).unwrap_or_default();
        let mem = memory::read_entries(&dir);
        out.push(AgentSummary {
            description: soul_description(&soul),
            memory_count: mem.len(),
            memory_max: memory::MAX_ENTRIES,
            knowledge_count: knowledge_files(&dir).len(),
            dir: dir.to_string_lossy().to_string(),
            def,
        });
    }
    out.sort_by(|a, b| a.def.name.to_lowercase().cmp(&b.def.name.to_lowercase()));
    out
}

/// Full detail for one agent (editor). Errors when the agent or its agent.json
/// is missing/unreadable.
pub fn read(root: &Path, slug: &str) -> Result<AgentDetail, String> {
    require_slug(slug)?;
    let dir = agent_dir(root, slug);
    let def = read_def(&dir, slug)?;
    let soul = fs::read_to_string(soul_file(&dir)).unwrap_or_default();
    Ok(AgentDetail {
        soul,
        memory: memory::read_entries(&dir),
        knowledge: knowledge_files(&dir),
        dir: dir.to_string_lossy().to_string(),
        def,
    })
}

/// Create a new agent folder with agent.json + soul.md + an empty memory.md.
/// Errors if the slug is invalid or the folder already exists.
pub fn create(root: &Path, def: &AgentDef, soul: &str) -> Result<AgentDetail, String> {
    require_slug(&def.slug)?;
    let dir = agent_dir(root, &def.slug);
    if dir.exists() {
        return Err(format!("an agent named '{}' already exists", def.slug));
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut def = def.clone();
    if def.created_at.trim().is_empty() {
        def.created_at = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    }
    if def.default_runtime.trim().is_empty() {
        def.default_runtime = default_runtime();
    }
    write_atomic(&dir, AGENT_FILE, &serialize_def(&def)?)?;
    write_atomic(&dir, SOUL_FILE, soul)?;
    // memory.md is created lazily on the agent's first append — the folder is
    // complete and hand-editable without it.
    read(root, &def.slug)
}

/// Overwrite agent.json + soul.md for an existing agent (the editor's Save).
/// Errors when the agent folder does not exist. `memory.md`/`knowledge/` are
/// untouched — those are the agent's own.
pub fn write(root: &Path, slug: &str, def: &AgentDef, soul: &str) -> Result<AgentDetail, String> {
    require_slug(slug)?;
    let dir = agent_dir(root, slug);
    if !dir.exists() {
        return Err(format!("no agent named '{slug}'"));
    }
    let mut def = def.clone();
    def.slug = slug.to_string(); // slug is the folder identity, never renamed here
    if def.created_at.trim().is_empty() {
        // preserve the original createdAt if the payload dropped it
        if let Ok(existing) = read_def(&dir, slug) {
            def.created_at = existing.created_at;
        }
    }
    write_atomic(&dir, AGENT_FILE, &serialize_def(&def)?)?;
    write_atomic(&dir, SOUL_FILE, soul)?;
    read(root, slug)
}

/// Delete an agent folder (and everything inside it). Slug-validated so the
/// path can never escape the agents root.
pub fn delete(root: &Path, slug: &str) -> Result<(), String> {
    require_slug(slug)?;
    let dir = agent_dir(root, slug);
    if !dir.exists() {
        return Ok(()); // already gone → success (idempotent)
    }
    fs::remove_dir_all(&dir).map_err(|e| e.to_string())
}

/// Append one fact to an agent's memory. `today` is passed in for determinism.
pub fn memory_append(
    root: &Path,
    slug: &str,
    text: &str,
    today: &str,
) -> Result<AppendResult, String> {
    require_slug(slug)?;
    memory::append(&agent_dir(root, slug), text, today)
}

/// Remove one memory entry by index; returns the remaining entries.
pub fn memory_remove(root: &Path, slug: &str, index: usize) -> Result<Vec<MemoryEntry>, String> {
    require_slug(slug)?;
    memory::remove(&agent_dir(root, slug), index)
}

/// Compile the full runtime context for one agent (Phase B start pipeline):
/// soul → fixed operative block → memory snapshot → knowledge TOC, with the
/// hard budget flag. Reads the folder fresh (frozen at this moment).
pub fn compile_context(root: &Path, slug: &str) -> Result<CompiledContext, String> {
    require_slug(slug)?;
    let dir = agent_dir(root, slug);
    if !dir.exists() {
        return Err(format!("no agent named '{slug}'"));
    }
    let soul = fs::read_to_string(soul_file(&dir)).unwrap_or_default();
    let memory_block = memory::render_entries(&memory::read_entries(&dir));
    let toc = context::knowledge_toc(&knowledge_files(&dir));
    let operative = context::operative_block(
        &dir.to_string_lossy(),
        &dir.join("memory.md").to_string_lossy(),
    );
    let text = context::assemble(&soul, &operative, &memory_block, &toc);
    Ok(context::finalize(text))
}

/// Build the Agent-Builder developer-instructions for a session whose cwd is
/// `<root>/<slug>`. Pure string assembly (no IO) — the folder is created
/// separately by `create` before the Builder session starts. `refine` picks the
/// new-build vs. refine-existing opening.
pub fn builder_instructions(root: &Path, slug: &str, refine: bool) -> Result<String, String> {
    require_slug(slug)?;
    let dir = agent_dir(root, slug);
    Ok(builder::build_builder_instructions(
        slug,
        &dir.to_string_lossy(),
        refine,
    ))
}

/// Name of the compiled-context cache written into an agent's folder at start.
pub const COMPILED_FILE: &str = ".compiled.md";

/// Compile the agent's context and write it to `<dir>/.compiled.md`, returning
/// the file's absolute path. This is what the terminal start-ways read from:
/// Claude via `--append-system-prompt-file <path>`, Codex via
/// `-c developer_instructions="$(cat <path>)"`. Rewritten on every start so the
/// snapshot is fresh (the same frozen-at-start-time model as Maestro's memory).
pub fn write_compiled(root: &Path, slug: &str) -> Result<String, String> {
    let compiled = compile_context(root, slug)?;
    let dir = agent_dir(root, slug);
    write_atomic(&dir, COMPILED_FILE, &compiled.text)?;
    Ok(dir.join(COMPILED_FILE).to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "swarmz-agents-test-{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_def(slug: &str) -> AgentDef {
        AgentDef {
            name: "YouTube Coach".into(),
            slug: slug.into(),
            emoji: "📺".into(),
            accent: "#e0637a".into(),
            role: "strategy & scripts".into(),
            tone: "direct, honest".into(),
            principles: vec!["retention first".into()],
            default_runtime: "vibe".into(),
            default_model: None,
            default_effort: None,
            default_access: None,
            created_at: String::new(),
        }
    }

    #[test]
    fn slug_validation() {
        assert!(is_valid_slug("youtube-coach"));
        assert!(is_valid_slug("ferris"));
        assert!(!is_valid_slug("YouTube"));
        assert!(!is_valid_slug("-lead"));
        assert!(!is_valid_slug("a--b"));
        assert!(!is_valid_slug("../etc"));
        assert!(!is_valid_slug(""));
    }

    #[test]
    fn create_read_write_roundtrip() {
        let root = temp_root();
        let detail = create(&root, &sample_def("youtube-coach"), "# YouTube Coach\nRetention first.")
            .unwrap();
        assert_eq!(detail.def.name, "YouTube Coach");
        assert!(!detail.def.created_at.is_empty(), "createdAt auto-stamped");

        // duplicate create fails
        assert!(create(&root, &sample_def("youtube-coach"), "x").is_err());

        // edit
        let mut def = detail.def.clone();
        def.role = "video strategy".into();
        let updated = write(&root, "youtube-coach", &def, "# YouTube Coach\nNew soul.").unwrap();
        assert_eq!(updated.def.role, "video strategy");
        assert_eq!(updated.def.created_at, detail.def.created_at, "createdAt preserved");
        assert!(updated.soul.contains("New soul"));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn list_skips_broken_agents() {
        let root = temp_root();
        create(&root, &sample_def("good-one"), "# Good\nA fine agent.").unwrap();
        // a broken agent: folder + invalid json
        let broken = root.join("broken");
        fs::create_dir_all(&broken).unwrap();
        fs::write(broken.join(AGENT_FILE), "{ not json").unwrap();
        // a stray non-agent folder without agent.json
        fs::create_dir_all(root.join("empty")).unwrap();

        let agents = list(&root);
        assert_eq!(agents.len(), 1, "only the good agent survives");
        assert_eq!(agents[0].def.slug, "good-one");
        assert_eq!(agents[0].description, "A fine agent.");
        assert_eq!(agents[0].memory_max, memory::MAX_ENTRIES);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn compile_context_has_the_expected_structure() {
        let root = temp_root();
        create(
            &root,
            &sample_def("youtube-coach"),
            "# YouTube Coach\nYou coach a developer-audience channel. Retention first.",
        )
        .unwrap();
        memory_append(&root, "youtube-coach", "audience is developers", "2026-07-08").unwrap();
        // a knowledge file
        let kdir = root.join("youtube-coach").join(KNOWLEDGE_DIR);
        fs::create_dir_all(&kdir).unwrap();
        fs::write(kdir.join("retention.md"), "long secret contents here").unwrap();

        let ctx = compile_context(&root, "youtube-coach").unwrap();
        // order: soul → operative → memory → knowledge TOC
        let soul = ctx.text.find("You coach a developer-audience").unwrap();
        let core = ctx.text.find("Operating rules").unwrap();
        let mem = ctx.text.find("audience is developers").unwrap();
        let know = ctx.text.find("knowledge/retention.md").unwrap();
        assert!(soul < core && core < mem && mem < know);
        // knowledge is TOC-only — file contents NEVER injected
        assert!(!ctx.text.contains("long secret contents"));
        // within budget for a small agent
        assert!(!ctx.over_budget);
        assert_eq!(ctx.budget, context::BUDGET_BYTES);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn write_compiled_writes_cache_and_returns_path() {
        let root = temp_root();
        create(&root, &sample_def("scribe"), "You are Scribe, a careful writer.").unwrap();
        let path = write_compiled(&root, "scribe").unwrap();
        assert!(path.ends_with(COMPILED_FILE), "returns the .compiled.md path");
        let written = fs::read_to_string(&path).unwrap();
        let compiled = compile_context(&root, "scribe").unwrap();
        // the file IS the compiled context (what the terminal start-ways read)
        assert_eq!(written, compiled.text);
        assert!(written.contains("You are Scribe"));
        assert!(written.contains("Operating rules"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn compile_context_reports_budget_overflow() {
        let root = temp_root();
        let big_soul = "x".repeat(context::BUDGET_BYTES + 100);
        create(&root, &sample_def("big-brain"), &big_soul).unwrap();
        let ctx = compile_context(&root, "big-brain").unwrap();
        assert!(ctx.over_budget, "oversized soul trips the budget flag");
        assert!(ctx.bytes > context::BUDGET_BYTES);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn delete_is_idempotent_and_slug_guarded() {
        let root = temp_root();
        create(&root, &sample_def("gone"), "soul").unwrap();
        assert!(delete(&root, "gone").is_ok());
        assert!(delete(&root, "gone").is_ok(), "second delete is a no-op");
        assert!(delete(&root, "../etc").is_err(), "traversal rejected");
        fs::remove_dir_all(&root).ok();
    }
}
