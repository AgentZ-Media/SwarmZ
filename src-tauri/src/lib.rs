mod agents;
mod codex;
mod codex_usage;
mod git;
mod limits;
mod localstt;
mod openrouter;
mod orchestrator;
mod project;
mod projects;
mod pty;
mod storefile;
mod transcript;
mod usage;
mod worktree;

use notify::RecursiveMode;
use notify_debouncer_mini::new_debouncer;
use pty::{PtyManager, SharedPtyManager};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use usage::{SessionUsage, UsageTotals};

// pty_spawn/write/resize stay sync: they are fast (write is a channel send
// into the per-session writer thread, never a blocking PTY write — see
// pty.rs) and their main-thread serialization is what keeps spawn-before-
// write and keystroke ordering guarantees. Only kill goes off-thread: it can
// sleep ~250 ms in portable-pty's SIGHUP grace loop.
#[tauri::command]
fn pty_spawn(
    app: AppHandle,
    state: State<'_, SharedPtyManager>,
    id: String,
    cwd: Option<String>,
    startup: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.spawn(app, id, cwd, startup, cols, rows)
}

#[tauri::command]
fn pty_write(state: State<'_, SharedPtyManager>, id: String, data: String) -> Result<(), String> {
    state.write(&id, &data)
}

#[tauri::command]
fn pty_resize(
    state: State<'_, SharedPtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.resize(&id, cols, rows)
}

