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
/// fetches BOTH through this command for its wire messages.
#[tauri::command]
fn orchestrator_tools() -> serde_json::Value {
    serde_json::json!({
        "instructions": orchestrator::ORCHESTRATOR_INSTRUCTIONS,
        "tools": orchestrator::tool_definitions(),
    })
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
) -> Result<serde_json::Value, String> {
    orchestrator::chat_start(&app, codex_path).await
}

/// Send one user message; resolves with the final assistant text when the
/// turn completes (deltas/tool calls stream as events meanwhile).
#[tauri::command]
async fn orchestrator_chat_send(
    app: AppHandle,
    chat_id: String,
    text: String,
) -> Result<serde_json::Value, String> {
    orchestrator::chat_send(&app, &chat_id, &text).await
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
) -> Result<serde_json::Value, String> {
    orchestrator::chat_resume(&app, &thread_id).await
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
            orchestrator_chat_start,
            orchestrator_chat_send,
            orchestrator_chat_interrupt,
            orchestrator_chat_resume,
            orchestrator_chat_status,
            openrouter_chat_completion,
            openrouter_chat_cancel,
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
