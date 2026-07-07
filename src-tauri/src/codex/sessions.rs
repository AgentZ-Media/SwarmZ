// Vibe-Mode native Codex sessions — the SECOND consumer of the generic
// `codex app-server` host in `crate::codex::host` (the orchestrator brain is
// the first). Process strategy (b): each session owns a PRIVATE `ProcessHost`
// slot, so a crash isolates to that one session (t3code's "one process per
// thread"). Unlike the orchestrator, a Vibe session keeps codex' STANDARD
// harness intact — NO `dynamicTools`, NO `developerInstructions`; it is a
// plain agentic Codex session (exec + apply_patch), just driven natively and
// mirrored into the SwarmZ UI over `vibe://session-event`.
//
// Layers, bottom to top:
//   - `codex::host` — process, framing, per-threadId event routing, the
//     lazily (re)spawned `ProcessHost` slot (one per session here).
//   - per-session dispatcher — consumes the routed `ThreadEvent`s for this
//     session's thread: remembers approval `Responder`s so a later
//     `respond_approval` can answer them, tracks turn/busy state, and maps
//     each notification to a `vibe://session-event` emission.
//   - session API — the eight `vibe_session_*` Tauri commands in lib.rs call
//     the async functions here. `send` is NON-blocking: it returns the turn
//     id after the `turn/start` ack; the transcript + completion arrive as
//     events (many sessions run in parallel, the UI is event-driven).
//
// Access → sandbox mapping (exact wire strings verified against the 0.142.5
// protocol reference): `workspace` = sandbox `workspace-write` +
// approvalPolicy `on-request` (codex asks before writes/network it isn't sure
// about); `full` = sandbox `danger-full-access` + approvalPolicy `never`.
// Access changes take effect on the NEXT turn via a per-turn override
// (`sandboxPolicy` object form + `approvalPolicy` — both are turn-overridable
// "for this and all following turns").

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use super::host::{self, Connection, EventSink, ProcessHost, Responder, ThreadEvent};

/// commandExecution `aggregatedOutput` is capped before it crosses to the
/// webview — a runaway build log must never blow up the event payload or the
/// store. The TAIL is kept (the most recent output, incl. the exit line).
const MAX_AGG_OUTPUT: usize = 64 * 1024;

// ---------------------------------------------------------------------------
// Access profile
// ---------------------------------------------------------------------------

/// How much the session's Codex agent may touch the machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    /// sandbox `workspace-write` + approvalPolicy `on-request` — writes inside
    /// the workspace, asks before anything it isn't sure about.
    Workspace,
    /// sandbox `danger-full-access` + approvalPolicy `never` — no sandbox, no
    /// prompts. The "vibe" default: get out of the agent's way.
    Full,
}

impl Access {
    fn parse(raw: &str) -> Result<Self, String> {
        match raw {
            "workspace" => Ok(Access::Workspace),
            "full" => Ok(Access::Full),
            other => Err(format!("unknown access \"{other}\" (expected workspace|full)")),
        }
    }

    /// `SandboxMode` string for thread/start & thread/resume.
    fn sandbox_mode(self) -> &'static str {
        match self {
            Access::Workspace => "workspace-write",
            Access::Full => "danger-full-access",
        }
    }

    /// `AskForApproval` string.
    fn approval_policy(self) -> &'static str {
        match self {
            Access::Workspace => "on-request",
            Access::Full => "never",
        }
    }

    /// `SandboxPolicy` object (the tagged form turn/start overrides expect —
    /// NOT the `SandboxMode` string). Shapes match the 0.142.5 response form.
    fn sandbox_policy(self) -> Value {
        match self {
            Access::Workspace => json!({
                "type": "workspaceWrite",
                "writableRoots": [],
                "networkAccess": false,
                "excludeTmpdirEnvVar": false,
                "excludeSlashTmp": false,
            }),
            Access::Full => json!({ "type": "dangerFullAccess" }),
        }
    }
}

#[derive(Clone, Debug)]
struct SessionProfile {
    cwd: String,
    model: Option<String>,
    effort: Option<String>,
    access: Access,
}

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

/// Live state of one Vibe session. Touched by both its dispatcher task and the
/// commands, so it lives outside any async lock (plain mutex, no awaits while
/// held — commands clone what they need out of the lock before awaiting).
struct SessionState {
    /// this session's PRIVATE process slot (strategy b — crash isolation)
    host: Arc<ProcessHost>,
    /// current app-server thread; may be replaced on a lost-rollout fallback
    thread_id: Option<String>,
    /// spawn generation this session's route was registered under — a mismatch
    /// after a respawn triggers a transparent thread/resume before the turn
    generation: u64,
    profile: SessionProfile,
    /// running turn id (for interrupt); None between turns
    current_turn_id: Option<String>,
    /// one turn per session at a time — claimed synchronously in `send`
    busy: bool,
    /// access changed since the last turn → apply the override on the next
    /// turn/start (then clear)
    access_override_pending: bool,
    /// unanswered approval requests: our approval_id → the blocking Responder
    pending_approvals: HashMap<String, Responder>,
    /// this session's event sink (re-registered on the fresh connection after
    /// a respawn — routes die with the process)
    sink: EventSink,
    approval_counter: u64,
}

static SESSIONS: Lazy<Mutex<HashMap<String, SessionState>>> = Lazy::new(Mutex::default);

static APPROVAL_SEQ: AtomicU64 = AtomicU64::new(0);

fn emit_session_event(app: &AppHandle, session_id: &str, kind: &str, data: Value) {
    let _ = app.emit(
        "vibe://session-event",
        json!({ "session_id": session_id, "kind": kind, "data": data }),
    );
}

// ---------------------------------------------------------------------------
// Notification / server-request mapping (pure — unit-tested with fixtures)
// ---------------------------------------------------------------------------

/// Which approval flavor is this server request (or None if it isn't one)?
fn approval_kind(method: &str) -> Option<&'static str> {
    match method {
        "item/commandExecution/requestApproval" => Some("command"),
        "item/fileChange/requestApproval" => Some("fileChange"),
        _ => None,
    }
}

/// Keep the TAIL of an over-long string on a char boundary, prefixed with a
/// truncation marker. commandExecution output is what this guards.
fn cap_output(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut start = s.len() - max;
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    format!("…[{} bytes truncated]…\n{}", start, &s[start..])
}

