// Conductor brain (rebuild Phase 3): the Codex app-server chat layer, built
// on the generic host in `crate::codex` — ONE ProcessHost slot PER PROJECT
// now (the "slot allocation is the seam" architecture): every project's
// Conductor multiplexes its chats over its own long-lived process, spawned
// lazily and reaped when idle. Vibe sessions keep their private slots via the
// same host. Chats map 1:1 to app-server THREADS; the tool registry is
// declared as experimental DYNAMIC TOOLS on thread/start, and Codex calls
// back via `item/tool/call` server requests which we answer through the bus
// (`orchestrator::run_tool` → webview executors, scoped to the project).
//
// Layers, bottom to top:
//   - `codex::host` — process, framing, pending-rpc map, thread registry
//     (events for our threads arrive routed per threadId on the instance's
//     sink).
//   - per-project INSTANCE — `ProcessHost` slot + ONE dispatcher task; the
//     dispatcher consumes routed `ThreadEvent`s: answers `item/tool/call`,
//     auto-DECLINES approval requests (must not occur under read-only sandbox
//     + approvalPolicy "never"), maps notifications to
//     `orchestrator://chat-event` emissions and turn-completion wakeups, and
//     stamps the instance's last-used clock.
//   - chat API — `chat_start` / `chat_send` / `chat_interrupt` /
//     `chat_resume` / `chat_status`, exposed as Tauri commands in lib.rs.
//     `chat_start`/`chat_resume` carry the chat's ProjectContext; the thread
//     cwd is the PROJECT DIR (read-only sandbox — the Conductor works in the
//     project but cannot write it).
//
// Lifecycle: a project's process spawns lazily on first use; a died process
// is detected via the reader-EOF alive flag and respawned on the next call —
// in-flight requests fail with a clear error and running turns resolve as
// failed. After a respawn, chats transparently `thread/resume` their thread
// before the next turn (a per-chat generation counter detects the restart;
// rollouts persist on disk and dynamic tools are persisted and restored by
// codex — verified on 0.142.5/0.144.1). Closing a project tab does NOT touch
// its instance (chats keep working); instead an IDLE REAPER ends any
// project's process that had no chat activity and no running turn for
// `IDLE_REAP_SECS` (15 minutes) — the next message transparently respawns +
// resumes, so reaping is invisible except for the one-time respawn latency.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, oneshot};

use super::adapter;
use super::memory::MemoryScope;
use super::persona::{MemoryBlocks, PersonaSpec, ProjectContext};
use crate::codex::host::{
    self, Connection, EventSink, ProcessHost, Responder, ThreadEvent, RPC_TIMEOUT_MS,
    THREAD_TIMEOUT_MS, TURN_TIMEOUT_MS,
};

/// The dynamic-tools protocol is experimental; this is the version the
/// integration spike verified end-to-end (originally 0.142.5, re-verified
/// live on 0.144.1 in the Phase-0 probes). Mentioned in the version guard.
const KNOWN_GOOD_VERSION: &str = "0.144.1";

/// A project instance with no chat activity and no running turn for this long
/// gets its process ended (idle reaping — N = 15 minutes). The instance entry
/// and its chats stay; the next message respawns + `thread/resume`s.
const IDLE_REAP_SECS: u64 = 15 * 60;
/// How often the reaper looks.
const REAP_TICK_SECS: u64 = 60;

// System instructions are compiled per session from persona + project +
// memory + the hard-wired operative core (see
// `super::persona::build_instructions`) and delivered as
// `developerInstructions` on thread/start + thread/resume (keeps codex's own
// base prompt — and with it the tool harness — intact, unlike
// `baseInstructions`). Persona + project are captured per chat at start;
// memory (global + project scope) is read fresh from disk each start/resume
// (frozen per session).

// ---------------------------------------------------------------------------
// Chat state + per-project instances
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
    /// The Conductor instance this chat belongs to (captured at start/resume).
    project: ProjectContext,
    current_turn_id: Option<String>,
    last_agent_message: Option<String>,
    done_tx: Option<oneshot::Sender<TurnOutcome>>,
}

#[derive(Default)]
struct Shared {
    chats: HashMap<String, ChatState>,
    thread_to_chat: HashMap<String, String>,
}

/// Chat/thread registry — touched by the dispatcher tasks and the commands,
/// so it lives outside any async lock (plain mutex, no awaits while held).
/// Global across projects: thread ids are UUIDs, chat ids app-unique.
static SHARED: Lazy<Mutex<Shared>> = Lazy::new(Mutex::default);

