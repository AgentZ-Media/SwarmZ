// Orchestrator brain (Phase 3): the Codex app-server chat layer, built on
// the generic host in `crate::codex` (ONE shared process for all chats —
// strategy (a); Vibe sessions use dedicated processes via the same host).
// Chats map 1:1 to app-server THREADS; the tool registry is declared as
// experimental DYNAMIC TOOLS on thread/start, and Codex calls back via
// `item/tool/call` server requests which we answer through the Phase-2 bus
// (`orchestrator::run_tool` → webview executors).
//
// Layers, bottom to top:
//   - `codex::host` — process, framing, pending-rpc map, thread registry
//     (events for our threads arrive routed per threadId on ONE sink).
//   - dispatcher — consumes routed `ThreadEvent`s: answers `item/tool/call`,
//     auto-DECLINES approval requests (must not occur under read-only
//     sandbox + approvalPolicy "never"), maps notifications to
//     `orchestrator://chat-event` emissions and turn-completion wakeups.
//   - chat API — `chat_start` / `chat_send` / `chat_interrupt` /
//     `chat_resume` / `chat_status`, exposed as Tauri commands in lib.rs.
//
// Lifecycle: the shared ProcessHost spawns lazily on first use; a died
// process is detected via the reader-EOF alive flag and respawned on the
// next call — in-flight requests fail with a clear error and running turns
// resolve as failed. After a respawn, chats transparently `thread/resume`
// their thread before the next turn (a per-chat generation counter detects
// the restart; rollouts persist on disk and dynamic tools are persisted and
// restored by codex — verified on 0.142.5).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, oneshot};

use super::adapter;
use super::persona::PersonaSpec;
use crate::codex::host::{
    self, Connection, EventSink, ProcessHost, Responder, ThreadEvent, RPC_TIMEOUT_MS,
    THREAD_TIMEOUT_MS, TURN_TIMEOUT_MS,
};

/// The dynamic-tools protocol is experimental; this is the version the
/// integration spike verified end-to-end (originally 0.142.5, re-verified
/// live on 0.144.1 in the Phase-0 probes). Mentioned in the version guard.
const KNOWN_GOOD_VERSION: &str = "0.144.1";

// System instructions are compiled per session from persona + memory + the
// hard-wired operative core (see `super::persona::build_instructions`) and
// delivered as `developerInstructions` on thread/start + thread/resume (keeps
// codex's own base prompt — and with it the tool harness — intact, unlike
// `baseInstructions`). Persona is captured per chat at start; memory is read
// fresh from disk each start/resume (frozen per session).

// ---------------------------------------------------------------------------
// Chat state + manager
// ---------------------------------------------------------------------------

/// Terminal outcome of one turn, delivered to the waiting `chat_send`.
struct TurnOutcome {
    status: String, // completed | interrupted | failed
    error: Option<String>,
    message: Option<String>,
}

#[derive(Default)]
struct ChatState {
    thread_id: String,
    /// ProcessHost generation at start/resume — a mismatch after a respawn
    /// triggers a transparent thread/resume before the next turn.
    generation: u64,
    /// Persona captured at start/resume — reused for the developerInstructions
    /// when chat_send has to transparently thread/resume after a respawn.
    persona: PersonaSpec,
    current_turn_id: Option<String>,
    last_agent_message: Option<String>,
    done_tx: Option<oneshot::Sender<TurnOutcome>>,
}

#[derive(Default)]
struct Shared {
    chats: HashMap<String, ChatState>,
    thread_to_chat: HashMap<String, String>,
}

/// Chat/thread registry — touched by both the dispatcher task and the
/// commands, so it lives outside any async lock (plain mutex, no awaits
/// while held).
static SHARED: Lazy<Mutex<Shared>> = Lazy::new(Mutex::default);

/// The ONE shared app-server slot all orchestrator chats multiplex over
/// (process strategy (a) — see codex::host).
static HOST: Lazy<ProcessHost> = Lazy::new(ProcessHost::new);

