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
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot, watch, Semaphore};

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

/// Hard cap on ONE protocol line from the child's stdout (audit R8): a
/// broken/hostile child streaming an endless line must not OOM the app.
/// Enforced BEFORE parse/enqueue. Together with the 32-slot raw and route
/// queues this gives an approximate 64 MiB queued-payload ceiling per client
/// across both stages (plus JSON object overhead), rather than a count-only
/// bound whose theoretical footprint was multiple GiB. An oversized record
/// is consumed and dropped; framing remains intact.
const MAX_LINE_BYTES: usize = 1024 * 1024;
/// Stderr is log output — one line beyond this is noise, not data.
const MAX_STDERR_LINE_BYTES: usize = 8 * 1024;
/// Server-event queue between the reader task and the router (audit R8):
/// bounded so a flood backpressures the child's stdout pipe instead of
/// growing an unbounded queue. The router forwards to per-thread route
/// queues that are bounded too (F10, `ROUTE_CHANNEL_CAPACITY`) — a stalled
/// consumer backpressures end to end instead of ballooning memory.
const EVENTS_CHANNEL_CAPACITY: usize = 32;
/// Outgoing-line queue to the writer task (audit R8): RPCs and approval
/// responses are small and rare; a full queue means the child stopped
/// reading its stdin — failing fast is correct then.
const STDIN_CHANNEL_CAPACITY: usize = 256;

/// Process-wide child budget shared by Conductors and worker sessions. A
/// project/session storm must not turn the desktop app into an unbounded
/// process launcher. The permit lives in the reader/reaper task and is only
/// returned after the OS child has actually exited.
const MAX_CODEX_PROCESSES: usize = 48;
static CODEX_PROCESS_BUDGET: Lazy<Arc<Semaphore>> =
    Lazy::new(|| Arc::new(Semaphore::new(MAX_CODEX_PROCESSES)));

/// One bounded read from a line-delimited stream.
enum BoundedLine {
    Line(String),
    /// the line exceeded the cap — it was fully consumed and discarded
    Oversize,
    Eof,
}

/// Read the next newline-terminated line without ever buffering more than
/// `max` bytes (audit R8 — `BufRead::lines()` would buffer the whole line).
async fn next_line_bounded<R>(reader: &mut R, max: usize) -> std::io::Result<BoundedLine>
where
    R: tokio::io::AsyncBufRead + Unpin,
{
    use tokio::io::AsyncBufReadExt;
    let mut buf: Vec<u8> = Vec::new();
    let mut skipping = false;
    loop {
        let chunk = reader.fill_buf().await?;
        if chunk.is_empty() {
            // EOF
            return Ok(if skipping {
                BoundedLine::Oversize
            } else if buf.is_empty() {
                BoundedLine::Eof
            } else {
                BoundedLine::Line(String::from_utf8_lossy(&buf).into_owned())
            });
        }
        match chunk.iter().position(|&b| b == b'\n') {
            Some(pos) => {
                let over = !skipping && buf.len() + pos > max;
                if !skipping && !over {
                    buf.extend_from_slice(&chunk[..pos]);
                }
                reader.consume(pos + 1);
                if skipping || over {
                    return Ok(BoundedLine::Oversize);
                }
                if buf.last() == Some(&b'\r') {
                    buf.pop();
                }
                return Ok(BoundedLine::Line(
                    String::from_utf8_lossy(&buf).into_owned(),
                ));
            }
            None => {
                let len = chunk.len();
                if !skipping {
                    if buf.len() + len > max {
                        buf = Vec::new(); // drop what we buffered
                        skipping = true;
                    } else {
                        buf.extend_from_slice(chunk);
                    }
                }
                reader.consume(len);
            }
        }
    }
}

