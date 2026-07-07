// Orchestrator roundtrip bus (Phase 2): tools are DEFINED in Rust
// (registry.rs) but EXECUTE in the webview, where the Zustand store lives.
// `run_tool_via` emits an `orchestrator://tool-request` event, parks a
// oneshot in the pending map and awaits the webview's
// `orchestrator_tool_response` command (or the tool's timeout).
//
// The core is deliberately tauri-free: the caller passes the emit function,
// so the whole request/response/timeout choreography is unit-testable.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::oneshot;

use super::registry;

pub type ToolResult = Result<Value, String>;

/// The event payload the webview bus (src/lib/orchestrator/bus.ts) receives.
#[derive(Debug, Clone, Serialize)]
pub struct ToolRequest {
    pub id: String,
    pub tool: String,
    pub args: Value,
    /// Backend chat id of the chat whose turn triggered this call — None for
    /// dev-hook / internal calls. The webview maps it to its store chat and
    /// hands executors the chat context (Phase-5 touched-pane tracking).
    pub chat_id: Option<String>,
}

/// In-flight tool requests awaiting their webview response.
#[derive(Default)]
pub struct PendingMap {
    inner: Mutex<HashMap<String, oneshot::Sender<ToolResult>>>,
}

impl PendingMap {
    fn register(&self, id: &str) -> oneshot::Receiver<ToolResult> {
        let (tx, rx) = oneshot::channel();
        self.inner.lock().insert(id.to_string(), tx);
        rx
    }

    fn remove(&self, id: &str) {
        self.inner.lock().remove(id);
    }

    /// Resolve a pending request. Returns false for unknown/expired ids —
    /// the caller treats that as a silent no-op (a late response after a
    /// timeout is expected, not an error).
    pub fn resolve(&self, id: &str, result: ToolResult) -> bool {
        match self.inner.lock().remove(id) {
            Some(tx) => tx.send(result).is_ok(),
            None => false,
        }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.inner.lock().len()
    }
}

/// The app-wide pending map (one webview, one bus).
pub static PENDING: Lazy<PendingMap> = Lazy::new(PendingMap::default);

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(1);

fn next_request_id() -> String {
    // unique within a run; the counter alone would do, the millis make ids
    // recognizable in logs across restarts
    let n = REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed);
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("orch-{ms}-{n}")
}

/// Run one tool roundtrip: validate → emit request → await response/timeout.
/// `timeout_override` exists for tests; production callers pass None (the
/// registry's per-tool timeout applies).
pub async fn run_tool_via<E>(
    pending: &PendingMap,
    emit: E,
    tool: &str,
    args: Value,
    chat_id: Option<String>,
    timeout_override: Option<u64>,
) -> ToolResult
where
    E: FnOnce(&ToolRequest) -> Result<(), String>,
{
    let def = registry::find_tool(tool).ok_or_else(|| {
        format!(
            "unknown tool \"{tool}\" — available: {}",
            registry::tool_names().join(", ")
        )
    })?;
    // tolerate a missing/null args payload for tools without parameters
    let args = if args.is_null() {
        Value::Object(Default::default())
    } else {
        args
    };
    registry::validate_args(&def, &args)?;

    let id = next_request_id();
    let rx = pending.register(&id);
    let request = ToolRequest {
        id: id.clone(),
        tool: tool.to_string(),
        args,
        chat_id,
    };
    if let Err(e) = emit(&request) {
        pending.remove(&id);
        return Err(format!("failed to emit tool request: {e}"));
    }

    let timeout_ms = timeout_override.unwrap_or(def.timeout_ms);
    match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => {
            // sender dropped without a response — should not happen
            pending.remove(&id);
            Err(format!("tool \"{tool}\": request channel dropped"))
        }
        Err(_) => {
            pending.remove(&id);
            Err(format!(
                "tool \"{tool}\" timed out after {timeout_ms} ms — the webview never responded"
            ))
        }
    }
}

