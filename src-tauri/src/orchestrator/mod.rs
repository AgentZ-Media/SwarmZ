// Orchestrator tool bus (Phase 2) + brain (Phase 3). Pieces:
//   - registry.rs — the single-source tool catalog (names, descriptions,
//     JSON-Schema parameters, timeouts) that the LLM providers receive
//     (Codex app-server dynamicTools today, OpenRouter tools in Phase 6).
//   - bus.rs — the Rust↔webview roundtrip: tools execute in the webview
//     (that's where the store lives); Rust emits `orchestrator://tool-request`
//     and awaits the `orchestrator_tool_response` command.
//   - appserver.rs + adapter.rs — the Codex app-server brain: chats ↔
//     threads over the generic host in `crate::codex` (one shared process,
//     strategy (a)), the registry declared as dynamicTools (adapter.rs),
//     tool callbacks answered via `run_tool`, streaming
//     `orchestrator://chat-event`s.
//   - openrouter.rs — brain provider B (Phase 6): one streamed OpenRouter
//     chat-completion call per loop iteration (the tool LOOP runs in the
//     webview, src/lib/orchestrator/openrouter-loop.ts), emitting the same
//     `delta` chat events + a per-chat stream cancel.
//
// `run_tool` is the internal API the brain calls; the
// `orchestrator_run_tool` command (lib.rs) exposes the same surface to the
// dev hook `window.__orch.tool(...)` for smoke tests.

mod adapter;
mod appserver;
mod bus;
mod memory;
mod openrouter;
mod persona;
mod registry;

use serde_json::Value;
use tauri::{AppHandle, Emitter};

pub use appserver::{chat_interrupt, chat_resume, chat_send, chat_start, chat_status, list_models};
pub use memory::{
    append as memory_append, read_entries as memory_read, remove as memory_remove, AppendResult,
    MemoryEntry,
};
pub use openrouter::{cancel as openrouter_cancel, chat_completion as openrouter_chat_completion};
pub use persona::{build_instructions, PersonaSpec};
pub use registry::tool_definitions;

/// Run one orchestrator tool end to end: validate against the registry,
/// round-trip through the webview executors, enforce the tool's timeout.
/// `chat_id` is the backend chat whose turn triggered the call (forwarded in
/// the emitted request for Phase-5 touched-pane tracking); dev-hook and
/// internal calls pass None.
pub async fn run_tool(
    app: &AppHandle,
    tool: &str,
    args: Value,
    chat_id: Option<String>,
) -> Result<Value, String> {
    bus::run_tool_via(
        &bus::PENDING,
        |request| {
            app.emit("orchestrator://tool-request", request)
                .map_err(|e| e.to_string())
        },
        tool,
        args,
        chat_id,
        None,
    )
    .await
}

/// Deliver a webview tool response (the `orchestrator_tool_response` command).
/// Unknown/expired ids are a logged no-op, never an error.
pub fn resolve_tool_response(id: &str, ok: bool, payload: Value) {
    bus::resolve_response(id, ok, payload);
}
