mod codex;
mod codex_usage;
mod git;
mod orchestrator;
mod projects;
mod storefile;
mod transcript;
mod worktree;

use codex_usage::{SessionUsage, UsageTotals};
use tauri::{AppHandle, Emitter, Manager};

// Usage commands run off the main thread: the per-file cache makes them
// cheap in steady state, but the first call after launch parses the backlog
// under ~/.codex/sessions.
#[tauri::command]
async fn usage_for_dir(cwd: String) -> Option<SessionUsage> {
    tauri::async_runtime::spawn_blocking(move || codex_usage::usage_for_dir(&cwd))
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
) -> Option<SessionUsage> {
    tauri::async_runtime::spawn_blocking(move || {
        codex_usage::usage_for_session(
            &cwd,
            since as u64,
            session.as_deref(),
            exclude.as_deref().unwrap_or(&[]),
        )
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
async fn usage_totals() -> Result<UsageTotals, String> {
    tauri::async_runtime::spawn_blocking(codex_usage::usage_totals)
        .await
        .map_err(|e| e.to_string())
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

/// Does this absolute path point at an existing file? Powers the inline
/// validation of the codex/git binary overrides in Settings — a typo there
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

// ---- Orchestrator sensing — read-only, see transcript.rs / projects.rs ----

#[tauri::command]
async fn transcript_read(
    session_id: String,
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
        transcript::read(&session_id, &opts)
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

// ---- Orchestrator tool bus — see orchestrator/ ----

/// The tool catalog + the orchestrator system instructions, both single-
/// source in Rust. The catalog is handed to Codex as `dynamicTools` (and the
/// instructions as `developerInstructions`). `persona` is the current
/// Settings persona (None = the Maestro seed); memory is read fresh so every
/// consumer compiles the SAME instructions from one source.
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

/// Run one tool through the roundtrip bus (Rust → webview executor → Rust).
/// Async: it awaits the webview's response (or the tool's timeout) — no
/// blocking work happens on this side.
#[tauri::command]
async fn orchestrator_run_tool(
    app: AppHandle,
    tool: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    // dev-hook surface — no chat context (executors skip touched-session tracking)
    orchestrator::run_tool(&app, &tool, args, None).await
}

/// Webview → Rust leg of the roundtrip. Sync on purpose: it only resolves a
/// oneshot in the pending map (fast, non-blocking). Unknown/expired ids are
/// a logged no-op — a late response after a timeout is normal, not an error.
#[tauri::command]
fn orchestrator_tool_response(id: String, ok: bool, payload: serde_json::Value) {
    orchestrator::resolve_tool_response(&id, ok, payload);
}

// ---- Orchestrator brain — see orchestrator/appserver.rs ----
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

// ---- Native Codex sessions — see codex/sessions.rs ----
//
// All async: they await JSON-RPC roundtrips against a PRIVATE `codex
// app-server` child per session (crash isolation). Progress streams as
// `vibe://session-event` `{session_id, kind, data}`. `session_id` is
// assigned by the frontend (it keys the store's VibeSession); `codex_path`
// is the Settings codex-binary override, passed on the start/resume calls.

/// Start a fresh session (dedicated process + thread/start). `access`
/// ∈ workspace | full maps to the sandbox/approval policy. Returns `{thread_id}`.
#[tauri::command]
async fn vibe_session_start(
    app: AppHandle,
    session_id: String,
    cwd: String,
    model: Option<String>,
    effort: Option<String>,
    access: String,
    codex_path: Option<String>,
) -> Result<serde_json::Value, String> {
    codex::sessions::session_start(&app, &session_id, cwd, model, effort, &access, codex_path).await
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // remember window size/position/maximized across restarts
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(move |app| {
            // before the webview can touch the store: rescue a corrupt
            // swarmz.json / refresh its backup (see storefile.rs)
            if let Ok(dir) = app.path().app_data_dir() {
                storefile::rescue(&dir);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            usage_for_dir,
            usage_for_session,
            usage_totals,
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
            orchestrator_chat_start,
            orchestrator_chat_send,
            orchestrator_chat_interrupt,
            orchestrator_chat_resume,
            orchestrator_chat_status,
            codex_list_models,
            vibe_session_start,
            vibe_session_resume,
            vibe_session_send,
            vibe_session_interrupt,
            vibe_session_respond_approval,
            vibe_session_set_access,
            vibe_session_set_model_effort,
            vibe_session_close,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // ⌘Q / menu quit (code Some(0)): hand the decision to the frontend,
            // which warns when sessions are still working and closes the window
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