/// Resolve a webview response against the global pending map. Unknown or
/// expired ids are a logged no-op (late responses after a timeout are normal).
pub fn resolve_response(id: &str, ok: bool, payload: Value) {
    let result = if ok {
        Ok(payload)
    } else {
        // the webview bus sends the error message as a plain string; be
        // tolerant of anything else
        Err(match payload {
            Value::String(s) => s,
            other => other.to_string(),
        })
    };
    if !PENDING.resolve(id, result) {
        eprintln!("[orchestrator] response for unknown/expired request {id} — ignored");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn unknown_tool_is_rejected_without_a_roundtrip() {
        let pending = PendingMap::default();
        let err = run_tool_via(
            &pending,
            |_req| panic!("must not emit for unknown tools"),
            "definitely_not_a_tool",
            json!({}),
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(err.contains("unknown tool"), "unexpected error: {err}");
        assert!(err.contains("fleet_snapshot"), "should list valid tools: {err}");
        assert_eq!(pending.len(), 0);
    }

    #[tokio::test]
    async fn invalid_args_are_rejected_without_a_roundtrip() {
        let pending = PendingMap::default();
        let err = run_tool_via(
            &pending,
            |_req| panic!("must not emit for invalid args"),
            "prompt_pane",
            json!({ "pane_id": "abc" }), // text missing
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(err.contains("text"), "unexpected error: {err}");
        assert_eq!(pending.len(), 0);
    }

    #[tokio::test]
    async fn timeout_fires_and_cleans_the_pending_map() {
        let pending = PendingMap::default();
        let err = run_tool_via(
            &pending,
            |_req| Ok(()), // emitted, but nobody ever responds
            "fleet_snapshot",
            json!({}),
            None,
            Some(25),
        )
        .await
        .unwrap_err();
        assert!(err.contains("timed out"), "unexpected error: {err}");
        assert_eq!(pending.len(), 0, "timeout must remove the pending entry");
    }

    #[tokio::test]
    async fn response_resolves_the_pending_future() {
        let pending = PendingMap::default();
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let call = run_tool_via(
            &pending,
            |req| {
                assert_eq!(req.tool, "fleet_snapshot");
                tx.send(req.id.clone()).unwrap();
                Ok(())
            },
            "fleet_snapshot",
            json!({}),
            None,
            Some(5_000),
        );
        let respond = async {
            // emit ran synchronously before the await, so this never blocks
            let id = rx.recv().unwrap();
            assert!(pending.resolve(&id, Ok(json!({ "summary": "8 panes" }))));
        };
        let (result, ()) = tokio::join!(call, respond);
        assert_eq!(result.unwrap()["summary"], "8 panes");
        assert_eq!(pending.len(), 0);
    }

    #[tokio::test]
    async fn error_responses_become_err() {
        let pending = PendingMap::default();
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let call = run_tool_via(
            &pending,
            |req| {
                tx.send(req.id.clone()).unwrap();
                Ok(())
            },
            "git_status",
            json!({ "pane_id": "nope" }),
            None,
            Some(5_000),
        );
        let respond = async {
            let id = rx.recv().unwrap();
            pending.resolve(&id, Err("unknown pane_id \"nope\"".into()));
        };
        let (result, ()) = tokio::join!(call, respond);
        assert!(result.unwrap_err().contains("unknown pane_id"));
    }

    #[tokio::test]
    async fn chat_context_reaches_the_emitted_request() {
        let pending = PendingMap::default();
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let call = run_tool_via(
            &pending,
            |req| {
                // the owning chat rides along so the webview executors can
                // track touched panes (Phase 5); dev-hook calls pass None
                assert_eq!(req.chat_id.as_deref(), Some("chat-7"));
                tx.send(req.id.clone()).unwrap();
                Ok(())
            },
            "fleet_snapshot",
            json!({}),
            Some("chat-7".to_string()),
            Some(5_000),
        );
        let respond = async {
            let id = rx.recv().unwrap();
            assert!(pending.resolve(&id, Ok(json!({ "summary": "ok" }))));
        };
        let (result, ()) = tokio::join!(call, respond);
        assert!(result.is_ok());
    }

    #[test]
    fn unknown_response_ids_are_a_silent_no_op() {
        let pending = PendingMap::default();
        assert!(!pending.resolve("never-registered", Ok(json!(null))));
    }
}