/// Normalize one raw ThreadItem for the UI: mostly a passthrough (codex already
/// emits the right camelCase shapes), the one active step is capping a
/// commandExecution's `aggregatedOutput`. Unknown item types pass through
/// untouched — they still carry `id` + `type`, which is all the store needs.
fn normalize_item(item: &Value) -> Value {
    let mut out = item.clone();
    if out.get("type").and_then(|v| v.as_str()) == Some("commandExecution") {
        if let Some(agg) = out.get("aggregatedOutput").and_then(|v| v.as_str()) {
            if agg.len() > MAX_AGG_OUTPUT {
                let capped = cap_output(agg, MAX_AGG_OUTPUT);
                if let Some(obj) = out.as_object_mut() {
                    obj.insert("aggregatedOutput".into(), json!(capped));
                }
            }
        }
    }
    out
}

/// Map one server NOTIFICATION to the `(kind, data)` we emit on
/// `vibe://session-event`, or None for the ones we ignore. Pure: the SHARED
/// bookkeeping (turn id, busy) is done by the caller. `agentMessage` items are
/// routed to `delta`/`message` (the streaming bubble), everything else to
/// `item_started`/`item_updated`/`item_completed`.
fn map_notification(method: &str, params: &Value) -> Option<(&'static str, Value)> {
    match method {
        "turn/started" => {
            let turn_id = params.pointer("/turn/id").and_then(|v| v.as_str());
            Some(("turn_started", json!({ "turn_id": turn_id })))
        }
        "item/agentMessage/delta" => {
            let text = params.get("delta").and_then(|v| v.as_str()).unwrap_or("");
            Some(("delta", json!({ "item_id": params.get("itemId"), "text": text })))
        }
        // commandExecution output streams incrementally while a command runs —
        // live-verified in the Phase-2 spike (item/updated never fired; this
        // did). The store appends it to the command item's output.
        "item/commandExecution/outputDelta" => {
            let delta = params.get("delta").and_then(|v| v.as_str()).unwrap_or("");
            Some(("item_output_delta", json!({ "item_id": params.get("itemId"), "delta": delta })))
        }
        "item/started" => {
            let item = params.get("item")?;
            if item.get("type").and_then(|v| v.as_str()) == Some("agentMessage") {
                return None; // the streaming bubble is driven by deltas
            }
            Some(("item_started", json!({ "item": normalize_item(item) })))
        }
        // item/updated is not in the generated schema for 0.142.5 but is
        // handled defensively (growing aggregatedOutput / plan mutations) —
        // harmless if it never fires.
        "item/updated" => {
            let item = params.get("item")?;
            if item.get("type").and_then(|v| v.as_str()) == Some("agentMessage") {
                return None;
            }
            Some(("item_updated", json!({ "item": normalize_item(item) })))
        }
        "item/completed" => {
            let item = params.get("item")?;
            if item.get("type").and_then(|v| v.as_str()) == Some("agentMessage") {
                let text = item.get("text").and_then(|v| v.as_str()).unwrap_or("");
                return Some((
                    "message",
                    json!({ "item_id": item.get("id"), "text": text, "phase": item.get("phase") }),
                ));
            }
            Some(("item_completed", json!({ "item": normalize_item(item) })))
        }
        "turn/diff/updated" => Some((
            "turn_diff",
            json!({ "diff": params.get("diff").and_then(|v| v.as_str()).unwrap_or("") }),
        )),
        "turn/plan/updated" => Some((
            "plan",
            json!({ "explanation": params.get("explanation"), "plan": params.get("plan") }),
        )),
        "thread/tokenUsage/updated" => {
            let usage = params.get("tokenUsage")?;
            Some((
                "token_usage",
                json!({
                    "total": usage.get("total"),
                    "last": usage.get("last"),
                    "modelContextWindow": usage.get("modelContextWindow"),
                }),
            ))
        }
        "turn/completed" => {
            let status = params
                .pointer("/turn/status")
                .and_then(|v| v.as_str())
                .unwrap_or("completed");
            if status == "failed" {
                let error = params
                    .pointer("/turn/error/message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("turn failed");
                Some(("turn_failed", json!({ "error": error })))
            } else {
                Some(("turn_completed", json!({ "status": status })))
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
            Some(("warning", json!({ "message": message, "will_retry": will_retry })))
        }
        "warning" => {
            let message = params
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("app-server warning");
            Some(("warning", json!({ "message": message })))
        }
        _ => None, // token deltas we ignore, thread/status/changed, mcp status, …
    }
}

// ---------------------------------------------------------------------------
// Per-session dispatcher
// ---------------------------------------------------------------------------

fn spawn_session_dispatcher(
    app: AppHandle,
    session_id: String,
    mut rx: mpsc::UnboundedReceiver<ThreadEvent>,
) {
    tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            match ev {
                ThreadEvent::Request { method, params, responder } => {
                    handle_server_request(&app, &session_id, &method, params, responder);
                }
                ThreadEvent::Notification { method, params } => {
                    handle_notification(&app, &session_id, &method, &params);
                }
                ThreadEvent::Exited => handle_exit(&app, &session_id),
            }
        }
        // all senders dropped (session closed → SessionState + Connection gone)
    });
}

/// Approvals are BLOCKING server requests: remember the Responder under a fresh
/// approval id and surface the request to the UI. The user's later decision
/// (`respond_approval`) answers the blocked RPC. Any OTHER server-initiated
/// request (user-input prompts, elicitations, …) is refused with -32601 — the
/// server treats that as a denial and the turn continues/fails.
fn handle_server_request(
    app: &AppHandle,
    session_id: &str,
    method: &str,
    params: Value,
    responder: Responder,
) {
    match approval_kind(method) {
        Some(kind) => {
            let approval_id = {
                let mut sessions = SESSIONS.lock();
                let Some(st) = sessions.get_mut(session_id) else {
                    // session vanished mid-request — must still answer or the
                    // server hangs on the blocked RPC
                    responder.ok(&json!({ "decision": "cancel" }));
                    return;
                };
                st.approval_counter += 1;
                let approval_id = format!(
                    "{session_id}-ap-{}-{}",
                    st.approval_counter,
                    APPROVAL_SEQ.fetch_add(1, Ordering::Relaxed)
                );
                st.pending_approvals.insert(approval_id.clone(), responder);
                approval_id
            };
            emit_session_event(
                app,
                session_id,
                "approval_request",
                // pass the request params through verbatim (itemId, reason,
                // command/cwd, availableDecisions, …) — the UI reads them
                json!({ "approval_id": approval_id, "kind": kind, "request": params }),
            );
        }
        None => {
            responder.error(-32601, "not supported by SwarmZ vibe sessions");
            emit_session_event(
                app,
                session_id,
                "warning",
                json!({ "message": format!("declined unsupported server request ({method})") }),
            );
        }
    }
}