/// The dispatcher's event sink — created together with the dispatcher task
/// on first use (it needs the AppHandle); every chat thread registers this
/// same sink with the host, so one task serves all chats.
static DISPATCHER: Lazy<tokio::sync::Mutex<Option<EventSink>>> =
    Lazy::new(|| tokio::sync::Mutex::new(None));

static CHAT_COUNTER: AtomicU64 = AtomicU64::new(0);

fn emit_chat_event(app: &AppHandle, chat_id: &str, kind: &str, data: Value) {
    let _ = app.emit(
        "orchestrator://chat-event",
        json!({ "chat_id": chat_id, "kind": kind, "data": data }),
    );
}

fn chat_for_thread(thread_id: Option<&str>) -> Option<String> {
    let tid = thread_id?;
    SHARED.lock().thread_to_chat.get(tid).cloned()
}

/// Live connection + generation + the dispatcher sink chat threads register.
async fn ensure_conn(app: &AppHandle) -> Result<(Arc<Connection>, u64, EventSink), String> {
    let sink = {
        let mut slot = DISPATCHER.lock().await;
        match &*slot {
            Some(s) => s.clone(),
            None => {
                let (tx, rx) = mpsc::unbounded_channel();
                spawn_dispatcher(app.clone(), rx);
                *slot = Some(tx.clone());
                tx
            }
        }
    };
    let (conn, generation) = HOST.ensure().await?;
    Ok((conn, generation, sink))
}

/// Wrap thread/start failures that smell like a codex without the
/// experimental dynamic-tools API in an actionable message.
fn guard_dynamic_tools_error(err: String, version: Option<&str>) -> String {
    let lower = err.to_lowercase();
    if lower.contains("dynamictools") || lower.contains("dynamic_tools") || lower.contains("experimental") || lower.contains("unknown field") {
        format!(
            "the installed codex CLI ({}) does not support dynamic tools over app-server — SwarmZ needs the experimental dynamicTools API (verified working with codex {KNOWN_GOOD_VERSION}); update the codex CLI. Underlying error: {err}",
            version.unwrap_or("unknown version"),
        )
    } else {
        err
    }
}

fn home_dir_string() -> String {
    dirs::home_dir()
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or_else(|| "/".to_string())
}

/// Read the curated memory file fresh and render it as prompt-ready list lines
/// (empty string on any failure). Off the main thread — small file IO.
async fn load_memory(app: &AppHandle) -> String {
    let Ok(dir) = app.path().app_data_dir() else {
        return String::new();
    };
    tauri::async_runtime::spawn_blocking(move || {
        super::memory::render_entries(&super::memory::read_entries(&dir))
    })
    .await
    .unwrap_or_default()
}

/// thread/start params: neutral cwd (home), read-only sandbox, no approval
/// prompts (auto-declined anyway if one slips through), the compiled
/// instructions (persona + memory + core) as developer message, and the whole
/// registry as dynamic tools.
fn thread_start_params(persona: &PersonaSpec, memory: &str) -> Value {
    json!({
        "cwd": home_dir_string(),
        "sandbox": "read-only",
        "approvalPolicy": "never",
        "developerInstructions": super::build_instructions(persona, memory),
        "dynamicTools": adapter::dynamic_tool_specs(),
    })
}

/// thread/resume params: dynamicTools are NOT re-declarable here — codex
/// persists and restores them from the thread rollout (verified on 0.142.5).
/// developerInstructions ARE re-sent, so memory changes land on the next resume.
fn thread_resume_params(thread_id: &str, persona: &PersonaSpec, memory: &str) -> Value {
    json!({
        "threadId": thread_id,
        "cwd": home_dir_string(),
        "sandbox": "read-only",
        "approvalPolicy": "never",
        "developerInstructions": super::build_instructions(persona, memory),
    })
}

// ---------------------------------------------------------------------------
// Dispatcher — routed thread events → bus calls, events, wakeups
// ---------------------------------------------------------------------------