/// One Conductor instance = one project's app-server slot + a dispatcher
/// PER PROCESS GENERATION + the idle clock + the lifecycle lease. Created
/// lazily per project id and kept for the app run (only the PROCESS inside
/// is reaped/respawned).
struct Instance {
    host: ProcessHost,
    /// last chat activity (command or routed event) — the reaper's clock
    last_used: Mutex<Instant>,
    /// the CURRENT generation's dispatcher sink — events are tagged with
    /// their generation by giving every generation its own dispatcher task,
    /// so a late event from generation N can never mutate N+1 state
    gen_sink: Mutex<Option<(u64, EventSink)>>,
    /// lifecycle lease: spawn-touching operations (ensure/start/resume) and
    /// the reaper's re-check+shutdown serialize on this, closing the
    /// check-then-shutdown TOCTOU
    lease: tokio::sync::Mutex<()>,
}

impl Instance {
    fn touch(&self) {
        *self.last_used.lock() = Instant::now();
    }

    fn idle_for(&self) -> Duration {
        self.last_used.lock().elapsed()
    }
}

/// project id → Conductor instance. The empty-string key is the neutral
/// probe instance (`chat_status`/`list_models` without a project).
static INSTANCES: Lazy<Mutex<HashMap<String, Arc<Instance>>>> = Lazy::new(Mutex::default);

static REAPER_STARTED: AtomicBool = AtomicBool::new(false);
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

/// The instance for a project id — created lazily (host slot; dispatchers
/// spawn per process generation); also boots the global idle reaper on first
/// use. Touching the idle clock HERE (before the lease) is load-bearing: a
/// send arriving while the reaper holds the lease resets `idle_for`, so the
/// reaper's re-check under the lease sees the activity and skips.
fn instance_for(_app: &AppHandle, project_id: &str) -> Arc<Instance> {
    let mut instances = INSTANCES.lock();
    if let Some(existing) = instances.get(project_id) {
        existing.touch();
        return existing.clone();
    }
    let instance = Arc::new(Instance {
        host: ProcessHost::new(),
        last_used: Mutex::new(Instant::now()),
        gen_sink: Mutex::new(None),
        lease: tokio::sync::Mutex::new(()),
    });
    instances.insert(project_id.to_string(), instance.clone());
    if !REAPER_STARTED.swap(true, Ordering::SeqCst) {
        spawn_reaper();
    }
    instance
}

/// Does this project have a turn in flight (running or awaited)?
fn project_has_running_turn(project_id: &str) -> bool {
    SHARED.lock().chats.values().any(|c| {
        c.project.id == project_id && (c.done_tx.is_some() || c.current_turn_id.is_some())
    })
}

/// The idle reaper: every `REAP_TICK_SECS`, end the process of any instance
/// that has been idle for `IDLE_REAP_SECS` with no running turn. The instance
/// (dispatchers, chats, thread ids) stays — the next message respawns the
/// process and transparently `thread/resume`s. TOCTOU-safe: the idle and
/// running-turn checks are RE-DONE while holding the instance's lifecycle
/// lease (a busy lease = activity = skip), and every spawn-touching operation
/// touches the idle clock BEFORE taking the lease — so a send racing the
/// reaper either resets the clock in time or blocks until the shutdown
/// finished and simply respawns.
fn spawn_reaper() {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(REAP_TICK_SECS));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            let candidates: Vec<(String, Arc<Instance>)> = INSTANCES
                .lock()
                .iter()
                .map(|(id, inst)| (id.clone(), inst.clone()))
                .collect();
            for (project_id, inst) in candidates {
                // cheap pre-checks without the lease
                if inst.idle_for() < Duration::from_secs(IDLE_REAP_SECS)
                    || project_has_running_turn(&project_id)
                {
                    continue;
                }
                // a held lease means someone is spawning/starting right now
                let Ok(_lease) = inst.lease.try_lock() else {
                    continue;
                };
                // re-check atomically under the lease
                if inst.idle_for() < Duration::from_secs(IDLE_REAP_SECS)
                    || project_has_running_turn(&project_id)
                {
                    continue;
                }
                if inst.host.alive().await.is_some() {
                    eprintln!(
                        "[orchestrator] reaping idle conductor process for project {project_id:?} (idle > {IDLE_REAP_SECS}s)"
                    );
                    inst.host.shutdown().await;
                }
            }
        }
    });
}

