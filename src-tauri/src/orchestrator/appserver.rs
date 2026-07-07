// Orchestrator brain (Phase 3): ONE long-lived `codex app-server` child
// process speaking newline-delimited JSON-RPC (protocol.rs) over stdio.
// Chats map 1:1 to app-server THREADS; the tool registry is declared as
// experimental DYNAMIC TOOLS on thread/start, and Codex calls back via
// `item/tool/call` server requests which we answer through the Phase-2 bus
// (`orchestrator::run_tool` → webview executors).
//
// Layers, bottom to top:
//   - `Client`  — process + framing + request-id map. Tauri-free; the
//     #[ignore]d `appserver_spike` test drives it against the real codex.
//   - dispatcher — consumes `ServerEvent`s: answers `item/tool/call`,
//     auto-DECLINES approval requests (must not occur under read-only
//     sandbox + approvalPolicy "never"), maps notifications to
//     `orchestrator://chat-event` emissions and turn-completion wakeups.
//   - chat API — `chat_start` / `chat_send` / `chat_interrupt` /
//     `chat_resume` / `chat_status`, exposed as Tauri commands in lib.rs.
//
// Lifecycle: lazy spawn on first use; a died process is detected via the
// reader-EOF `alive` flag and respawned on the next call — in-flight
// requests fail with a clear error and running turns resolve as failed.
// After a respawn, chats transparently `thread/resume` their thread before
// the next turn (rollouts persist on disk; dynamic tools are persisted and
// restored by codex — verified on 0.142.5).

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};

use super::protocol::{self, Incoming};

/// Budget for ordinary RPCs (initialize, account/read, turn/interrupt, and
/// the immediate turn/start acknowledgement — NOT the turn itself).
const RPC_TIMEOUT_MS: u64 = 30_000;
/// thread/start and thread/resume may boot MCP servers from the user's
/// codex config before answering.
const THREAD_TIMEOUT_MS: u64 = 120_000;
/// A whole orchestrator turn: model latency + any number of tool roundtrips
/// (create_panes alone budgets 120 s).
const TURN_TIMEOUT_MS: u64 = 30 * 60 * 1_000;

/// The dynamic-tools protocol is experimental; this is the version the
/// integration spike verified end-to-end. Mentioned in the version guard.
const KNOWN_GOOD_VERSION: &str = "0.142.5";

/// System instructions for the orchestrator thread, delivered as
/// `developerInstructions` on thread/start (keeps codex's own base prompt —
/// and with it the tool harness — intact, unlike `baseInstructions`).
pub const ORCHESTRATOR_INSTRUCTIONS: &str = r#"You are the SwarmZ Orchestrator — a team lead over a fleet of terminal AI agents (Claude Code, Codex and plain shells) running as panes in the SwarmZ app. You act ONLY through your SwarmZ tools (fleet_snapshot, read_transcript, read_project_docs, read_notes, git_status, list_projects, list_blueprints, prompt_pane, create_panes, create_workspace); you never edit files or run commands yourself, and you never use shell access, scripts or any non-SwarmZ tools that may appear available — your job is orchestration, the agents do the work.

## Context discipline
- A fresh one-line fleet summary is prepended to every user message; call fleet_snapshot only when you need the details behind it (pane ids, per-pane activity, projects, models). It is cheap and always current.
- Read a project's docs (read_project_docs) at most once per project per conversation; remember what you learned.
- Read transcripts only for panes the question is actually about, with small tails (the default of 20 messages is usually plenty).

## Prompting the agents
- codex panes expect direct, fully specified, self-contained orders: name the files, the constraints and the definition of done — leave no room for interpretation.
- claude panes get the goal, the relevant context and the constraints; Claude can be trusted to think along and fill gaps sensibly.
- shell panes only ever receive shell commands, never prose.

## Worktrees
Request worktree:true in create_panes only when multiple agents will WRITE in the same repository concurrently. Reviews and read-only tasks run as plain panes in the repo itself. An explicit user wish always overrides this rule.

## Delivery contract
- An explicit user order is your approval to execute it fully — do not ask for per-step confirmations.
- Never initiate outward-facing actions (push, PR, publish, anything leaving the machine) unless the user explicitly ordered them. You have no outward tools in this version; do not route around that via agent panes unprompted.
- prompt_pane submits by default (submit:true). If a pane is busy, prefer waiting or telling the user instead of queueing text into it — unless the user asked you to queue.

