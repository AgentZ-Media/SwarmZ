// Generic `codex app-server` process host — the ONE place that spawns,
// frames and respawns app-server children. Consumers (orchestrator chats,
// Vibe-Mode Codex sessions) never touch the process directly; they hold a
// `Connection`, register their threads with an event sink, and get server
// requests/notifications routed to them per `threadId`.
//
// Layers, bottom to top:
//   - `Client`  — one child process + stdio pumps + PendingRpc id map +
//     reader-EOF `alive` flag. Tauri-free; the #[ignore]d spike tests drive
//     it against the real codex binary.
//   - resolver — `resolve_codex_program` with the packaged-app PATH fix
//     (macOS gives GUI apps a minimal PATH) behind a process-wide cache,
//     shared by every consumer (Settings override applies to all).
//   - `Connection` — Client + handshake + the THREAD REGISTRY: a router
//     task forwards each server event to the sink registered for its
//     `threadId`. Server requests for unregistered threads are refused with
//     -32601; notifications without a registered sink are ignored (that
//     covers account-level notifications and foreign threads alike).
//   - `ProcessHost` — one lazily (re)spawned connection slot with a
//     generation counter. Both process strategies (t3code-inspired) are just
//     how many slots you allocate: the orchestrator shares ONE slot across
//     all its chat threads; a Vibe session owns a PRIVATE slot for its
//     single thread (crash isolation). Spawn/framing/respawn code exists
//     exactly once, here.
//
// Respawn contract: reader EOF drops the `alive` flag, fails all pending
// RPCs and delivers `ThreadEvent::Exited` once per registered sink. The next
// `ensure()` spawns a fresh process and bumps the generation — a consumer
// that sees a generation change transparently `thread/resume`s before its
// next turn (`resume_thread` classifies "unknown thread" failures as the
// typed `ResumeError::ThreadNotFound`, so the consumer can fall back to a
// fresh `thread/start` when the rollout is gone — the t3code fallback).

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};

use super::protocol::{self, Incoming};

/// Budget for ordinary RPCs (initialize, account/read, turn/interrupt, and
/// the immediate turn/start acknowledgement — NOT the turn itself).
pub const RPC_TIMEOUT_MS: u64 = 30_000;
/// thread/start and thread/resume may boot MCP servers from the user's
/// codex config before answering.
pub const THREAD_TIMEOUT_MS: u64 = 120_000;
/// A whole agent turn: model latency + any number of tool roundtrips
/// (the orchestrator's create_panes alone budgets 120 s).
pub const TURN_TIMEOUT_MS: u64 = 30 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Client — process + framing + id map (tauri-free, spike-testable)
// ---------------------------------------------------------------------------

/// Raw events the reader task hands to the per-connection router.
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

/// How long a graceful shutdown (stdin EOF) may take before the child is
/// force-killed — a codex that ignores the EOF must not linger as a zombie.
const SHUTDOWN_KILL_AFTER_MS: u64 = 5_000;

/// Handle to one running `codex app-server` process.
pub struct Client {
    /// Writer channel — `None` after `shutdown()` (closing it drops the
    /// child's stdin → EOF → codex exits; the reader task then reaps it).
    stdin_tx: Mutex<Option<mpsc::UnboundedSender<String>>>,
    pending: Arc<PendingRpc>,
    next_id: AtomicU64,
    alive: Arc<AtomicBool>,
    /// fired by the shutdown watchdog once the EOF grace period elapsed —
    /// the reader task (which owns the child) then force-kills it
    kill: Arc<tokio::sync::Notify>,
}

