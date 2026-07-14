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
use super::persona::{
    MemoryBlocks, ModelCatalogEntry, PersonaSpec, ProjectContext, ReasoningEffortEntry,
};
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
    /// triggers a transparent thread/resume before the next turn. Commits
    /// only AFTER a successful resume (a failed resume must retry).
    generation: u64,
    /// The EVENT fence (audit C4, mirroring the session-side F11 split):
    /// advanced to the target generation BEFORE the awaited resume —
    /// a delayed straggler from the dead generation (Exited, turn/completed)
    /// must never touch an operation that is already moving to the new
    /// process. Guards compare against THIS, never against `generation`.
    fence_generation: u64,
    /// Persona captured at start/resume — reused for the developerInstructions
    /// when chat_send has to transparently thread/resume after a respawn.
    persona: PersonaSpec,
    /// The Conductor instance this chat belongs to (captured at start/resume).
    project: ProjectContext,
    current_turn_id: Option<String>,
    last_agent_message: Option<String>,
    done_tx: Option<oneshot::Sender<TurnOutcome>>,
    /// Operation token: incremented whenever a `done_tx` is installed. Every
    /// later step of that operation (marking the turn started, clearing on
    /// its error paths) verifies the token — a stale operation can neither
    /// clobber nor resurrect a successor's slot (audit C4).
    done_op: u64,
    /// The process generation the CURRENT operation's turn was started on —
    /// `None` while the operation is still setting up (ensure/resume).
    /// `handle_exit` fails ONLY operations whose turn verifiably ran on the
    /// dead generation; `turn/completed` consumes `done_tx` ONLY once a turn
    /// was actually started (a stale completion from a previous, timed-out
    /// turn can no longer steal a fresh operation's sender) — audit C4.
    done_gen: Option<u64>,
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
                let (tx, rx) = mpsc::channel(crate::codex::host::ROUTE_CHANNEL_CAPACITY);
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
#[cfg(test)]
fn thread_start_params(
    persona: &PersonaSpec,
    project: &ProjectContext,
    memory: &MemoryBlocks,
) -> Value {
    thread_start_params_with_models(persona, project, memory, None)
}

fn thread_start_params_with_models(
    persona: &PersonaSpec,
    project: &ProjectContext,
    memory: &MemoryBlocks,
    models: Option<&[ModelCatalogEntry]>,
) -> Value {
    json!({
        "cwd": thread_cwd(project),
        "sandbox": "read-only",
        "approvalPolicy": "never",
        "developerInstructions": super::build_instructions_with_models(persona, project, memory, models),
        "dynamicTools": adapter::dynamic_tool_specs(),
    })
}

/// thread/resume params: dynamicTools are NOT re-declarable here — codex
/// persists and restores them from the thread rollout (verified on 0.142.5).
/// developerInstructions ARE re-sent, so memory changes land on the next resume.
#[cfg(test)]
fn thread_resume_params(
    thread_id: &str,
    persona: &PersonaSpec,
    project: &ProjectContext,
    memory: &MemoryBlocks,
) -> Value {
    thread_resume_params_with_models(thread_id, persona, project, memory, None)
}