fn spawn_dispatcher(app: AppHandle, mut rx: mpsc::UnboundedReceiver<ThreadEvent>) {
    tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            match ev {
                ThreadEvent::Request { method, params, responder } => {
                    handle_server_request(&app, method, params, responder);
                }
                ThreadEvent::Notification { method, params } => {
                    handle_notification(&app, &method, &params);
                }
                ThreadEvent::Exited => {
                    handle_exit(&app);
                }
            }
        }
    });
}

fn handle_server_request(app: &AppHandle, method: String, params: Value, responder: Responder) {
    let thread_id = params
        .get("threadId")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let chat_id = chat_for_thread(thread_id.as_deref());
    match method.as_str() {
        "item/tool/call" => {
            // answered in a task of its own — tool roundtrips must not block
            // the dispatcher (deltas keep streaming while a tool runs)
            let app = app.clone();
            tokio::spawn(async move {
                let tool = params
                    .get("tool")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let args = adapter::normalize_tool_args(params.get("arguments"));
                if let Some(cid) = &chat_id {
                    emit_chat_event(
                        &app,
                        cid,
                        "tool_call",
                        json!({ "tool": tool, "args_summary": adapter::summarize_args(&args) }),
                    );
                }
                let result = super::run_tool(&app, &tool, args, chat_id.clone()).await;
                if let Some(cid) = &chat_id {
                    emit_chat_event(
                        &app,
                        cid,
                        "tool_done",
                        json!({ "tool": tool, "ok": result.is_ok() }),
                    );
                }
                responder.ok(&adapter::tool_call_response(&result));
            });
        }
        // Approvals must never occur (read-only sandbox + approvalPolicy
        // "never" + instructions) — if one arrives anyway: auto-DECLINE.
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            responder.ok(&json!({ "decision": "decline" }));
            if let Some(cid) = &chat_id {
                emit_chat_event(
                    app,
                    cid,
                    "warning",
                    json!({ "message": format!("auto-declined unexpected approval request ({method})") }),
                );
            }
        }
        // anything else server-initiated (user-input prompts, elicitations,
        // permission grants, legacy v1 approvals): refuse with an error —
        // the server treats that as a denial and the turn continues/fails
        other => {
            responder.error(-32601, "not supported by the SwarmZ orchestrator");
            if let Some(cid) = &chat_id {
                emit_chat_event(
                    app,
                    cid,
                    "warning",
                    json!({ "message": format!("declined unsupported server request ({other})") }),
                );
            }
        }
    }
}