## Style
Answer the user in the language they use (this user usually writes German). Be compact: status lines and short paragraphs, not essays. Say what you did, what is running where, and what you are waiting on."#;

// ---------------------------------------------------------------------------
// Client — process + framing + id map (tauri-free, spike-testable)
// ---------------------------------------------------------------------------

/// Events the reader task hands to the dispatcher.
#[derive(Debug)]
pub enum ServerEvent {
    Request {
        id: Value,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
    /// stdout closed — the process is gone. Pending requests were failed.
    Exited,
}

/// Our in-flight requests, keyed by the numeric id we sent.
#[derive(Default)]
pub struct PendingRpc {
    inner: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
}

impl PendingRpc {
    fn register(&self, id: u64) -> oneshot::Receiver<Result<Value, String>> {
        let (tx, rx) = oneshot::channel();
        self.inner.lock().insert(id, tx);
        rx
    }

    fn remove(&self, id: u64) {
        self.inner.lock().remove(&id);
    }

    fn resolve(&self, id: u64, result: Result<Value, String>) -> bool {
        match self.inner.lock().remove(&id) {
            Some(tx) => tx.send(result).is_ok(),
            None => false,
        }
    }

    /// Fail every in-flight request (process died).
    fn fail_all(&self, reason: &str) {
        for (_, tx) in self.inner.lock().drain() {
            let _ = tx.send(Err(reason.to_string()));
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.inner.lock().len()
    }
}

/// Handle to one running `codex app-server` process.
pub struct Client {
    stdin_tx: mpsc::UnboundedSender<String>,
    pending: Arc<PendingRpc>,
    next_id: AtomicU64,
    alive: Arc<AtomicBool>,
}

impl Client {
    /// Spawn `<program> app-server` and wire the stdio pumps. Server-initiated
    /// requests and notifications go to `events`; responses resolve the
    /// pending map. Must run inside a tokio runtime.
    pub async fn spawn(
        program: &str,
        events: mpsc::UnboundedSender<ServerEvent>,
    ) -> Result<Self, String> {
        let mut child = Command::new(program)
            .arg("app-server")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("failed to start `{program} app-server`: {e}"))?;
        let mut stdin = child.stdin.take().ok_or("app-server: no stdin")?;
        let stdout = child.stdout.take().ok_or("app-server: no stdout")?;
        let stderr = child.stderr.take();

        let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<String>();
        let pending = Arc::new(PendingRpc::default());
        let alive = Arc::new(AtomicBool::new(true));

        // writer: serialize all outgoing lines through one task (ordering)
        tokio::spawn(async move {
            while let Some(line) = stdin_rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err()
                    || stdin.write_all(b"\n").await.is_err()
                    || stdin.flush().await.is_err()
                {
                    break;
                }
            }
            // channel closed (Client dropped) → stdin drops → EOF → codex exits
        });

        // stderr → log lines (codex logs there; useful when things go wrong)
        if let Some(err) = stderr {
            tokio::spawn(async move {
                let mut lines = BufReader::new(err).lines();
                while let Ok(Some(l)) = lines.next_line().await {
                    eprintln!("[codex app-server] {l}");
                }
            });
        }