fn handle_notification(app: &AppHandle, session_id: &str, method: &str, params: &Value) {
    // SHARED bookkeeping first (turn id for interrupt, busy for the one-turn
    // guard) — then the pure event mapping.
    match method {
        "turn/started" => {
            let turn_id = params
                .pointer("/turn/id")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            if let Some(st) = SESSIONS.lock().get_mut(session_id) {
                st.current_turn_id = turn_id;
            }
        }
        "turn/completed" => {
            if let Some(st) = SESSIONS.lock().get_mut(session_id) {
                st.current_turn_id = None;
                st.busy = false;
            }
        }
        _ => {}
    }
    if let Some((kind, data)) = map_notification(method, params) {
        emit_session_event(app, session_id, kind, data);
    }
}

/// The private process died: clear turn/busy state, drop dead approval
/// responders, tell the UI. The next `send` respawns and resumes.
fn handle_exit(app: &AppHandle, session_id: &str) {
    if let Some(st) = SESSIONS.lock().get_mut(session_id) {
        st.current_turn_id = None;
        st.busy = false;
        st.pending_approvals.clear(); // the blocked RPCs died with the process
    }
    emit_session_event(
        app,
        session_id,
        "process_exited",
        json!({ "message": "the session process exited — it restarts on the next message" }),
    );
}

// ---------------------------------------------------------------------------
// Thread / turn params
// ---------------------------------------------------------------------------

fn thread_start_params(profile: &SessionProfile) -> Value {
    let mut p = json!({
        "cwd": profile.cwd,
        "sandbox": profile.access.sandbox_mode(),
        "approvalPolicy": profile.access.approval_policy(),
    });
    if let Some(model) = &profile.model {
        p["model"] = json!(model);
    }
    // NO dynamicTools, NO developerInstructions — Codex' standard harness must
    // stay intact for a plain agentic session.
    p
}

fn thread_resume_params(thread_id: &str, profile: &SessionProfile) -> Value {
    let mut p = json!({
        "threadId": thread_id,
        "cwd": profile.cwd,
        "sandbox": profile.access.sandbox_mode(),
        "approvalPolicy": profile.access.approval_policy(),
    });
    if let Some(model) = &profile.model {
        p["model"] = json!(model);
    }
    p
}

/// turn/start params. `effort` (a per-turn override) rides on every turn when
/// set; the sandbox/approval override is only attached when access changed
/// since the last turn (keeps the object-form `sandboxPolicy` off the wire on
/// ordinary turns).
fn turn_params(
    thread_id: &str,
    text: &str,
    profile: &SessionProfile,
    include_access_override: bool,
) -> Value {
    let mut p = json!({
        "threadId": thread_id,
        "input": [{ "type": "text", "text": text }],
    });
    // model + effort are per-turn overrides that stick — riding them on every
    // turn is what lets the user change model/effort mid-session (they apply on
    // the next turn/start without a fresh thread).
    if let Some(model) = &profile.model {
        p["model"] = json!(model);
    }
    if let Some(effort) = &profile.effort {
        p["effort"] = json!(effort);
    }
    if include_access_override {
        p["sandboxPolicy"] = profile.access.sandbox_policy();
        p["approvalPolicy"] = json!(profile.access.approval_policy());
    }
    p
}

// ---------------------------------------------------------------------------
// Commands (the eight vibe_session_* Tauri commands in lib.rs call these)
// ---------------------------------------------------------------------------

/// Wire up a fresh session's sink + dispatcher + registry entry once the
/// thread exists. Returns nothing — the caller already holds `thread_id`.
fn register_session(
    app: &AppHandle,
    session_id: &str,
    host: Arc<ProcessHost>,
    conn: &Connection,
    generation: u64,
    thread_id: &str,
    profile: SessionProfile,
) {
    let (tx, rx) = mpsc::unbounded_channel();
    spawn_session_dispatcher(app.clone(), session_id.to_string(), rx);
    conn.register_thread(thread_id, tx.clone());
    SESSIONS.lock().insert(
        session_id.to_string(),
        SessionState {
            host,
            thread_id: Some(thread_id.to_string()),
            generation,
            profile,
            current_turn_id: None,
            busy: false,
            access_override_pending: false,
            pending_approvals: HashMap::new(),
            sink: tx,
            approval_counter: 0,
        },
    );
}

/// Start a fresh Vibe session: a dedicated app-server process + thread/start
/// with the access-mapped sandbox. `session_id` is assigned by the frontend
/// (it keys the store's VibeSession); `codex_path` is the Settings override.
pub async fn session_start(
    app: &AppHandle,
    session_id: &str,
    cwd: String,
    model: Option<String>,
    effort: Option<String>,
    access: &str,
    codex_path: Option<String>,
) -> Result<Value, String> {
    if codex_path.is_some() {
        host::set_codex_override(codex_path);
    }
    if SESSIONS.lock().contains_key(session_id) {
        return Err(format!("vibe session \"{session_id}\" is already open"));
    }
    let profile = SessionProfile {
        cwd,
        model,
        effort,
        access: Access::parse(access)?,
    };
    let host = Arc::new(ProcessHost::new());
    let (conn, generation) = host.ensure().await?;
    let res = conn
        .request("thread/start", thread_start_params(&profile), host::THREAD_TIMEOUT_MS)
        .await?;
    let thread_id = res
        .pointer("/thread/id")
        .and_then(|v| v.as_str())
        .ok_or("thread/start: no thread id in response")?
        .to_string();
    register_session(app, session_id, host, &conn, generation, &thread_id, profile);
    Ok(json!({ "thread_id": thread_id }))
}