fn handle_notification(app: &AppHandle, method: &str, params: &Value) {
    let thread_id = params.get("threadId").and_then(|v| v.as_str());
    let Some(chat_id) = chat_for_thread(thread_id) else {
        return; // not one of our chats (or no threadId) — ignore
    };
    match method {
        "turn/started" => {
            let turn_id = params
                .pointer("/turn/id")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            if let Some(chat) = SHARED.lock().chats.get_mut(&chat_id) {
                chat.current_turn_id = turn_id.clone();
            }
            emit_chat_event(app, &chat_id, "turn_started", json!({ "turn_id": turn_id }));
        }
        "item/agentMessage/delta" => {
            let delta = params.get("delta").and_then(|v| v.as_str()).unwrap_or("");
            emit_chat_event(app, &chat_id, "delta", json!({ "text": delta }));
        }
        "item/completed" => {
            let item = params.get("item").cloned().unwrap_or(Value::Null);
            if item.get("type").and_then(|v| v.as_str()) == Some("agentMessage") {
                let text = item
                    .get("text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if let Some(chat) = SHARED.lock().chats.get_mut(&chat_id) {
                    chat.last_agent_message = Some(text.clone());
                }
                emit_chat_event(app, &chat_id, "message", json!({ "text": text }));
            }
        }
        "turn/completed" => {
            let status = params
                .pointer("/turn/status")
                .and_then(|v| v.as_str())
                .unwrap_or("completed")
                .to_string();
            let error = params
                .pointer("/turn/error/message")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let (done_tx, message) = {
                let mut shared = SHARED.lock();
                match shared.chats.get_mut(&chat_id) {
                    Some(chat) => {
                        chat.current_turn_id = None;
                        (chat.done_tx.take(), chat.last_agent_message.take())
                    }
                    None => (None, None),
                }
            };
            if status == "failed" {
                emit_chat_event(
                    app,
                    &chat_id,
                    "turn_failed",
                    json!({ "error": error.clone().unwrap_or_else(|| "turn failed".into()) }),
                );
            } else {
                emit_chat_event(app, &chat_id, "turn_completed", json!({ "status": status }));
            }
            if let Some(tx) = done_tx {
                let _ = tx.send(TurnOutcome {
                    status,
                    error,
                    message,
                });
            }
        }
        "error" => {
            let message = params
                .pointer("/error/message")
                .and_then(|v| v.as_str())
                .unwrap_or("app-server error");
            let will_retry = params
                .get("willRetry")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            emit_chat_event(
                app,
                &chat_id,
                "warning",
                json!({ "message": message, "will_retry": will_retry }),
            );
        }
        "warning" => {
            let message = params
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("app-server warning");
            emit_chat_event(app, &chat_id, "warning", json!({ "message": message }));
        }
        "thread/tokenUsage/updated" => {
            // context accounting for the chat's context gauge (last = current
            // footprint, total = cumulative, modelContextWindow = the cap)
            if let Some(usage) = params.get("tokenUsage") {
                emit_chat_event(
                    app,
                    &chat_id,
                    "token_usage",
                    json!({
                        "total": usage.get("total"),
                        "last": usage.get("last"),
                        "modelContextWindow": usage.get("modelContextWindow"),
                    }),
                );
            }
        }
        _ => {} // everything else (item/started, thread/status/changed, …): ignore
    }
}

/// Process died: fail every running turn and tell every chat.
fn handle_exit(app: &AppHandle) {
    let pending: Vec<(String, Option<oneshot::Sender<TurnOutcome>>)> = {
        let mut shared = SHARED.lock();
        shared
            .chats
            .iter_mut()
            .map(|(cid, chat)| {
                chat.current_turn_id = None;
                (cid.clone(), chat.done_tx.take())
            })
            .collect()
    };
    for (chat_id, done_tx) in pending {
        if let Some(tx) = done_tx {
            let _ = tx.send(TurnOutcome {
                status: "failed".into(),
                error: Some("codex app-server exited".into()),
                message: None,
            });
            emit_chat_event(
                app,
                &chat_id,
                "turn_failed",
                json!({ "error": "codex app-server exited" }),
            );
        }
        emit_chat_event(
            app,
            &chat_id,
            "warning",
            json!({ "message": "codex app-server exited — it restarts with the next message (the thread is resumed)" }),
        );
    }
}

// ---------------------------------------------------------------------------
// Chat API (the five Tauri commands live in lib.rs and call these)
// ---------------------------------------------------------------------------

/// Register the thread's route on the (possibly fresh) connection and the
/// chat bookkeeping. Idempotent per thread — a re-registration after a
/// respawn just refreshes the route + generation.
fn register_chat(
    conn: &Connection,
    sink: &EventSink,
    generation: u64,
    thread_id: &str,
) -> String {
    conn.register_thread(thread_id, sink.clone());
    let mut shared = SHARED.lock();
    if let Some(existing) = shared.thread_to_chat.get(thread_id) {
        let cid = existing.clone();
        if let Some(chat) = shared.chats.get_mut(&cid) {
            chat.generation = generation;
        }
        return cid;
    }
    let chat_id = format!("chat-{}", CHAT_COUNTER.fetch_add(1, Ordering::Relaxed) + 1);
    shared
        .thread_to_chat
        .insert(thread_id.to_string(), chat_id.clone());
    shared.chats.insert(
        chat_id.clone(),
        ChatState {
            thread_id: thread_id.to_string(),
            generation,
            ..Default::default()
        },
    );
    chat_id
}

