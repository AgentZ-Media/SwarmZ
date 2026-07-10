// Orchestrator tool bus + brain. Pieces:
//   - registry.rs — the single-source tool catalog (names, descriptions,
//     JSON-Schema parameters, timeouts) handed to the Codex app-server as
//     dynamicTools.
//   - bus.rs — the Rust↔webview roundtrip: tools execute in the webview
//     (that's where the store lives); Rust emits `orchestrator://tool-request`
//     and awaits the `orchestrator_tool_response` command.
//   - appserver.rs + adapter.rs — the Codex app-server brain: ONE Conductor
//     instance PER PROJECT (own ProcessHost slot + per-generation dispatcher
//     over the generic host in `crate::codex`, idle-reaped after 15 min),
//     chats ↔ threads on their project's instance, the registry declared as
//     dynamicTools (adapter.rs), tool callbacks answered via `run_tool`
//     (project-scoped), streaming `orchestrator://chat-event`s.
//
// `run_tool` is the internal API the brain calls; the
// `orchestrator_run_tool` command (lib.rs) exposes the same surface to the
// dev hook `window.__orch.tool(...)` for smoke tests.

mod adapter;
mod appserver;
mod bus;
mod memory;
mod persona;
mod registry;

use serde_json::Value;
use tauri::{AppHandle, Emitter};

pub use appserver::{chat_interrupt, chat_resume, chat_send, chat_start, chat_status, list_models};
pub use memory::{
    append as memory_append, read_entries as memory_read, remove as memory_remove, AppendResult,
    MemoryEntry, MemoryScope,
};
pub use persona::{build_instructions, MemoryBlocks, PersonaSpec, ProjectContext};
pub use registry::tool_definitions;

/// Run one orchestrator tool end to end: validate against the registry,
/// round-trip through the webview executors, enforce the tool's timeout.
/// `chat_id` is the backend chat whose turn triggered the call (forwarded in
/// the emitted request for Phase-5 touched-pane tracking); `project_id` is
/// the Conductor instance's project (executors scope on it). Dev-hook and
/// internal calls pass None for both.
pub async fn run_tool(
    app: &AppHandle,
    tool: &str,
    args: Value,
    chat_id: Option<String>,
    project_id: Option<String>,
) -> Result<Value, String> {
    // "" is NOT a scope: a legacy chat without a project must run unscoped,
    // never filtered down to a nonexistent project "" (= empty fleet)
    let project_id = project_id.filter(|p| !p.trim().is_empty());
    bus::run_tool_via(
        &bus::PENDING,
        |request| {
            app.emit("orchestrator://tool-request", request)
                .map_err(|e| e.to_string())
        },
        tool,
        args,
        chat_id,
        project_id,
        None,
    )
    .await
}

/// Deliver a webview tool response (the `orchestrator_tool_response` command).
/// Unknown/expired ids are a logged no-op, never an error.
pub fn resolve_tool_response(id: &str, ok: bool, payload: Value) {
    bus::resolve_response(id, ok, payload);
}