/// Reopen a persisted session across an app restart: a dedicated process +
/// thread/resume. A `ThreadNotFound` (rollout gone / was ephemeral) falls back
/// to a fresh thread/start — the returned `resumed:false` tells the UI its
/// prior transcript context is gone (the displayed history stays, the model's
/// context doesn't). `session_id`/`thread_id` come from the persisted store.
pub async fn session_resume(
    app: &AppHandle,
    session_id: &str,
    thread_id: &str,
    cwd: String,
    model: Option<String>,
    effort: Option<String>,
    access: &str,
    codex_path: Option<String>,
) -> Result<Value, String> {
    if codex_path.is_some() {
        host::set_codex_override(codex_path);
    }
    if SESSIONS.lock().contains_key(session_id) {
        return Err(format!("vibe session \"{session_id}\" is already open"));
    }
    let profile = SessionProfile {
        cwd,
        model,
        effort,
        access: Access::parse(access)?,
    };
    let host = Arc::new(ProcessHost::new());
    let (conn, generation) = host.ensure().await?;

    let (effective_thread_id, resumed) =
        match host::resume_thread(&conn, thread_resume_params(thread_id, &profile)).await {
            Ok(_) => (thread_id.to_string(), true),
            Err(host::ResumeError::ThreadNotFound(_)) => {
                // rollout gone — start a fresh thread under the same session id
                let res = conn
                    .request(
                        "thread/start",
                        thread_start_params(&profile),
                        host::THREAD_TIMEOUT_MS,
                    )
                    .await?;
                let tid = res
                    .pointer("/thread/id")
                    .and_then(|v| v.as_str())
                    .ok_or("thread/start after lost thread returned no id")?
                    .to_string();
                (tid, false)
            }
            Err(host::ResumeError::Other(m)) => {
                return Err(format!("resuming the session failed: {m}"))
            }
        };
    register_session(
        app,
        session_id,
        host,
        &conn,
        generation,
        &effective_thread_id,
        profile,
    );
    Ok(json!({ "thread_id": effective_thread_id, "resumed": resumed }))
}

/// Send one user message — NON-blocking: returns the turn id after the
/// `turn/start` ack; the transcript + completion stream as events. One turn
/// per session at a time (a busy session rejects). Transparently resumes after
/// a private-process respawn.
pub async fn session_send(app: &AppHandle, session_id: &str, text: &str) -> Result<Value, String> {
    // atomically claim the turn slot + snapshot what we need for the roundtrip
    let (host, sink, mut thread_id, gen_stored, override_pending, profile) = {
        let mut sessions = SESSIONS.lock();
        let st = sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("unknown vibe session \"{session_id}\""))?;
        if st.busy {
            return Err("a turn is already running in this session — interrupt it or wait".into());
        }
        let thread_id = st
            .thread_id
            .clone()
            .ok_or("this session has no thread yet")?;
        st.busy = true;
        (
            st.host.clone(),
            st.sink.clone(),
            thread_id,
            st.generation,
            st.access_override_pending,
            st.profile.clone(),
        )
    };
    let release = |sid: &str| {
        if let Some(st) = SESSIONS.lock().get_mut(sid) {
            st.busy = false;
        }
    };

    let (conn, generation) = match host.ensure().await {
        Ok(v) => v,
        Err(e) => {
            release(session_id);
            return Err(e);
        }
    };

    // the private process was respawned since this session's route was set →
    // resume the thread (routes die with the process, re-register below)
    if gen_stored != generation {
        match host::resume_thread(&conn, thread_resume_params(&thread_id, &profile)).await {
            Ok(_) => {}
            Err(host::ResumeError::ThreadNotFound(_)) => {
                match conn
                    .request(
                        "thread/start",
                        thread_start_params(&profile),
                        host::THREAD_TIMEOUT_MS,
                    )
                    .await
                {
                    Ok(res) => match res.pointer("/thread/id").and_then(|v| v.as_str()) {
                        Some(tid) => {
                            thread_id = tid.to_string();
                            if let Some(st) = SESSIONS.lock().get_mut(session_id) {
                                st.thread_id = Some(thread_id.clone());
                            }
                            emit_session_event(
                                app,
                                session_id,
                                "warning",
                                json!({ "message": "the previous session process is gone and its history could not be restored — continuing in a fresh thread" }),
                            );
                        }
                        None => {
                            release(session_id);
                            return Err("restarting the lost thread returned no id".into());
                        }
                    },
                    Err(e) => {
                        release(session_id);
                        return Err(format!("restarting the lost thread failed: {e}"));
                    }
                }
            }
            Err(host::ResumeError::Other(m)) => {
                release(session_id);
                return Err(format!("resuming the session after a restart failed: {m}"));
            }
        }
        conn.register_thread(&thread_id, sink.clone());
        if let Some(st) = SESSIONS.lock().get_mut(session_id) {
            st.generation = generation;
        }
    }

    let params = turn_params(&thread_id, text, &profile, override_pending);
    match conn
        .request("turn/start", params, host::RPC_TIMEOUT_MS)
        .await
    {
        Ok(res) => {
            let turn_id = res
                .pointer("/turn/id")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            if let Some(st) = SESSIONS.lock().get_mut(session_id) {
                st.current_turn_id = turn_id.clone();
                if override_pending {
                    st.access_override_pending = false;
                }
            }
            Ok(json!({ "turn_id": turn_id }))
        }
        Err(e) => {
            release(session_id);
            Err(format!("turn/start failed: {e}"))
        }
    }
}

/// Interrupt the session's running turn (turn/completed with status
/// "interrupted" follows over the event stream).
pub async fn session_interrupt(session_id: &str) -> Result<(), String> {
    let (host, thread_id, turn_id) = {
        let sessions = SESSIONS.lock();
        let st = sessions
            .get(session_id)
            .ok_or_else(|| format!("unknown vibe session \"{session_id}\""))?;
        let turn_id = st
            .current_turn_id
            .clone()
            .ok_or("no turn is running in this session")?;
        let thread_id = st.thread_id.clone().ok_or("this session has no thread")?;
        (st.host.clone(), thread_id, turn_id)
    };
    let conn = host
        .alive()
        .await
        .ok_or("the session process is not running")?;
    conn.request(
        "turn/interrupt",
        json!({ "threadId": thread_id, "turnId": turn_id }),
        host::RPC_TIMEOUT_MS,
    )
    .await
    .map(|_| ())
}