impl Client {
    /// Spawn `<program> app-server` and wire the stdio pumps. Server-initiated
    /// requests and notifications go to `events`; responses resolve the
    /// pending map. Must run inside a tokio runtime.
    pub async fn spawn(
        program: &str,
        events: mpsc::UnboundedSender<ServerEvent>,
    ) -> Result<Self, String> {
        // enrich the child's PATH with the binary's own dir — the built app's
        // minimal GUI PATH otherwise breaks anything codex spawns by name
        // (user-configured MCP servers etc.)
        let mut cmd = Command::new(program);
        if let Some(dir) = std::path::Path::new(program).parent().filter(|d| !d.as_os_str().is_empty()) {
            let base = std::env::var("PATH").unwrap_or_default();
            cmd.env("PATH", format!("{}:{}", dir.display(), base));
        }
        let mut child = cmd
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

        let kill = Arc::new(tokio::sync::Notify::new());

        // reader: classify each line; owns the child for reaping on EOF and
        // for the force-kill fallback (the kill notify fires when a graceful
        // shutdown's EOF grace period elapsed)
        {
            let pending = pending.clone();
            let alive = alive.clone();
            let kill = kill.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                loop {
                    tokio::select! {
                        line = lines.next_line() => {
                            let Ok(Some(line)) = line else { break };
                            match protocol::parse_line(&line) {
                                Some(Incoming::Response { id, result }) => {
                                    if !pending.resolve(id, result) {
                                        eprintln!("[codex host] app-server response for unknown id {id} — ignored");
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
                        _ = kill.notified() => {
                            // graceful shutdown ignored — force-kill; the
                            // stream then EOFs and the normal cleanup runs
                            eprintln!("[codex host] app-server ignored stdin EOF — force-killing");
                            let _ = child.start_kill();
                        }
                    }
                }
                alive.store(false, Ordering::SeqCst);
                pending.fail_all("codex app-server exited");
                let _ = events.send(ServerEvent::Exited);
                let _ = child.wait().await; // reap
            });
        }

        Ok(Client {
            stdin_tx: Mutex::new(Some(stdin_tx)),
            pending,
            next_id: AtomicU64::new(1),
            alive,
            kill,
        })
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Send one line to the writer task. Err = writer gone (shutdown/exited).
    fn send_line(&self, line: String) -> Result<(), ()> {
        match &*self.stdin_tx.lock() {
            Some(tx) => tx.send(line).map_err(|_| ()),
            None => Err(()),
        }
    }

    /// Graceful shutdown: close the writer channel — the writer task ends,
    /// the child's stdin drops (EOF) and codex exits; the reader task then
    /// fails pending RPCs and emits `Exited`. A watchdog force-kills the
    /// child if it ignores the EOF for `SHUTDOWN_KILL_AFTER_MS` (no zombies
    /// until app quit). Idempotent.
    pub fn shutdown(&self) {
        let armed = self.stdin_tx.lock().take().is_some();
        if !armed {
            return; // already shut down — don't arm a second watchdog
        }
        let alive = self.alive.clone();
        let kill = self.kill.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(SHUTDOWN_KILL_AFTER_MS)).await;
            if alive.load(Ordering::SeqCst) {
                kill.notify_waiters();
            }
        });
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
            .send_line(protocol::request_line(id, method, &params))
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
        let _ = self.send_line(protocol::notification_line(method));
    }

    /// Answer a server-initiated request.
    pub fn respond(&self, id: &Value, result: &Value) {
        let _ = self.send_line(protocol::response_line(id, result));
    }

    pub fn respond_error(&self, id: &Value, code: i64, message: &str) {
        let _ = self.send_line(protocol::error_response_line(id, code, message));
    }
}