        // reader: classify each line; owns the child for reaping on EOF
        {
            let pending = pending.clone();
            let alive = alive.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    match protocol::parse_line(&line) {
                        Some(Incoming::Response { id, result }) => {
                            if !pending.resolve(id, result) {
                                eprintln!("[orchestrator] app-server response for unknown id {id} — ignored");
                            }
                        }
                        Some(Incoming::ServerRequest { id, method, params }) => {
                            let _ = events.send(ServerEvent::Request { id, method, params });
                        }
                        Some(Incoming::Notification { method, params }) => {
                            let _ = events.send(ServerEvent::Notification { method, params });
                        }
                        None => {} // unknown/unparseable line: ignore silently
                    }
                }
                alive.store(false, Ordering::SeqCst);
                pending.fail_all("codex app-server exited");
                let _ = events.send(ServerEvent::Exited);
                let _ = child.wait().await; // reap
            });
        }

        Ok(Client {
            stdin_tx,
            pending,
            next_id: AtomicU64::new(1),
            alive,
        })
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// One request/response roundtrip with a timeout.
    pub async fn request(
        &self,
        method: &str,
        params: Value,
        timeout_ms: u64,
    ) -> Result<Value, String> {
        if !self.is_alive() {
            return Err("codex app-server is not running".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let rx = self.pending.register(id);
        if self
            .stdin_tx
            .send(protocol::request_line(id, method, &params))
            .is_err()
        {
            self.pending.remove(id);
            return Err("codex app-server stdin closed".into());
        }
        match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(format!("{method}: response channel dropped")),
            Err(_) => {
                self.pending.remove(id);
                Err(format!("{method} timed out after {timeout_ms} ms"))
            }
        }
    }

    pub fn notify(&self, method: &str) {
        let _ = self.stdin_tx.send(protocol::notification_line(method));
    }

    /// Answer a server-initiated request.
    pub fn respond(&self, id: &Value, result: &Value) {
        let _ = self.stdin_tx.send(protocol::response_line(id, result));
    }

    pub fn respond_error(&self, id: &Value, code: i64, message: &str) {
        let _ = self
            .stdin_tx
            .send(protocol::error_response_line(id, code, message));
    }
}

/// initialize (experimentalApi — required for dynamicTools) + `initialized`.
/// Returns the server's userAgent (carries the codex version).
pub async fn handshake(client: &Client) -> Result<String, String> {
    let res = client
        .request(
            "initialize",
            json!({
                "clientInfo": {
                    "name": "SwarmZ",
                    "title": "SwarmZ Orchestrator",
                    "version": env!("CARGO_PKG_VERSION"),
                },
                "capabilities": { "experimentalApi": true },
            }),
            RPC_TIMEOUT_MS,
        )
        .await?;
    client.notify("initialized");
    Ok(res
        .get("userAgent")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string())
}

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
    /// Manager.generation at start/resume — a mismatch after a respawn
    /// triggers a transparent thread/resume before the next turn.
    generation: u64,
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
/// commands, so it lives outside the manager lock (plain mutex, no awaits
/// while held).
static SHARED: Lazy<Mutex<Shared>> = Lazy::new(Mutex::default);

#[derive(Default)]
struct Manager {
    client: Option<Arc<Client>>,
    codex_path: Option<String>,
    version: Option<String>,
    /// bumped per successful spawn+handshake — see ChatState.generation
    generation: u64,
    chat_counter: u64,
}

/// Process manager — tokio mutex because ensure_client awaits while holding
/// it (spawn + handshake, a few hundred ms; never a whole turn).
static MANAGER: Lazy<tokio::sync::Mutex<Manager>> = Lazy::new(Default::default);

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

/// Ensure a live, initialized app-server; (re)spawn lazily.
async fn ensure_client(app: &AppHandle, mgr: &mut Manager) -> Result<Arc<Client>, String> {
    if let Some(c) = &mgr.client {
        if c.is_alive() {
            return Ok(c.clone());
        }
    }
    let program = mgr
        .codex_path
        .clone()
        .unwrap_or_else(|| "codex".to_string());
    let (events_tx, events_rx) = mpsc::unbounded_channel();
    let client = Arc::new(Client::spawn(&program, events_tx).await?);
    spawn_dispatcher(app.clone(), client.clone(), events_rx);
    let version = handshake(&client)
        .await
        .map_err(|e| format!("codex app-server initialize failed: {e}"))?;
    mgr.version = Some(version);
    mgr.generation += 1;
    mgr.client = Some(client.clone());
    Ok(client)
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

/// thread/start params: neutral cwd (home), read-only sandbox, no approval
/// prompts (auto-declined anyway if one slips through), our instructions as
/// developer message, and the whole registry as dynamic tools.
fn thread_start_params() -> Value {
    json!({
        "cwd": home_dir_string(),
        "sandbox": "read-only",
        "approvalPolicy": "never",
        "developerInstructions": ORCHESTRATOR_INSTRUCTIONS,
        "dynamicTools": protocol::dynamic_tool_specs(),
    })
}

/// thread/resume params: dynamicTools are NOT re-declarable here — codex
/// persists and restores them from the thread rollout (verified on 0.142.5).
fn thread_resume_params(thread_id: &str) -> Value {
    json!({
        "threadId": thread_id,
        "cwd": home_dir_string(),
        "sandbox": "read-only",
        "approvalPolicy": "never",
        "developerInstructions": ORCHESTRATOR_INSTRUCTIONS,
    })
}

// ---------------------------------------------------------------------------
// Dispatcher — server requests + notifications → bus calls, events, wakeups
// ---------------------------------------------------------------------------

fn spawn_dispatcher(
    app: AppHandle,
    client: Arc<Client>,
    mut rx: mpsc::UnboundedReceiver<ServerEvent>,
) {
    tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            match ev {
                ServerEvent::Request { id, method, params } => {
                    handle_server_request(&app, &client, id, method, params);
                }
                ServerEvent::Notification { method, params } => {
                    handle_notification(&app, &method, &params);
                }
                ServerEvent::Exited => {
                    handle_exit(&app);
                }
            }
        }
    });
}

