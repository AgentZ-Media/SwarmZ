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
//   - session API — the eleven `vibe_session_*` Tauri commands in lib.rs call
//     the async functions here. `send` is NON-blocking: it returns the turn
//     id after the `turn/start` ack; the transcript + completion arrive as
//     events (many sessions run in parallel, the UI is event-driven).
//
// Access → sandbox mapping (exact wire strings verified against the 0.144.1
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
use tokio::sync::{mpsc, oneshot};

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
            other => Err(format!(
                "unknown access \"{other}\" (expected workspace|full)"
            )),
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
    /// NOT the `SandboxMode` string). Shapes match the 0.144.1 response form.
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
    /// the process generation this session's EVENT FENCE lives on — events
    /// from any other generation are dropped. Moved FORWARD as soon as an
    /// operation learns of a respawn (final hardening F11: BEFORE the
    /// awaited thread/resume), so a delayed straggler from the dead
    /// generation can never clear the new operation's busy flag.
    generation: u64,
    /// spawn generation the thread's ROUTE + thread/resume were last
    /// established under — a mismatch with the live process generation
    /// triggers the transparent thread/resume before the next turn. Split
    /// from `generation` (F11): the fence moves early, the route only after
    /// the resume actually succeeded (a failed resume retries on the next
    /// send while the fence stays ahead).
    route_generation: u64,
    profile: SessionProfile,
    /// Access policy that the CURRENT live thread/turn is known to have
    /// applied. `profile.access` is the requested policy for the next fresh
    /// turn; changing it does not retune an already-running turn. Keeping the
    /// two values separate closes the downgrade window where a FULL-access
    /// turn could otherwise be steered by the Conductor after the UI merely
    /// requested workspace access.
    applied_access: Access,
    /// Monotone revision of the requested access profile. A turn/resume keeps
    /// the revision it started with and may clear `access_override_pending`
    /// only when no newer access choice arrived while its RPC was in flight.
    access_revision: u64,
    /// running turn id (for interrupt); None between turns
    current_turn_id: Option<String>,
    /// one turn per session at a time — claimed synchronously in `send`
    busy: bool,
    /// access changed since the last turn → apply the override on the next
    /// turn/start (then clear)
    access_override_pending: bool,
    /// unanswered approval requests: our approval_id → the blocking Responder
    /// PLUS its server-side routing class — "human-only" must never live only
    /// in frontend state (the strict Conductor response path checks it here)
    pending_approvals: HashMap<String, PendingApproval>,
    /// a `session_compact` waiting for its compaction turn to end — resolved
    /// by the shared turn/completed bookkeeping (status, error) or dropped on
    /// process exit. Only ever Some while `busy` is held by the compaction.
    compact_done: Option<oneshot::Sender<(String, Option<String>)>>,
    /// this session's event sink (re-registered on the fresh connection after
    /// a respawn — routes die with the process)
    sink: EventSink,
    approval_counter: u64,
}

/// One blocked approval request: the Responder that answers the server's RPC
/// plus the routing class it was classified with (source of truth for the
/// strict Conductor response path — the frontend can never upgrade it).
/// `gh_write_gated` marks a "routine" that exists ONLY because the gh-write
/// gate (integration master toggle AND autonomous-writes opt-in) was on at
/// arrival — the strict path re-checks the LIVE gate, so a pending gh write
/// can't outlive a later disable of either flag (see `routine_gate`).
struct PendingApproval {
    responder: Responder,
    escalation: &'static str,
    gh_write_gated: bool,
}

static SESSIONS: Lazy<Mutex<HashMap<String, SessionState>>> = Lazy::new(Mutex::default);

static APPROVAL_SEQ: AtomicU64 = AtomicU64::new(0);

/// Number of process slots that are alive right now. Registry entries and
/// persisted thread history are deliberately not capacity: a closed/crashed
/// host becomes free immediately and will be counted again only after a lazy
/// resume actually spawns it.
pub async fn live_backend_count() -> usize {
    let hosts: Vec<Arc<ProcessHost>> = SESSIONS
        .lock()
        .values()
        .map(|state| state.host.clone())
        .collect();
    let mut live = 0usize;
    for host in hosts {
        if host.alive().await.is_some() {
            live = live.saturating_add(1);
        }
    }
    live
}

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

// ---------------------------------------------------------------------------