/// Live connection + generation + this GENERATION's dispatcher sink. Must be
/// called while holding the instance lease. A fresh generation gets a fresh
/// dispatcher task — that is what tags every routed event with its process
/// generation (a late event from generation N can never touch N+1 state).
async fn leased_conn(
    app: &AppHandle,
    project_id: &str,
    instance: &Arc<Instance>,
) -> Result<(Arc<Connection>, u64, EventSink), String> {
    let (conn, generation) = instance.host.ensure().await?;
    let sink = {
        let mut cache = instance.gen_sink.lock();
        match &*cache {
            Some((g, s)) if *g == generation => s.clone(),
            _ => {
                let (tx, rx) = mpsc::unbounded_channel();
                spawn_gen_dispatcher(
                    app.clone(),
                    project_id.to_string(),
                    instance.clone(),
                    generation,
                    rx,
                );
                *cache = Some((generation, tx.clone()));
                tx
            }
        }
    };
    Ok((conn, generation, sink))
}

/// Live connection + generation + sink for one project's Conductor —
/// touch → lease → ensure (see `instance_for`/`spawn_reaper` for why this
/// order is load-bearing).
async fn ensure_conn(
    app: &AppHandle,
    project_id: &str,
) -> Result<(Arc<Connection>, u64, EventSink), String> {
    let instance = instance_for(app, project_id);
    let _lease = instance.lease.lock().await;
    leased_conn(app, project_id, &instance).await
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

/// The Conductor's thread cwd: the project dir — the Conductor works IN the
/// project (read-only sandbox). Falls back to home when the dir is empty or
/// gone (a deleted project folder must not brick its Conductor).
fn thread_cwd(project: &ProjectContext) -> String {
    let dir = project.dir.trim();
    if !dir.is_empty() && std::path::Path::new(dir).is_dir() {
        dir.to_string()
    } else {
        home_dir_string()
    }
}

/// Read both memory scopes fresh (global + this project) and render them as
/// prompt-ready blocks. Off the main thread — small file IO.
async fn load_memory(app: &AppHandle, project_id: &str) -> MemoryBlocks {
    let Ok(dir) = app.path().app_data_dir() else {
        return MemoryBlocks::default();
    };
    let pid = project_id.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let global =
            super::memory::render_entries(&super::memory::read_entries(&dir, &MemoryScope::Global));
        // strict scope construction — an invalid/reserved/empty id gets NO
        // project memory instead of a munged or aliased file name
        let project = match MemoryScope::project(&pid) {
            Ok(scope) => {
                super::memory::render_entries(&super::memory::read_entries(&dir, &scope))
            }
            Err(_) => String::new(),
        };
        MemoryBlocks { global, project }
    })
    .await
    .unwrap_or_default()
}

/// thread/start params: cwd = the project dir, read-only sandbox, no approval
/// prompts (auto-declined anyway if one slips through), the compiled
/// instructions (persona + project + memory + core) as developer message, and
/// the whole registry as dynamic tools.
fn thread_start_params(
    persona: &PersonaSpec,
    project: &ProjectContext,
    memory: &MemoryBlocks,
) -> Value {
    json!({
        "cwd": thread_cwd(project),
        "sandbox": "read-only",
        "approvalPolicy": "never",
        "developerInstructions": super::build_instructions(persona, project, memory),
        "dynamicTools": adapter::dynamic_tool_specs(),
    })
}

/// thread/resume params: dynamicTools are NOT re-declarable here — codex
/// persists and restores them from the thread rollout (verified on 0.142.5).
/// developerInstructions ARE re-sent, so memory changes land on the next resume.
fn thread_resume_params(
    thread_id: &str,
    persona: &PersonaSpec,
    project: &ProjectContext,
    memory: &MemoryBlocks,
) -> Value {
    json!({
        "threadId": thread_id,
        "cwd": thread_cwd(project),
        "sandbox": "read-only",
        "approvalPolicy": "never",
        "developerInstructions": super::build_instructions(persona, project, memory),
    })
}

// ---------------------------------------------------------------------------
// Dispatcher — routed thread events → bus calls, events, wakeups
// ---------------------------------------------------------------------------