/// Store the chat's persona after (re)registration — reused by chat_send's
/// transparent resume so a respawn keeps the same voice.
fn set_chat_persona(chat_id: &str, persona: PersonaSpec) {
    if let Some(chat) = SHARED.lock().chats.get_mut(chat_id) {
        chat.persona = persona;
    }
}

/// Start a fresh orchestrator chat (thread/start with all dynamic tools). The
/// persona (voice) is captured here; memory is read fresh from disk.
pub async fn chat_start(
    app: &AppHandle,
    codex_path: Option<String>,
    persona: Option<PersonaSpec>,
) -> Result<Value, String> {
    if codex_path.is_some() {
        // the frontend passes the current settings value on every call —
        // an empty string clears the override back to plain `codex`
        host::set_codex_override(codex_path);
    }
    let persona = persona.unwrap_or_default();
    let memory = load_memory(app).await;
    let (conn, generation, sink) = ensure_conn(app).await?;
    let res = conn
        .request(
            "thread/start",
            thread_start_params(&persona, &memory),
            THREAD_TIMEOUT_MS,
        )
        .await
        .map_err(|e| guard_dynamic_tools_error(e, Some(conn.version())))?;
    let thread_id = res
        .pointer("/thread/id")
        .and_then(|v| v.as_str())
        .ok_or("thread/start: no thread id in response")?
        .to_string();
    let chat_id = register_chat(&conn, &sink, generation, &thread_id);
    set_chat_persona(&chat_id, persona);
    Ok(json!({ "chat_id": chat_id, "thread_id": thread_id }))
}

/// Reopen an existing app-server thread as a chat (thread/resume — dynamic
/// tools are restored from the rollout by codex). Persona + fresh memory are
/// re-sent as developerInstructions.
pub async fn chat_resume(
    app: &AppHandle,
    thread_id: &str,
    persona: Option<PersonaSpec>,
) -> Result<Value, String> {
    let persona = persona.unwrap_or_default();
    let memory = load_memory(app).await;
    let (conn, generation, sink) = ensure_conn(app).await?;
    conn.request(
        "thread/resume",
        thread_resume_params(thread_id, &persona, &memory),
        THREAD_TIMEOUT_MS,
    )
    .await?;
    let chat_id = register_chat(&conn, &sink, generation, thread_id);
    set_chat_persona(&chat_id, persona);
    Ok(json!({ "chat_id": chat_id, "thread_id": thread_id }))
}