// Approval policy lives in codex::approval; keep the public sessions path
// as a compatibility re-export for existing Rust callers.
pub use super::approval::classify_approval;
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
/// `item_started`/`item_completed`. There is NO `item/updated` in the
/// protocol (verified against the 0.142.5 AND 0.144.1 schemas + live runs —
/// items only ever fire started/completed plus their typed deltas).
fn map_notification(method: &str, params: &Value) -> Option<(&'static str, Value)> {
    match method {
        "turn/started" => {
            let turn_id = params.pointer("/turn/id").and_then(|v| v.as_str());
            Some(("turn_started", json!({ "turn_id": turn_id })))
        }
        "item/agentMessage/delta" => {
            let text = params.get("delta").and_then(|v| v.as_str()).unwrap_or("");
            Some((
                "delta",
                json!({ "item_id": params.get("itemId"), "text": text }),
            ))
        }
        // commandExecution output streams incrementally while a command runs —
        // live-verified in the Phase-2 spike. The store appends it to the
        // command item's output.
        "item/commandExecution/outputDelta" => {
            let delta = params.get("delta").and_then(|v| v.as_str()).unwrap_or("");
            // R8: one runaway delta must not flood the event bridge — the
            // store-side aggregation is tail-capped anyway (MAX_AGG_OUTPUT)
            let delta = if delta.len() > MAX_AGG_OUTPUT {
                cap_output(delta, MAX_AGG_OUTPUT)
            } else {
                delta.to_string()
            };
            Some((
                "item_output_delta",
                json!({ "item_id": params.get("itemId"), "delta": delta }),
            ))
        }
        "item/started" => {
            let item = params.get("item")?;
            if item.get("type").and_then(|v| v.as_str()) == Some("agentMessage") {
                return None; // the streaming bubble is driven by deltas
            }
            Some(("item_started", json!({ "item": normalize_item(item) })))
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
            // A context compaction (from thread/compact/start): the model's
            // context was summarized. The VISIBLE transcript stays untouched
            // (this item is not rendered as history) — the frontend just drops
            // a subtle divider so the user knows it happened.
            if item.get("type").and_then(|v| v.as_str()) == Some("contextCompaction") {
                return Some(("compacted", json!({})));
            }
            Some(("item_completed", json!({ "item": normalize_item(item) })))
        }
        // A dedicated compaction notification exists in the schema but did not
        // fire on 0.142.5/0.144.1 (the contextCompaction ITEM above is the
        // reliable signal); mapped anyway for forward-compatibility.
        "thread/compacted" => Some(("compacted", json!({}))),
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
            Some((
                "warning",
                json!({ "message": message, "will_retry": will_retry }),
            ))
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

/// One dispatcher task PER PROCESS GENERATION (audit R6, mirroring the
/// Conductor's fencing in appserver.rs): the channel is created fresh for
/// each (re)spawn and the generation is baked into the task, so every
/// handler can compare it against the session's CURRENT generation — a
/// straggler event from a dead gen-N process can never mutate state (or
/// reach the UI) after the session resumed onto gen N+1.
fn spawn_session_dispatcher(
    app: AppHandle,
    session_id: String,
    generation: u64,
    mut rx: mpsc::Receiver<ThreadEvent>,
) {
    tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            match ev {
                ThreadEvent::Request {
                    method,
                    params,
                    responder,
                } => {
                    handle_server_request(
                        &app,
                        &session_id,
                        generation,
                        &method,
                        params,
                        responder,
                    );
                }
                ThreadEvent::Notification { method, params } => {
                    handle_notification(&app, &session_id, generation, &method, &params);
                }
                ThreadEvent::Exited => handle_exit(&app, &session_id, generation),
            }
        }
        // all senders dropped (session closed → SessionState + Connection gone)
    });
}

/// Is `generation` still the session's live process generation? Stale = the
/// event belongs to an older, dead process — drop it (fail closed).
fn generation_current(session_id: &str, generation: u64) -> bool {
    SESSIONS
        .lock()
        .get(session_id)
        .map(|st| st.generation == generation)
        .unwrap_or(false)
}