fn thread_resume_params_with_models(
    thread_id: &str,
    persona: &PersonaSpec,
    project: &ProjectContext,
    memory: &MemoryBlocks,
    models: Option<&[ModelCatalogEntry]>,
) -> Value {
    json!({
        "threadId": thread_id,
        "cwd": thread_cwd(project),
        "sandbox": "read-only",
        "approvalPolicy": "never",
        "developerInstructions": super::build_instructions_with_models(persona, project, memory, models),
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
    mut rx: mpsc::Receiver<ThreadEvent>,
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

/// The chat's EVENT FENCE generation (None = unknown chat) — the guard value
/// for straggler drops. NOT `generation` (resume bookkeeping): the fence
/// moves to the target generation BEFORE the awaited resume (audit C4).
fn chat_fence(chat_id: &str) -> Option<u64> {
    SHARED.lock().chats.get(chat_id).map(|c| c.fence_generation)
}

// ---------------------------------------------------------------------------
// Operation-slot state machine (audit C4 — pure state transitions on SHARED,
// unit-tested; the async command flows below compose exactly these)
// ---------------------------------------------------------------------------

/// Claim the chat's turn slot ATOMICALLY (check-and-set in one lock section)
/// and bind the fresh `done_tx` to a new operation token. Two parallel sends
/// can never both pass the busy check; every later step of the operation
/// verifies the returned token.
fn claim_turn_slot(
    chat_id: &str,
    done_tx: oneshot::Sender<TurnOutcome>,
    busy_msg: &str,
) -> Result<(u64, String, PersonaSpec, ProjectContext), String> {
    let mut shared = SHARED.lock();
    let chat = shared
        .chats
        .get_mut(chat_id)
        .ok_or_else(|| format!("unknown chat_id \"{chat_id}\" — start a chat first"))?;
    if chat.done_tx.is_some() {
        return Err(busy_msg.into());
    }
    chat.done_op += 1;
    chat.done_tx = Some(done_tx);
    chat.done_gen = None;
    chat.last_agent_message = None;
    Ok((
        chat.done_op,
        chat.thread_id.clone(),
        chat.persona.clone(),
        chat.project.clone(),
    ))
}

/// Advance the chat's EVENT fence to `generation` — called BEFORE the awaited
/// thread/resume (C4): from this point a straggler from any older process
/// generation is fenced out, even though the resume (and the `generation`
/// bookkeeping commit) is still pending. Never moves backwards.
fn advance_fence(chat_id: &str, generation: u64) {
    if let Some(chat) = SHARED.lock().chats.get_mut(chat_id) {
        if generation > chat.fence_generation {
            chat.fence_generation = generation;
        }
    }
}

/// The LAST gate before `turn/start` (C4): mark operation `token`'s turn as
/// started on `generation`. Returns false when the operation no longer owns
/// the slot (its `done_tx` was consumed — e.g. a process exit failed it
/// mid-setup) — the caller must NOT start a turn then: the webview would be
/// told "failed" while a real turn runs on, silently shedding the
/// autonomous marker.
fn try_mark_turn_started(chat_id: &str, token: u64, generation: u64) -> bool {
    let mut shared = SHARED.lock();
    let Some(chat) = shared.chats.get_mut(chat_id) else {
        return false;
    };
    if chat.done_op != token || chat.done_tx.is_none() {
        return false;
    }
    chat.done_gen = Some(generation);
    true
}

/// Clear operation `token`'s slot on its error paths — token-checked, so a
/// stale operation can never free a successor's claim.
fn clear_op(chat_id: &str, token: u64) {
    if let Some(chat) = SHARED.lock().chats.get_mut(chat_id) {
        if chat.done_op == token {
            chat.done_tx = None;
            chat.done_gen = None;
        }
    }
}

/// Consume the chat's sender for a terminal `turn/completed` — but ONLY when
/// the current operation actually STARTED a turn (`done_gen` set): a stale
/// completion (a previous timed-out turn ending late) can no longer steal a
/// fresh operation's sender while it is still setting up (C4).
fn take_completion(chat_id: &str) -> (Option<oneshot::Sender<TurnOutcome>>, Option<String>) {
    let mut shared = SHARED.lock();
    match shared.chats.get_mut(chat_id) {
        Some(chat) => {
            chat.current_turn_id = None;
            if chat.done_gen.is_some() {
                chat.done_gen = None;
                (chat.done_tx.take(), chat.last_agent_message.take())
            } else {
                (None, None)
            }
        }
        None => (None, None),
    }
}

/// One process generation died: take (to fail) every operation of that
/// project whose turn VERIFIABLY ran on that (or an older) generation.
/// Operations still setting up toward a newer process (`done_gen` None) are
/// untouched — their own error paths handle a dead connection, and failing
/// them here while their turn later starts is exactly the C4 race.
fn take_exit_failures(
    project_id: &str,
    event_gen: u64,
) -> Vec<(String, Option<oneshot::Sender<TurnOutcome>>)> {
    let mut shared = SHARED.lock();
    shared
        .chats
        .iter_mut()
        .filter(|(_, chat)| {
            chat.project.id == project_id && chat.done_gen.is_some_and(|g| g <= event_gen)
        })
        .map(|(cid, chat)| {
            chat.current_turn_id = None;
            chat.done_gen = None;
            (cid.clone(), chat.done_tx.take())
        })
        .collect()
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
    // answer the (dead) responder and drop the request. The FENCE generation
    // guards (C4): it advances before the awaited resume, so mid-respawn
    // stragglers are fenced too.
    if let Some(cid) = &chat_id {
        if chat_fence(cid).is_some_and(|g| g > event_gen) {
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
    // the NEW process; the old turn was failed by that generation's Exited).
    // The FENCE generation guards (C4): it advances BEFORE the awaited
    // resume, closing the mid-respawn straggler window.
    if chat_fence(&chat_id).is_some_and(|g| g > event_gen) {
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
            match item.get("type").and_then(|v| v.as_str()) {
                Some("agentMessage") => {
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
                // context compaction (thread/compact/start) — the chat's
                // visible history stays; the UI drops a notice
                Some("contextCompaction") => {
                    emit_chat_event(app, &chat_id, "compacted", json!({}));
                }
                _ => {}
            }
        }
        "thread/compacted" => emit_chat_event(app, &chat_id, "compacted", json!({})),
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
            // C4: `take_completion` consumes the sender ONLY when the current
            // operation actually started a turn — a stale completion never
            // steals a fresh operation's slot mid-setup
            let (done_tx, message) = take_completion(&chat_id);
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
/// THAT project's chats whose turn VERIFIABLY ran on that (or an older)
/// generation and tell them. Chats that already resumed onto a NEWER process
/// are untouched, operations still SETTING UP toward a new process are
/// untouched too (audit C4 — failing them while their turn later starts
/// would strip the webview's autonomous marker off a live turn), and other
/// projects' Conductors never were (that is the point of per-project slots).
/// An idle reap takes this same path — no turns are running then, so nothing
/// is failed.
fn handle_exit(app: &AppHandle, project_id: &str, event_gen: u64) {
    let pending = take_exit_failures(project_id, event_gen);
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
            if generation > chat.fence_generation {
                chat.fence_generation = generation;
            }
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
            fence_generation: generation,
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
    let models = model_catalog_from_connection(&conn).await.unwrap_or_default();
    let res = conn
        .request(
            "thread/start",
            thread_start_params_with_models(&persona, &project, &memory, Some(&models)),
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
    let models = model_catalog_from_connection(&conn).await.unwrap_or_default();
    conn.request(
        "thread/resume",
        thread_resume_params_with_models(
            thread_id,
            &persona,
            &project,
            &memory,
            Some(&models),
        ),
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
    if effort
        .as_deref()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("ultra"))
    {
        return Err(
            "effort \"ultra\" is unavailable in SwarmZ — Ultra is a multi-agent mode, not a single-agent reasoning level"
                .into(),
        );
    }
    // claim the chat's turn slot ATOMICALLY (check-and-set in one lock
    // section) — two parallel sends can no longer both pass the busy check
    // and overwrite each other's done_tx. The claim binds this operation to
    // a TOKEN (C4); every error path below MUST clear_op, and the turn only
    // ever starts through `try_mark_turn_started`.
    let (done_tx, done_rx) = oneshot::channel();
    let (op_token, thread_id, persona, project) = claim_turn_slot(
        chat_id,
        done_tx,
        "a turn is already running in this chat — interrupt it or wait",
    )?;

    let (conn, generation, sink) = match ensure_conn(app, &project.id).await {
        Ok(v) => v,
        Err(e) => {
            clear_op(chat_id, op_token);
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
        // C4: move the EVENT fence to the new generation BEFORE awaiting the
        // resume — a delayed old-generation straggler (Exited,
        // turn/completed) must not touch this operation mid-respawn
        advance_fence(chat_id, generation);
        let memory = load_memory(app, &project.id).await;
        let models = model_catalog_from_connection(&conn).await.unwrap_or_default();
        if let Err(e) = host::resume_thread(
            &conn,
            thread_resume_params_with_models(
                &thread_id,
                &persona,
                &project,
                &memory,
                Some(&models),
            ),
        )
        .await
        {
            // ThreadNotFound included: the orchestrator has no fresh-start
            // fallback here by design — the frontend controller handles a
            // failed resume by starting a new thread
            clear_op(chat_id, op_token);
            return Err(format!(
                "thread/resume after app-server restart failed: {}",
                e.message()
            ));
        }
        conn.register_thread(&thread_id, sink.clone());
        // the RESUME bookkeeping commits only now, after a genuine success
        // (the fence moved earlier — see above)
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

    // C4: NEVER start a turn for an operation that was already failed — if
    // the sender was consumed while we were setting up (a process exit
    // straggler), report that failure instead of launching a turn the
    // webview would account as human-triggered.
    if !try_mark_turn_started(chat_id, op_token, generation) {
        return match done_rx.await {
            Ok(outcome) => Err(outcome
                .error
                .unwrap_or_else(|| "turn aborted before it started".into())),
            Err(_) => Err("turn aborted before it started".into()),
        };
    }

    match conn
        .request("turn/start", turn_params, RPC_TIMEOUT_MS)
        .await
    {
        Ok(res) => {
            if let Some(turn_id) = res.pointer("/turn/id").and_then(|v| v.as_str()) {
                let mut shared = SHARED.lock();
                if let Some(chat) = shared.chats.get_mut(chat_id) {
                    if chat.done_op == op_token {
                        chat.current_turn_id = Some(turn_id.to_string());
                    }
                }
            }
        }
        Err(e) => {
            clear_op(chat_id, op_token);
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
            clear_op(chat_id, op_token);
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

/// How long a compaction turn may run before we stop waiting on it.
const COMPACT_TIMEOUT_MS: u64 = 300_000;

/// Compact the chat's thread (`thread/compact/start`): codex summarizes the
/// model-visible history and continues from the summary — the on-disk rollout
/// and the chat's UI transcript are untouched, only the context the Conductor
/// carries into its next turn shrinks. Runs as a short real turn: it claims
/// the chat's turn slot (a busy chat refuses) and BLOCKS until the compaction
/// turn/completed arrives (so a following send never races a second turn).
/// Transparently resumes after a process respawn, like `chat_send`.
pub async fn chat_compact(app: &AppHandle, chat_id: &str) -> Result<Value, String> {
    let (done_tx, done_rx) = oneshot::channel();
    // same C4 discipline as chat_send: token-bound claim, fence advance
    // before the awaited resume, and no compaction turn for an operation
    // that was already failed
    let (op_token, thread_id, persona, project) = claim_turn_slot(
        chat_id,
        done_tx,
        "a turn is already running in this chat — interrupt it or wait before compacting",
    )?;
    let (conn, generation, sink) = match ensure_conn(app, &project.id).await {
        Ok(v) => v,
        Err(e) => {
            clear_op(chat_id, op_token);
            return Err(e);
        }
    };
    let needs_resume = SHARED
        .lock()
        .chats
        .get(chat_id)
        .map(|c| c.generation != generation)
        .unwrap_or(false);
    if needs_resume {
        advance_fence(chat_id, generation);
        let memory = load_memory(app, &project.id).await;
        let models = model_catalog_from_connection(&conn).await.unwrap_or_default();
        if let Err(e) = host::resume_thread(
            &conn,
            thread_resume_params_with_models(
                &thread_id,
                &persona,
                &project,
                &memory,
                Some(&models),
            ),
        )
        .await
        {
            clear_op(chat_id, op_token);
            return Err(format!("thread/resume before compaction failed: {}", e.message()));
        }
        conn.register_thread(&thread_id, sink.clone());
        if let Some(chat) = SHARED.lock().chats.get_mut(chat_id) {
            chat.generation = generation;
        }
    }
    if !try_mark_turn_started(chat_id, op_token, generation) {
        return match done_rx.await {
            Ok(outcome) => Err(outcome
                .error
                .unwrap_or_else(|| "compaction aborted before it started".into())),
            Err(_) => Err("compaction aborted before it started".into()),
        };
    }
    if let Err(e) = conn
        .request(
            "thread/compact/start",
            json!({ "threadId": thread_id }),
            RPC_TIMEOUT_MS,
        )
        .await
    {
        clear_op(chat_id, op_token);
        return Err(format!("thread/compact/start failed: {e}"));
    }
    match tokio::time::timeout(Duration::from_millis(COMPACT_TIMEOUT_MS), done_rx).await {
        Ok(Ok(outcome)) => {
            if outcome.status == "failed" {
                Err(outcome.error.unwrap_or_else(|| "compaction failed".into()))
            } else {
                Ok(json!({ "status": outcome.status }))
            }
        }
        Ok(Err(_)) => Err("compaction aborted: chat state was dropped".into()),
        Err(_) => {
            // do NOT clear done_tx: the compaction turn may still be running,
            // and freeing the slot here would let a later send claim it while
            // the OLD turn/completed is still in flight — that stale
            // completion would then resolve the new sender. The slot stays
            // claimed until a genuine terminal event (turn/completed or
            // process exit) takes done_tx; a best-effort interrupt forces
            // that promptly on a live process.
            let turn_id = SHARED
                .lock()
                .chats
                .get(chat_id)
                .and_then(|c| c.current_turn_id.clone());
            if let Some(turn_id) = turn_id {
                let _ = conn
                    .request(
                        "turn/interrupt",
                        json!({ "threadId": thread_id, "turnId": turn_id }),
                        RPC_TIMEOUT_MS,
                    )
                    .await;
            }
            Err(
                "compaction timed out — it was interrupted; the chat frees up when its turn ends"
                    .into(),
            )
        }
    }
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

/// Rich, live model catalog from the installed Codex app-server. The protocol
/// is paginated and model-specific effort values are open strings, so this is
/// the single source used by the Conductor tool, prompt snapshot and pickers.
/// Hidden entries are dropped; server order is preserved.
pub async fn model_catalog(app: &AppHandle) -> Result<Vec<ModelCatalogEntry>, String> {
    let conn = match any_alive_connection().await {
        Some(conn) => conn,
        None => ensure_conn(app, "").await?.0,
    };
    model_catalog_from_connection(&conn).await
}

/// Compatibility surface for the existing UI picker callers.
pub async fn list_models(app: &AppHandle) -> Result<Vec<String>, String> {
    Ok(model_catalog(app)
        .await?
        .into_iter()
        .map(|entry| entry.model)
        .collect())
}

const MODEL_CATALOG_PAGE_LIMIT: u64 = 100;
const MODEL_CATALOG_MAX_PAGES: usize = 8;
const MODEL_CATALOG_MAX_MODELS: usize = 256;

async fn model_catalog_from_connection(
    conn: &Connection,
) -> Result<Vec<ModelCatalogEntry>, String> {
    let mut out = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MODEL_CATALOG_MAX_PAGES {
        let res = conn
            .request(
                "model/list",
                json!({
                    "cursor": cursor.clone(),
                    "limit": MODEL_CATALOG_PAGE_LIMIT,
                    "includeHidden": false,
                }),
                RPC_TIMEOUT_MS,
            )
            .await?;
        let (mut page, next) = parse_model_page(&res)?;
        let remaining = MODEL_CATALOG_MAX_MODELS.saturating_sub(out.len());
        page.truncate(remaining);
        out.extend(page);
        if out.len() >= MODEL_CATALOG_MAX_MODELS {
            break;
        }
        match next {
            Some(next) if !next.is_empty() && cursor.as_deref() != Some(next.as_str()) => {
                cursor = Some(next);
            }
            _ => break,
        }
    }
    Ok(out)
}

/// Pure one-page parser. Required top-level `data` shape fails loudly;
/// malformed individual entries degrade independently so one provider row
/// cannot hide the rest of the catalog.
fn parse_model_page(res: &Value) -> Result<(Vec<ModelCatalogEntry>, Option<String>), String> {
    let data = res
        .get("data")
        .and_then(Value::as_array)
        .ok_or("model/list: response has no data array")?;
    let entries = data
        .iter()
        .filter(|item| !item.get("hidden").and_then(Value::as_bool).unwrap_or(false))
        .filter_map(parse_model_entry)
        .collect();
    let next = res
        .get("nextCursor")
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok((entries, next))
}

fn parse_model_entry(item: &Value) -> Option<ModelCatalogEntry> {
    let id = item.get("id").and_then(Value::as_str)?.trim();
    if id.is_empty() {
        return None;
    }
    let model = item
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(id);
    let efforts = item
        .get("supportedReasoningEfforts")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|effort| {
                    let value = effort
                        .get("reasoningEffort")
                        .and_then(Value::as_str)?
                        .trim();
                    if value.is_empty() {
                        return None;
                    }
                    // Codex advertises Ultra through this protocol field, but
                    // Ultra is a multi-agent execution mode, not a reasoning
                    // effort for one SwarmZ agent. Never expose it as one.
                    if value.eq_ignore_ascii_case("ultra") {
                        return None;
                    }
                    Some(ReasoningEffortEntry {
                        effort: value.to_string(),
                        description: effort
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(ModelCatalogEntry {
        id: id.to_string(),
        model: model.to_string(),
        display_name: item
            .get("displayName")
            .and_then(Value::as_str)
            .unwrap_or(id)
            .to_string(),
        description: item
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        is_default: item
            .get("isDefault")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        default_reasoning_effort: item
            .get("defaultReasoningEffort")
            .and_then(Value::as_str)
            .filter(|value| !value.eq_ignore_ascii_case("ultra"))
            .unwrap_or("")
            .to_string(),
        supported_reasoning_efforts: efforts,
    })
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
    fn model_list_keeps_routing_metadata_and_filters_hidden_and_ultra() {
        // shape from the generated 0.144.1 `ModelListResponse` schema
        let res = json!({ "data": [
            {
                "id": "gpt-5.6-sol", "model": "gpt-5.6-sol",
                "displayName": "GPT-5.6 Sol", "description": "Frontier model",
                "hidden": false, "isDefault": true,
                "defaultReasoningEffort": "low",
                "supportedReasoningEfforts": [
                    { "reasoningEffort": "low", "description": "Fast" },
                    { "reasoningEffort": "max", "description": "Deep" },
                    { "reasoningEffort": "ultra", "description": "Multi-agent" }
                ]
            },
            { "id": "gpt-5.5-internal", "hidden": true },
            { "id": "gpt-5.6-luna", "displayName": "GPT-5.6 Luna", "hidden": false },
            { "displayName": "no id — dropped", "hidden": false },
        ], "nextCursor": "page-2" });
        let (models, next) = parse_model_page(&res).expect("valid page");
        assert_eq!(next.as_deref(), Some("page-2"));
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].model, "gpt-5.6-sol");
        assert!(models[0].is_default);
        assert_eq!(models[0].default_reasoning_effort, "low");
        assert_eq!(
            models[0]
                .supported_reasoning_efforts
                .iter()
                .map(|entry| entry.effort.as_str())
                .collect::<Vec<_>>(),
            vec!["low", "max"]
        );
        assert!(parse_model_page(&json!({})).is_err());
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
        assert_eq!(tools.len(), crate::orchestrator::tool_definitions().len());
        assert!(tools.iter().any(|t| t["name"] == "spawn_agents"));
        assert!(tools.iter().any(|t| t["name"] == "list_models"));

        let catalog = vec![ModelCatalogEntry {
            id: "gpt-5.6-terra".into(),
            model: "gpt-5.6-terra".into(),
            display_name: "GPT-5.6 Terra".into(),
            description: "Balanced everyday model".into(),
            is_default: false,
            default_reasoning_effort: "medium".into(),
            supported_reasoning_efforts: vec![ReasoningEffortEntry {
                effort: "medium".into(),
                description: String::new(),
            }],
        }];
        let with_models = thread_start_params_with_models(
            &persona,
            &project,
            &MemoryBlocks::default(),
            Some(&catalog),
        );
        let model_instructions = with_models["developerInstructions"].as_str().unwrap();
        assert!(model_instructions.contains("gpt-5.6-terra"));
        assert!(model_instructions.contains("supported efforts [medium]"));

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

    /// Insert a bare test chat into SHARED (unique ids per test — SHARED is
    /// process-global).
    fn insert_test_chat(chat_id: &str, project_id: &str, generation: u64) {
        let mut shared = SHARED.lock();
        shared
            .thread_to_chat
            .insert(format!("thread-{chat_id}"), chat_id.to_string());
        shared.chats.insert(
            chat_id.to_string(),
            ChatState {
                thread_id: format!("thread-{chat_id}"),
                generation,
                fence_generation: generation,
                project: ProjectContext {
                    id: project_id.into(),
                    dir: String::new(),
                    name: String::new(),
                },
                ..Default::default()
            },
        );
    }

    fn remove_test_chat(chat_id: &str) {
        let mut shared = SHARED.lock();
        if let Some(chat) = shared.chats.remove(chat_id) {
            shared.thread_to_chat.remove(&chat.thread_id);
        }
    }

    /// Audit C4 (frozen): the Conductor respawn race. `chat_send` installs
    /// its `done_tx` while the chat still carries the OLD generation; a
    /// delayed old-generation `Exited` must NOT take and fail that sender —
    /// the send would then start the real turn anyway, the webview would
    /// clear busy + the autonomous marker, and the still-running autonomous
    /// turn's tool calls would count as human-triggered. The operation
    /// binding (`done_gen`) plus the pre-`turn/start` gate close both halves.
    #[test]
    fn respawn_race_never_fails_a_mid_setup_operation() {
        let cid = format!("c4-race-{}", std::process::id());
        let pid = format!("c4-project-{}", std::process::id());
        insert_test_chat(&cid, &pid, 1);

        // the operation claims the slot (still on generation 1)
        let (tx, mut rx) = oneshot::channel();
        let (token, ..) = claim_turn_slot(&cid, tx, "busy").expect("claim");

        // the delayed gen-1 Exited straggler arrives MID-SETUP: it must not
        // touch the operation (its turn never ran on gen 1)
        assert!(
            take_exit_failures(&pid, 1).is_empty(),
            "an exit must never fail an operation that has not started a turn"
        );
        assert!(
            rx.try_recv().is_err(),
            "the fresh done_tx must survive the stale exit"
        );

        // chat_send advances the FENCE before awaiting the resume — from now
        // on gen-1 stragglers are dropped by the event guards
        advance_fence(&cid, 2);
        assert_eq!(chat_fence(&cid), Some(2));
        // (and the fence never moves backwards)
        advance_fence(&cid, 1);
        assert_eq!(chat_fence(&cid), Some(2));

        // the turn starts on generation 2
        assert!(try_mark_turn_started(&cid, token, 2), "the live op must start");
        // another late gen-1 exit: the turn runs on gen 2 → untouched
        assert!(take_exit_failures(&pid, 1).is_empty());
        // a GENUINE gen-2 exit fails exactly this operation
        let failed = take_exit_failures(&pid, 2);
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].0, cid);
        assert!(failed[0].1.is_some(), "the sender is taken for failing");
        remove_test_chat(&cid);
    }

    /// C4 companion: once an operation's sender was consumed, the operation
    /// must NEVER start its turn (`try_mark_turn_started` refuses) — and a
    /// stale token can neither free nor hijack a successor's slot.
    #[test]
    fn failed_operations_cannot_start_turns_and_stale_tokens_are_inert() {
        let cid = format!("c4-token-{}", std::process::id());
        let pid = format!("c4-token-project-{}", std::process::id());
        insert_test_chat(&cid, &pid, 1);

        let (tx1, _rx1) = oneshot::channel();
        let (token1, ..) = claim_turn_slot(&cid, tx1, "busy").expect("claim 1");
        // simulate the operation being failed (its sender consumed)
        SHARED
            .lock()
            .chats
            .get_mut(&cid)
            .unwrap()
            .done_tx
            .take()
            .unwrap()
            .send(TurnOutcome {
                status: "failed".into(),
                error: Some("codex app-server exited".into()),
                message: None,
            })
            .ok();
        assert!(
            !try_mark_turn_started(&cid, token1, 2),
            "a failed operation must never start a turn"
        );

        // a successor claims the slot — the stale token is inert against it
        let (tx2, mut rx2) = oneshot::channel();
        let (token2, ..) = claim_turn_slot(&cid, tx2, "busy").expect("claim 2");
        assert_ne!(token1, token2);
        clear_op(&cid, token1); // stale clear → no effect
        assert!(try_mark_turn_started(&cid, token2, 2));
        assert!(rx2.try_recv().is_err(), "successor's sender untouched");
        // the successor's own clear works
        clear_op(&cid, token2);
        assert!(SHARED.lock().chats.get(&cid).unwrap().done_tx.is_none());
        remove_test_chat(&cid);
    }

    /// C4 companion: a STALE `turn/completed` (a previous timed-out turn
    /// ending late) must not steal a fresh operation's sender while that
    /// operation is still setting up — `take_completion` only consumes once
    /// a turn was genuinely started.
    #[test]
    fn stale_completion_never_steals_a_fresh_slot() {
        let cid = format!("c4-completion-{}", std::process::id());
        let pid = format!("c4-completion-project-{}", std::process::id());
        insert_test_chat(&cid, &pid, 1);

        let (tx, mut rx) = oneshot::channel();
        let (token, ..) = claim_turn_slot(&cid, tx, "busy").expect("claim");
        // stale completion arrives before the op started its turn → not taken
        let (taken, _) = take_completion(&cid);
        assert!(taken.is_none(), "mid-setup sender must not be consumed");
        assert!(rx.try_recv().is_err());
        // once the turn started, a completion IS taken
        assert!(try_mark_turn_started(&cid, token, 1));
        let (taken, _) = take_completion(&cid);
        assert!(taken.is_some(), "a started turn's completion resolves");
        remove_test_chat(&cid);
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
    #[ignore = "live spike — needs the codex CLI, a login and network"]
    async fn appserver_spike() {
        let (events_tx, mut events_rx) = mpsc::channel(4_096);
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
        sink_rx: mpsc::Receiver<ThreadEvent>,
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
        let (sink_tx, sink_rx) = mpsc::channel(crate::codex::host::ROUTE_CHANNEL_CAPACITY);
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
    #[ignore = "live spike — needs the codex CLI, a login and network"]
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
        let (sink_tx, sink_rx) = mpsc::channel(crate::codex::host::ROUTE_CHANNEL_CAPACITY);
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

    // ---- Phase-5 autonomy-loop spike ----
    //
    // Live end-to-end proof of the loop's substance against the REAL codex
    // CLI: (1) a real AGENT session executes a small task in a scratch repo
    // with the Phase-5 report `outputSchema` and returns a machine-readable
    // status report; (2) a real CONDUCTOR thread (production instructions +
    // dynamic tools) receives the exact `[agent finished]` autonomous wire
    // text the trigger router builds (marker + report + diff line) and must
    // act like a lead: acknowledge the work and report — without a user in
    // the loop. The webview glue (trigger router, budget) is covered by the
    // vitest suite; this spike proves the two real model turns around it.
    // Ignored by default; run with:
    //   SWARMZ_SPIKE_DIR=<scratch> cargo test phase5_autonomy_loop_spike -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "live spike — needs the codex CLI, a login and network"]
    async fn phase5_autonomy_loop_spike() {
        use std::path::PathBuf;
        let base = std::env::var("SWARMZ_SPIKE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir().join("swarmz-phase5-loop-spike"));
        let repo = base.join("repo");
        std::fs::remove_dir_all(&repo).ok();
        std::fs::create_dir_all(&repo).unwrap();
        let repo = repo.canonicalize().unwrap();
        let repo_str = repo.to_string_lossy().into_owned();

        // ---- (1) the agent: a real task turn constrained by the report schema
        let report_schema = json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "done": { "type": "boolean" },
                "summary": { "type": "string" },
                "files_changed": { "type": "array", "items": { "type": "string" } },
                "tests_pass": { "type": ["boolean", "null"] },
                "needs_human": { "type": "boolean" },
                "question": { "type": ["string", "null"] },
                "followups": { "type": "array", "items": { "type": "string" } }
            },
            "required": ["done", "summary", "files_changed", "tests_pass", "needs_human", "question", "followups"]
        });
        let agent_host = ProcessHost::new();
        let (agent_conn, _g) = agent_host.ensure().await.expect("spawn agent");
        let started = agent_conn
            .request(
                "thread/start",
                json!({
                    "cwd": repo_str,
                    "sandbox": "danger-full-access",
                    "approvalPolicy": "never",
                }),
                THREAD_TIMEOUT_MS,
            )
            .await
            .expect("agent thread/start");
        let agent_tid = started
            .pointer("/thread/id")
            .and_then(|v| v.as_str())
            .unwrap()
            .to_string();
        let (atx, mut arx) = mpsc::channel(crate::codex::host::ROUTE_CHANNEL_CAPACITY);
        agent_conn.register_thread(&agent_tid, atx);
        agent_conn
            .request(
                "turn/start",
                json!({
                    "threadId": agent_tid,
                    "effort": "low",
                    "input": [{ "type": "text", "text": "Create a file named GREETING.md in your current working directory containing the single line 'hello from the swarm'. End your work by filling the required status report." }],
                    "outputSchema": report_schema,
                }),
                RPC_TIMEOUT_MS,
            )
            .await
            .expect("agent turn/start");
        let mut report_text = String::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(240);
        loop {
            let ev = tokio::time::timeout_at(deadline, arx.recv())
                .await
                .expect("agent turn timed out")
                .expect("agent sink closed");
            match ev {
                ThreadEvent::Request { responder, .. } => {
                    responder.ok(&json!({ "decision": "accept" }))
                }
                ThreadEvent::Notification { method, params } => {
                    if method == "item/completed"
                        && params.pointer("/item/type").and_then(|v| v.as_str())
                            == Some("agentMessage")
                    {
                        report_text = params
                            .pointer("/item/text")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                    }
                    if method == "turn/completed" {
                        assert_eq!(
                            params.pointer("/turn/status").and_then(|v| v.as_str()),
                            Some("completed")
                        );
                        break;
                    }
                }
                ThreadEvent::Exited => panic!("agent process exited mid-spike"),
            }
        }
        let report: Value =
            serde_json::from_str(report_text.trim()).expect("agent report must be pure JSON");
        println!("[loop] agent report: {report}");
        assert_eq!(report["done"], true, "agent must report done");
        assert!(repo.join("GREETING.md").is_file(), "agent must have created the file");

        // ---- (2) the Conductor: the [agent finished] autonomous turn
        let project = ProjectContext {
            id: "phase5-loop".into(),
            dir: repo_str.clone(),
            name: "phase5-loop".into(),
        };
        let cond_host = ProcessHost::new();
        let (cond_conn, _g) = cond_host.ensure().await.expect("spawn conductor");
        let cstarted = cond_conn
            .request(
                "thread/start",
                thread_start_params(&PersonaSpec::default(), &project, &MemoryBlocks::default()),
                THREAD_TIMEOUT_MS,
            )
            .await
            .expect("conductor thread/start");
        let cond_tid = cstarted
            .pointer("/thread/id")
            .and_then(|v| v.as_str())
            .unwrap()
            .to_string();
        let (ctx, mut crx) = mpsc::channel(crate::codex::host::ROUTE_CHANNEL_CAPACITY);
        cond_conn.register_thread(&cond_tid, ctx);
        // the EXACT wire shape the trigger router builds (triggers-core.ts)
        let wire = format!(
            "[agent finished] Agent «Maya» (id spike-maya) finished its turn.\nStructured report: {report}\nWorking tree: no uncommitted changes reported\n\nThis is an autonomous turn — no user message triggered it. Act as the lead: judge the result (read_agent / git_status / review_agent when warranted), hand out follow-up tasks yourself when they clearly serve the user's standing goal, and close the loop with a compact report of what got done and what you suggest next. Escalate to the user only what genuinely needs their call."
        );
        cond_conn
            .request(
                "turn/start",
                json!({ "threadId": cond_tid, "input": [{ "type": "text", "text": wire }] }),
                RPC_TIMEOUT_MS,
            )
            .await
            .expect("conductor turn/start");
        let mut tool_calls: Vec<String> = Vec::new();
        let mut final_message = String::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
        loop {
            let ev = tokio::time::timeout_at(deadline, crx.recv())
                .await
                .expect("conductor turn timed out")
                .expect("conductor sink closed");
            match ev {
                ThreadEvent::Request { method, params, responder } => {
                    if method == "item/tool/call" {
                        let tool = params
                            .get("tool")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        println!("[loop] conductor tool call: {tool}");
                        // canned answers standing in for the webview executors
                        let answer = match tool.as_str() {
                            "fleet_snapshot" => json!({
                                "project": { "id": "phase5-loop", "name": "phase5-loop", "dir": repo_str },
                                "summary": "1 session · 0 working · 0 wait approval",
                                "sessions": [{ "id": "spike-maya", "name": "Maya", "cwd": repo_str, "status": "idle", "worktree": null, "pendingApprovals": [] }],
                                "worktrees": [], "timers": [],
                            }),
                            "git_status" => json!({
                                "agent": { "id": "spike-maya", "name": "Maya" },
                                "cwd": repo_str,
                                "git": null,
                                "note": format!("not a git repository: {repo_str}"),
                            }),
                            "read_agent" => json!({
                                "agent": { "id": "spike-maya", "name": "Maya", "cwd": repo_str },
                                "transcript": format!("user: create GREETING.md\nassistant: {}", report_text.trim()),
                            }),
                            _ => json!("spike: tool unavailable in this probe"),
                        };
                        tool_calls.push(tool);
                        responder.ok(&adapter::tool_call_response(&Ok(answer)));
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
                        assert_eq!(
                            params.pointer("/turn/status").and_then(|v| v.as_str()),
                            Some("completed")
                        );
                        break;
                    }
                    _ => {}
                },
                ThreadEvent::Exited => panic!("conductor process exited mid-spike"),
            }
        }
        println!("[loop] conductor tool calls: {tool_calls:?}");
        println!("[loop] conductor final message: {final_message}");
        // the Conductor closed the loop: a non-empty lead-style report that
        // references the agent by name (never the raw session id)
        assert!(!final_message.trim().is_empty(), "conductor must report");
        assert!(
            final_message.contains("Maya"),
            "the report must reference the agent by name: {final_message}"
        );
        assert!(
            !final_message.contains("spike-maya"),
            "raw session ids must not surface to the user: {final_message}"
        );
        println!("==== phase5 autonomy loop spike: all assertions passed ====");
        std::fs::remove_dir_all(&base).ok();
    }

    // ---- Phase-8 codex-facing swarm integration spike ----
    //
    // The heart of the Phase-8 acceptance: the CODEX-FACING swarm mechanics
    // against the REAL codex 0.144.1 CLI, driven through the PRODUCTION Rust
    // codepaths — NOT an end-to-end test of the webview half (the Conductor's
    // tool calls are answered with canned results here, see the honest
    // boundary below)
    // (production thread params + operative core + dynamic tools for the
    // Conductor, `worktree::add/remove` for the git worktrees, the real
    // `classify_approval` router). In a fresh scratch git repo it proves:
    //   (a) an UNDECOMPOSED goal makes the Conductor sense the fleet
    //       (fleet_snapshot) and DECOMPOSE onto ≥2 agents (spawn_agents), one
    //       placed in a NEW worktree and one worktree-less;
    //   (b) two REAL agent sessions run in SEPARATE cwds and each writes only
    //       into its own directory (worktree isolation);
    //   (c) an agent ends with the `outputSchema`-forced status report;
    //   (d) approval classification is correct (a destructive command stays
    //       human, a read-only one is routine) — the Rust-anchored router;
    //   (e) the gated worktree cleanup refuses dirty work without --force and
    //       removes it with force (a human decision).
    //
    // What is NOT in this Rust spike (and why): the timer-fire → autonomous
    // turn path is webview/TS state (conductorTimers store + trigger router)
    // and is covered by the vitest suite (timers-core / triggers-core) plus
    // the phase5 wire spike; the webview EXECUTORS behind spawn_agents (which
    // actually start the sessions) are TS — here the Conductor's tool calls
    // are answered with production-shaped canned results, and part (b) starts
    // the two real sessions directly through the same host layer the executors
    // use. Honest boundary: this proves the codex-facing swarm mechanics
    // end-to-end; the TS glue around them has its own tests.
    //
    // Ignored by default (needs codex + login + network + git); run with:
    //   SWARMZ_SPIKE_DIR=<scratch> cargo test phase8_codex_swarm_integration_spike -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "live spike — needs the codex CLI, a login and network"]
    async fn phase8_codex_swarm_integration_spike() {
        use crate::codex::sessions::classify_approval;
        use std::path::PathBuf;
        use std::process::Command as StdCommand;

        fn git(repo: &std::path::Path, args: &[&str]) {
            let ok = StdCommand::new("git")
                .args(args)
                .current_dir(repo)
                .status()
                .expect("run git")
                .success();
            assert!(ok, "git {args:?} failed");
        }

        let base = std::env::var("SWARMZ_SPIKE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir().join("swarmz-phase8-e2e-spike"));
        std::fs::remove_dir_all(&base).ok();
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        // a real git repo so worktree::add works
        git(&repo, &["init", "-q"]);
        git(&repo, &["config", "user.email", "spike@swarmz.test"]);
        git(&repo, &["config", "user.name", "SwarmZ Spike"]);
        std::fs::write(repo.join("README.md"), "# spike\n").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        let repo = repo.canonicalize().unwrap();
        let repo_str = repo.to_string_lossy().into_owned();

        // =====================================================================
        // (a) the Conductor decomposes an undecomposed goal onto ≥2 agents
        // =====================================================================
        let project = ProjectContext {
            id: "phase8-e2e".into(),
            dir: repo_str.clone(),
            name: "phase8-e2e".into(),
        };
        let cond_host = ProcessHost::new();
        let (cond_conn, _g) = cond_host.ensure().await.expect("spawn conductor");
        let cstarted = cond_conn
            .request(
                "thread/start",
                thread_start_params(&PersonaSpec::default(), &project, &MemoryBlocks::default()),
                THREAD_TIMEOUT_MS,
            )
            .await
            .expect("conductor thread/start");
        let cond_tid = cstarted
            .pointer("/thread/id")
            .and_then(|v| v.as_str())
            .unwrap()
            .to_string();
        let (ctx, mut crx) = mpsc::channel(crate::codex::host::ROUTE_CHANNEL_CAPACITY);
        cond_conn.register_thread(&cond_tid, ctx);
        cond_conn
            .request(
                "turn/start",
                json!({ "threadId": cond_tid, "input": [{ "type": "text", "text":
                    "Goal: add a small greeting feature to this project — a function that returns a greeting string, plus a test for it. Split this into TWO parallel agents: one for the implementation, one for the test. First check the fleet, then spawn both agents with clear tasks. Put the implementation agent in a NEW worktree and keep the test agent worktree-less."
                }] }),
                RPC_TIMEOUT_MS,
            )
            .await
            .expect("conductor turn/start");

        let mut tool_calls: Vec<String> = Vec::new();
        let mut spawn_agent_count = 0usize;
        let mut spawn_placements: Vec<String> = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
        loop {
            let ev = tokio::time::timeout_at(deadline, crx.recv())
                .await
                .expect("conductor turn timed out")
                .expect("conductor sink closed");
            match ev {
                ThreadEvent::Request { method, params, responder } => {
                    if method == "item/tool/call" {
                        let tool =
                            params.get("tool").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let args = params.get("arguments").cloned().unwrap_or(Value::Null);
                        tool_calls.push(tool.clone());
                        let answer = match tool.as_str() {
                            "fleet_snapshot" => json!({
                                "project": { "id": "phase8-e2e", "name": "phase8-e2e", "dir": repo_str },
                                "summary": "0 sessions",
                                "sessions": [], "worktrees": [], "timers": [],
                            }),
                            "spawn_agents" => {
                                let specs = args
                                    .get("agents")
                                    .and_then(|a| a.as_array())
                                    .cloned()
                                    .unwrap_or_default();
                                spawn_agent_count += specs.len();
                                let mut spawned = Vec::new();
                                for (i, s) in specs.iter().enumerate() {
                                    let wt = s
                                        .get("worktree")
                                        .and_then(|w| w.as_str())
                                        .unwrap_or("none")
                                        .to_string();
                                    spawn_placements.push(wt);
                                    spawned.push(json!({
                                        "name": format!("Agent{}", i + 1),
                                        "id": format!("spike-agent-{}", i + 1),
                                    }));
                                }
                                json!({ "spawned": spawned })
                            }
                            _ => json!("spike: tool result unavailable"),
                        };
                        responder.ok(&adapter::tool_call_response(&Ok(answer)));
                    } else {
                        responder.error(-32601, "not supported by the spike");
                    }
                }
                ThreadEvent::Notification { method, params } => {
                    if method == "turn/completed" {
                        assert_eq!(
                            params.pointer("/turn/status").and_then(|v| v.as_str()),
                            Some("completed"),
                            "conductor turn must complete"
                        );
                        break;
                    }
                }
                ThreadEvent::Exited => panic!("conductor exited mid-spike"),
            }
        }
        println!("[e2e] conductor tool calls: {tool_calls:?}");
        println!("[e2e] spawn_agents specs: {spawn_agent_count}, placements: {spawn_placements:?}");
        assert!(
            tool_calls.iter().any(|t| t == "fleet_snapshot"),
            "the Conductor must sense the fleet before decomposing"
        );
        assert!(
            tool_calls.iter().any(|t| t == "spawn_agents"),
            "the Conductor must delegate via spawn_agents"
        );
        assert!(
            spawn_agent_count >= 2,
            "the Conductor must decompose onto ≥2 agents, got {spawn_agent_count}"
        );
        assert!(
            spawn_placements.iter().any(|p| p == "new"),
            "at least one agent must be placed in a NEW worktree, got {spawn_placements:?}"
        );

        // =====================================================================
        // (b)+(c) two REAL agents in SEPARATE cwds; one returns a report
        // =====================================================================
        // a real production worktree for the implementation agent
        let wt = crate::worktree::add(&repo_str, "swarm/impl-agent", false, None)
            .expect("worktree::add");
        let wt_path = std::fs::canonicalize(&wt.path).unwrap();
        let wt_str = wt_path.to_string_lossy().into_owned();
        println!("[e2e] worktree created: {wt_str}");
        assert_ne!(wt_str, repo_str, "the worktree must be a distinct dir");

        let report_schema = json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "done": { "type": "boolean" },
                "summary": { "type": "string" },
                "files_changed": { "type": "array", "items": { "type": "string" } },
                "tests_pass": { "type": ["boolean", "null"] },
                "needs_human": { "type": "boolean" },
                "question": { "type": ["string", "null"] },
                "followups": { "type": "array", "items": { "type": "string" } }
            },
            "required": ["done", "summary", "files_changed", "tests_pass", "needs_human", "question", "followups"]
        });

        // run one real agent turn in `cwd`; returns the final assistant text
        async fn run_agent(cwd: &str, task: &str, schema: Option<&Value>) -> String {
            let host = ProcessHost::new();
            let (conn, _g) = host.ensure().await.expect("spawn agent");
            let started = conn
                .request(
                    "thread/start",
                    json!({ "cwd": cwd, "sandbox": "danger-full-access", "approvalPolicy": "never" }),
                    THREAD_TIMEOUT_MS,
                )
                .await
                .expect("agent thread/start");
            let tid = started.pointer("/thread/id").and_then(|v| v.as_str()).unwrap().to_string();
            let (tx, mut rx) = mpsc::channel(crate::codex::host::ROUTE_CHANNEL_CAPACITY);
            conn.register_thread(&tid, tx);
            let mut turn = json!({
                "threadId": tid,
                "effort": "low",
                "input": [{ "type": "text", "text": task }],
            });
            if let Some(s) = schema {
                turn["outputSchema"] = s.clone();
            }
            conn.request("turn/start", turn, RPC_TIMEOUT_MS).await.expect("agent turn/start");
            let mut final_text = String::new();
            let deadline = tokio::time::Instant::now() + Duration::from_secs(240);
            loop {
                let ev = tokio::time::timeout_at(deadline, rx.recv())
                    .await
                    .expect("agent timed out")
                    .expect("agent sink closed");
                match ev {
                    ThreadEvent::Request { responder, .. } => {
                        responder.ok(&json!({ "decision": "accept" }))
                    }
                    ThreadEvent::Notification { method, params } => {
                        if method == "item/completed"
                            && params.pointer("/item/type").and_then(|v| v.as_str())
                                == Some("agentMessage")
                        {
                            final_text = params
                                .pointer("/item/text")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                        }
                        if method == "turn/completed" {
                            assert_eq!(
                                params.pointer("/turn/status").and_then(|v| v.as_str()),
                                Some("completed"),
                                "agent turn must complete"
                            );
                            break;
                        }
                    }
                    ThreadEvent::Exited => panic!("agent process exited mid-turn"),
                }
            }
            // host drops here → child killed
            final_text
        }

        // agent ONE — in the worktree, with the report schema
        let report_text = run_agent(
            &wt_str,
            "Create a file GREETING.txt in your current working directory containing exactly the line 'hello from the swarm'. Then fill the required status report.",
            Some(&report_schema),
        )
        .await;
        let report: Value =
            serde_json::from_str(report_text.trim()).expect("agent report must be pure JSON");
        println!("[e2e] impl-agent report: {report}");
        assert_eq!(report["done"], true, "impl agent must report done");
        assert!(
            wt_path.join("GREETING.txt").is_file(),
            "impl agent's file must land IN THE WORKTREE"
        );
        assert!(
            !repo.join("GREETING.txt").is_file(),
            "impl agent's file must NOT leak into the repo root (worktree isolation)"
        );

        // agent TWO — worktree-less, in the repo root
        let _ = run_agent(
            &repo_str,
            "Create a file TEST_MARKER.txt in your current working directory containing exactly the line 'test agent was here'. No other changes.",
            None,
        )
        .await;
        assert!(
            repo.join("TEST_MARKER.txt").is_file(),
            "worktree-less agent's file must land in the repo root"
        );
        assert!(
            !wt_path.join("TEST_MARKER.txt").is_file(),
            "the two agents must not cross cwds"
        );

        // =====================================================================
        // (d) approval classification — the Rust-anchored router
        // =====================================================================
        let destructive = classify_approval(
            "command",
            &json!({ "command": "rm -rf /", "cwd": wt_str }),
            &wt_str,
            false,
        );
        assert_eq!(destructive, "destructive", "rm -rf must stay human-only");
        let routine = classify_approval(
            "command",
            &json!({ "command": "cat README.md", "cwd": repo_str }),
            &repo_str,
            false,
        );
        assert_eq!(routine, "routine", "a read-only cat must be routine");
        println!("[e2e] approval classification: rm -rf → destructive, cat → routine ✓");

        // =====================================================================
        // (e) gated worktree cleanup — refuses dirty, forces on a human call
        // =====================================================================
        // the impl agent left uncommitted work in the worktree → non-force refuses
        let refused =
            crate::worktree::remove(&wt.root, &wt.path, &wt.branch, false, None);
        assert!(
            refused.is_err(),
            "non-force cleanup must REFUSE a worktree with uncommitted work"
        );
        println!("[e2e] gated cleanup correctly refused dirty worktree: {:?}", refused.err());
        // a human decision force-removes it
        crate::worktree::remove(&wt.root, &wt.path, &wt.branch, true, None)
            .expect("force remove must succeed");
        assert!(!wt_path.exists(), "the worktree folder must be gone after force remove");
        println!("[e2e] worktree force-removed ✓");

        // cleanup all scratch artifacts (processes died with their hosts)
        std::fs::remove_dir_all(&base).ok();
        println!("==== phase8 full-swarm E2E spike: all assertions passed ====");
    }

    // ---- Phase-8 compaction spike ----
    //
    // Live proof that `thread/compact/start` (the compact feature) genuinely
    // works on 0.144.1 AND that the turn AFTER compaction still carries the
    // pre-compaction context: turn 1 plants a codeword, compaction runs
    // (observed as the `contextCompaction` item + a completed turn), turn 2
    // asks for the codeword and must still know it. Ignored by default; run:
    //   cargo test phase8_compact_spike -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "live spike — needs the codex CLI, a login and network"]
    async fn phase8_compact_spike() {
        let cwd = std::env::temp_dir().join("swarmz-phase8-compact-spike");
        std::fs::create_dir_all(&cwd).unwrap();
        let host = ProcessHost::new();
        let (conn, _g) = host.ensure().await.expect("spawn app-server");
        let started = conn
            .request(
                "thread/start",
                json!({
                    "cwd": cwd.to_string_lossy(),
                    "sandbox": "read-only",
                    "approvalPolicy": "never",
                    "ephemeral": true,
                }),
                THREAD_TIMEOUT_MS,
            )
            .await
            .expect("thread/start");
        let tid = started.pointer("/thread/id").and_then(|v| v.as_str()).unwrap().to_string();
        let (tx, mut rx) = mpsc::channel(crate::codex::host::ROUTE_CHANNEL_CAPACITY);
        conn.register_thread(&tid, tx);

        // drive one turn/method and collect (final_message, saw_compaction)
        async fn drive(
            conn: &Arc<Connection>,
            rx: &mut mpsc::Receiver<ThreadEvent>,
            method: &str,
            params: Value,
        ) -> (String, bool) {
            conn.request(method, params, RPC_TIMEOUT_MS).await.expect("request");
            let mut final_message = String::new();
            let mut saw_compaction = false;
            let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
            loop {
                let ev = tokio::time::timeout_at(deadline, rx.recv())
                    .await
                    .expect("timed out")
                    .expect("sink closed");
                match ev {
                    ThreadEvent::Request { responder, .. } => {
                        responder.ok(&json!({ "decision": "accept" }))
                    }
                    ThreadEvent::Notification { method, params } => {
                        if method == "item/completed" {
                            match params.pointer("/item/type").and_then(|v| v.as_str()) {
                                Some("agentMessage") => {
                                    final_message = params
                                        .pointer("/item/text")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                }
                                Some("contextCompaction") => saw_compaction = true,
                                _ => {}
                            }
                        }
                        if method == "turn/completed" {
                            break;
                        }
                    }
                    ThreadEvent::Exited => panic!("process exited mid-turn"),
                }
            }
            (final_message, saw_compaction)
        }

        // turn 1: plant a codeword
        drive(
            &conn,
            &mut rx,
            "turn/start",
            json!({ "threadId": tid, "effort": "low", "input": [{ "type": "text", "text":
                "Remember this codeword for later: BANANA-42. Reply with just 'ok'." }] }),
        )
        .await;

        // compaction turn
        let (_m, saw_compaction) =
            drive(&conn, &mut rx, "thread/compact/start", json!({ "threadId": tid })).await;
        println!("[compact] contextCompaction item observed: {saw_compaction}");
        assert!(saw_compaction, "compaction must emit a contextCompaction item");

        // turn 2: the codeword must survive compaction
        let (answer, _) = drive(
            &conn,
            &mut rx,
            "turn/start",
            json!({ "threadId": tid, "effort": "low", "input": [{ "type": "text", "text":
                "What was the codeword I gave you earlier? Reply with just the codeword." }] }),
        )
        .await;
        println!("[compact] post-compaction answer: {answer:?}");
        assert!(
            answer.contains("BANANA-42"),
            "the post-compaction turn must still know the pre-compaction context: {answer}"
        );
        std::fs::remove_dir_all(&cwd).ok();
        println!("==== phase8 compact spike: compaction preserved context ====");
    }
}