/// initialize (experimentalApi — required for dynamicTools) + `initialized`.
/// Returns the server's userAgent (carries the codex version). The
/// clientInfo name "SwarmZ" also lands as `originator` in the session
/// rollouts — that is how SwarmZ-born sessions are recognizable on disk
/// (live-verified on 0.144.1: `session_meta.payload.originator` echoes the
/// clientInfo name, while `source` is always "vscode" for app-server
/// clients — never use `source` for own-session detection).
pub async fn handshake(client: &Client) -> Result<String, String> {
    let res = client
        .request(
            "initialize",
            json!({
                "clientInfo": {
                    "name": "SwarmZ",
                    "title": "SwarmZ",
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
// Binary resolution — process-wide cache, shared by every consumer
// ---------------------------------------------------------------------------

/// First `codex` binary found in `dirs` (pure — unit-tested).
fn find_codex_in(dirs: impl Iterator<Item = std::path::PathBuf>) -> Option<String> {
    dirs.map(|d| d.join("codex"))
        .find(|c| c.is_file())
        .map(|c| c.to_string_lossy().into_owned())
}

/// Resolve the codex binary to an ABSOLUTE path. macOS gives GUI apps a
/// minimal PATH (/usr/bin:/bin:…), so the bare `codex` that works in dev
/// (inherited shell PATH) fails in the built app with "No such file or
/// directory". Order: settings override → current $PATH → well-known install
/// dirs → login-shell probe (loads nvm/asdf/mise profiles). Blocking work —
/// callers wrap in spawn_blocking.
pub(crate) fn resolve_codex_program(override_path: Option<&str>) -> Result<String, String> {
    if let Some(p) = override_path.map(str::trim).filter(|p| !p.is_empty()) {
        return Ok(p.to_string());
    }
    if let Some(path) = std::env::var_os("PATH") {
        if let Some(found) = find_codex_in(std::env::split_paths(&path)) {
            return Ok(found);
        }
    }
    let mut known: Vec<std::path::PathBuf> =
        vec!["/opt/homebrew/bin".into(), "/usr/local/bin".into()];
    if let Some(h) = dirs::home_dir() {
        for rel in [".local/bin", ".bun/bin", ".volta/bin", ".cargo/bin", ".npm-global/bin"] {
            known.push(h.join(rel));
        }
    }
    if let Some(found) = find_codex_in(known.into_iter()) {
        return Ok(found);
    }
    if let Ok(out) = std::process::Command::new("/bin/zsh")
        .args(["-lc", "command -v codex"])
        .output()
    {
        if out.status.success() {
            let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !p.is_empty() {
                return Ok(p);
            }
        }
    }
    Err(
        "codex CLI not found on this system — install it or set the Codex binary path in Settings"
            .to_string(),
    )
}

#[derive(Default)]
struct Resolver {
    override_path: Option<String>,
    /// absolute codex binary resolved for the CURRENT override — cleared
    /// whenever the override is (re)set or a spawn with it fails (a cached
    /// path may go stale when codex moves/uninstalls)
    resolved: Option<String>,
}

static RESOLVER: Lazy<Mutex<Resolver>> = Lazy::new(Mutex::default);

/// Install the Settings codex-binary override (the frontend passes the
/// current value on relevant calls; empty/whitespace clears it back to
/// auto-resolution). Always drops the cached resolution.
pub fn set_codex_override(raw: Option<String>) {
    let normalized = raw.and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    let mut r = RESOLVER.lock();
    r.override_path = normalized;
    r.resolved = None; // path (possibly) changed — re-resolve on next spawn
}

/// Cached-or-fresh absolute codex path (resolution runs in spawn_blocking).
async fn resolved_program() -> Result<String, String> {
    if let Some(p) = RESOLVER.lock().resolved.clone() {
        return Ok(p);
    }
    let override_path = RESOLVER.lock().override_path.clone();
    let resolved = tokio::task::spawn_blocking(move || {
        resolve_codex_program(override_path.as_deref())
    })
    .await
    .map_err(|e| e.to_string())??;
    RESOLVER.lock().resolved = Some(resolved.clone());
    Ok(resolved)
}

fn invalidate_resolved_program() {
    RESOLVER.lock().resolved = None;
}

// ---------------------------------------------------------------------------
// Thread registry + Connection — per-threadId event routing
// ---------------------------------------------------------------------------

/// Where a registered thread's server events land. Multiple threads may
/// share one sink (the orchestrator does — one dispatcher for all chats).
pub type EventSink = mpsc::UnboundedSender<ThreadEvent>;

/// Answer handle for a routed server request — carries the request id and
/// the owning client, so the consumer never has to track which process
/// (generation) the request came from.
#[derive(Clone)]
pub struct Responder {
    client: Arc<Client>,
    id: Value,
}

impl Responder {
    pub fn ok(&self, result: &Value) {
        self.client.respond(&self.id, result);
    }

    pub fn error(&self, code: i64, message: &str) {
        self.client.respond_error(&self.id, code, message);
    }
}

impl std::fmt::Debug for Responder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Responder").field("id", &self.id).finish()
    }
}

/// Events delivered to a registered thread's sink.
#[derive(Debug)]
pub enum ThreadEvent {
    /// Server-initiated request for this thread — MUST be answered via the
    /// responder (the app-server blocks on it, e.g. approvals).
    Request {
        method: String,
        params: Value,
        responder: Responder,
    },
    /// Fire-and-forget notification carrying this thread's `threadId`.
    Notification { method: String, params: Value },
    /// The owning process died. Delivered ONCE per distinct sink (not per
    /// registered thread), so a shared dispatcher sees a single exit.
    Exited,
}

#[derive(Default)]
struct RouteTable {
    inner: Mutex<HashMap<String, EventSink>>,
}

impl RouteTable {
    fn insert(&self, thread_id: &str, sink: EventSink) {
        self.inner.lock().insert(thread_id.to_string(), sink);
    }

    fn remove(&self, thread_id: &str) {
        self.inner.lock().remove(thread_id);
    }

    fn get(&self, thread_id: &str) -> Option<EventSink> {
        self.inner.lock().get(thread_id).cloned()
    }

    /// Drain all routes, deduped to one sink per underlying channel — the
    /// process is gone, each consumer should hear about it exactly once.
    fn drain_distinct(&self) -> Vec<EventSink> {
        let sinks: Vec<EventSink> = self.inner.lock().drain().map(|(_, s)| s).collect();
        let mut distinct: Vec<EventSink> = Vec::new();
        for s in sinks {
            if !distinct.iter().any(|d| d.same_channel(&s)) {
                distinct.push(s);
            }
        }
        distinct
    }
}

/// One live app-server process with its router and handshake done. The unit
/// both process strategies hold; obtained via `ProcessHost::ensure`.
pub struct Connection {
    client: Arc<Client>,
    routes: Arc<RouteTable>,
    version: String,
}

impl Connection {
    /// Resolve + spawn + wire the router + handshake. On spawn failure the
    /// cached binary resolution is dropped so the next attempt re-resolves
    /// from scratch (codex may have moved/uninstalled).
    async fn open() -> Result<Arc<Connection>, String> {
        let program = resolved_program().await?;
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let client = match Client::spawn(&program, events_tx).await {
            Ok(c) => Arc::new(c),
            Err(e) => {
                invalidate_resolved_program();
                return Err(e);
            }
        };
        let routes = Arc::new(RouteTable::default());
        spawn_router(client.clone(), routes.clone(), events_rx);
        let version = handshake(&client)
            .await
            .map_err(|e| format!("codex app-server initialize failed: {e}"))?;
        Ok(Arc::new(Connection {
            client,
            routes,
            version,
        }))
    }

    /// The initialize userAgent (carries the codex version).
    pub fn version(&self) -> &str {
        &self.version
    }

    pub fn is_alive(&self) -> bool {
        self.client.is_alive()
    }

    /// One request/response roundtrip on this process.
    pub async fn request(
        &self,
        method: &str,
        params: Value,
        timeout_ms: u64,
    ) -> Result<Value, String> {
        self.client.request(method, params, timeout_ms).await
    }

    /// Route this thread's server events to `sink`. Re-register after every
    /// respawn (routes die with the process). Registering an already-routed
    /// thread replaces its sink.
    pub fn register_thread(&self, thread_id: &str, sink: EventSink) {
        self.routes.insert(thread_id, sink);
    }

    /// Not called by the orchestrator (its chats live as long as the app);
    /// the Vibe sessions (Phase 2) unregister on session close.
    #[allow(dead_code)]
    pub fn unregister_thread(&self, thread_id: &str) {
        self.routes.remove(thread_id);
    }

    /// Graceful process shutdown (see `Client::shutdown`) — the registered
    /// sinks still receive their `Exited` once the reader observes EOF.
    pub fn shutdown(&self) {
        self.client.shutdown();
    }
}

/// The per-connection router: forwards each raw server event to the sink
/// registered for its `threadId`. No sink responsible → notifications are
/// ignored, server requests are refused with -32601 (the server treats that
/// as a denial and the turn continues/fails) — same net behavior the
/// orchestrator dispatcher had for unknown methods.
fn spawn_router(
    client: Arc<Client>,
    routes: Arc<RouteTable>,
    mut rx: mpsc::UnboundedReceiver<ServerEvent>,
) {
    tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            match ev {
                ServerEvent::Request { id, method, params } => {
                    let sink = params
                        .get("threadId")
                        .and_then(|v| v.as_str())
                        .and_then(|tid| routes.get(tid));
                    let responder = Responder {
                        client: client.clone(),
                        id,
                    };
                    match sink {
                        Some(s) => {
                            if let Err(failed) = s.send(ThreadEvent::Request {
                                method,
                                params,
                                responder,
                            }) {
                                // consumer gone (sink dropped) — the request
                                // must still be answered or the server hangs
                                if let ThreadEvent::Request { responder, .. } = failed.0 {
                                    responder.error(-32601, "SwarmZ consumer for this thread is gone");
                                }
                            }
                        }
                        None => responder.error(-32601, "no SwarmZ consumer registered for this thread"),
                    }
                }
                ServerEvent::Notification { method, params } => {
                    if let Some(sink) = params
                        .get("threadId")
                        .and_then(|v| v.as_str())
                        .and_then(|tid| routes.get(tid))
                    {
                        let _ = sink.send(ThreadEvent::Notification { method, params });
                    }
                    // no sink: account-level or foreign-thread notification — ignore
                }
                ServerEvent::Exited => {
                    for sink in routes.drain_distinct() {
                        let _ = sink.send(ThreadEvent::Exited);
                    }
                    break;
                }
            }
        }
    });
}