/// One dispatcher task per project instance PER PROCESS GENERATION — routed
/// events of that generation's chat threads arrive here, tagged implicitly
/// by which dispatcher they land on. Every event stamps the instance's idle
/// clock (a streaming turn keeps its process warm). Handlers compare the
/// event's generation against the CHAT's generation: a chat that already
/// moved to a newer process ignores stragglers from the old one.
fn spawn_gen_dispatcher(
    app: AppHandle,
    project_id: String,
    instance: Arc<Instance>,
    generation: u64,
    mut rx: mpsc::UnboundedReceiver<ThreadEvent>,
) {
    tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            instance.touch();
            match ev {
                ThreadEvent::Request { method, params, responder } => {
                    handle_server_request(&app, generation, method, params, responder);
                }
                ThreadEvent::Notification { method, params } => {
                    handle_notification(&app, generation, &method, &params);
                }
                ThreadEvent::Exited => {
                    // this generation's process is gone — fail only turns
                    // that still RUN ON IT (chat.generation <= ours); chats
                    // already resumed onto a newer process are untouched
                    handle_exit(&app, &project_id, generation);
                    break;
                }
            }
        }
    });
}

/// The generation a chat currently runs on (None = unknown chat).
fn chat_generation(chat_id: &str) -> Option<u64> {
    SHARED.lock().chats.get(chat_id).map(|c| c.generation)
}