fn handle_server_request(
    app: &AppHandle,
    client: &Arc<Client>,
    id: Value,
    method: String,
    params: Value,
) {
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
            let client = client.clone();
            tokio::spawn(async move {
                let tool = params
                    .get("tool")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let args = protocol::normalize_tool_args(params.get("arguments"));
                if let Some(cid) = &chat_id {
                    emit_chat_event(
                        &app,
                        cid,
                        "tool_call",
                        json!({ "tool": tool, "args_summary": protocol::summarize_args(&args) }),
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
                client.respond(&id, &protocol::tool_call_response(&result));
            });
        }
        // Approvals must never occur (read-only sandbox + approvalPolicy
        // "never" + instructions) — if one arrives anyway: auto-DECLINE.
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            client.respond(&id, &json!({ "decision": "decline" }));
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
            client.respond_error(&id, -32601, "not supported by the SwarmZ orchestrator");
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
        _ => {} // everything else (token usage, item/started, …): ignore
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

fn normalize_path(p: Option<String>) -> Option<String> {
    p.and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() { None } else { Some(t) }
    })
}

fn register_chat(mgr: &mut Manager, thread_id: &str) -> String {
    let mut shared = SHARED.lock();
    if let Some(existing) = shared.thread_to_chat.get(thread_id) {
        let cid = existing.clone();
        if let Some(chat) = shared.chats.get_mut(&cid) {
            chat.generation = mgr.generation;
        }
        return cid;
    }
    mgr.chat_counter += 1;
    let chat_id = format!("chat-{}", mgr.chat_counter);
    shared
        .thread_to_chat
        .insert(thread_id.to_string(), chat_id.clone());
    shared.chats.insert(
        chat_id.clone(),
        ChatState {
            thread_id: thread_id.to_string(),
            generation: mgr.generation,
            ..Default::default()
        },
    );
    chat_id
}

/// Start a fresh orchestrator chat (thread/start with all dynamic tools).
pub async fn chat_start(app: &AppHandle, codex_path: Option<String>) -> Result<Value, String> {
    let mut mgr = MANAGER.lock().await;
    if codex_path.is_some() {
        // the frontend passes the current settings value on every call —
        // an empty string clears the override back to plain `codex`
        mgr.codex_path = normalize_path(codex_path);
    }
    let client = ensure_client(app, &mut mgr).await?;
    let version = mgr.version.clone();
    let res = client
        .request("thread/start", thread_start_params(), THREAD_TIMEOUT_MS)
        .await
        .map_err(|e| guard_dynamic_tools_error(e, version.as_deref()))?;
    let thread_id = res
        .pointer("/thread/id")
        .and_then(|v| v.as_str())
        .ok_or("thread/start: no thread id in response")?
        .to_string();
    let chat_id = register_chat(&mut mgr, &thread_id);
    Ok(json!({ "chat_id": chat_id, "thread_id": thread_id }))
}

/// Reopen an existing app-server thread as a chat (thread/resume — dynamic
/// tools are restored from the rollout by codex).
pub async fn chat_resume(app: &AppHandle, thread_id: &str) -> Result<Value, String> {
    let mut mgr = MANAGER.lock().await;
    let client = ensure_client(app, &mut mgr).await?;
    client
        .request(
            "thread/resume",
            thread_resume_params(thread_id),
            THREAD_TIMEOUT_MS,
        )
        .await?;
    let chat_id = register_chat(&mut mgr, thread_id);
    Ok(json!({ "chat_id": chat_id, "thread_id": thread_id }))
}