/// Answer a pending approval — `decision` ∈ accept | acceptForSession |
/// decline | cancel — resolving the blocked server request.
pub async fn session_respond_approval(
    session_id: &str,
    approval_id: &str,
    decision: &str,
) -> Result<(), String> {
    if !matches!(decision, "accept" | "acceptForSession" | "decline" | "cancel") {
        return Err(format!(
            "unknown approval decision \"{decision}\" (accept|acceptForSession|decline|cancel)"
        ));
    }
    let responder = {
        let mut sessions = SESSIONS.lock();
        let st = sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("unknown vibe session \"{session_id}\""))?;
        st.pending_approvals
            .remove(approval_id)
            .ok_or_else(|| format!("no pending approval \"{approval_id}\" in this session"))?
    };
    responder.ok(&json!({ "decision": decision }));
    Ok(())
}

/// Change the session's access mode. Takes effect on the NEXT turn (a per-turn
/// sandbox/approval override).
pub async fn session_set_access(session_id: &str, access: &str) -> Result<(), String> {
    let access = Access::parse(access)?;
    let mut sessions = SESSIONS.lock();
    let st = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("unknown vibe session \"{session_id}\""))?;
    if st.profile.access != access {
        st.profile.access = access;
        st.access_override_pending = true;
    }
    Ok(())
}

/// Change the session's model / reasoning effort. Takes effect on the NEXT turn
/// (both are per-turn overrides that stick — no fresh thread needed). Empty
/// strings clear the override back to the user's codex default.
pub async fn session_set_model_effort(
    session_id: &str,
    model: Option<String>,
    effort: Option<String>,
) -> Result<(), String> {
    let mut sessions = SESSIONS.lock();
    let st = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("unknown vibe session \"{session_id}\""))?;
    st.profile.model = model.filter(|s| !s.is_empty());
    st.profile.effort = effort.filter(|s| !s.is_empty());
    Ok(())
}