// ---------------------------------------------------------------------------
// ProcessHost — one lazily (re)spawned connection slot
// ---------------------------------------------------------------------------

#[derive(Default)]
struct ProcessHostState {
    conn: Option<Arc<Connection>>,
    /// bumped per successful spawn+handshake — consumers compare their
    /// per-thread copy to detect respawns (→ transparent thread/resume)
    generation: u64,
    /// survives respawn failures, for status reporting
    last_version: Option<String>,
}

/// One (re)spawnable app-server slot. Strategy (a): the orchestrator keeps a
/// single static slot and multiplexes all chat threads over it. Strategy
/// (b): each Vibe session allocates its own slot — a crash there kills only
/// that session's process.
pub struct ProcessHost {
    // tokio mutex because ensure() awaits while holding it (spawn +
    // handshake, a few hundred ms; never a whole turn)
    state: tokio::sync::Mutex<ProcessHostState>,
}

impl ProcessHost {
    pub fn new() -> Self {
        ProcessHost {
            state: tokio::sync::Mutex::new(ProcessHostState::default()),
        }
    }

    /// A live, initialized connection + its spawn generation; (re)spawns
    /// lazily. A generation different from the one a consumer stored for its
    /// thread means "the process restarted since — resume before the next
    /// turn".
    pub async fn ensure(&self) -> Result<(Arc<Connection>, u64), String> {
        let mut st = self.state.lock().await;
        if let Some(c) = &st.conn {
            if c.is_alive() {
                return Ok((c.clone(), st.generation));
            }
        }
        let conn = Connection::open().await?;
        st.generation += 1;
        st.last_version = Some(conn.version().to_string());
        st.conn = Some(conn.clone());
        Ok((conn, st.generation))
    }