/// Send one user message; resolves with the turn's final assistant text once
/// the turn completes (progress streams via `orchestrator://chat-event`).
/// `model`/`effort` are optional per-turn overrides (they stick for this and
/// following turns per the app-server protocol) — omitted = the user's default.
pub async fn chat_send(
    app: &AppHandle,
    chat_id: &str,
    text: &str,
    model: Option<String>,
    effort: Option<String>,
) -> Result<Value, String> {
    let (conn, generation, sink) = ensure_conn(app).await?;

    let (thread_id, needs_resume, persona) = {
        let shared = SHARED.lock();
        let chat = shared
            .chats
            .get(chat_id)
            .ok_or_else(|| format!("unknown chat_id \"{chat_id}\" — start a chat first"))?;
        if chat.done_tx.is_some() {
            return Err("a turn is already running in this chat — interrupt it or wait".into());
        }
        (
            chat.thread_id.clone(),
            chat.generation != generation,
            chat.persona.clone(),
        )
    };

    // the process was respawned since this chat started → resume its thread
    // (and re-register its route — routes die with the process)
    if needs_resume {
        let memory = load_memory(app).await;
        host::resume_thread(&conn, thread_resume_params(&thread_id, &persona, &memory))
            .await
            .map_err(|e| {
                // ThreadNotFound included: the orchestrator has no fresh-start
                // fallback here by design — the frontend controller handles a
                // failed resume by starting a new thread (Phase 4)
                format!("thread/resume after app-server restart failed: {}", e.message())
            })?;
        conn.register_thread(&thread_id, sink.clone());
        if let Some(chat) = SHARED.lock().chats.get_mut(chat_id) {
            chat.generation = generation;
        }
    }

    // fresh fleet summary line, prepended to every user turn (best effort —
    // the instructions tell the model to rely on it)
    // internal call (no model turn behind it) — no chat context on purpose,
    // the executors must not track it as an orchestrator action
    let summary = super::run_tool(app, "fleet_snapshot", json!({}), None)
        .await
        .ok()
        .and_then(|v| v.get("summary").and_then(|s| s.as_str()).map(String::from));
    let input_text = match summary {
        Some(s) => format!("[fleet status: {s}]\n\n{text}"),
        None => text.to_string(),
    };

    let (done_tx, done_rx) = oneshot::channel();
    {
        let mut shared = SHARED.lock();
        let chat = shared
            .chats
            .get_mut(chat_id)
            .ok_or_else(|| format!("unknown chat_id \"{chat_id}\""))?;
        chat.done_tx = Some(done_tx);
        chat.last_agent_message = None;
    }
    let clear_done = || {
        if let Some(chat) = SHARED.lock().chats.get_mut(chat_id) {
            chat.done_tx = None;
        }
    };

    let mut turn_params = json!({
        "threadId": thread_id,
        "input": [{ "type": "text", "text": input_text }],
    });
    if let Some(m) = model.filter(|s| !s.is_empty()) {
        turn_params["model"] = json!(m);
    }
    if let Some(e) = effort.filter(|s| !s.is_empty()) {
        turn_params["effort"] = json!(e);
    }

    match conn
        .request("turn/start", turn_params, RPC_TIMEOUT_MS)
        .await
    {
        Ok(res) => {
            if let Some(turn_id) = res.pointer("/turn/id").and_then(|v| v.as_str()) {
                if let Some(chat) = SHARED.lock().chats.get_mut(chat_id) {
                    chat.current_turn_id = Some(turn_id.to_string());
                }
            }
        }
        Err(e) => {
            clear_done();
            return Err(format!("turn/start failed: {e}"));
        }
    }

    match tokio::time::timeout(Duration::from_millis(TURN_TIMEOUT_MS), done_rx).await {
        Ok(Ok(outcome)) => {
            if outcome.status == "failed" {
                Err(outcome.error.unwrap_or_else(|| "turn failed".into()))
            } else {
                Ok(json!({
                    "status": outcome.status,
                    "text": outcome.message.unwrap_or_default(),
                }))
            }
        }
        Ok(Err(_)) => Err("turn aborted: chat state was dropped".into()),
        Err(_) => {
            clear_done();
            Err(format!(
                "turn timed out after {} minutes",
                TURN_TIMEOUT_MS / 60_000
            ))
        }
    }
}

/// Interrupt the chat's running turn (the awaited `chat_send` resolves via
/// the following turn/completed with status "interrupted").
pub async fn chat_interrupt(chat_id: &str) -> Result<(), String> {
    let (thread_id, turn_id) = {
        let shared = SHARED.lock();
        let chat = shared
            .chats
            .get(chat_id)
            .ok_or_else(|| format!("unknown chat_id \"{chat_id}\""))?;
        let turn_id = chat
            .current_turn_id
            .clone()
            .ok_or("no turn is running in this chat")?;
        (chat.thread_id.clone(), turn_id)
    };
    let conn = HOST
        .alive()
        .await
        .ok_or("codex app-server is not running")?;
    conn.request(
        "turn/interrupt",
        json!({ "threadId": thread_id, "turnId": turn_id }),
        RPC_TIMEOUT_MS,
    )
    .await
    .map(|_| ())
}