/// Close a session: best-effort interrupt a running turn, cancel every pending
/// approval, unregister the thread and drop the registry entry — dropping it
/// drops the private ProcessHost, ending the child (stdin close + kill_on_drop)
/// and, once its sink is gone, the dispatcher task.
pub async fn session_close(session_id: &str) -> Result<(), String> {
    let Some(mut st) = SESSIONS.lock().remove(session_id) else {
        return Ok(()); // already gone — idempotent
    };
    // best-effort interrupt the live turn
    if let (Some(thread_id), Some(turn_id)) = (st.thread_id.clone(), st.current_turn_id.clone()) {
        if let Some(conn) = st.host.alive().await {
            let _ = conn
                .request(
                    "turn/interrupt",
                    json!({ "threadId": thread_id, "turnId": turn_id }),
                    host::RPC_TIMEOUT_MS,
                )
                .await;
        }
    }
    // answer every blocked approval so the child doesn't hang before it exits
    for (_id, responder) in st.pending_approvals.drain() {
        responder.ok(&json!({ "decision": "cancel" }));
    }
    if let Some(thread_id) = &st.thread_id {
        if let Some(conn) = st.host.alive().await {
            conn.unregister_thread(thread_id);
        }
    }
    // `st` drops here → private ProcessHost + sink drop → child exits, dispatcher ends
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex::protocol::{parse_line, Incoming};

    fn notif(line: &str) -> (String, Value) {
        match parse_line(line) {
            Some(Incoming::Notification { method, params }) => (method, params),
            other => panic!("expected Notification, got {other:?}"),
        }
    }

    // fixture lines captured from real codex 0.142.5 (same shapes as protocol.rs)
    const FIX_DELTA: &str = r#"{"method":"item/agentMessage/delta","params":{"threadId":"t","turnId":"tn","itemId":"msg_1","delta":"He"}}"#;
    const FIX_CMD_STARTED: &str = r#"{"method":"item/started","params":{"item":{"type":"commandExecution","id":"call_1","command":"/bin/zsh -lc 'ls'","cwd":"/tmp","status":"inProgress","commandActions":[{"type":"listFiles","command":"ls","path":null}],"aggregatedOutput":null,"exitCode":null,"durationMs":null},"threadId":"t","turnId":"tn","startedAtMs":1}}"#;
    const FIX_CMD_COMPLETED: &str = r#"{"method":"item/completed","params":{"item":{"type":"commandExecution","id":"call_1","command":"/bin/zsh -lc 'ls'","cwd":"/tmp","status":"completed","aggregatedOutput":"total 8\n","exitCode":0,"durationMs":3},"threadId":"t","turnId":"tn","completedAtMs":2}}"#;
    const FIX_FILECHANGE_COMPLETED: &str = r#"{"method":"item/completed","params":{"item":{"type":"fileChange","id":"call_2","changes":[{"path":"/tmp/hello.txt","kind":{"type":"add"},"diff":"hi\n"}],"status":"completed"},"threadId":"t","turnId":"tn","completedAtMs":3}}"#;
    const FIX_AGENT_STARTED: &str = r#"{"method":"item/started","params":{"item":{"type":"agentMessage","id":"msg_1","text":"","phase":null},"threadId":"t","turnId":"tn","startedAtMs":1}}"#;
    const FIX_AGENT_COMPLETED: &str = r#"{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"msg_1","text":"Done.","phase":"final_answer"},"threadId":"t","turnId":"tn","completedAtMs":9}}"#;
    const FIX_TURN_DIFF: &str = r#"{"method":"turn/diff/updated","params":{"threadId":"t","turnId":"tn","diff":"diff --git a/x b/x\n"}}"#;
    const FIX_TOKEN_USAGE: &str = r#"{"method":"thread/tokenUsage/updated","params":{"threadId":"t","turnId":"tn","tokenUsage":{"total":{"totalTokens":15043,"inputTokens":14992,"cachedInputTokens":4992,"outputTokens":51,"reasoningOutputTokens":0},"last":{"totalTokens":15043,"inputTokens":14992,"cachedInputTokens":4992,"outputTokens":51,"reasoningOutputTokens":0},"modelContextWindow":258400}}}"#;
    const FIX_TURN_DONE: &str = r#"{"method":"turn/completed","params":{"threadId":"t","turn":{"id":"tn","status":"completed","error":null}}}"#;
    const FIX_TURN_INTERRUPTED: &str = r#"{"method":"turn/completed","params":{"threadId":"t","turn":{"id":"tn","status":"interrupted","error":null}}}"#;
    const FIX_TURN_FAILED: &str = r#"{"method":"turn/completed","params":{"threadId":"t","turn":{"id":"tn","status":"failed","error":{"message":"context window exceeded"}}}}"#;
    const FIX_TURN_STARTED: &str = r#"{"method":"turn/started","params":{"threadId":"t","turn":{"id":"tn","status":"inProgress"}}}"#;
    const FIX_CMD_APPROVAL: &str = r#"{"method":"item/commandExecution/requestApproval","id":0,"params":{"threadId":"t","turnId":"tn","itemId":"call_3","reason":"allow touch?","command":"/bin/zsh -lc 'touch x'","cwd":"/tmp","availableDecisions":["accept","cancel"]}}"#;

    #[test]
    fn access_mapping_matches_wire_strings() {
        assert_eq!(Access::Workspace.sandbox_mode(), "workspace-write");
        assert_eq!(Access::Workspace.approval_policy(), "on-request");
        assert_eq!(Access::Full.sandbox_mode(), "danger-full-access");
        assert_eq!(Access::Full.approval_policy(), "never");
        assert_eq!(Access::Workspace.sandbox_policy()["type"], "workspaceWrite");
        assert_eq!(Access::Full.sandbox_policy()["type"], "dangerFullAccess");
        assert!(Access::parse("workspace").is_ok());
        assert!(Access::parse("full").is_ok());
        assert!(Access::parse("nonsense").is_err());
    }

    #[test]
    fn thread_and_turn_params_carry_the_right_fields() {
        let profile = SessionProfile {
            cwd: "/repo".into(),
            model: Some("gpt-5.5".into()),
            effort: Some("high".into()),
            access: Access::Workspace,
        };
        let start = thread_start_params(&profile);
        assert_eq!(start["cwd"], "/repo");
        assert_eq!(start["sandbox"], "workspace-write");
        assert_eq!(start["approvalPolicy"], "on-request");
        assert_eq!(start["model"], "gpt-5.5");
        // the standard Codex harness stays intact
        assert!(start.get("dynamicTools").is_none());
        assert!(start.get("developerInstructions").is_none());
        // effort is a per-turn override, not a thread/start field
        assert!(start.get("effort").is_none());

        // ordinary turn: model + effort ride along, no sandbox override on wire
        let plain = turn_params("tn", "hi", &profile, false);
        assert_eq!(plain["threadId"], "tn");
        assert_eq!(plain["input"][0]["text"], "hi");
        assert_eq!(plain["model"], "gpt-5.5");
        assert_eq!(plain["effort"], "high");
        assert!(plain.get("sandboxPolicy").is_none());
        assert!(plain.get("approvalPolicy").is_none());

        // access changed: the object-form override is attached
        let overridden = turn_params("tn", "hi", &profile, true);
        assert_eq!(overridden["sandboxPolicy"]["type"], "workspaceWrite");
        assert_eq!(overridden["approvalPolicy"], "on-request");

        // no model/effort set → neither field is on the wire
        let bare = SessionProfile {
            cwd: "/repo".into(),
            model: None,
            effort: None,
            access: Access::Workspace,
        };
        let bare_turn = turn_params("tn", "hi", &bare, false);
        assert!(bare_turn.get("model").is_none());
        assert!(bare_turn.get("effort").is_none());
    }

    #[test]
    fn maps_agent_message_stream() {
        let (m, p) = notif(FIX_DELTA);
        let (kind, data) = map_notification(&m, &p).unwrap();
        assert_eq!(kind, "delta");
        assert_eq!(data["item_id"], "msg_1");
        assert_eq!(data["text"], "He");

        // commandExecution output delta (live-confirmed in the spike)
        let out = r#"{"method":"item/commandExecution/outputDelta","params":{"threadId":"t","turnId":"tn","itemId":"call_1","delta":"a\n"}}"#;
        let (m, p) = notif(out);
        let (kind, data) = map_notification(&m, &p).unwrap();
        assert_eq!(kind, "item_output_delta");
        assert_eq!(data["item_id"], "call_1");
        assert_eq!(data["delta"], "a\n");

        // agentMessage item/started is swallowed — the delta drives the bubble
        let (m, p) = notif(FIX_AGENT_STARTED);
        assert!(map_notification(&m, &p).is_none());

        // agentMessage item/completed becomes a `message`, not `item_completed`
        let (m, p) = notif(FIX_AGENT_COMPLETED);
        let (kind, data) = map_notification(&m, &p).unwrap();
        assert_eq!(kind, "message");
        assert_eq!(data["item_id"], "msg_1");
        assert_eq!(data["text"], "Done.");
        assert_eq!(data["phase"], "final_answer");
    }

    #[test]
    fn maps_command_and_file_items() {
        let (m, p) = notif(FIX_CMD_STARTED);
        let (kind, data) = map_notification(&m, &p).unwrap();
        assert_eq!(kind, "item_started");
        assert_eq!(data["item"]["type"], "commandExecution");
        assert_eq!(data["item"]["status"], "inProgress");
        assert_eq!(data["item"]["command"], "/bin/zsh -lc 'ls'");

        let (m, p) = notif(FIX_CMD_COMPLETED);
        let (kind, data) = map_notification(&m, &p).unwrap();
        assert_eq!(kind, "item_completed");
        assert_eq!(data["item"]["exitCode"], 0);
        assert_eq!(data["item"]["aggregatedOutput"], "total 8\n");

        let (m, p) = notif(FIX_FILECHANGE_COMPLETED);
        let (kind, data) = map_notification(&m, &p).unwrap();
        assert_eq!(kind, "item_completed");
        assert_eq!(data["item"]["type"], "fileChange");
        assert_eq!(data["item"]["changes"][0]["kind"]["type"], "add");
        assert_eq!(data["item"]["changes"][0]["diff"], "hi\n");
    }

    #[test]
    fn maps_diff_tokens_and_turn_lifecycle() {
        let (m, p) = notif(FIX_TURN_STARTED);
        let (kind, data) = map_notification(&m, &p).unwrap();
        assert_eq!(kind, "turn_started");
        assert_eq!(data["turn_id"], "tn");

        let (m, p) = notif(FIX_TURN_DIFF);
        let (kind, data) = map_notification(&m, &p).unwrap();
        assert_eq!(kind, "turn_diff");
        assert!(data["diff"].as_str().unwrap().starts_with("diff --git"));

        let (m, p) = notif(FIX_TOKEN_USAGE);
        let (kind, data) = map_notification(&m, &p).unwrap();
        assert_eq!(kind, "token_usage");
        assert_eq!(data["total"]["totalTokens"], 15043);
        assert_eq!(data["last"]["outputTokens"], 51);
        assert_eq!(data["modelContextWindow"], 258400);

        let (m, p) = notif(FIX_TURN_DONE);
        assert_eq!(map_notification(&m, &p).unwrap(), ("turn_completed", json!({ "status": "completed" })));

        let (m, p) = notif(FIX_TURN_INTERRUPTED);
        assert_eq!(map_notification(&m, &p).unwrap(), ("turn_completed", json!({ "status": "interrupted" })));

        let (m, p) = notif(FIX_TURN_FAILED);
        let (kind, data) = map_notification(&m, &p).unwrap();
        assert_eq!(kind, "turn_failed");
        assert_eq!(data["error"], "context window exceeded");
    }

    #[test]
    fn approval_request_is_classified_and_passed_through() {
        assert_eq!(approval_kind("item/commandExecution/requestApproval"), Some("command"));
        assert_eq!(approval_kind("item/fileChange/requestApproval"), Some("fileChange"));
        assert_eq!(approval_kind("item/tool/requestUserInput"), None);

        // the whole request (itemId, reason, command, availableDecisions) must
        // survive verbatim so the UI can render + look up the diff by itemId
        let params = match parse_line(FIX_CMD_APPROVAL) {
            Some(Incoming::ServerRequest { params, .. }) => params,
            other => panic!("expected ServerRequest, got {other:?}"),
        };
        assert_eq!(params["itemId"], "call_3");
        assert_eq!(params["command"], "/bin/zsh -lc 'touch x'");
        assert!(params["availableDecisions"].is_array());
    }

    #[test]
    fn command_output_is_capped_on_the_tail() {
        let big = "x".repeat(MAX_AGG_OUTPUT + 5_000);
        let item = json!({ "type": "commandExecution", "id": "c", "aggregatedOutput": big });
        let normalized = normalize_item(&item);
        let out = normalized["aggregatedOutput"].as_str().unwrap();
        assert!(out.len() < MAX_AGG_OUTPUT + 200, "capped near the limit");
        assert!(out.starts_with("…["), "carries the truncation marker");
        assert!(out.ends_with('x'));

        // short output is untouched; unknown item types pass through
        let small = json!({ "type": "commandExecution", "id": "c", "aggregatedOutput": "ok\n" });
        assert_eq!(normalize_item(&small)["aggregatedOutput"], "ok\n");
        let other = json!({ "type": "webSearch", "id": "w", "query": "rust" });
        assert_eq!(normalize_item(&other), other);
    }

    fn cap_boundary_str() -> String {
        // multibyte tail must not split a char
        let mut s = "a".repeat(MAX_AGG_OUTPUT);
        s.push_str("üüü");
        s
    }

    #[test]
    fn cap_output_respects_char_boundaries() {
        let capped = cap_output(&cap_boundary_str(), MAX_AGG_OUTPUT);
        assert!(capped.is_char_boundary(0));
        // round-trips as valid UTF-8 (would have panicked on a bad boundary)
        assert!(capped.contains('ü'));
    }

    // ---- session spike (Vibe Mode Phase 2) ----
    //
    // Live verification of the three open Phase-1 questions against the REAL
    // codex CLI, at the host layer (no AppHandle needed): (a) turn/interrupt →
    // turn/completed status "interrupted"; (b) a declined approval and how the
    // turn proceeds; (c) whether item/commandExecution/outputDelta (or a
    // growing item/updated) streams while a command runs. Ignored by default
    // (needs codex + login + network — CI stays green); run with:
    //   cargo test sessions_spike -- --ignored --nocapture

    use crate::codex::host::{ResumeError, THREAD_TIMEOUT_MS, RPC_TIMEOUT_MS};
    use std::time::Duration;

    #[tokio::test]
    #[ignore]
    async fn sessions_spike() {
        // (a) INTERRUPT — full access so a `sleep` runs approval-free
        {
            println!("\n==== (a) interrupt ====");
            let profile = SessionProfile {
                cwd: std::env::temp_dir().to_string_lossy().into_owned(),
                model: None,
                effort: None,
                access: Access::Full,
            };
            let host = ProcessHost::new();
            let (conn, _gen) = host.ensure().await.expect("spawn");
            let started = conn
                .request("thread/start", thread_start_params(&profile), THREAD_TIMEOUT_MS)
                .await
                .expect("thread/start");
            let thread_id = started.pointer("/thread/id").and_then(|v| v.as_str()).unwrap().to_string();
            let (tx, mut rx) = mpsc::unbounded_channel();
            conn.register_thread(&thread_id, tx);
            conn.request(
                "turn/start",
                turn_params(&thread_id, "Run the shell command `sleep 30` and tell me when it finishes.", &profile, false),
                RPC_TIMEOUT_MS,
            )
            .await
            .expect("turn/start");

            // wait until the command is actually running, then interrupt
            let mut turn_id: Option<String> = None;
            let mut interrupted_sent = false;
            let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
            let status = loop {
                let ev = tokio::time::timeout_at(deadline, rx.recv()).await.expect("timeout").expect("closed");
                match ev {
                    ThreadEvent::Notification { method, params } => {
                        if method == "turn/started" {
                            turn_id = params.pointer("/turn/id").and_then(|v| v.as_str()).map(str::to_string);
                        }
                        if method == "item/started"
                            && params.pointer("/item/type").and_then(|v| v.as_str()) == Some("commandExecution")
                            && !interrupted_sent
                        {
                            if let Some(tid) = &turn_id {
                                println!("[a] command running — sending turn/interrupt");
                                conn.request("turn/interrupt", json!({ "threadId": thread_id, "turnId": tid }), RPC_TIMEOUT_MS)
                                    .await
                                    .expect("turn/interrupt");
                                interrupted_sent = true;
                            }
                        }
                        if method == "turn/completed" {
                            break params.pointer("/turn/status").and_then(|v| v.as_str()).unwrap_or("?").to_string();
                        }
                    }
                    ThreadEvent::Request { responder, .. } => responder.ok(&json!({ "decision": "accept" })),
                    ThreadEvent::Exited => panic!("[a] process exited mid-spike"),
                }
            };
            println!("[a] interrupt → turn status = {status}");
            assert_eq!(status, "interrupted", "(a) turn/interrupt must yield status interrupted");
        }

        // (b) DECLINE — workspace + on-request only gates commands that
        // ESCALATE past the sandbox (an in-workspace `touch` runs approval-free,
        // unlike Phase-1's `untrusted` probe); writing OUTSIDE the workspace
        // (into HOME) forces the on-request command approval.
        {
            println!("\n==== (b) decline ====");
            let cwd = std::env::temp_dir().join("swarmz-sessions-spike-b");
            std::fs::create_dir_all(&cwd).ok();
            let outside = dirs::home_dir().unwrap().join("swarmz_spike_declined.marker");
            std::fs::remove_file(&outside).ok();
            let profile = SessionProfile {
                cwd: cwd.to_string_lossy().into_owned(),
                model: None,
                effort: None,
                access: Access::Workspace,
            };
            let host = ProcessHost::new();
            let (conn, _g) = host.ensure().await.expect("spawn");
            let started = conn
                .request("thread/start", thread_start_params(&profile), THREAD_TIMEOUT_MS)
                .await
                .expect("thread/start");
            let thread_id = started.pointer("/thread/id").and_then(|v| v.as_str()).unwrap().to_string();
            let (tx, mut rx) = mpsc::unbounded_channel();
            conn.register_thread(&thread_id, tx);
            let prompt = format!(
                "Run the shell command `touch {}` — it writes OUTSIDE this workspace, in the home directory — and report the result.",
                outside.display()
            );
            conn.request(
                "turn/start",
                turn_params(&thread_id, &prompt, &profile, false),
                RPC_TIMEOUT_MS,
            )
            .await
            .expect("turn/start");

            let mut declined = false;
            let mut cmd_status: Option<String> = None;
            let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
            let status = loop {
                let ev = tokio::time::timeout_at(deadline, rx.recv()).await.expect("timeout").expect("closed");
                match ev {
                    ThreadEvent::Request { method, params, responder } => {
                        println!("[b] server request {method} — reason={:?}", params.get("reason").and_then(|v| v.as_str()));
                        if approval_kind(&method).is_some() {
                            responder.ok(&json!({ "decision": "decline" }));
                            declined = true;
                        } else {
                            responder.error(-32601, "unsupported");
                        }
                    }
                    ThreadEvent::Notification { method, params } => {
                        if method == "item/completed"
                            && params.pointer("/item/type").and_then(|v| v.as_str()) == Some("commandExecution")
                        {
                            cmd_status = params.pointer("/item/status").and_then(|v| v.as_str()).map(str::to_string);
                            println!("[b] commandExecution completed status={cmd_status:?}");
                        }
                        if method == "turn/completed" {
                            break params.pointer("/turn/status").and_then(|v| v.as_str()).unwrap_or("?").to_string();
                        }
                    }
                    ThreadEvent::Exited => panic!("[b] process exited mid-spike"),
                }
            };
            println!("[b] declined={declined} cmd_status={cmd_status:?} turn_status={status}");
            assert!(declined, "(b) a command approval must have been requested");
            assert!(!outside.is_file(), "(b) the declined command must NOT have run");
            std::fs::remove_file(&outside).ok();
            println!("[b] turn continued to status={status} after the decline");
        }

        // (c) OUTPUT STREAMING — does outputDelta / a growing item/updated fire?
        {
            println!("\n==== (c) command output streaming ====");
            let profile = SessionProfile {
                cwd: std::env::temp_dir().to_string_lossy().into_owned(),
                model: None,
                effort: None,
                access: Access::Full,
            };
            let host = ProcessHost::new();
            let (conn, _g) = host.ensure().await.expect("spawn");
            let started = conn
                .request("thread/start", thread_start_params(&profile), THREAD_TIMEOUT_MS)
                .await
                .expect("thread/start");
            let thread_id = started.pointer("/thread/id").and_then(|v| v.as_str()).unwrap().to_string();
            let (tx, mut rx) = mpsc::unbounded_channel();
            conn.register_thread(&thread_id, tx);
            conn.request(
                "turn/start",
                turn_params(&thread_id, "Run exactly this shell command and report its output: sh -c 'echo a; sleep 2; echo b'", &profile, false),
                RPC_TIMEOUT_MS,
            )
            .await
            .expect("turn/start");

            let mut output_deltas = 0usize;
            let mut item_updates = 0usize;
            let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
            loop {
                let ev = tokio::time::timeout_at(deadline, rx.recv()).await.expect("timeout").expect("closed");
                match ev {
                    ThreadEvent::Request { responder, .. } => responder.ok(&json!({ "decision": "accept" })),
                    ThreadEvent::Notification { method, .. } => {
                        if method == "item/commandExecution/outputDelta" {
                            output_deltas += 1;
                        }
                        if method == "item/updated" {
                            item_updates += 1;
                        }
                        if method == "turn/completed" {
                            break;
                        }
                    }
                    ThreadEvent::Exited => panic!("[c] process exited mid-spike"),
                }
            }
            println!("[c] outputDelta notifications: {output_deltas}, item/updated notifications: {item_updates}");
            // observational: whether streaming fires informs Phase 3, not a hard assert
        }

        // sanity: a bogus resume still classifies as ThreadNotFound (the fallback cue)
        {
            let profile = SessionProfile {
                cwd: std::env::temp_dir().to_string_lossy().into_owned(),
                model: None,
                effort: None,
                access: Access::Full,
            };
            let host = ProcessHost::new();
            let (conn, _g) = host.ensure().await.expect("spawn");
            let bogus = host::resume_thread(
                &conn,
                thread_resume_params("019f0000-0000-7000-8000-000000000000", &profile),
            )
            .await;
            assert!(matches!(bogus, Err(ResumeError::ThreadNotFound(_))), "bogus resume must classify as ThreadNotFound");
        }
    }
}