    /// The current connection, only if it is still alive (never spawns).
    pub async fn alive(&self) -> Option<Arc<Connection>> {
        let st = self.state.lock().await;
        st.conn.as_ref().filter(|c| c.is_alive()).cloned()
    }

    /// The codex version of the last successful spawn (status reporting).
    pub async fn last_version(&self) -> Option<String> {
        self.state.lock().await.last_version.clone()
    }

    /// Gracefully end the slot's process (idle reaping): the connection is
    /// dropped from the slot and its stdin closed — codex exits on EOF and
    /// every registered sink hears `Exited`. The next `ensure()` respawns
    /// with a bumped generation, so consumers transparently `thread/resume`.
    pub async fn shutdown(&self) {
        let mut st = self.state.lock().await;
        if let Some(conn) = st.conn.take() {
            conn.shutdown();
        }
    }
}

impl Default for ProcessHost {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Typed thread/resume — the t3code fallback signal
// ---------------------------------------------------------------------------

/// Why a `thread/resume` failed — `ThreadNotFound` is the consumer's cue to
/// fall back to a fresh `thread/start` (rollout deleted / never persisted).
#[derive(Debug)]
pub enum ResumeError {
    ThreadNotFound(String),
    Other(String),
}

impl ResumeError {
    pub fn message(&self) -> &str {
        match self {
            ResumeError::ThreadNotFound(m) | ResumeError::Other(m) => m,
        }
    }
}

/// Does this error text mean "the server does not know this thread"?
/// "no rollout found" is what codex actually answers — live-verified on
/// 0.142.5 and re-verified verbatim on 0.144.1
/// (`no rollout found for thread id … (code -32600)`);
/// the other substrings follow t3code's recoverable-resume matcher for
/// robustness across versions.
pub fn is_unknown_thread_error(err: &str) -> bool {
    let lower = err.to_lowercase();
    [
        "no rollout found",
        "not found",
        "unknown thread",
        "does not exist",
        "no such thread",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

/// `thread/resume` with typed failure classification. Params are the
/// consumer's (`threadId` + its usual thread config — dynamicTools are NOT
/// re-declarable here; codex restores them from the rollout).
pub async fn resume_thread(conn: &Connection, params: Value) -> Result<Value, ResumeError> {
    conn.request("thread/resume", params, THREAD_TIMEOUT_MS)
        .await
        .map_err(|e| {
            if is_unknown_thread_error(&e) {
                ResumeError::ThreadNotFound(e)
            } else {
                ResumeError::Other(e)
            }
        })
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
    fn codex_resolution_prefers_override_and_scans_dirs() {
        // explicit override wins untouched (even if it doesn't exist)
        assert_eq!(
            resolve_codex_program(Some("  /custom/codex  ")).unwrap(),
            "/custom/codex"
        );
        // pure dir scan: only the dir that actually holds a codex file hits
        let dir = std::env::temp_dir().join(format!(
            "swarmz-codex-resolve-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(
            find_codex_in([dir.join("missing"), dir.clone()].into_iter()),
            None
        );
        std::fs::write(dir.join("codex"), "").unwrap();
        assert_eq!(
            find_codex_in([dir.join("missing"), dir.clone()].into_iter()),
            Some(dir.join("codex").to_string_lossy().into_owned())
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unknown_thread_errors_are_classified() {
        for msg in [
            // verbatim live answer from codex (0.142.5 spike, re-verified on 0.144.1)
            "no rollout found for thread id 019f0000-0000-7000-8000-000000000000 (code -32600)",
            "thread not found (code -32600)",
            "Unknown thread id 019f…",
            "thread 019f… does not exist",
            "No such thread",
        ] {
            assert!(is_unknown_thread_error(msg), "{msg}");
        }
        for msg in ["network unreachable", "timed out after 120000 ms"] {
            assert!(!is_unknown_thread_error(msg), "{msg}");
        }
    }

    #[tokio::test]
    async fn route_table_routes_and_broadcasts_exit_once_per_sink() {
        let routes = RouteTable::default();
        let (shared_tx, mut shared_rx) = mpsc::unbounded_channel();
        let (solo_tx, mut solo_rx) = mpsc::unbounded_channel();
        // two threads share one sink (orchestrator pattern), one has its own
        routes.insert("t-1", shared_tx.clone());
        routes.insert("t-2", shared_tx.clone());
        routes.insert("t-3", solo_tx);

        assert!(routes.get("t-1").is_some());
        assert!(routes.get("nope").is_none());
        routes.remove("t-2");
        assert!(routes.get("t-2").is_none());
        routes.insert("t-2", shared_tx);

        // process death: each distinct sink hears Exited exactly once
        for sink in routes.drain_distinct() {
            let _ = sink.send(ThreadEvent::Exited);
        }
        assert!(matches!(shared_rx.recv().await, Some(ThreadEvent::Exited)));
        assert!(matches!(solo_rx.recv().await, Some(ThreadEvent::Exited)));
        assert!(
            shared_rx.try_recv().is_err(),
            "shared sink must get exactly ONE Exited despite two routes"
        );
        assert!(routes.get("t-1").is_none(), "routes drained with the process");
    }

    // ---- session spike (Vibe Mode Phase 1) ----
    //
    // Live proof against the REAL installed codex CLI: two SESSIONS with a
    // dedicated process each (strategy b), running turns in parallel under
    // sandbox workspace-write + approvalPolicy "untrusted" (forces a command
    // approval), with a real approval accept-roundtrip, fileChange items,
    // turn/diff/updated and token usage observed. Ignored by default (needs
    // codex + login + network — CI stays green); run with:
    //   cargo test session_spike -- --ignored --nocapture

    struct SessionOutcome {
        label: &'static str,
        thread_id: String,
        turn_status: String,
        cmd_approvals: usize,
        file_approvals: usize,
        approved_cmd_completed_ok: bool,
        file_change_completed: bool,
        last_diff: Option<String>,
        last_token_total: Option<u64>,
        started_at: std::time::Instant,
        finished_at: std::time::Instant,
    }

    async fn drive_spike_session(
        label: &'static str,
        cwd: std::path::PathBuf,
        file_name: &str,
        log: Arc<Mutex<Vec<String>>>,
        t0: std::time::Instant,
    ) -> SessionOutcome {
        let push = |log: &Arc<Mutex<Vec<String>>>, line: String| {
            let stamped = format!("[{:>7.3}s] [{label}] {line}", t0.elapsed().as_secs_f64());
            println!("{stamped}");
            log.lock().push(stamped);
        };

        // strategy (b): a private ProcessHost slot for this one session
        let host = ProcessHost::new();
        let (conn, generation) = host.ensure().await.expect("spawn dedicated app-server");
        push(&log, format!("process up (generation {generation}, {})", conn.version()));

        let started = conn
            .request(
                "thread/start",
                json!({
                    "cwd": cwd.to_string_lossy(),
                    "sandbox": "workspace-write",
                    "approvalPolicy": "untrusted",
                    "ephemeral": true,
                    "developerInstructions": "You are a test agent. Do exactly what the user asks, nothing more.",
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
        push(&log, format!("thread started: {thread_id}"));

        let (sink_tx, mut sink_rx) = mpsc::unbounded_channel();
        conn.register_thread(&thread_id, sink_tx);

        // apply_patch under "untrusted" triggers a fileChange approval;
        // `touch` is not on the trusted-command list and forces a
        // commandExecution approval (`cat` alone would NOT — it counts as
        // trusted; live-verified)
        let prompt = format!(
            "Two steps, in order: (1) create a file named {file_name} with the exact \
             content 'alpha' (use apply_patch); (2) run the shell command \
             `touch done.marker && cat {file_name}` and reply with exactly what it printed."
        );
        let started_at = std::time::Instant::now();
        conn.request(
            "turn/start",
            json!({ "threadId": thread_id, "input": [{ "type": "text", "text": prompt }] }),
            RPC_TIMEOUT_MS,
        )
        .await
        .expect("turn/start");

        let mut cmd_approvals = 0usize;
        let mut file_approvals = 0usize;
        let mut approved_cmd_ids: Vec<String> = Vec::new();
        let mut approved_cmd_completed_ok = false;
        let mut file_change_completed = false;
        let mut last_diff: Option<String> = None;
        let mut last_token_total: Option<u64> = None;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
        let turn_status = loop {
            let ev = tokio::time::timeout_at(deadline, sink_rx.recv())
                .await
                .expect("spike session timed out")
                .expect("event sink closed");
            match ev {
                ThreadEvent::Request { method, params, responder } => match method.as_str() {
                    "item/commandExecution/requestApproval"
                    | "item/fileChange/requestApproval" => {
                        push(
                            &log,
                            format!(
                                "APPROVAL request: {method} — reason={:?} command={:?} decisions={}",
                                params.get("reason").and_then(|v| v.as_str()),
                                params.get("command").and_then(|v| v.as_str()),
                                params.get("availableDecisions").cloned().unwrap_or(Value::Null),
                            ),
                        );
                        if method == "item/commandExecution/requestApproval" {
                            cmd_approvals += 1;
                            if let Some(item_id) = params.get("itemId").and_then(|v| v.as_str()) {
                                approved_cmd_ids.push(item_id.to_string());
                            }
                        } else {
                            file_approvals += 1;
                        }
                        responder.ok(&json!({ "decision": "accept" }));
                    }
                    other => {
                        push(&log, format!("unexpected server request {other} — refusing"));
                        responder.error(-32601, "not supported by the spike");
                    }
                },
                ThreadEvent::Notification { method, params } => match method.as_str() {
                    "item/completed" => {
                        let item = params.get("item").cloned().unwrap_or(Value::Null);
                        let ty = item.get("type").and_then(|v| v.as_str()).unwrap_or("?");
                        let status = item.get("status").and_then(|v| v.as_str()).unwrap_or("-");
                        match ty {
                            "fileChange" => {
                                push(&log, format!("fileChange completed: {}", item["changes"]));
                                if status == "completed" {
                                    file_change_completed = true;
                                }
                            }
                            "commandExecution" => {
                                let exit = item.get("exitCode").cloned().unwrap_or(Value::Null);
                                push(
                                    &log,
                                    format!(
                                        "commandExecution completed: status={status} exit={exit} cmd={:?}",
                                        item.get("command").and_then(|v| v.as_str())
                                    ),
                                );
                                let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
                                if approved_cmd_ids.iter().any(|a| a == id)
                                    && status == "completed"
                                    && exit == json!(0)
                                {
                                    approved_cmd_completed_ok = true;
                                }
                            }
                            "agentMessage" => {
                                push(
                                    &log,
                                    format!(
                                        "agentMessage: {:?}",
                                        item.get("text").and_then(|v| v.as_str())
                                    ),
                                );
                            }
                            _ => {}
                        }
                    }
                    "turn/diff/updated" => {
                        let diff = params.get("diff").and_then(|v| v.as_str()).unwrap_or("");
                        push(&log, format!("turn/diff/updated ({} chars): {diff:?}", diff.len()));
                        last_diff = Some(diff.to_string());
                    }
                    "thread/tokenUsage/updated" => {
                        let total = params
                            .pointer("/tokenUsage/total/totalTokens")
                            .and_then(|v| v.as_u64());
                        push(&log, format!("tokenUsage: total={total:?}"));
                        last_token_total = total;
                    }
                    "turn/completed" => {
                        let status = params
                            .pointer("/turn/status")
                            .and_then(|v| v.as_str())
                            .unwrap_or("?")
                            .to_string();
                        push(&log, format!("turn completed: {status}"));
                        break status;
                    }
                    _ => {}
                },
                ThreadEvent::Exited => panic!("[{label}] app-server exited mid-spike"),
            }
        };
        let finished_at = std::time::Instant::now();

        // t3code fallback, live: resuming a thread this process never saw
        // must classify as ThreadNotFound (the cue for a fresh thread/start)
        let bogus = resume_thread(
            &conn,
            json!({ "threadId": "019f0000-0000-7000-8000-000000000000" }),
        )
        .await;
        match &bogus {
            Err(ResumeError::ThreadNotFound(m)) => {
                push(&log, format!("bogus thread/resume → ThreadNotFound: {m}"))
            }
            Err(ResumeError::Other(m)) => {
                push(&log, format!("bogus thread/resume → OTHER (classifier miss!): {m}"))
            }
            Ok(_) => push(&log, "bogus thread/resume unexpectedly SUCCEEDED".into()),
        }
        assert!(
            matches!(bogus, Err(ResumeError::ThreadNotFound(_))),
            "resume of an unknown thread must classify as ThreadNotFound"
        );

        SessionOutcome {
            label,
            thread_id,
            turn_status,
            cmd_approvals,
            file_approvals,
            approved_cmd_completed_ok,
            file_change_completed,
            last_diff,
            last_token_total,
            started_at,
            finished_at,
        }
    }

    #[tokio::test]
    #[ignore]
    async fn session_spike() {
        let base = std::env::temp_dir().join("swarmz-session-spike");
        let cwd_a = base.join("a");
        let cwd_b = base.join("b");
        for (cwd, file) in [(&cwd_a, "probe_a.txt"), (&cwd_b, "probe_b.txt")] {
            std::fs::create_dir_all(cwd).unwrap();
            std::fs::remove_file(cwd.join(file)).ok(); // the write must be real
            std::fs::remove_file(cwd.join("done.marker")).ok(); // so must the command
        }

        let log = Arc::new(Mutex::new(Vec::new()));
        let t0 = std::time::Instant::now();
        // two dedicated processes, both turns genuinely in parallel
        let (a, b) = tokio::join!(
            drive_spike_session("A", cwd_a.clone(), "probe_a.txt", log.clone(), t0),
            drive_spike_session("B", cwd_b.clone(), "probe_b.txt", log.clone(), t0),
        );

        println!("\n==== session spike summary ====");
        for s in [&a, &b] {
            println!(
                "[{}] thread={} status={} cmd_approvals={} file_approvals={} approved_cmd_ok={} file_change={} tokens={:?} diff={} chars",
                s.label,
                s.thread_id,
                s.turn_status,
                s.cmd_approvals,
                s.file_approvals,
                s.approved_cmd_completed_ok,
                s.file_change_completed,
                s.last_token_total,
                s.last_diff.as_deref().map(str::len).unwrap_or(0),
            );
        }
        let overlapped = a.started_at < b.finished_at && b.started_at < a.finished_at;
        println!("turn windows overlapped (true parallelism): {overlapped}");

        for (s, cwd, file) in [(&a, &cwd_a, "probe_a.txt"), (&b, &cwd_b, "probe_b.txt")] {
            assert_eq!(s.turn_status, "completed", "[{}] turn must complete", s.label);
            assert!(
                s.cmd_approvals >= 1,
                "[{}] untrusted policy must force a command approval for `touch`",
                s.label
            );
            assert!(
                s.approved_cmd_completed_ok,
                "[{}] the accepted command must run to exitCode 0",
                s.label
            );
            assert!(
                s.file_change_completed,
                "[{}] a completed fileChange item must be observed",
                s.label
            );
            let content = std::fs::read_to_string(cwd.join(file))
                .unwrap_or_else(|e| panic!("[{}] {file} missing: {e}", s.label));
            assert!(
                content.contains("alpha"),
                "[{}] {file} content unexpected: {content:?}",
                s.label
            );
            assert!(
                cwd.join("done.marker").is_file(),
                "[{}] the approved command's side effect (done.marker) is missing",
                s.label
            );
        }
    }
}