/// Approvals are BLOCKING server requests: remember the Responder under a fresh
/// approval id and surface the request to the UI. The user's later decision
/// (`respond_approval`) answers the blocked RPC. Any OTHER server-initiated
/// request (user-input prompts, elicitations, …) is refused with -32601 — the
/// server treats that as a denial and the turn continues/fails.
fn handle_server_request(
    app: &AppHandle,
    session_id: &str,
    generation: u64,
    method: &str,
    params: Value,
    responder: Responder,
) {
    // R6: a request from a stale generation is answered (the blocked RPC of
    // the OLD process must not hang) but never surfaces or stores anything
    if !generation_current(session_id, generation) {
        responder.ok(&json!({ "decision": "cancel" }));
        return;
    }
    match approval_kind(method) {
        Some(kind) => {
            // the session's trusted cwd first (classification touches the
            // filesystem — never under the lock)
            let Some(cwd) = SESSIONS
                .lock()
                .get(session_id)
                .map(|st| st.profile.cwd.clone())
            else {
                // session vanished mid-request — must still answer or the
                // server hangs on the blocked RPC
                responder.ok(&json!({ "decision": "cancel" }));
                return;
            };
            // Conductor routing class (Phase 4, fail closed): "routine" =
            // the Conductor may decide it, "destructive" = hard human-only.
            // Stored NEXT to the Responder — the strict response path
            // enforces it server-side, whatever the frontend claims. The
            // gh-write gate reads the Rust-side flags (integration master
            // toggle AND the autonomous-writes opt-in — final hardening
            // F2), never anything frontend-claimed per request.
            let escalation = classify_approval(
                kind,
                &params,
                &cwd,
                crate::github::agent_gh_writes_allowed(),
            );
            // Phase-7 stale-toggle guard: is this routine ONLY because the
            // integration is on right now? (classified again with the flag
            // off — a difference marks it for the live re-check on respond)
            let gh_write_gated = escalation == "routine"
                && classify_approval(kind, &params, &cwd, false) == "destructive";
            let approval_id = {
                let mut sessions = SESSIONS.lock();
                // re-check the generation UNDER the lock — the session may
                // have respawned between classification and storage
                let Some(st) = sessions
                    .get_mut(session_id)
                    .filter(|st| st.generation == generation)
                else {
                    responder.ok(&json!({ "decision": "cancel" }));
                    return;
                };
                st.approval_counter += 1;
                let approval_id = format!(
                    "{session_id}-ap-{}-{}",
                    st.approval_counter,
                    APPROVAL_SEQ.fetch_add(1, Ordering::Relaxed)
                );
                st.pending_approvals.insert(
                    approval_id.clone(),
                    PendingApproval {
                        responder,
                        escalation,
                        gh_write_gated,
                    },
                );
                approval_id
            };
            emit_session_event(
                app,
                session_id,
                "approval_request",
                // pass the request params through verbatim (itemId, reason,
                // command/cwd, availableDecisions, …) — the UI reads them
                json!({ "approval_id": approval_id, "kind": kind, "escalation": escalation, "request": params }),
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

/// A blocked `session_compact`'s waiter: (turn status, optional error).
type CompactWaiter = oneshot::Sender<(String, Option<String>)>;

/// The `turn/completed` bookkeeping, generation-fenced (audit R6): clears
/// turn/busy state and takes the compact waiter ONLY when the event's
/// generation is still the session's live one. Returns `None` when the event
/// was stale (nothing mutated), `Some(compact_done)` when it applied.
fn turn_completed_bookkeeping(session_id: &str, generation: u64) -> Option<Option<CompactWaiter>> {
    let mut sessions = SESSIONS.lock();
    let st = sessions
        .get_mut(session_id)
        .filter(|st| st.generation == generation)?;
    st.current_turn_id = None;
    st.busy = false;
    Some(st.compact_done.take())
}

/// The process-exit bookkeeping, generation-fenced: a gen-N `Exited` arriving
/// after the session already respawned onto gen N+1 must not clear the NEW
/// turn's busy flag or drop the NEW process' approvals. Returns `None` when
/// stale.
fn exit_bookkeeping(session_id: &str, generation: u64) -> Option<Option<CompactWaiter>> {
    let mut sessions = SESSIONS.lock();
    let st = sessions
        .get_mut(session_id)
        .filter(|st| st.generation == generation)?;
    st.current_turn_id = None;
    st.busy = false;
    st.pending_approvals.clear(); // the blocked RPCs died with the process
    Some(st.compact_done.take())
}

fn handle_notification(
    app: &AppHandle,
    session_id: &str,
    generation: u64,
    method: &str,
    params: &Value,
) {
    // R6: an event from a dead generation neither mutates state nor reaches
    // the UI — the new generation's own events tell the real story.
    if !generation_current(session_id, generation) {
        return;
    }
    // SHARED bookkeeping first (turn id for interrupt, busy for the one-turn
    // guard) — then the pure event mapping.
    match method {
        "turn/started" => {
            let turn_id = params
                .pointer("/turn/id")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            if let Some(st) = SESSIONS
                .lock()
                .get_mut(session_id)
                .filter(|st| st.generation == generation)
            {
                st.current_turn_id = turn_id;
            }
        }
        "turn/completed" => {
            // a blocked `session_compact` waits on this turn — resolve it
            // AFTER the busy flag cleared (so the RPC returning implies the
            // Rust-side slot is genuinely free for the next send)
            if let Some(Some(tx)) = turn_completed_bookkeeping(session_id, generation) {
                let status = params
                    .pointer("/turn/status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("completed")
                    .to_string();
                let error = params
                    .pointer("/turn/error/message")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                let _ = tx.send((status, error));
            }
        }
        _ => {}
    }
    if let Some((kind, data)) = map_notification(method, params) {
        emit_session_event(app, session_id, kind, data);
    }
}

/// The private process died: clear turn/busy state, drop dead approval
/// responders, tell the UI. The next `send` respawns and resumes. Generation-
/// fenced — a stale exit (the session already lives on a newer process) is a
/// silent no-op.
fn handle_exit(app: &AppHandle, session_id: &str, generation: u64) {
    let Some(compact_done) = exit_bookkeeping(session_id, generation) else {
        return; // stale generation — the live process is untouched
    };
    if let Some(tx) = compact_done {
        // a blocked `session_compact` must not hang until its timeout
        let _ = tx.send((
            "exited".into(),
            Some("the session process exited during compaction".into()),
        ));
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
        // Product invariant: temporary lanes never inherit a global Codex
        // personality. The Orchestrator's fixed identity lives in its own
        // developer instructions, not in reusable worker presets.
        "personality": "none",
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
        "personality": "none",
    });
    if let Some(model) = &profile.model {
        p["model"] = json!(model);
    }
    p
}

/// turn/start params. `effort` (a per-turn override) rides on every turn when
/// set; the sandbox/approval override is only attached when access changed
/// since the last turn (keeps the object-form `sandboxPolicy` off the wire on
/// ordinary turns). `output_schema` (Phase 5) is the ONE-TURN-ONLY
/// `outputSchema` param — a JSON Schema constraining the turn's FINAL
/// assistant message (live-verified on 0.144.1); the orchestrator's
/// `expect_report` tasks ride it so agents end with a machine-readable
/// status report.
fn turn_params(
    thread_id: &str,
    text: &str,
    profile: &SessionProfile,
    include_access_override: bool,
    output_schema: Option<&Value>,
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
    if let Some(schema) = output_schema {
        p["outputSchema"] = schema.clone();
    }
    p
}

// ---------------------------------------------------------------------------
// Commands (the eleven vibe_session_* Tauri commands in lib.rs call these)
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
    let applied_access = profile.access;
    let (tx, rx) = mpsc::channel(host::ROUTE_CHANNEL_CAPACITY);
    spawn_session_dispatcher(app.clone(), session_id.to_string(), generation, rx);
    // state BEFORE route (audit R6 ordering): once an event can arrive, the
    // generation fence must already know this session
    SESSIONS.lock().insert(
        session_id.to_string(),
        SessionState {
            host,
            thread_id: Some(thread_id.to_string()),
            generation,
            route_generation: generation,
            profile,
            applied_access,
            access_revision: 0,
            current_turn_id: None,
            busy: false,
            access_override_pending: false,
            pending_approvals: HashMap::new(),
            compact_done: None,
            sink: tx.clone(),
            approval_counter: 0,
        },
    );
    conn.register_thread(thread_id, tx);
}

/// Final hardening F11 — adopt a NEW process generation ATOMICALLY, before
/// the (awaited) thread/resume runs: the event fence moves forward first,
/// so a DELAYED `Exited`/`turn/completed` straggler from the dead
/// generation can no longer clear the busy flag the in-flight send/compact
/// operation holds (pre-fix, that cleared busy while the resume awaited and
/// a second send could race in). The dead generation's leftovers are taken
/// over here: the stale turn id clears and its blocked approval responders
/// are returned so the caller can cancel them (they belong to the dead
/// process — same cleanup `exit_bookkeeping` would have done).
fn adopt_generation(session_id: &str, generation: u64) -> Vec<PendingApproval> {
    let mut sessions = SESSIONS.lock();
    let Some(st) = sessions.get_mut(session_id) else {
        return Vec::new();
    };
    st.generation = generation;
    st.current_turn_id = None;
    st.pending_approvals.drain().map(|(_, p)| p).collect()
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
    refuse_ultra_effort(effort.as_deref())?;
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
    // R7: a post-spawn failure must not leak the freshly spawned child —
    // shut it down explicitly before erroring out
    let res = match conn
        .request(
            "thread/start",
            thread_start_params(&profile),
            host::THREAD_TIMEOUT_MS,
        )
        .await
    {
        Ok(res) => res,
        Err(e) => {
            host.shutdown().await;
            return Err(e);
        }
    };
    let Some(thread_id) = res
        .pointer("/thread/id")
        .and_then(|v| v.as_str())
        .map(str::to_string)
    else {
        host.shutdown().await;
        return Err("thread/start: no thread id in response".into());
    };
    register_session(
        app, session_id, host, &conn, generation, &thread_id, profile,
    );
    Ok(json!({ "thread_id": thread_id }))
}

/// Reopen a persisted session across an app restart: a dedicated process +
/// thread/resume. A `ThreadNotFound` (rollout gone / was ephemeral) falls back
/// to a fresh thread/start — the returned `resumed:false` tells the UI its
/// prior transcript context is gone (the displayed history stays, the model's
/// context doesn't). `session_id`/`thread_id` come from the persisted store.
// 8 args: the resume wire is (identity, thread, profile, override) — a
// params struct would only rename the same eight fields (audit R13).
#[allow(clippy::too_many_arguments)]
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
    refuse_ultra_effort(effort.as_deref())?;
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

    // R7: like session_start, a post-spawn failure shuts the child down
    // instead of leaking it behind the error
    let (effective_thread_id, resumed) =
        match host::resume_thread(&conn, thread_resume_params(thread_id, &profile)).await {
            Ok(_) => (thread_id.to_string(), true),
            Err(host::ResumeError::ThreadNotFound(_)) => {
                // rollout gone — start a fresh thread under the same session id
                let res = match conn
                    .request(
                        "thread/start",
                        thread_start_params(&profile),
                        host::THREAD_TIMEOUT_MS,
                    )
                    .await
                {
                    Ok(res) => res,
                    Err(e) => {
                        host.shutdown().await;
                        return Err(e);
                    }
                };
                let Some(tid) = res
                    .pointer("/thread/id")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                else {
                    host.shutdown().await;
                    return Err("thread/start after lost thread returned no id".into());
                };
                (tid, false)
            }
            Err(host::ResumeError::Other(m)) => {
                host.shutdown().await;
                return Err(format!("resuming the session failed: {m}"));
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

/// The Conductor-path access gate (final hardening F5, pure + unit-tested):
/// a session running with FULL access (no sandbox, no approvals) must never
/// be driven by the Conductor's tool bus — a human may have granted that
/// authority for their OWN prompts, but an autonomous Conductor repurposing
/// it is capability reuse past every approval guardrail. Fail-closed
/// refusal (the clearer variant; re-confining silently would surprise the
/// human who set the access). The human composer path passes `false`.
fn conductor_access_gate(access: Access, require_workspace: bool) -> Result<(), String> {
    if require_workspace && access == Access::Full {
        return Err(
            "refused: this session runs with FULL access (no sandbox) — the Conductor may not prompt, steer or review full-access sessions; the human drives it, or downgrades it to workspace access first"
                .into(),
        );
    }
    Ok(())
}

/// Gate an operation that reuses an already-existing turn/thread capability
/// (steer/review). Both the requested and last ACKed access must be workspace:
/// a pending downgrade is not effective until a fresh turn applies it, while
/// a pending upgrade must be treated as full immediately.
fn conductor_reuse_access_gate(
    requested: Access,
    applied: Access,
    require_workspace: bool,
) -> Result<(), String> {
    if require_workspace && (requested == Access::Full || applied == Access::Full) {
        return Err(
            "refused: this session has FULL access applied or pending — the Conductor may not prompt, steer or review it until workspace access has been applied by a fresh turn"
                .into(),
        );
    }
    Ok(())
}

/// Commit the access policy ACKed by a turn/start or thread/resume without
/// losing a newer UI choice that arrived while the RPC was in flight.
fn commit_applied_access(session_id: &str, applied: Access, revision: u64) {
    if let Some(st) = SESSIONS.lock().get_mut(session_id) {
        st.applied_access = applied;
        if st.access_revision == revision {
            st.access_override_pending = false;
        } else {
            // A newer request exists. It still needs a fresh turn exactly when
            // it differs from what this older ACK just made effective.
            st.access_override_pending = st.profile.access != st.applied_access;
        }
    }
}

/// Send one user message — NON-blocking: returns the turn id after the
/// `turn/start` ack; the transcript + completion stream as events. One turn
/// per session at a time (a busy session rejects). Transparently resumes after
/// a private-process respawn. `output_schema` (optional, Phase 5) constrains
/// this ONE turn's final assistant message to a JSON Schema — the structured
/// agent→Conductor status reports ride on it. `require_workspace` (final
/// hardening F5) is the STRICT Conductor path: a FULL-access session refuses
/// before anything is claimed — see `conductor_access_gate`.
pub async fn session_send(
    app: &AppHandle,
    session_id: &str,
    text: &str,
    output_schema: Option<Value>,
    require_workspace: bool,
) -> Result<Value, String> {
    // atomically claim the turn slot + snapshot what we need for the roundtrip
    let (host, mut thread_id, gen_stored, override_pending, access_revision, profile) = {
        let mut sessions = SESSIONS.lock();
        let st = sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("unknown vibe session \"{session_id}\""))?;
        // F5: checked INSIDE the lock, against the live profile — before the
        // busy claim, so a refusal leaves the session untouched
        // A fresh turn atomically carries a pending access override, so the
        // requested profile is the effective policy for THIS new turn. Reuse
        // operations use the stricter requested+applied gate below.
        conductor_access_gate(st.profile.access, require_workspace)?;
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
            thread_id,
            st.route_generation,
            st.access_override_pending,
            st.access_revision,
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
    // resume the thread (routes die with the process, re-register below with
    // a FRESH generation-tagged dispatcher — audit R6)
    if gen_stored != generation {
        // F11: move the event fence to the new generation BEFORE awaiting the
        // resume — a delayed straggler from the dead generation must not
        // clear THIS operation's busy flag mid-respawn. The dead process'
        // blocked approvals are answered (cancel) as part of the takeover.
        for pending in adopt_generation(session_id, generation) {
            pending.responder.ok(&json!({ "decision": "cancel" }));
        }
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
        // thread/resume or the lost-rollout thread/start above both apply the
        // requested profile before any new turn can run in this generation.
        commit_applied_access(session_id, profile.access, access_revision);
        // fresh generation-tagged dispatcher — the old one only ever serves
        // (and drops) the dead process' stragglers. The state's fence moved
        // in `adopt_generation` already (F11); the ROUTE generation commits
        // only now, after the resume genuinely succeeded.
        let (tx, rx) = mpsc::channel(host::ROUTE_CHANNEL_CAPACITY);
        spawn_session_dispatcher(app.clone(), session_id.to_string(), generation, rx);
        if let Some(st) = SESSIONS.lock().get_mut(session_id) {
            st.generation = generation;
            st.route_generation = generation;
            st.sink = tx.clone();
        }
        conn.register_thread(&thread_id, tx);
    }

    let params = turn_params(
        &thread_id,
        text,
        &profile,
        override_pending,
        output_schema.as_ref(),
    );
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
            }
            if override_pending {
                commit_applied_access(session_id, profile.access, access_revision);
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

/// How long a session compaction turn may run before we stop waiting on it.
const COMPACT_TIMEOUT_MS: u64 = 300_000;

/// Compact the session's thread (`thread/compact/start`, live-verified on
/// 0.144.1): codex summarizes the model-visible history into a compaction
/// item and continues from the summary — the on-disk rollout and the SwarmZ
/// UI transcript are untouched, only the context the model carries into the
/// next turn shrinks. Runs as a real (short) turn: it claims the one-turn
/// slot synchronously (a busy session refuses — interrupt or wait first) and
/// BLOCKS until the compaction's turn/completed arrived (mirrors
/// `chat_compact` — a following `session_send` must never race the still-
/// running compaction turn into "a turn is already running"). The busy flag
/// itself is still driven by the turn events, and it clears BEFORE the
/// waiting RPC resolves. Transparently resumes after a private-process
/// respawn, like `send`.
pub async fn session_compact(app: &AppHandle, session_id: &str) -> Result<Value, String> {
    let (done_tx, done_rx) = oneshot::channel();
    let (host, thread_id, gen_stored, profile) = {
        let mut sessions = SESSIONS.lock();
        let st = sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("unknown vibe session \"{session_id}\""))?;
        if st.busy {
            return Err(
                "a turn is already running in this session — interrupt it or wait before compacting"
                    .into(),
            );
        }
        let thread_id = st
            .thread_id
            .clone()
            .ok_or("this session has no thread yet")?;
        st.busy = true;
        st.compact_done = Some(done_tx);
        (
            st.host.clone(),
            thread_id,
            st.route_generation,
            st.profile.clone(),
        )
    };
    let release = |sid: &str| {
        if let Some(st) = SESSIONS.lock().get_mut(sid) {
            st.busy = false;
            st.compact_done = None;
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
    // resume the thread so compaction operates on the right context (fresh
    // generation-tagged dispatcher, audit R6 — same as `send`)
    if gen_stored != generation {
        // F11: fence forward BEFORE the awaited resume — same as `send`
        for pending in adopt_generation(session_id, generation) {
            pending.responder.ok(&json!({ "decision": "cancel" }));
        }
        if let Err(e) = host::resume_thread(&conn, thread_resume_params(&thread_id, &profile)).await
        {
            release(session_id);
            return Err(format!(
                "resuming the session before compaction failed: {}",
                e.message()
            ));
        }
        let (tx, rx) = mpsc::channel(host::ROUTE_CHANNEL_CAPACITY);
        spawn_session_dispatcher(app.clone(), session_id.to_string(), generation, rx);
        // generation BEFORE route — see the identical ordering note in `send`
        if let Some(st) = SESSIONS.lock().get_mut(session_id) {
            st.generation = generation;
            st.route_generation = generation;
            st.sink = tx.clone();
        }
        conn.register_thread(&thread_id, tx);
    }
    if let Err(e) = conn
        .request(
            "thread/compact/start",
            json!({ "threadId": thread_id }),
            host::RPC_TIMEOUT_MS,
        )
        .await
    {
        release(session_id);
        return Err(format!("thread/compact/start failed: {e}"));
    }
    // BLOCK until the compaction turn genuinely ended — turn/completed clears
    // busy and resolves `compact_done` (process exit resolves it too), so a
    // send fired right after this RPC returns finds the slot free.
    match tokio::time::timeout(
        std::time::Duration::from_millis(COMPACT_TIMEOUT_MS),
        done_rx,
    )
    .await
    {
        Ok(Ok((status, error))) => {
            if status == "completed" {
                Ok(json!({ "status": status }))
            } else {
                Err(error.unwrap_or_else(|| format!("compaction ended as \"{status}\"")))
            }
        }
        // sender dropped without a message: the session was closed mid-compaction
        Ok(Err(_)) => Err("compaction aborted: the session was closed".into()),
        Err(_) => {
            // stop waiting, but leave the busy flag to the turn events — the
            // compaction turn may still be running and the one-turn guard
            // must keep refusing sends until it genuinely ends
            if let Some(st) = SESSIONS.lock().get_mut(session_id) {
                st.compact_done = None;
            }
            Err(
                "compaction timed out — the session stays busy until its turn ends (interrupt it to stop)"
                    .into(),
            )
        }
    }
}

/// Steer the session's RUNNING turn: inject `text` into it (turn/steer with
/// the race-safe `expectedTurnId` precondition — live-verified on 0.144.1:
/// the running turn absorbs the instruction; a mismatch fails with
/// "expected active turn id …" / "no active turn to steer"). Errors when no
/// turn is running — callers fall back to a normal send then. The steered
/// text is mirrored into the transcript by the frontend controller.
/// `require_workspace` (final hardening F5) is the STRICT Conductor path:
/// a FULL-access session refuses — see `conductor_access_gate`.
pub async fn session_steer(
    session_id: &str,
    text: &str,
    require_workspace: bool,
) -> Result<Value, String> {
    let (host, thread_id, turn_id) = {
        let sessions = SESSIONS.lock();
        let st = sessions
            .get(session_id)
            .ok_or_else(|| format!("unknown vibe session \"{session_id}\""))?;
        // F5: against the live profile, before any turn state is read
        conductor_reuse_access_gate(st.profile.access, st.applied_access, require_workspace)?;
        // the "steer-race:" tag matters: Rust clears current_turn_id on
        // turn/completed BEFORE the frontend busy flag clears, so an early
        // no-turn here is the SAME lost race as the wire-level mismatch —
        // callers fall back to a normal send instead of dropping the text
        let turn_id = st.current_turn_id.clone().ok_or(
            "steer-race: no turn is running in this session — send a normal prompt instead",
        )?;
        let thread_id = st.thread_id.clone().ok_or("this session has no thread")?;
        (st.host.clone(), thread_id, turn_id)
    };
    let conn = host
        .alive()
        .await
        .ok_or("the session process is not running")?;
    let res = conn
        .request(
            "turn/steer",
            json!({
                "threadId": thread_id,
                "expectedTurnId": turn_id,
                "input": [{ "type": "text", "text": text }],
            }),
            host::RPC_TIMEOUT_MS,
        )
        .await
        .map_err(|e| {
            // the LOST RACE (turn ended between check and steer) gets a
            // stable prefix so the frontend can fall back to a normal send
            // without matching codex's message text itself
            if is_steer_race_error(&e) {
                format!("steer-race: {e}")
            } else {
                format!("turn/steer failed: {e}")
            }
        })?;
    Ok(json!({ "turn_id": res.get("turnId"), "steered": true }))
}

/// Is a steer failure the LOST RACE (the turn ended between check and steer)?
/// Callers retry as a normal turn then. Message shapes live-verified on
/// 0.144.1.
pub fn is_steer_race_error(err: &str) -> bool {
    err.contains("no active turn to steer") || err.contains("expected active turn id")
}

/// Move the session to a new working directory (worktree assignment): the
/// profile changes for future starts/resumes, and a LIVE thread is retuned
/// immediately via `thread/settings/update {cwd}` (live-verified on 0.144.1
/// — the next turn runs in the new cwd, confirmed by `pwd`).
pub async fn session_set_cwd(session_id: &str, cwd: &str) -> Result<(), String> {
    let cwd = cwd.trim();
    if cwd.is_empty() || !std::path::Path::new(cwd).is_dir() {
        return Err(format!("cwd is not an existing folder: {cwd:?}"));
    }
    let (host, thread_id) = {
        let sessions = SESSIONS.lock();
        let st = sessions
            .get(session_id)
            .ok_or_else(|| format!("unknown vibe session \"{session_id}\""))?;
        (st.host.clone(), st.thread_id.clone())
    };
    // R12: the profile commits ONLY after the live thread ACKED the new cwd
    // — a failed update must not leave profile and thread split-brained
    // (approval confinement classifies against the profile cwd).
    if let (Some(conn), Some(thread_id)) = (host.alive().await, thread_id) {
        conn.request(
            "thread/settings/update",
            json!({ "threadId": thread_id, "cwd": cwd }),
            host::RPC_TIMEOUT_MS,
        )
        .await
        .map_err(|e| format!("thread/settings/update (cwd) failed: {e}"))?;
    }
    // no live process: the profile cwd applies on the next resume
    if let Some(st) = SESSIONS.lock().get_mut(session_id) {
        st.profile.cwd = cwd.to_string();
    }
    Ok(())
}

/// How long a detached review turn may run before we give up collecting.
const REVIEW_COLLECT_TIMEOUT_SECS: u64 = 570;

/// Build the `review/start` target from the tool's compact string form.
fn review_target(target: &str) -> Result<Value, String> {
    let t = target.trim();
    if t.is_empty() || t == "uncommitted" || t == "uncommittedChanges" {
        return Ok(json!({ "type": "uncommittedChanges" }));
    }
    if let Some(branch) = t.strip_prefix("branch:") {
        let branch = branch.trim();
        if branch.is_empty() {
            return Err("target \"branch:\" needs a base branch name".into());
        }
        return Ok(json!({ "type": "baseBranch", "branch": branch }));
    }
    if let Some(sha) = t.strip_prefix("commit:") {
        let sha = sha.trim();
        if sha.is_empty() {
            return Err("target \"commit:\" needs a commit sha".into());
        }
        return Ok(json!({ "type": "commit", "sha": sha }));
    }
    Err(format!(
        "unknown review target {t:?} — use \"uncommitted\", \"branch:<base>\" or \"commit:<sha>\""
    ))
}

/// Run a DETACHED codex review over the session's work (`review/start`,
/// live-verified on 0.144.1: detached returns a fresh `reviewThreadId`, the
/// findings arrive as the review thread's final agentMessage and as
/// `exitedReviewMode.review`; needs the parent thread's rollout on disk —
/// sessions are non-ephemeral, so it is). The session itself is untouched
/// (its own turn keeps running). Blocks until the review turn completes.
///
/// `require_workspace` (audit C3) is the STRICT Conductor path, like
/// send/steer: the review thread inherits the parent session's access
/// profile, and a HUMAN-granted full-access profile (danger-full-access +
/// approvalPolicy "never" — commands run WITHOUT any approval this handler
/// could cancel) must never be reused by an autonomous review. A
/// full-access session refuses via `conductor_access_gate`, checked against
/// the live profile BEFORE anything runs.
pub async fn session_review(
    session_id: &str,
    target: &str,
    require_workspace: bool,
) -> Result<Value, String> {
    let target = review_target(target)?;
    let (host, thread_id, generation, profile) = {
        let sessions = SESSIONS.lock();
        let st = sessions
            .get(session_id)
            .ok_or_else(|| format!("unknown vibe session \"{session_id}\""))?;
        // C3: gate FIRST — a refused full-access session stays untouched
        conductor_reuse_access_gate(st.profile.access, st.applied_access, require_workspace)?;
        let thread_id = st
            .thread_id
            .clone()
            .ok_or("this session has no thread yet")?;
        (
            st.host.clone(),
            thread_id,
            st.route_generation,
            st.profile.clone(),
        )
    };
    let (conn, current_gen) = host.ensure().await?;
    // respawned since the session's route was set → the parent thread must be
    // resumed in THIS process before review/start can load it
    if current_gen != generation {
        host::resume_thread(&conn, thread_resume_params(&thread_id, &profile))
            .await
            .map_err(|e| {
                format!(
                    "resuming the session before the review failed: {}",
                    e.message()
                )
            })?;
        // NOTE: the session's own event route is re-established by its next
        // send; the review only needs the thread loaded.
    }

    let res = conn
        .request(
            "review/start",
            json!({ "threadId": thread_id, "target": target, "delivery": "detached" }),
            host::THREAD_TIMEOUT_MS,
        )
        .await
        .map_err(|e| format!("review/start failed: {e}"))?;
    let review_tid = res
        .get("reviewThreadId")
        .and_then(|v| v.as_str())
        .ok_or("review/start: no reviewThreadId in response")?
        .to_string();

    // collect the review thread's outcome on a temporary route
    let (tx, mut rx) = mpsc::channel(host::ROUTE_CHANNEL_CAPACITY);
    conn.register_thread(&review_tid, tx);
    let mut review_text: Option<String> = None;
    let mut last_message: Option<String> = None;
    let mut status = "timeout".to_string();
    let deadline =
        tokio::time::Instant::now() + std::time::Duration::from_secs(REVIEW_COLLECT_TIMEOUT_SECS);
    loop {
        let ev = match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some(ev)) => ev,
            Ok(None) | Err(_) => break,
        };
        match ev {
            ThreadEvent::Request {
                method, responder, ..
            } => {
                // a review must never execute anything — cancel approvals,
                // refuse everything else
                if approval_kind(&method).is_some() {
                    responder.ok(&json!({ "decision": "cancel" }));
                } else {
                    responder.error(-32601, "not supported during a SwarmZ review");
                }
            }
            ThreadEvent::Notification { method, params } => match method.as_str() {
                "item/completed" => {
                    let item = params.get("item").cloned().unwrap_or(Value::Null);
                    match item.get("type").and_then(|v| v.as_str()) {
                        Some("exitedReviewMode") => {
                            review_text = item
                                .get("review")
                                .and_then(|v| v.as_str())
                                .map(str::to_string);
                        }
                        Some("agentMessage") => {
                            last_message = item
                                .get("text")
                                .and_then(|v| v.as_str())
                                .map(str::to_string);
                        }
                        _ => {}
                    }
                }
                "turn/completed" => {
                    status = params
                        .pointer("/turn/status")
                        .and_then(|v| v.as_str())
                        .unwrap_or("completed")
                        .to_string();
                    break;
                }
                _ => {}
            },
            ThreadEvent::Exited => {
                conn.unregister_thread(&review_tid);
                return Err("the session process exited during the review".into());
            }
        }
    }
    conn.unregister_thread(&review_tid);
    if status == "timeout" {
        return Err(format!(
            "the review did not finish within {REVIEW_COLLECT_TIMEOUT_SECS}s"
        ));
    }
    Ok(json!({
        "status": status,
        "review": review_text.or(last_message.clone()),
        "review_thread_id": review_tid,
    }))
}

/// The strict Conductor response gate (pure, unit-tested): only "routine"
/// passes, AND a routine class that exists solely because the gh-write gate
/// was ON at classification time (`gh_write_gated`) is re-checked against
/// the LIVE gate — `gh_writes_allowed_now` is the CONJUNCTION of the
/// integration master toggle and the autonomous-writes opt-in (final
/// hardening F2): the user disabling EITHER while the approval sat pending
/// downgrades it back to human-only. Frontend state can never upgrade an
/// approval through this gate.
fn routine_gate(
    escalation: &str,
    gh_write_gated: bool,
    gh_writes_allowed_now: bool,
) -> Result<(), String> {
    if escalation != "routine" {
        return Err(
            "this approval is classified DESTRUCTIVE — only the human may decide it".into(),
        );
    }
    if gh_write_gated && !gh_writes_allowed_now {
        return Err(
            "this approval is a GitHub write and autonomous GitHub writes are not (or no longer) enabled — only the human may decide it now".into(),
        );
    }
    Ok(())
}

/// Answer a pending approval — `decision` ∈ accept | acceptForSession |
/// decline | cancel — resolving the blocked server request.
///
/// `require_routine` is the STRICT Conductor path: the decision is applied
/// ONLY when the request was classified "routine" at arrival — the check and
/// the removal happen atomically under the session lock, so a destructive
/// approval can never be answered through this path no matter what the
/// frontend claims. The human path passes `false` and may decide anything.
pub async fn session_respond_approval(
    session_id: &str,
    approval_id: &str,
    decision: &str,
    require_routine: bool,
) -> Result<(), String> {
    if !matches!(
        decision,
        "accept" | "acceptForSession" | "decline" | "cancel"
    ) {
        return Err(format!(
            "unknown approval decision \"{decision}\" (accept|acceptForSession|decline|cancel)"
        ));
    }
    let responder = {
        let mut sessions = SESSIONS.lock();
        let st = sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("unknown vibe session \"{session_id}\""))?;
        let pending = st
            .pending_approvals
            .get(approval_id)
            .ok_or_else(|| format!("no pending approval \"{approval_id}\" in this session"))?;
        if require_routine {
            // the responder STAYS pending on refusal — the human's card
            // remains live (destructive class, or a gh write whose routine
            // class went stale because the integration was disabled)
            routine_gate(
                pending.escalation,
                pending.gh_write_gated,
                crate::github::agent_gh_writes_allowed(),
            )?;
        }
        st.pending_approvals
            .remove(approval_id)
            .expect("checked above")
            .responder
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
        st.access_revision = st.access_revision.wrapping_add(1);
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
    refuse_ultra_effort(effort.as_deref())?;
    let mut sessions = SESSIONS.lock();
    let st = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("unknown vibe session \"{session_id}\""))?;
    st.profile.model = model.filter(|s| !s.is_empty());
    st.profile.effort = effort.filter(|s| !s.is_empty());
    Ok(())
}

fn refuse_ultra_effort(effort: Option<&str>) -> Result<(), String> {
    if effort.is_some_and(|value| value.trim().eq_ignore_ascii_case("ultra")) {
        return Err(
            "effort \"ultra\" is unavailable in SwarmZ — Ultra is a multi-agent mode, not a single-agent reasoning level"
                .into(),
        );
    }
    Ok(())
}

/// Close a session: best-effort interrupt a running turn, cancel every pending
/// approval, unregister the thread, SHUT THE PROCESS DOWN explicitly and drop
/// the registry entry. The explicit `host.shutdown()` (audit R7) closes the
/// child's stdin (EOF → codex exits) and arms the force-kill watchdog — a
/// codex ignoring the EOF is killed after the grace period instead of
/// lingering until app quit. The frontend's cap-eviction path goes through
/// this close, so evicted sessions can no longer accumulate child processes.
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
    for (_id, pending) in st.pending_approvals.drain() {
        pending.responder.ok(&json!({ "decision": "cancel" }));
    }
    if let Some(thread_id) = &st.thread_id {
        if let Some(conn) = st.host.alive().await {
            conn.unregister_thread(thread_id);
        }
    }
    // graceful stdin-EOF + kill watchdog — never rely on Drop alone
    st.host.shutdown().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[path = "sessions/tests.rs"]
mod tests;