/// Handle to one running `codex app-server` process.
pub struct Client {
    /// Writer channel — `None` after `shutdown()` (closing it drops the
    /// child's stdin → EOF → codex exits; the reader task then reaps it).
    /// Bounded (audit R8): a child that stopped reading fails sends fast.
    stdin_tx: Mutex<Option<mpsc::Sender<String>>>,
    pending: Arc<PendingRpc>,
    next_id: AtomicU64,
    alive: Arc<AtomicBool>,
    /// Persistent cancellation signal fired by the shutdown watchdog once the
    /// EOF grace period elapsed. Unlike `Notify::notify_waiters`, a watch value
    /// cannot be lost while the reader is blocked forwarding into a full queue.
    kill: watch::Sender<bool>,
}

impl Client {
    /// Spawn `<program> app-server` and wire the stdio pumps. Server-initiated
    /// requests and notifications go to `events` (bounded — see
    /// `EVENTS_CHANNEL_CAPACITY`); responses resolve the pending map. Must
    /// run inside a tokio runtime.
    pub async fn spawn(program: &str, events: mpsc::Sender<ServerEvent>) -> Result<Self, String> {
        let process_permit = CODEX_PROCESS_BUDGET
            .clone()
            .try_acquire_owned()
            .map_err(|_| {
                format!(
                    "refusing to start another codex app-server: global process budget ({MAX_CODEX_PROCESSES}) is exhausted — close idle agents and retry"
                )
            })?;
        // enrich the child's PATH with the binary's own dir — the built app's
        // minimal GUI PATH otherwise breaks anything codex spawns by name
        // (user-configured MCP servers etc.)
        let mut cmd = Command::new(program);
        // Never leak the desktop process' ambient credentials into Codex
        // workers. Mission lanes are intentionally secret-free by default,
        // and ordinary sessions should follow the same predictable boundary.
        // Explicit runtime environments resolve narrowly-scoped secret
        // references in their native runner instead of inheriting everything.
        cmd.env_clear();
        for key in [
            "HOME",
            "TMPDIR",
            "LANG",
            "LC_ALL",
            "SHELL",
            "TERM",
            "CODEX_HOME",
        ] {
            if let Some(value) = std::env::var_os(key) {
                cmd.env(key, value);
            }
        }
        if let Some(dir) = std::path::Path::new(program)
            .parent()
            .filter(|d| !d.as_os_str().is_empty())
        {
            let base = std::env::var("PATH").unwrap_or_default();
            cmd.env("PATH", format!("{}:{}", dir.display(), base));
        }
        // SwarmZ processes run WITHOUT the user's global MCP servers (see
        // `mcp_disable_args`) — the user's config.toml is only READ, never
        // modified. The read is tiny but still file I/O → spawn_blocking.
        // FAIL-CLOSED (audit R12): an enabled server whose name cannot ride
        // the `-c` disable path refuses the spawn instead of silently
        // booting that server into every SwarmZ child.
        let mcp_off = tokio::task::spawn_blocking(mcp_disable_args)
            .await
            .map_err(|e| e.to_string())??;
        cmd.arg("app-server")
            .args(&mcp_off)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        unsafe {
            // Own process group: a force-stop must also terminate commands or
            // helpers the app-server still owns.
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to start `{program} app-server`: {e}"))?;
        #[cfg(unix)]
        let child_pid = child.id().ok_or("app-server: no process id")? as libc::pid_t;
        let mut stdin = child.stdin.take().ok_or("app-server: no stdin")?;
        let stdout = child.stdout.take().ok_or("app-server: no stdout")?;
        let stderr = child.stderr.take();

        let (stdin_tx, mut stdin_rx) = mpsc::channel::<String>(STDIN_CHANNEL_CAPACITY);
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

        // stderr → log lines (codex logs there; useful when things go wrong).
        // Bounded per line (audit R8/R12): a flooding child can't OOM the
        // logger, and one runaway line is truncated instead of echoed whole.
        if let Some(err) = stderr {
            tokio::spawn(async move {
                let mut reader = BufReader::new(err);
                loop {
                    match next_line_bounded(&mut reader, MAX_STDERR_LINE_BYTES).await {
                        Ok(BoundedLine::Line(l)) => eprintln!("[codex app-server] {l}"),
                        Ok(BoundedLine::Oversize) => {
                            eprintln!("[codex app-server] (oversized stderr line truncated)")
                        }
                        Ok(BoundedLine::Eof) | Err(_) => break,
                    }
                }
            });
        }

        let (kill, mut kill_rx) = watch::channel(false);

        // reader: classify each line; owns the child for reaping on EOF and
        // for the force-kill fallback (the kill notify fires when a graceful
        // shutdown's EOF grace period elapsed). Lines are read BOUNDED
        // (audit R8) and events go into a BOUNDED queue — a flood
        // backpressures the child's stdout pipe instead of growing memory.
        {
            let pending = pending.clone();
            let alive = alive.clone();
            tokio::spawn(async move {
                // Held until this task reaps the child at the bottom.
                let process_permit = process_permit;
                let mut reader = BufReader::new(stdout);
                'reader: loop {
                    tokio::select! {
                        biased;
                        changed = kill_rx.changed() => {
                            if changed.is_err() || *kill_rx.borrow() {
                                eprintln!("[codex host] app-server ignored stdin EOF — force-killing");
                                #[cfg(unix)]
                                unsafe {
                                    libc::killpg(child_pid, libc::SIGKILL);
                                }
                                let _ = child.start_kill();
                                break 'reader;
                            }
                        }
                        line = next_line_bounded(&mut reader, MAX_LINE_BYTES) => {
                            let line = match line {
                                Ok(BoundedLine::Line(line)) => line,
                                Ok(BoundedLine::Oversize) => {
                                    eprintln!("[codex host] dropped an oversized protocol line (> {MAX_LINE_BYTES} bytes)");
                                    continue;
                                }
                                Ok(BoundedLine::Eof) | Err(_) => break,
                            };
                            match protocol::parse_line(&line) {
                                Some(Incoming::Response { id, result }) => {
                                    if !pending.resolve(id, result) {
                                        eprintln!("[codex host] app-server response for unknown id {id} — ignored");
                                    }
                                }
                                Some(Incoming::ServerRequest { id, method, params }) => {
                                    tokio::select! {
                                        biased;
                                        changed = kill_rx.changed() => {
                                            if changed.is_err() || *kill_rx.borrow() {
                                                #[cfg(unix)]
                                                unsafe {
                                                    libc::killpg(child_pid, libc::SIGKILL);
                                                }
                                                let _ = child.start_kill();
                                                break 'reader;
                                            }
                                        }
                                        _ = events.send(ServerEvent::Request { id, method, params }) => {}
                                    }
                                }
                                Some(Incoming::Notification { method, params }) => {
                                    tokio::select! {
                                        biased;
                                        changed = kill_rx.changed() => {
                                            if changed.is_err() || *kill_rx.borrow() {
                                                #[cfg(unix)]
                                                unsafe {
                                                    libc::killpg(child_pid, libc::SIGKILL);
                                                }
                                                let _ = child.start_kill();
                                                break 'reader;
                                            }
                                        }
                                        _ = events.send(ServerEvent::Notification { method, params }) => {}
                                    }
                                }
                                None => {} // unknown/unparseable line: ignore silently
                            }
                        }
                    }
                }
                alive.store(false, Ordering::SeqCst);
                pending.fail_all("codex app-server exited");
                let _ = child.wait().await; // reap
                                            // The global process slot represents an OS process, not event
                                            // delivery. Release it immediately after reap even if the
                                            // router remains backpressured behind a stalled route.
                drop(process_permit);
                tokio::spawn(async move {
                    let _ = events.send(ServerEvent::Exited).await;
                });
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

    /// Send one line to the writer task. Err = writer gone (shutdown/exited)
    /// or the queue is full (the child stopped reading its stdin — audit R8:
    /// fail fast instead of queueing without bound).
    fn send_line(&self, line: String) -> Result<(), ()> {
        match &*self.stdin_tx.lock() {
            Some(tx) => tx.try_send(line).map_err(|_| ()),
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
                let _ = kill.send(true);
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
        for rel in [
            ".local/bin",
            ".bun/bin",
            ".volta/bin",
            ".cargo/bin",
            ".npm-global/bin",
        ] {
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
    let resolved =
        tokio::task::spawn_blocking(move || resolve_codex_program(override_path.as_deref()))
            .await
            .map_err(|e| e.to_string())??;
    RESOLVER.lock().resolved = Some(resolved.clone());
    Ok(resolved)
}

fn invalidate_resolved_program() {
    RESOLVER.lock().resolved = None;
}

// ---------------------------------------------------------------------------
// MCP opt-out — SwarmZ children never boot the user's global MCP servers
// ---------------------------------------------------------------------------
//
// Every `codex app-server` child inherits the user's `~/.codex/config.toml`,
// including its `[mcp_servers.*]` entries (the ChatGPT desktop app installs a
// heavyweight `node_repl` with `startup_timeout_sec = 120`). Those servers
// boot PER THREAD on the first turn; live on 0.144.1 that boot both delays
// the turn and trips the codex tool router (`timeout_ms must be at least
// 10000` → the Conductor's first dynamic tool call gets "cancelled before
// receiving a response"). SwarmZ agents don't use those servers, so every
// spawn disables them for THIS PROCESS ONLY.
//
// Live-verified mechanism (0.144.1, see docs/ARCHITECTURE.md):
//   · `-c mcp_servers={}` does NOT work — `-c` table overrides MERGE into the
//     config table instead of replacing it (probed: a dummy entry is added,
//     the user's servers keep booting). Same for a per-thread
//     `thread/start {config: {mcp_servers: {}}}`.
//   · `-c mcp_servers.<name>.enabled=false` DOES work per server → we
//     enumerate the names by READING the user's config.toml (never writing
//     it) and emit one disable per entry.
//   · `--disable apps` (= `-c features.apps=false`) turns off the built-in
//     `codex_apps` MCP server that otherwise boots per thread regardless of
//     config.

/// The user's codex config file (`$CODEX_HOME/config.toml`, default
/// `~/.codex/config.toml`) — read-only.
fn codex_config_path() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .or_else(|| dirs::home_dir().map(|h| h.join(".codex")))?;
    Some(home.join("config.toml"))
}

/// Only names expressible as a bare TOML key segment ride in a `-c` dotted
/// path. Codex constrains MCP server names to this charset anyway; anything
/// else is skipped (and logged) rather than guessed at.
fn is_bare_toml_key(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The per-spawn CLI args that disable MCP servers for one `codex
/// app-server` child (pure — unit-tested; `config_text` is the user's
/// config.toml. Empty means no configured servers; malformed or schema-wrong
/// input refuses locally rather than relying on a downstream Codex version to
/// reject the same bytes in exactly the same way.
///
/// FAIL-CLOSED (audit R12): a server whose name cannot ride a bare `-c`
/// dotted path CANNOT be disabled per process — if that server is ENABLED,
/// this errors and the spawn refuses, instead of silently letting the
/// undisableable server boot into every SwarmZ child. A quoted-name server
/// that is already `enabled = false` in the config is safely skipped.
pub(crate) fn mcp_disable_args_from(config_text: &str) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = vec!["--disable".into(), "apps".into()];
    let parsed: toml::Table = config_text
        .parse()
        .map_err(|e| format!("refusing to start codex: cannot parse MCP config safely: {e}"))?;
    let servers = match parsed.get("mcp_servers") {
        None => return Ok(args),
        Some(value) => value.as_table().ok_or_else(|| {
            "refusing to start codex: mcp_servers in config.toml is not a table".to_string()
        })?,
    };
    for (name, table) in servers {
        if is_bare_toml_key(name) {
            args.push("-c".into());
            args.push(format!("mcp_servers.{name}.enabled=false"));
        } else {
            let already_disabled = table
                .get("enabled")
                .and_then(|v| v.as_bool())
                .map(|b| !b)
                .unwrap_or(false);
            if !already_disabled {
                return Err(format!(
                    "mcp server name {name:?} in ~/.codex/config.toml cannot be disabled per process (not a bare TOML key) — disable it in the config or rename it before SwarmZ can spawn codex"
                ));
            }
        }
    }
    Ok(args)
}

/// Read the user's config.toml (READ-ONLY) and build the disable args.
/// Missing file = no user servers = just the `apps` opt-out. Recomputed per
/// spawn so config edits apply to the next process.
fn mcp_disable_args() -> Result<Vec<String>, String> {
    mcp_disable_args_at(codex_config_path().as_deref())
}

/// File-reading half split out for deterministic failure tests. A missing
/// config genuinely means no configured servers. Any OTHER read failure is
/// ambiguous and therefore refuses the child spawn: treating permission/I/O
/// errors as an empty config could silently boot every global MCP server.
fn mcp_disable_args_at(path: Option<&std::path::Path>) -> Result<Vec<String>, String> {
    let text = match path {
        None => String::new(),
        Some(path) => match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => {
                return Err(format!(
                    "refusing to start codex: cannot safely read MCP config {}: {e}",
                    path.display()
                ));
            }
        },
    };
    mcp_disable_args_from(&text)
}

// ---------------------------------------------------------------------------
// Thread registry + Connection — per-threadId event routing
// ---------------------------------------------------------------------------

/// Per-thread route queue capacity (final hardening F10): the raw event
/// queue is bounded, so the routes it drains into must be bounded too or
/// the end-to-end backpressure collapses into an unbounded consumer queue.
/// A full route makes the router `.await` — which backpressures the raw
/// queue and ultimately the child's stdout pipe. Consumers (the session and
/// orchestrator dispatchers) drain fast and never await back into the
/// router, so a full queue means a genuine flood, not a deadlock.
pub const ROUTE_CHANNEL_CAPACITY: usize = 32;

/// Where a registered thread's server events land. Multiple threads may
/// share one sink (the orchestrator does — one dispatcher for all chats).
/// BOUNDED (F10) — create with `mpsc::channel(ROUTE_CHANNEL_CAPACITY)`.
pub type EventSink = mpsc::Sender<ThreadEvent>;

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
        let (events_tx, events_rx) = mpsc::channel(EVENTS_CHANNEL_CAPACITY);
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
fn spawn_router(client: Arc<Client>, routes: Arc<RouteTable>, mut rx: mpsc::Receiver<ServerEvent>) {
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
                            // bounded send (F10): a full route AWAITS —
                            // backpressure instead of unbounded growth
                            if let Err(failed) = s
                                .send(ThreadEvent::Request {
                                    method,
                                    params,
                                    responder,
                                })
                                .await
                            {
                                // consumer gone (sink dropped) — the request
                                // must still be answered or the server hangs
                                if let ThreadEvent::Request { responder, .. } = failed.0 {
                                    responder
                                        .error(-32601, "SwarmZ consumer for this thread is gone");
                                }
                            }
                        }
                        None => {
                            responder.error(-32601, "no SwarmZ consumer registered for this thread")
                        }
                    }
                }
                ServerEvent::Notification { method, params } => {
                    if let Some(sink) = params
                        .get("threadId")
                        .and_then(|v| v.as_str())
                        .and_then(|tid| routes.get(tid))
                    {
                        let _ = sink
                            .send(ThreadEvent::Notification { method, params })
                            .await;
                    }
                    // no sink: account-level or foreign-thread notification — ignore
                }
                ServerEvent::Exited => {
                    for sink in routes.drain_distinct() {
                        let _ = sink.send(ThreadEvent::Exited).await;
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
#[path = "host/tests.rs"]
mod tests;