fn handle_server_request(
    app: &AppHandle,
    event_gen: u64,
    method: String,
    params: Value,
    responder: Responder,
) {
    let thread_id = params
        .get("threadId")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let chat_id = chat_for_thread(thread_id.as_deref());
    // a straggler from an older process generation: the chat has moved on —
    // answer the (dead) responder and drop the request
    if let Some(cid) = &chat_id {
        if chat_generation(cid).is_some_and(|g| g > event_gen) {
            responder.error(-32601, "stale process generation");
            return;
        }
    }
    match method.as_str() {
        "item/tool/call" => {
            // answered in a task of its own — tool roundtrips must not block
            // the dispatcher (deltas keep streaming while a tool runs)
            let app = app.clone();
            // the CHAT's project scopes the executors ("" = unscoped is
            // normalized away in run_tool)
            let project_id = chat_id
                .as_deref()
                .and_then(|cid| {
                    SHARED
                        .lock()
                        .chats
                        .get(cid)
                        .map(|c| c.project.id.clone())
                })
                .unwrap_or_default();
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
                let result = super::run_tool(
                    &app,
                    &tool,
                    args,
                    chat_id.clone(),
                    Some(project_id),
                )
                .await;
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

fn handle_notification(app: &AppHandle, event_gen: u64, method: &str, params: &Value) {
    let thread_id = params.get("threadId").and_then(|v| v.as_str());
    let Some(chat_id) = chat_for_thread(thread_id) else {
        return; // not one of our chats (or no threadId) — ignore
    };
    // a straggler from an older process generation must never mutate a chat
    // that already resumed onto a newer one (its done_tx/turn state belong to
    // the NEW process; the old turn was failed by that generation's Exited)
    if chat_generation(&chat_id).is_some_and(|g| g > event_gen) {
        return;
    }
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

/// One process generation of one project died: fail every running turn of
/// THAT project's chats that still run on that (or an older) generation and
/// tell them. Chats that already resumed onto a NEWER process are untouched
/// (`chat.generation > event_gen`), and other projects' Conductors never
/// were (that is the point of per-project slots). An idle reap takes this
/// same path — no turns are running then, so nothing is failed.
fn handle_exit(app: &AppHandle, project_id: &str, event_gen: u64) {
    let pending: Vec<(String, Option<oneshot::Sender<TurnOutcome>>)> = {
        let mut shared = SHARED.lock();
        shared
            .chats
            .iter_mut()
            .filter(|(_, chat)| {
                chat.project.id == project_id && chat.generation <= event_gen
            })
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
            emit_chat_event(
                app,
                &chat_id,
                "warning",
                json!({ "message": "codex app-server exited — it restarts with the next message (the thread is resumed)" }),
            );
        }
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

/// Store the chat's persona + project after (re)registration — reused by
/// chat_send's transparent resume so a respawn keeps voice AND scope.
fn set_chat_context(chat_id: &str, persona: PersonaSpec, project: ProjectContext) {
    if let Some(chat) = SHARED.lock().chats.get_mut(chat_id) {
        chat.persona = persona;
        chat.project = project;
    }
}

/// Start a fresh Conductor chat for one project (thread/start with all
/// dynamic tools on that project's instance). The persona (voice) and the
/// project are captured here; memory is read fresh from disk.
pub async fn chat_start(
    app: &AppHandle,
    codex_path: Option<String>,
    persona: Option<PersonaSpec>,
    project: Option<ProjectContext>,
) -> Result<Value, String> {
    if codex_path.is_some() {
        // the frontend passes the current settings value on every call —
        // an empty string clears the override back to plain `codex`
        host::set_codex_override(codex_path);
    }
    let persona = persona.unwrap_or_default();
    let project = project.unwrap_or_default();
    let memory = load_memory(app, &project.id).await;
    let (conn, generation, sink) = ensure_conn(app, &project.id).await?;
    let res = conn
        .request(
            "thread/start",
            thread_start_params(&persona, &project, &memory),
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
    set_chat_context(&chat_id, persona, project);
    Ok(json!({ "chat_id": chat_id, "thread_id": thread_id }))
}

/// Reopen an existing app-server thread as a chat (thread/resume on its
/// project's instance — dynamic tools are restored from the rollout by
/// codex). Persona + project + fresh memory are re-sent as
/// developerInstructions.
pub async fn chat_resume(
    app: &AppHandle,
    thread_id: &str,
    persona: Option<PersonaSpec>,
    project: Option<ProjectContext>,
) -> Result<Value, String> {
    let persona = persona.unwrap_or_default();
    let project = project.unwrap_or_default();
    let memory = load_memory(app, &project.id).await;
    let (conn, generation, sink) = ensure_conn(app, &project.id).await?;
    conn.request(
        "thread/resume",
        thread_resume_params(thread_id, &persona, &project, &memory),
        THREAD_TIMEOUT_MS,
    )
    .await?;
    let chat_id = register_chat(&conn, &sink, generation, thread_id);
    set_chat_context(&chat_id, persona, project);
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
    // claim the chat's turn slot ATOMICALLY (check-and-set in one lock
    // section) — two parallel sends can no longer both pass the busy check
    // and overwrite each other's done_tx. Every error path below MUST
    // clear_done.
    let (done_tx, done_rx) = oneshot::channel();
    let (thread_id, persona, project) = {
        let mut shared = SHARED.lock();
        let chat = shared
            .chats
            .get_mut(chat_id)
            .ok_or_else(|| format!("unknown chat_id \"{chat_id}\" — start a chat first"))?;
        if chat.done_tx.is_some() {
            return Err("a turn is already running in this chat — interrupt it or wait".into());
        }
        chat.done_tx = Some(done_tx);
        chat.last_agent_message = None;
        (
            chat.thread_id.clone(),
            chat.persona.clone(),
            chat.project.clone(),
        )
    };
    let clear_done = || {
        if let Some(chat) = SHARED.lock().chats.get_mut(chat_id) {
            chat.done_tx = None;
        }
    };

    let (conn, generation, sink) = match ensure_conn(app, &project.id).await {
        Ok(v) => v,
        Err(e) => {
            clear_done();
            return Err(e);
        }
    };
    let needs_resume = {
        let shared = SHARED.lock();
        shared
            .chats
            .get(chat_id)
            .map(|c| c.generation != generation)
            .unwrap_or(false)
    };

    // the process was respawned (crash or idle reap) since this chat's last
    // turn → resume its thread (and re-register its route — routes die with
    // the process)
    if needs_resume {
        let memory = load_memory(app, &project.id).await;
        if let Err(e) = host::resume_thread(
            &conn,
            thread_resume_params(&thread_id, &persona, &project, &memory),
        )
        .await
        {
            // ThreadNotFound included: the orchestrator has no fresh-start
            // fallback here by design — the frontend controller handles a
            // failed resume by starting a new thread
            clear_done();
            return Err(format!(
                "thread/resume after app-server restart failed: {}",
                e.message()
            ));
        }
        conn.register_thread(&thread_id, sink.clone());
        if let Some(chat) = SHARED.lock().chats.get_mut(chat_id) {
            chat.generation = generation;
        }
    }

    // fresh PROJECT-scoped fleet summary line, prepended to every user turn
    // (best effort — the instructions tell the model to rely on it).
    // Internal call (no model turn behind it) — no chat context on purpose,
    // the executors must not track it as an orchestrator action; the project
    // context DOES ride along so the summary covers only this project.
    let summary = super::run_tool(
        app,
        "fleet_snapshot",
        json!({}),
        None,
        Some(project.id.clone()),
    )
    .await
    .ok()
    .and_then(|v| v.get("summary").and_then(|s| s.as_str()).map(String::from));
    let input_text = match summary {
        Some(s) => format!("[fleet status: {s}]\n\n{text}"),
        None => text.to_string(),
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
    let (thread_id, turn_id, project_id) = {
        let shared = SHARED.lock();
        let chat = shared
            .chats
            .get(chat_id)
            .ok_or_else(|| format!("unknown chat_id \"{chat_id}\""))?;
        let turn_id = chat
            .current_turn_id
            .clone()
            .ok_or("no turn is running in this chat")?;
        (chat.thread_id.clone(), turn_id, chat.project.id.clone())
    };
    let instance = INSTANCES
        .lock()
        .get(&project_id)
        .cloned()
        .ok_or("this project's codex app-server is not running")?;
    let conn = instance
        .host
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

/// Any instance whose process is currently alive (no spawn) — the cheap path
/// for status/model queries that just need SOME connection.
async fn any_alive_connection() -> Option<Arc<Connection>> {
    let instances: Vec<Arc<Instance>> = INSTANCES.lock().values().cloned().collect();
    for inst in instances {
        if let Some(conn) = inst.host.alive().await {
            return Some(conn);
        }
    }
    None
}

/// Newest known codex version across the instances (status reporting).
async fn last_known_version() -> Option<String> {
    let instances: Vec<Arc<Instance>> = INSTANCES.lock().values().cloned().collect();
    for inst in instances {
        if let Some(v) = inst.host.last_version().await {
            return Some(v);
        }
    }
    None
}

/// Health/identity: process liveness, codex version (initialize userAgent),
/// and an account/read summary. Reuses any alive Conductor process, else
/// spawns the given project's instance (or the neutral probe instance).
/// A failure to spawn is reported as `running:false`, never as Err.
pub async fn chat_status(
    app: &AppHandle,
    codex_path: Option<String>,
    project: Option<ProjectContext>,
) -> Value {
    if codex_path.is_some() {
        host::set_codex_override(codex_path);
    }
    let conn = match any_alive_connection().await {
        Some(conn) => conn,
        None => {
            let project_id = project.map(|p| p.id).unwrap_or_default();
            match ensure_conn(app, &project_id).await {
                Ok((conn, _, _)) => conn,
                Err(e) => {
                    return json!({
                        "running": false,
                        "error": e,
                        "version": last_known_version().await,
                        "account": Value::Null,
                    });
                }
            }
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
/// (the default model comes first). The frontend caches per app run. Reuses
/// any alive Conductor process, else spawns the neutral probe instance.
pub async fn list_models(app: &AppHandle) -> Result<Vec<String>, String> {
    let conn = match any_alive_connection().await {
        Some(conn) => conn,
        None => ensure_conn(app, "").await?.0,
    };
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

    fn project() -> ProjectContext {
        ProjectContext {
            id: "p1".into(),
            dir: std::env::temp_dir().to_string_lossy().into_owned(),
            name: "api".into(),
        }
    }

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
    fn thread_params_carry_project_cwd_tools_sandbox_and_instructions() {
        let persona = PersonaSpec::default();
        let project = project();
        let start = thread_start_params(&persona, &project, &MemoryBlocks::default());
        assert_eq!(start["sandbox"], "read-only");
        assert_eq!(start["approvalPolicy"], "never");
        // the Conductor works IN the project — cwd is the project dir
        assert_eq!(start["cwd"], json!(project.dir));
        let instructions = start["developerInstructions"].as_str().unwrap();
        assert!(instructions.contains("Conductor of THIS project"));
        // persona header is compiled in ahead of the operative core
        assert!(instructions.contains("Maestro"));
        // the project block names the project (quoted literal since the
        // injection hardening)
        assert!(instructions.contains("Name: \"api\""));
        // the approval doctrine is single-source here
        assert!(instructions.contains("the HUMAN holds final authority over what an agent may do"));
        let tools = start["dynamicTools"].as_array().unwrap();
        assert_eq!(tools.len(), 9);

        // memory snapshots flow into developerInstructions when present
        let with_mem = thread_start_params(
            &persona,
            &project,
            &MemoryBlocks {
                global: "- 2026-07-07 reviews go to Opus".into(),
                project: "- 2026-07-08 uses pnpm".into(),
            },
        );
        let text = with_mem["developerInstructions"].as_str().unwrap();
        assert!(text.contains("reviews go to Opus"));
        assert!(text.contains("uses pnpm"));

        // resume must NOT re-declare dynamicTools (restored from the rollout)
        let resume = thread_resume_params("t-1", &persona, &project, &MemoryBlocks::default());
        assert_eq!(resume["threadId"], "t-1");
        assert!(resume.get("dynamicTools").is_none());
        assert_eq!(resume["sandbox"], "read-only");
        assert_eq!(resume["cwd"], json!(project.dir));
        assert!(resume["developerInstructions"]
            .as_str()
            .unwrap()
            .contains("Conductor of THIS project"));
    }

    #[test]
    fn thread_cwd_falls_back_to_home_when_the_dir_is_gone() {
        let mut p = project();
        assert_eq!(thread_cwd(&p), p.dir);
        p.dir = "/definitely/not/a/real/folder-83651".into();
        assert_eq!(thread_cwd(&p), home_dir_string());
        p.dir = "  ".into();
        assert_eq!(thread_cwd(&p), home_dir_string());
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

    // ---- conductor instances spike (Phase 3) ----
    //
    // Live proof against the REAL installed codex CLI: TWO Conductor
    // instances (two scratch projects) run in parallel over SEPARATE
    // processes with SEPARATE cwds, using the production thread params
    // (persona + project + operative core + dynamic tools, read-only sandbox,
    // approvalPolicy never). Each runs a mini-turn that must report ITS
    // project folder; then instance A's process is shut down (the idle-reap
    // path) and transparently resumed — proving respawn transparency of one
    // instance never touches the other. Ignored by default; run with:
    //   cargo test conductor_instances_spike -- --ignored --nocapture

    struct SpikeConductor {
        label: &'static str,
        project: ProjectContext,
        host: ProcessHost,
        conn: Arc<Connection>,
        generation: u64,
        sink_rx: mpsc::UnboundedReceiver<ThreadEvent>,
        thread_id: String,
    }

    async fn spike_start_conductor(
        label: &'static str,
        project: ProjectContext,
    ) -> SpikeConductor {
        let host = ProcessHost::new();
        let (conn, generation) = host.ensure().await.expect("spawn conductor app-server");
        println!(
            "[{label}] process up (generation {generation}, {})",
            conn.version()
        );
        let started = conn
            .request(
                "thread/start",
                thread_start_params(&PersonaSpec::default(), &project, &MemoryBlocks::default()),
                THREAD_TIMEOUT_MS,
            )
            .await
            .expect("thread/start with production params");
        let thread_id = started
            .pointer("/thread/id")
            .and_then(|v| v.as_str())
            .expect("thread id")
            .to_string();
        let (sink_tx, sink_rx) = mpsc::unbounded_channel();
        conn.register_thread(&thread_id, sink_tx);
        println!("[{label}] thread started: {thread_id} (cwd {})", project.dir);
        SpikeConductor {
            label,
            project,
            host,
            conn,
            generation,
            sink_rx,
            thread_id,
        }
    }

    /// Run one turn asking the model for its working directory; return the
    /// final assistant message. Dynamic tool calls are answered with a
    /// minimal fake so the production registry never blocks the turn.
    async fn spike_run_cwd_turn(c: &mut SpikeConductor) -> String {
        c.conn
            .request(
                "turn/start",
                json!({
                    "threadId": c.thread_id,
                    "input": [{
                        "type": "text",
                        "text": "What is your current working directory? Reply with the absolute path only — no other words, no tool calls needed.",
                    }],
                }),
                RPC_TIMEOUT_MS,
            )
            .await
            .expect("turn/start");
        let mut final_message = String::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(240);
        loop {
            let ev = tokio::time::timeout_at(deadline, c.sink_rx.recv())
                .await
                .unwrap_or_else(|_| panic!("[{}] spike turn timed out", c.label))
                .expect("event sink closed");
            match ev {
                ThreadEvent::Request { method, params, responder } => {
                    // the production registry is declared — answer any tool
                    // call the model makes with a tiny fake result
                    println!("[{}] server request {method} ({})", c.label, params["tool"]);
                    if method == "item/tool/call" {
                        responder.ok(&adapter::tool_call_response(&Ok(json!(
                            "spike: tool unavailable in this probe"
                        ))));
                    } else {
                        responder.error(-32601, "not supported by the spike");
                    }
                }
                ThreadEvent::Notification { method, params } => match method.as_str() {
                    "item/completed"
                        if params.pointer("/item/type").and_then(|v| v.as_str())
                            == Some("agentMessage") =>
                    {
                        final_message = params
                            .pointer("/item/text")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                    }
                    "turn/completed" => {
                        let status = params.pointer("/turn/status").and_then(|v| v.as_str());
                        println!("[{}] turn completed: {status:?}", c.label);
                        assert_eq!(status, Some("completed"));
                        break;
                    }
                    _ => {}
                },
                ThreadEvent::Exited => panic!("[{}] app-server exited mid-turn", c.label),
            }
        }
        println!("[{}] final message: {final_message:?}", c.label);
        final_message
    }

    #[tokio::test]
    #[ignore]
    async fn conductor_instances_spike() {
        let base = std::env::temp_dir().join("swarmz-conductor-spike");
        let dir_a = base.join("project-a");
        let dir_b = base.join("project-b");
        std::fs::create_dir_all(&dir_a).unwrap();
        std::fs::create_dir_all(&dir_b).unwrap();
        // canonicalize — the model reports the resolved path (/private/var…)
        let canon_a = std::fs::canonicalize(&dir_a).unwrap();
        let canon_b = std::fs::canonicalize(&dir_b).unwrap();

        let project_a = ProjectContext {
            id: "spike-a".into(),
            dir: canon_a.to_string_lossy().into_owned(),
            name: "project-a".into(),
        };
        let project_b = ProjectContext {
            id: "spike-b".into(),
            dir: canon_b.to_string_lossy().into_owned(),
            name: "project-b".into(),
        };

        // two instances, spawned + started in parallel (separate processes)
        let (mut a, mut b) = tokio::join!(
            spike_start_conductor("A", project_a),
            spike_start_conductor("B", project_b),
        );
        assert!(
            !Arc::ptr_eq(&a.conn, &b.conn),
            "instances must run on separate processes"
        );

        // both mini-turns in parallel — each must report ITS project dir
        let (msg_a, msg_b) = tokio::join!(spike_run_cwd_turn(&mut a), spike_run_cwd_turn(&mut b));
        assert!(
            msg_a.contains(&a.project.dir),
            "[A] cwd answer must name project A's dir: {msg_a}"
        );
        assert!(
            msg_b.contains(&b.project.dir),
            "[B] cwd answer must name project B's dir: {msg_b}"
        );
        assert!(
            !msg_a.contains(&b.project.dir) && !msg_b.contains(&a.project.dir),
            "cwd answers must not cross projects"
        );

        // ---- respawn transparency: shut A down (the idle-reap path) ----
        a.host.shutdown().await;
        // the shutdown surfaces as Exited on A's sink (event routing correct)
        let exited = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                match a.sink_rx.recv().await {
                    Some(ThreadEvent::Exited) => break true,
                    Some(_) => continue,
                    None => break false,
                }
            }
        })
        .await
        .expect("no Exited after shutdown");
        assert!(exited, "A must observe its process exit");
        println!("[A] process shut down (idle-reap path)");
        // B is untouched: still alive, same generation
        assert!(b.host.alive().await.is_some(), "B's process must survive A's reap");
        assert!(b.conn.is_alive());

        // next use of A: fresh spawn (generation bump) + transparent resume
        let (conn2, gen2) = a.host.ensure().await.expect("respawn A");
        assert!(gen2 > a.generation, "respawn must bump the generation");
        host::resume_thread(
            &conn2,
            thread_resume_params(
                &a.thread_id,
                &PersonaSpec::default(),
                &a.project,
                &MemoryBlocks::default(),
            ),
        )
        .await
        .expect("thread/resume after respawn");
        let (sink_tx, sink_rx) = mpsc::unbounded_channel();
        conn2.register_thread(&a.thread_id, sink_tx);
        a.conn = conn2;
        a.generation = gen2;
        a.sink_rx = sink_rx;
        println!("[A] respawned (generation {gen2}) + thread resumed");

        // A works again after the respawn — and still knows ITS cwd
        let msg_a2 = spike_run_cwd_turn(&mut a).await;
        assert!(
            msg_a2.contains(&a.project.dir),
            "[A] post-respawn cwd answer must still name project A's dir: {msg_a2}"
        );

        // B still healthy and functional after A's whole respawn cycle
        assert!(b.host.alive().await.is_some());
        let (_, gen_b) = b.host.ensure().await.unwrap();
        assert_eq!(gen_b, b.generation, "B must never have respawned");
        let msg_b2 = spike_run_cwd_turn(&mut b).await;
        assert!(msg_b2.contains(&b.project.dir));

        println!("==== conductor instances spike: all assertions passed ====");
    }
}