/// Health/identity: process liveness, codex version (initialize userAgent),
/// and an account/read summary. Spawns the process if needed; a failure to
/// spawn is reported as `running:false` with the error, never as Err.
pub async fn chat_status(app: &AppHandle, codex_path: Option<String>) -> Value {
    if codex_path.is_some() {
        host::set_codex_override(codex_path);
    }
    let conn = match ensure_conn(app).await {
        Ok((conn, _, _)) => conn,
        Err(e) => {
            return json!({
                "running": false,
                "error": e,
                "version": HOST.last_version().await,
                "account": Value::Null,
            });
        }
    };
    let version = conn.version().to_string();
    let account = match conn.request("account/read", json!({}), RPC_TIMEOUT_MS).await {
        Ok(v) => {
            let acc = v.get("account").filter(|a| !a.is_null());
            json!({
                "logged_in": acc.is_some(),
                "type": acc.and_then(|a| a.get("type")).cloned().unwrap_or(Value::Null),
                "plan": acc.and_then(|a| a.get("planType")).cloned().unwrap_or(Value::Null),
                "email": acc.and_then(|a| a.get("email")).cloned().unwrap_or(Value::Null),
            })
        }
        Err(e) => json!({ "error": e }),
    };
    json!({ "running": true, "version": version, "account": account })
}

/// The model ids the installed codex actually offers (`model/list`,
/// live-verified on 0.142.5) — the authoritative picker source, unlike the
/// recently-used heuristic. Hidden entries are dropped; server order is kept
/// (the default model comes first). The frontend caches per app run.
pub async fn list_models(app: &AppHandle) -> Result<Vec<String>, String> {
    let (conn, _, _) = ensure_conn(app).await?;
    let res = conn
        .request("model/list", json!({}), RPC_TIMEOUT_MS)
        .await?;
    Ok(parse_model_list(&res))
}