#[tauri::command]
async fn pty_kill(state: State<'_, SharedPtyManager>, id: String) -> Result<(), String> {
    let manager = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || manager.kill(&id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pty_has_children(
    state: State<'_, SharedPtyManager>,
    id: String,
) -> Result<bool, String> {
    let manager = Arc::clone(state.inner());
    // subprocess work (pgrep) — keep it off the async runtime's core threads
    tauri::async_runtime::spawn_blocking(move || manager.has_children(&id))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn project_commands(cwd: String) -> Vec<project::DetectedCommand> {
    // file reads — keep them off the async runtime's core threads
    tauri::async_runtime::spawn_blocking(move || project::detect(&cwd))
        .await
        .unwrap_or_default()
}

// Usage commands run off the main thread: the incremental cache makes them
// cheap in steady state, but the *first* call after launch parses the whole
// backlog under ~/.claude/projects — easily hundreds of MB for heavy users.
#[tauri::command]
async fn usage_for_dir(cwd: String, runtime: Option<String>) -> Option<SessionUsage> {
    tauri::async_runtime::spawn_blocking(move || match runtime.as_deref() {
        Some("codex") => codex_usage::usage_for_dir(&cwd),
        _ => usage::usage_for_dir(&cwd),
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
async fn usage_for_session(
    cwd: String,
    since: f64,
    session: Option<String>,
    exclude: Option<Vec<String>>,
    runtime: Option<String>,
) -> Option<SessionUsage> {
    tauri::async_runtime::spawn_blocking(move || match runtime.as_deref() {
        Some("codex") => codex_usage::usage_for_session(
            &cwd,
            since as u64,
            session.as_deref(),
            exclude.as_deref().unwrap_or(&[]),
        ),
        _ => usage::usage_for_session(
            &cwd,
            since as u64,
            session.as_deref(),
            exclude.as_deref().unwrap_or(&[]),
        ),
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
async fn usage_totals() -> Result<UsageTotals, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut totals = usage::usage_totals();
        let codex = codex_usage::usage_totals();
        totals.runtime = None;
        totals.total_cost_usd += codex.total_cost_usd;
        totals.input_tokens += codex.input_tokens;
        totals.output_tokens += codex.output_tokens;
        totals.cache_creation_tokens += codex.cache_creation_tokens;
        totals.cache_read_tokens += codex.cache_read_tokens;
        totals.reasoning_output_tokens += codex.reasoning_output_tokens;
        totals.message_count += codex.message_count;
        totals.session_count += codex.session_count;
        for cm in codex.by_model {
            if let Some(existing) = totals.by_model.iter_mut().find(|m| m.model == cm.model) {
                existing.input_tokens += cm.input_tokens;
                existing.output_tokens += cm.output_tokens;
                existing.cache_creation_tokens += cm.cache_creation_tokens;
                existing.cache_read_tokens += cm.cache_read_tokens;
                existing.reasoning_output_tokens += cm.reasoning_output_tokens;
                existing.message_count += cm.message_count;
                existing.cost_usd += cm.cost_usd;
            } else {
                totals.by_model.push(cm);
            }
        }
        totals
    })
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn subscription_limits() -> Result<Option<limits::SubscriptionLimits>, String> {
    limits::fetch_limits().await
}

/// Account-level Codex rate limits: the newest `rate_limits` event across all
/// of `~/.codex/sessions` (bounded tail reads, newest file first — see
/// `codex_usage::account_limits`). `limits: null` = no data ever seen.
#[tauri::command]
async fn codex_account_limits() -> codex_usage::CodexAccountLimits {
    // file walk + tail reads — keep them off the async runtime's core threads
    tauri::async_runtime::spawn_blocking(codex_usage::account_limits)
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn openrouter_key_status() -> openrouter::KeyStatus {
    openrouter::key_status().await
}

#[tauri::command]
async fn openrouter_set_key(key: String) -> Result<openrouter::KeyStatus, String> {
    // subprocess work (security CLI) — keep it off the async runtime's core threads
    tauri::async_runtime::spawn_blocking(move || openrouter::set_key(&key))
        .await
        .map_err(|e| e.to_string())??;
    Ok(openrouter::key_status().await)
}

#[tauri::command]
async fn openrouter_clear_key() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(openrouter::clear_key)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn openrouter_models() -> Result<Vec<openrouter::ModelInfo>, String> {
    openrouter::models().await
}

#[tauri::command]
async fn openrouter_transcribe(
    audio: String,
    format: String,
    model: String,
    language: Option<String>,
) -> Result<openrouter::TranscriptionResult, String> {
    openrouter::transcribe(audio, format, model, language).await
}

#[tauri::command]
async fn openrouter_cleanup(
    text: String,
    model: String,
    prompt: String,
) -> Result<String, String> {
    openrouter::cleanup(text, model, prompt).await
}

#[tauri::command]
fn local_stt_status() -> localstt::LocalSttStatus {
    localstt::status()
}

#[tauri::command]
async fn local_stt_download(app: AppHandle) -> Result<(), String> {
    localstt::download(app).await
}

#[tauri::command]
fn local_stt_cancel_download() {
    localstt::cancel_download();
}

#[tauri::command]
async fn local_stt_remove() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(localstt::remove)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn local_stt_unload() {
    localstt::unload();
}

#[tauri::command]
async fn local_stt_transcribe(audio: String) -> Result<openrouter::TranscriptionResult, String> {
    // model load + inference are seconds of CPU work — keep them off the
    // async runtime's core threads
    tauri::async_runtime::spawn_blocking(move || localstt::transcribe(&audio))
        .await
        .map_err(|e| e.to_string())?
}

/// Does this absolute path point at an existing file? Powers the inline
/// validation of the claude/git binary overrides in Settings — a typo there
/// would otherwise silently degrade several features at once.
#[tauri::command]
async fn path_is_file(path: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || std::path::Path::new(&path).is_file())
        .await
        .unwrap_or(false)
}

#[tauri::command]
async fn git_info(cwd: String, bin: Option<String>) -> Option<git::GitInfo> {
    // subprocess work — keep it off the async runtime's core threads
    tauri::async_runtime::spawn_blocking(move || git::git_info(&cwd, bin.as_deref()))
        .await
        .ok()
        .flatten()
}

#[tauri::command]
async fn worktree_add(
    cwd: String,
    branch: String,
    copy_env: bool,
    bin: Option<String>,
) -> Result<worktree::WorktreeInfo, String> {
    // git subprocesses + file copies — keep them off the async runtime's core threads
    tauri::async_runtime::spawn_blocking(move || {
        worktree::add(&cwd, &branch, copy_env, bin.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn worktree_status(path: String, bin: Option<String>) -> Result<worktree::WorktreeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || worktree::status(&path, bin.as_deref()))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn worktree_remove(
    root: String,
    path: String,
    branch: String,
    bin: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        worktree::remove(&root, &path, &branch, bin.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn worktree_list(
    roots: Vec<String>,
    bin: Option<String>,
) -> Result<worktree::WorktreeScan, String> {
    tauri::async_runtime::spawn_blocking(move || worktree::list(&roots, bin.as_deref()))
        .await
        .map_err(|e| e.to_string())
}

// ---- Orchestrator sensing (Phase 1) — read-only, see transcript.rs / projects.rs ----

#[tauri::command]
async fn transcript_read(
    cwd: String,
    session_id: String,
    runtime: String,
    tail_messages: Option<usize>,
    max_bytes: Option<u64>,
    include_first_user_message: Option<bool>,
) -> Result<transcript::TranscriptView, String> {
    // file reads (possibly a seek into a huge jsonl) — off the core threads
    tauri::async_runtime::spawn_blocking(move || {
        let defaults = transcript::TranscriptOpts::default();
        let opts = transcript::TranscriptOpts {
            tail_messages: tail_messages.unwrap_or(defaults.tail_messages),
            max_bytes: max_bytes.unwrap_or(defaults.max_bytes),
            include_first_user_message: include_first_user_message
                .unwrap_or(defaults.include_first_user_message),
        };
        transcript::read(&cwd, &session_id, &runtime, &opts)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn project_docs(root: String) -> Result<transcript::ProjectDocs, String> {
    tauri::async_runtime::spawn_blocking(move || transcript::project_docs(&root))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn discover_projects(
    scan_roots: Vec<String>,
    known: Vec<projects::KnownFolder>,
) -> Result<Vec<projects::ProjectEntry>, String> {
    // directory walks + jsonl head reads — off the core threads
    tauri::async_runtime::spawn_blocking(move || projects::discover_default(&scan_roots, &known))
        .await
        .map_err(|e| e.to_string())
}

// ---- Orchestrator tool bus (Phase 2) — see orchestrator/ ----

/// The tool catalog + the orchestrator system instructions, both single-
/// source in Rust. Phase 3 hands the tools to Codex `dynamicTools` (and the
/// instructions as `developerInstructions`); the Phase-6 OpenRouter loop
/// fetches BOTH through this command for its wire messages. `persona` is the
/// current Settings persona (None = the Maestro seed); memory is read fresh
/// so both provider paths compile the SAME instructions from one source.
#[tauri::command]
async fn orchestrator_tools(
    app: AppHandle,
    persona: Option<orchestrator::PersonaSpec>,
) -> serde_json::Value {
    let persona = persona.unwrap_or_default();
    let memory = orchestrator_memory_block(&app).await;
    serde_json::json!({
        "instructions": orchestrator::build_instructions(&persona, &memory),
        "tools": orchestrator::tool_definitions(),
    })
}

/// The app data dir (holds `swarmz.json` and `orchestrator-memory.md`).
fn orchestrator_data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// Render the curated memory as prompt-ready list lines (empty on failure).
async fn orchestrator_memory_block(app: &AppHandle) -> String {
    let Ok(dir) = orchestrator_data_dir(app) else {
        return String::new();
    };
    tauri::async_runtime::spawn_blocking(move || {
        let entries = orchestrator::memory_read(&dir);
        entries
            .iter()
            .map(|e| {
                if e.date.is_empty() {
                    format!("- {}", e.text)
                } else {
                    format!("- {} {}", e.date, e.text)
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    })
    .await
    .unwrap_or_default()
}

/// Read the curated orchestrator memory (Settings UI).
#[tauri::command]
async fn orchestrator_memory_read(
    app: AppHandle,
) -> Result<Vec<orchestrator::MemoryEntry>, String> {
    let dir = orchestrator_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || orchestrator::memory_read(&dir))
        .await
        .map_err(|e| e.to_string())
}

/// Append one fact to the curated memory (the `remember` tool executor). The
/// caps are enforced here; the result reports any FIFO drop.
#[tauri::command]
async fn orchestrator_memory_append(
    app: AppHandle,
    text: String,
) -> Result<orchestrator::AppendResult, String> {
    let dir = orchestrator_data_dir(&app)?;
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    tauri::async_runtime::spawn_blocking(move || orchestrator::memory_append(&dir, &text, &today))
        .await
        .map_err(|e| e.to_string())?
}

/// Remove one memory entry by index (Settings UI). Returns the remaining list.
#[tauri::command]
async fn orchestrator_memory_remove(
    app: AppHandle,
    index: usize,
) -> Result<Vec<orchestrator::MemoryEntry>, String> {
    let dir = orchestrator_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || orchestrator::memory_remove(&dir, index))
        .await
        .map_err(|e| e.to_string())?
}

// ---- Custom Agents (the Agent-Baukasten) ----
//
// Agents live in `~/.swarmz/agents/<slug>/` (home-relative, NOT the app data
// dir — they are global + hand-editable). The folder is the source of truth;
// the frontend store only caches. All IO is small + sync → spawn_blocking.

/// The agents root: `~/.swarmz/agents`. Missing home dir → error.
fn agents_root() -> Result<std::path::PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".swarmz").join("agents"))
        .ok_or_else(|| "cannot resolve the home directory".to_string())
}

/// List every discoverable agent (library cards). Broken agents are skipped.
#[tauri::command]
async fn agent_list() -> Result<Vec<agents::AgentSummary>, String> {
    let root = agents_root()?;
    tauri::async_runtime::spawn_blocking(move || agents::list(&root))
        .await
        .map_err(|e| e.to_string())
}

/// Full detail for one agent (editor): def + soul + memory + knowledge files.
#[tauri::command]
async fn agent_read(slug: String) -> Result<agents::AgentDetail, String> {
    let root = agents_root()?;
    tauri::async_runtime::spawn_blocking(move || agents::read(&root, &slug))
        .await
        .map_err(|e| e.to_string())?
}

/// Create a new agent folder (agent.json + soul.md). Errors if the slug exists.
#[tauri::command]
async fn agent_create(
    def: agents::AgentDef,
    soul: String,
) -> Result<agents::AgentDetail, String> {
    let root = agents_root()?;
    tauri::async_runtime::spawn_blocking(move || agents::create(&root, &def, &soul))
        .await
        .map_err(|e| e.to_string())?
}

/// Overwrite an existing agent's agent.json + soul.md (the editor's Save).
#[tauri::command]
async fn agent_write(
    slug: String,
    def: agents::AgentDef,
    soul: String,
) -> Result<agents::AgentDetail, String> {
    let root = agents_root()?;
    tauri::async_runtime::spawn_blocking(move || agents::write(&root, &slug, &def, &soul))
        .await
        .map_err(|e| e.to_string())?
}

/// Delete an agent folder (idempotent, slug-guarded).
#[tauri::command]
async fn agent_delete(slug: String) -> Result<(), String> {
    let root = agents_root()?;
    tauri::async_runtime::spawn_blocking(move || agents::delete(&root, &slug))
        .await
        .map_err(|e| e.to_string())?
}

/// Append one fact to an agent's own memory.md (caps enforced in Rust).
#[tauri::command]
async fn agent_memory_append(
    slug: String,
    text: String,
) -> Result<agents::AppendResult, String> {
    let root = agents_root()?;
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    tauri::async_runtime::spawn_blocking(move || agents::memory_append(&root, &slug, &text, &today))
        .await
        .map_err(|e| e.to_string())?
}

/// Remove one memory entry by index; returns the remaining entries.
#[tauri::command]
async fn agent_memory_remove(
    slug: String,
    index: usize,
) -> Result<Vec<agents::MemoryEntry>, String> {
    let root = agents_root()?;
    tauri::async_runtime::spawn_blocking(move || agents::memory_remove(&root, &slug, index))
        .await
        .map_err(|e| e.to_string())?
}

/// Compile an agent's runtime context (Phase B start pipeline): soul → fixed
/// operative block → memory snapshot → knowledge TOC, with the hard budget flag.
#[tauri::command]
async fn agent_compile_context(slug: String) -> Result<agents::CompiledContext, String> {
    let root = agents_root()?;
    tauri::async_runtime::spawn_blocking(move || agents::compile_context(&root, &slug))
        .await
        .map_err(|e| e.to_string())?
}

/// Compile the agent's context and write it to `<dir>/.compiled.md`, returning
/// the absolute path — the terminal start-ways (Claude
/// `--append-system-prompt-file`, Codex `-c developer_instructions="$(cat …)"`)
/// read the persona from this file at PTY spawn.
#[tauri::command]
async fn agent_write_compiled(slug: String) -> Result<String, String> {
    let root = agents_root()?;
    tauri::async_runtime::spawn_blocking(move || agents::write_compiled(&root, &slug))
        .await
        .map_err(|e| e.to_string())?
}

/// Build the Agent-Builder developer-instructions for a new-agent (or refine)
/// Vibe session whose cwd is the agent's own folder. Pure string assembly, but
/// kept async + `spawn_blocking` for consistency with the other agent commands.
#[tauri::command]
async fn agent_builder_instructions(slug: String, refine: bool) -> Result<String, String> {
    let root = agents_root()?;
    tauri::async_runtime::spawn_blocking(move || agents::builder_instructions(&root, &slug, refine))
        .await
        .map_err(|e| e.to_string())?
}

/// Run one tool through the roundtrip bus (Rust → webview executor → Rust).
/// Async: it awaits the webview's response (or the tool's timeout) — no
/// blocking work happens on this side.
#[tauri::command]
async fn orchestrator_run_tool(
    app: AppHandle,
    tool: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    // dev-hook surface — no chat context (executors skip touched-pane tracking)
    orchestrator::run_tool(&app, &tool, args, None).await
}

/// Webview → Rust leg of the roundtrip. Sync on purpose: it only resolves a
/// oneshot in the pending map (fast, non-blocking). Unknown/expired ids are
/// a logged no-op — a late response after a timeout is normal, not an error.
#[tauri::command]
fn orchestrator_tool_response(id: String, ok: bool, payload: serde_json::Value) {
    orchestrator::resolve_tool_response(&id, ok, payload);
}

// ---- Orchestrator brain (Phase 3) — see orchestrator/appserver.rs ----
//
// All async: they await JSON-RPC roundtrips against the long-lived
// `codex app-server` child (spawned lazily; tokio::process — no blocking
// work on the main thread). Progress streams as `orchestrator://chat-event`.

/// Start a fresh orchestrator chat (app-server thread with dynamic tools).
/// `codex_path` is the Settings codex-binary override, passed on every call.
#[tauri::command]
async fn orchestrator_chat_start(
    app: AppHandle,
    codex_path: Option<String>,
    persona: Option<orchestrator::PersonaSpec>,
) -> Result<serde_json::Value, String> {
    orchestrator::chat_start(&app, codex_path, persona).await
}

/// Send one user message; resolves with the final assistant text when the
/// turn completes (deltas/tool calls stream as events meanwhile).
#[tauri::command]
async fn orchestrator_chat_send(
    app: AppHandle,
    chat_id: String,
    text: String,
    model: Option<String>,
    effort: Option<String>,
) -> Result<serde_json::Value, String> {
    orchestrator::chat_send(&app, &chat_id, &text, model, effort).await
}

/// Interrupt the chat's running turn (turn/interrupt).
#[tauri::command]
async fn orchestrator_chat_interrupt(chat_id: String) -> Result<(), String> {
    orchestrator::chat_interrupt(&chat_id).await
}

/// Reopen a persisted app-server thread as a chat (thread/resume).
#[tauri::command]
async fn orchestrator_chat_resume(
    app: AppHandle,
    thread_id: String,
    persona: Option<orchestrator::PersonaSpec>,
) -> Result<serde_json::Value, String> {
    orchestrator::chat_resume(&app, &thread_id, persona).await
}

/// Liveness + codex version + account summary. Never errors — spawn
/// failures come back as `{ running: false, error }`.
#[tauri::command]
async fn orchestrator_chat_status(
    app: AppHandle,
    codex_path: Option<String>,
) -> serde_json::Value {
    orchestrator::chat_status(&app, codex_path).await
}

/// The model ids the installed codex offers (`model/list`, hidden entries
/// dropped, server order = default first) — the pickers' "Available" section.
#[tauri::command]
async fn codex_list_models(app: AppHandle) -> Result<Vec<String>, String> {
    orchestrator::list_models(&app).await
}

// ---- Orchestrator brain, provider B (Phase 6) — see orchestrator/openrouter.rs ----

/// One streamed OpenRouter chat-completion call for the webview tool loop.
/// Content tokens emit as `orchestrator://chat-event` deltas under `chat_id`
/// (the STORE chat id); resolves with the assembled assistant message
/// `{ content, tool_calls, finish_reason }`. The key stays in the keychain —
/// it never reaches JS.
#[tauri::command]
async fn openrouter_chat_completion(
    app: AppHandle,
    chat_id: String,
    model: String,
    messages: serde_json::Value,
    tools: serde_json::Value,
) -> Result<serde_json::Value, String> {
    orchestrator::openrouter_chat_completion(&app, chat_id, model, messages, tools).await
}

/// Cancel the chat's in-flight OpenRouter stream (the completion resolves
/// with `finish_reason: "cancelled"`, keeping the partial content). Sync on
/// purpose: it only flips an atomic flag.
#[tauri::command]
fn openrouter_chat_cancel(chat_id: String) {
    orchestrator::openrouter_cancel(&chat_id);
}

// ---- Vibe-Mode native Codex sessions (Phase 2) — see codex/sessions.rs ----
//
// All async: they await JSON-RPC roundtrips against a PRIVATE `codex
// app-server` child per session (strategy b — crash isolation). Progress
// streams as `vibe://session-event` `{session_id, kind, data}`. `session_id`
// is assigned by the frontend (it keys the store's VibeSession); `codex_path`
// is the Settings codex-binary override, passed on the start/resume calls.

/// The extra writable sandbox roots for a Vibe session: a custom agent's own
/// folder (`~/.swarmz/agents/<slug>`), so a specialist can maintain its own
/// memory.md approval-free even when the session runs in a project elsewhere.
/// Slug-validated (never a path escape); empty for plain sessions or a bad slug.
fn agent_writable_roots(agent_slug: Option<String>) -> Vec<String> {
    agent_slug
        .filter(|s| agents::is_valid_slug(s))
        .and_then(|slug| agents_root().ok().map(|root| root.join(slug)))
        .map(|dir| vec![dir.to_string_lossy().into_owned()])
        .unwrap_or_default()
}

/// Start a fresh Vibe session (dedicated process + thread/start). `access`
/// ∈ workspace | full maps to the sandbox/approval policy. Returns `{thread_id}`.
#[tauri::command]
async fn vibe_session_start(
    app: AppHandle,
    session_id: String,
    cwd: String,
    model: Option<String>,
    effort: Option<String>,
    access: String,
    developer_instructions: Option<String>,
    agent_slug: Option<String>,
    codex_path: Option<String>,
) -> Result<serde_json::Value, String> {
    codex::sessions::session_start(
        &app,
        &session_id,
        cwd,
        model,
        effort,
        &access,
        developer_instructions,
        agent_writable_roots(agent_slug),
        codex_path,
    )
    .await
}

/// Reopen a persisted session across an app restart (thread/resume, with a
/// fresh-start fallback when the rollout is gone). Returns `{thread_id, resumed}`.
#[tauri::command]
async fn vibe_session_resume(
    app: AppHandle,
    session_id: String,
    thread_id: String,
    cwd: String,
    model: Option<String>,
    effort: Option<String>,
    access: String,
    developer_instructions: Option<String>,
    agent_slug: Option<String>,
    codex_path: Option<String>,
) -> Result<serde_json::Value, String> {
    codex::sessions::session_resume(
        &app,
        &session_id,
        &thread_id,
        cwd,
        model,
        effort,
        &access,
        developer_instructions,
        agent_writable_roots(agent_slug),
        codex_path,
    )
    .await
}

/// Send one user message — non-blocking; returns `{turn_id}` after the
/// turn/start ack. The transcript + completion arrive as events.
#[tauri::command]
async fn vibe_session_send(
    app: AppHandle,
    session_id: String,
    text: String,
) -> Result<serde_json::Value, String> {
    codex::sessions::session_send(&app, &session_id, &text).await
}

/// Interrupt the session's running turn (turn/interrupt).
#[tauri::command]
async fn vibe_session_interrupt(session_id: String) -> Result<(), String> {
    codex::sessions::session_interrupt(&session_id).await
}

/// Answer a pending approval — `decision` ∈ accept | acceptForSession |
/// decline | cancel.
#[tauri::command]
async fn vibe_session_respond_approval(
    session_id: String,
    approval_id: String,
    decision: String,
) -> Result<(), String> {
    codex::sessions::session_respond_approval(&session_id, &approval_id, &decision).await
}

/// Change the session's access mode (takes effect on the next turn).
#[tauri::command]
async fn vibe_session_set_access(session_id: String, access: String) -> Result<(), String> {
    codex::sessions::session_set_access(&session_id, &access).await
}

/// Change the session's model / reasoning effort (takes effect on the next
/// turn). Empty/null clears back to the user's codex default.
#[tauri::command]
async fn vibe_session_set_model_effort(
    session_id: String,
    model: Option<String>,
    effort: Option<String>,
) -> Result<(), String> {
    codex::sessions::session_set_model_effort(&session_id, model, effort).await
}

/// Close a session: interrupt, cancel pending approvals, drop the process.
#[tauri::command]
async fn vibe_session_close(session_id: String) -> Result<(), String> {
    codex::sessions::session_close(&session_id).await
}

fn start_usage_watcher(app: AppHandle) {
    let claude_dir = usage::claude_projects_dir().filter(|d| d.exists());
    let codex_dir = dirs::home_dir()
        .map(|h| h.join(".codex").join("sessions"))
        .filter(|d| d.exists());
    let mut roots = Vec::new();
    if let Some(d) = claude_dir.clone() {
        roots.push(d);
    }
    if let Some(d) = codex_dir {
        roots.push(d);
    }
    if roots.is_empty() {
        return;
    }
    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut debouncer = match new_debouncer(Duration::from_millis(600), tx) {
            Ok(d) => d,
            Err(_) => return,
        };
        for root in &roots {
            let _ = debouncer.watcher().watch(root, RecursiveMode::Recursive);
        }
        // keep the debouncer alive for the lifetime of this thread.
        // Emit the *project dir names* that changed so the frontend can skip
        // refreshes for sessions it isn't displaying (an empty list means
        // "unknown / everything", e.g. after a pricing refresh).
        for res in rx {
            if let Ok(events) = res {
                let mut dirs: Vec<String> = events
                    .iter()
                    .filter_map(|e| {
                        let dir = claude_dir.as_ref()?;
                        e.path
                            .strip_prefix(dir)
                            .ok()?
                            .components()
                            .next()
                            .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    })
                    .collect();
                dirs.sort();
                dirs.dedup();
                let _ = app.emit("usage://changed", dirs);
            }
        }
        drop(debouncer);
    });
}

/// Pull live model pricing once per run; retry while offline, refresh daily.
fn start_pricing_refresher(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let delay = if usage::refresh_pricing().await {
                // empty list = "everything changed" (all costs were repriced)
                let _ = app.emit("usage://changed", Vec::<String>::new());
                std::time::Duration::from_secs(24 * 60 * 60)
            } else {
                std::time::Duration::from_secs(5 * 60)
            };
            tokio::time::sleep(delay).await;
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let manager: SharedPtyManager = Arc::new(PtyManager::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // remember window size/position/maximized across restarts
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(manager.clone())
        .setup(move |app| {
            // before the webview can touch the store: rescue a corrupt
            // swarmz.json / refresh its backup (see storefile.rs)
            if let Ok(dir) = app.path().app_data_dir() {
                storefile::rescue(&dir);
            }
            start_usage_watcher(app.handle().clone());
            start_pricing_refresher(app.handle().clone());
            Ok(())
        })
        .on_window_event(move |_window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                manager.kill_all();
            }
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            pty_has_children,
            project_commands,
            usage_for_dir,
            usage_for_session,
            usage_totals,
            subscription_limits,
            codex_account_limits,
            path_is_file,
            git_info,
            worktree_add,
            worktree_status,
            worktree_remove,
            worktree_list,
            transcript_read,
            project_docs,
            discover_projects,
            orchestrator_tools,
            orchestrator_run_tool,
            orchestrator_tool_response,
            orchestrator_memory_read,
            orchestrator_memory_append,
            orchestrator_memory_remove,
            agent_list,
            agent_read,
            agent_create,
            agent_write,
            agent_delete,
            agent_memory_append,
            agent_memory_remove,
            agent_compile_context,
            agent_write_compiled,
            agent_builder_instructions,
            orchestrator_chat_start,
            orchestrator_chat_send,
            orchestrator_chat_interrupt,
            orchestrator_chat_resume,
            orchestrator_chat_status,
            codex_list_models,
            openrouter_chat_completion,
            openrouter_chat_cancel,
            vibe_session_start,
            vibe_session_resume,
            vibe_session_send,
            vibe_session_interrupt,
            vibe_session_respond_approval,
            vibe_session_set_access,
            vibe_session_set_model_effort,
            vibe_session_close,
            openrouter_key_status,
            openrouter_set_key,
            openrouter_clear_key,
            openrouter_models,
            openrouter_transcribe,
            openrouter_cleanup,
            local_stt_status,
            local_stt_download,
            local_stt_cancel_download,
            local_stt_remove,
            local_stt_unload,
            local_stt_transcribe,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // ⌘Q / menu quit (code Some(0)): hand the decision to the frontend,
            // which warns when agents are still working and closes the window
            // on confirm (→ ExitRequested with code None, which passes here).
            // prevent_exit() is a built-in no-op for the updater's restart
            // (RESTART_EXIT_CODE), so updates keep working.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_some() {
                    api.prevent_exit();
                    let _ = app.emit("app://quit-requested", ());
                }
            }
        });
}