/// Send one user message; resolves with the turn's final assistant text once
/// the turn completes (progress streams via `orchestrator://chat-event`).
pub async fn chat_send(app: &AppHandle, chat_id: &str, text: &str) -> Result<Value, String> {
    let (client, generation) = {
        let mut mgr = MANAGER.lock().await;
        let client = ensure_client(app, &mut mgr).await?;
        (client, mgr.generation)
    };

    let (thread_id, needs_resume) = {
        let shared = SHARED.lock();
        let chat = shared
            .chats
            .get(chat_id)
            .ok_or_else(|| format!("unknown chat_id \"{chat_id}\" — start a chat first"))?;
        if chat.done_tx.is_some() {
            return Err("a turn is already running in this chat — interrupt it or wait".into());
        }
        (chat.thread_id.clone(), chat.generation != generation)
    };

    // the process was respawned since this chat started → resume its thread
    if needs_resume {
        client
            .request(
                "thread/resume",
                thread_resume_params(&thread_id),
                THREAD_TIMEOUT_MS,
            )
            .await
            .map_err(|e| format!("thread/resume after app-server restart failed: {e}"))?;
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

    match client
        .request(
            "turn/start",
            json!({
                "threadId": thread_id,
                "input": [{ "type": "text", "text": input_text }],
            }),
            RPC_TIMEOUT_MS,
        )
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
    let client = {
        let mgr = MANAGER.lock().await;
        match &mgr.client {
            Some(c) if c.is_alive() => c.clone(),
            _ => return Err("codex app-server is not running".into()),
        }
    };
    client
        .request(
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
    let mut mgr = MANAGER.lock().await;
    if codex_path.is_some() {
        mgr.codex_path = normalize_path(codex_path);
    }
    let client = match ensure_client(app, &mut mgr).await {
        Ok(c) => c,
        Err(e) => {
            return json!({
                "running": false,
                "error": e,
                "version": mgr.version,
                "account": Value::Null,
            });
        }
    };
    let version = mgr.version.clone();
    drop(mgr);
    let account = match client.request("account/read", json!({}), RPC_TIMEOUT_MS).await {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn pending_rpc_resolves_and_fails_all() {
        let pending = PendingRpc::default();
        let rx1 = pending.register(1);
        let rx2 = pending.register(2);
        assert_eq!(pending.len(), 2);

        assert!(pending.resolve(1, Ok(json!({ "ok": true }))));
        assert_eq!(rx1.await.unwrap().unwrap()["ok"], true);

        // unknown ids are a no-op, not a panic
        assert!(!pending.resolve(99, Ok(Value::Null)));

        pending.fail_all("process died");
        let err = rx2.await.unwrap().unwrap_err();
        assert!(err.contains("process died"), "{err}");
        assert_eq!(pending.len(), 0);
    }

    #[tokio::test]
    async fn removed_ids_do_not_resolve() {
        let pending = PendingRpc::default();
        let rx = pending.register(7);
        pending.remove(7);
        assert!(!pending.resolve(7, Ok(Value::Null)));
        assert!(rx.await.is_err(), "sender must be gone after remove");
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
        let start = thread_start_params();
        assert_eq!(start["sandbox"], "read-only");
        assert_eq!(start["approvalPolicy"], "never");
        assert!(start["developerInstructions"]
            .as_str()
            .unwrap()
            .contains("SwarmZ Orchestrator"));
        let tools = start["dynamicTools"].as_array().unwrap();
        assert_eq!(tools.len(), 10);

        // resume must NOT re-declare dynamicTools (restored from the rollout)
        let resume = thread_resume_params("t-1");
        assert_eq!(resume["threadId"], "t-1");
        assert!(resume.get("dynamicTools").is_none());
        assert_eq!(resume["sandbox"], "read-only");
    }

    /// Full ping-tool loop against the REAL installed codex CLI. Ignored by
    /// default (needs codex + login + network — CI stays green); run with:
    ///   cargo test appserver_spike -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn appserver_spike() {
        let (events_tx, mut events_rx) = mpsc::unbounded_channel();
        let client = Arc::new(
            Client::spawn("codex", events_tx)
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
                        &protocol::tool_call_response(&Ok(json!("pong from the spike host"))),
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