/// Pure `model/list`-response → visible model ids (unit-tested).
fn parse_model_list(res: &Value) -> Vec<String> {
    res.get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|m| !m.get("hidden").and_then(|h| h.as_bool()).unwrap_or(false))
                .filter_map(|m| m.get("id").and_then(|i| i.as_str()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex::host::{handshake, Client, ServerEvent};

    #[test]
    fn model_list_keeps_visible_ids_in_server_order() {
        // shape from a live 0.142.5 `model/list` probe (fields trimmed)
        let res = json!({ "data": [
            { "id": "gpt-5.5", "displayName": "GPT-5.5", "hidden": false },
            { "id": "gpt-5.5-internal", "hidden": true },
            { "id": "gpt-5.5-codex", "displayName": "GPT-5.5 Codex", "hidden": false },
            { "displayName": "no id — dropped", "hidden": false },
        ]});
        assert_eq!(parse_model_list(&res), vec!["gpt-5.5", "gpt-5.5-codex"]);
        assert!(parse_model_list(&json!({})).is_empty());
    }

    #[test]
    fn version_guard_wraps_dynamic_tool_failures_only() {
        let wrapped = guard_dynamic_tools_error(
            "unknown field `dynamicTools` (code -32602)".into(),
            Some("codex/0.99.0"),
        );
        assert!(wrapped.contains("codex/0.99.0"), "{wrapped}");
        assert!(wrapped.contains(KNOWN_GOOD_VERSION), "{wrapped}");

        let untouched = guard_dynamic_tools_error("network unreachable".into(), None);
        assert_eq!(untouched, "network unreachable");
    }

    #[test]
    fn thread_params_carry_tools_sandbox_and_instructions() {
        let persona = PersonaSpec::default();
        let start = thread_start_params(&persona, "");
        assert_eq!(start["sandbox"], "read-only");
        assert_eq!(start["approvalPolicy"], "never");
        let instructions = start["developerInstructions"].as_str().unwrap();
        assert!(instructions.contains("SwarmZ Orchestrator"));
        // persona header is compiled in ahead of the operative core
        assert!(instructions.contains("Maestro"));
        // the layout/placement guidance is single-source here (grid awareness)
        assert!(instructions.contains("Layout & placement"));
        let tools = start["dynamicTools"].as_array().unwrap();
        assert_eq!(tools.len(), 11);

        // memory snapshot flows into developerInstructions when present
        let with_mem = thread_start_params(&persona, "- 2026-07-07 reviews go to Opus");
        assert!(with_mem["developerInstructions"]
            .as_str()
            .unwrap()
            .contains("reviews go to Opus"));

        // resume must NOT re-declare dynamicTools (restored from the rollout)
        let resume = thread_resume_params("t-1", &persona, "");
        assert_eq!(resume["threadId"], "t-1");
        assert!(resume.get("dynamicTools").is_none());
        assert_eq!(resume["sandbox"], "read-only");
        assert!(resume["developerInstructions"]
            .as_str()
            .unwrap()
            .contains("SwarmZ Orchestrator"));
    }

    /// Full ping-tool loop against the REAL installed codex CLI. Ignored by
    /// default (needs codex + login + network — CI stays green); run with:
    ///   cargo test appserver_spike -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn appserver_spike() {
        let (events_tx, mut events_rx) = mpsc::unbounded_channel();
        // resolve exactly like production — doubles as a regression test for
        // the built app's minimal GUI PATH (run with PATH=/usr/bin:/bin …)
        let program = crate::codex::host::resolve_codex_program(None).expect("resolve codex binary");
        println!("resolved codex: {program}");
        let client = Arc::new(
            Client::spawn(&program, events_tx)
                .await
                .expect("spawn codex app-server"),
        );

        let version = handshake(&client).await.expect("initialize");
        println!("initialize ok — userAgent: {version}");

        let tmp = std::env::temp_dir().join("swarmz-appserver-spike");
        std::fs::create_dir_all(&tmp).unwrap();
        let started = client
            .request(
                "thread/start",
                json!({
                    "cwd": tmp.to_string_lossy(),
                    "sandbox": "read-only",
                    "approvalPolicy": "never",
                    "ephemeral": true,
                    "developerInstructions": "You are a connectivity test agent.",
                    "dynamicTools": [{
                        "type": "function",
                        "name": "ping",
                        "description": "Health check of the host app; returns the answer string.",
                        "inputSchema": { "type": "object", "properties": {} },
                    }],
                }),
                THREAD_TIMEOUT_MS,
            )
            .await
            .expect("thread/start");
        let thread_id = started
            .pointer("/thread/id")
            .and_then(|v| v.as_str())
            .expect("thread id")
            .to_string();
        println!("thread started: {thread_id}");

        client
            .request(
                "turn/start",
                json!({
                    "threadId": thread_id,
                    "input": [{
                        "type": "text",
                        "text": "Call the ping tool exactly once and reply with exactly what it returned.",
                    }],
                }),
                RPC_TIMEOUT_MS,
            )
            .await
            .expect("turn/start");

        let mut tool_called = false;
        let mut final_message: Option<String> = None;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(240);
        loop {
            let ev = tokio::time::timeout_at(deadline, events_rx.recv())
                .await
                .expect("spike timed out waiting for the turn")
                .expect("event stream closed");
            match ev {
                ServerEvent::Request { id, method, params } => {
                    assert_eq!(method, "item/tool/call", "unexpected server request");
                    assert_eq!(params["tool"], "ping");
                    println!("tool call: {} args={}", params["tool"], params["arguments"]);
                    tool_called = true;
                    client.respond(
                        &id,
                        &adapter::tool_call_response(&Ok(json!("pong from the spike host"))),
                    );
                }
                ServerEvent::Notification { method, params } => match method.as_str() {
                    "item/completed"
                        if params.pointer("/item/type").and_then(|v| v.as_str())
                            == Some("agentMessage") =>
                    {
                        final_message = params
                            .pointer("/item/text")
                            .and_then(|v| v.as_str())
                            .map(str::to_string);
                    }
                    "turn/completed" => {
                        let status = params.pointer("/turn/status").and_then(|v| v.as_str());
                        println!("turn completed: {status:?}");
                        assert_eq!(status, Some("completed"));
                        break;
                    }
                    _ => {}
                },
                ServerEvent::Exited => panic!("app-server exited mid-spike"),
            }
        }

        println!("tool_called: {tool_called}");
        println!("final agent message: {final_message:?}");
        assert!(tool_called, "the model never called the dynamic tool");
        let msg = final_message.expect("no final agent message");
        assert!(
            msg.to_lowercase().contains("pong"),
            "final message does not reference the tool result: {msg}"
        );
    }
}
