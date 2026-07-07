// Wire protocol for `codex app-server` (Phase 3): JSON-RPC 2.0 over
// newline-delimited stdio — WITHOUT the `"jsonrpc":"2.0"` header field.
// Verified against codex 0.142.5 (the server neither sends nor expects it).
//
// This module is pure (no process, no tauri): message framing, the
// incoming-line classifier, and the adapters between our tool registry and
// the app-server's experimental dynamic-tools shapes. Everything here is
// unit-tested against fixture lines captured from a real codex 0.142.5 run.

use serde_json::{json, Value};

use super::registry;

/// One parsed incoming line from the app-server's stdout.
#[derive(Debug)]
pub enum Incoming {
    /// Answer to one of OUR requests (`id` echoes the numeric id we sent).
    Response { id: u64, result: Result<Value, String> },
    /// SERVER-initiated request (e.g. `item/tool/call`) — must be answered.
    /// `id` is kept as raw JSON so the response echoes it exactly.
    ServerRequest {
        id: Value,
        method: String,
        params: Value,
    },
    /// Fire-and-forget notification (deltas, item/turn lifecycle, …).
    Notification { method: String, params: Value },
}

/// Classify one stdout line. Returns None for anything unparseable —
/// the caller ignores those silently (defensive parser).
pub fn parse_line(line: &str) -> Option<Incoming> {
    let msg: Value = serde_json::from_str(line).ok()?;
    let obj = msg.as_object()?;
    let method = obj.get("method").and_then(|m| m.as_str());
    let has_id = obj.contains_key("id");
    match (method, has_id) {
        // request FROM the server: method + id
        (Some(m), true) => Some(Incoming::ServerRequest {
            id: obj.get("id").cloned().unwrap_or(Value::Null),
            method: m.to_string(),
            params: obj.get("params").cloned().unwrap_or(Value::Null),
        }),
        // notification: method, no id
        (Some(m), false) => Some(Incoming::Notification {
            method: m.to_string(),
            params: obj.get("params").cloned().unwrap_or(Value::Null),
        }),
        // response to one of our requests: id + result/error, no method
        (None, true) => {
            let id = obj.get("id").and_then(|i| i.as_u64())?;
            let result = if let Some(err) = obj.get("error") {
                let code = err.get("code").and_then(|c| c.as_i64());
                let message = err
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("unknown error");
                Err(match code {
                    Some(c) => format!("{message} (code {c})"),
                    None => message.to_string(),
                })
            } else {
                Ok(obj.get("result").cloned().unwrap_or(Value::Null))
            };
            Some(Incoming::Response { id, result })
        }
        _ => None,
    }
}

/// Serialize one of OUR requests (no `jsonrpc` header, see module docs).
pub fn request_line(id: u64, method: &str, params: &Value) -> String {
    json!({ "id": id, "method": method, "params": params }).to_string()
}

/// Serialize a client notification (e.g. `initialized`).
pub fn notification_line(method: &str) -> String {
    json!({ "method": method }).to_string()
}

/// Serialize the success answer to a server-initiated request.
pub fn response_line(id: &Value, result: &Value) -> String {
    json!({ "id": id, "result": result }).to_string()
}

/// Serialize an error answer to a server-initiated request.
pub fn error_response_line(id: &Value, code: i64, message: &str) -> String {
    json!({ "id": id, "error": { "code": code, "message": message } }).to_string()
}

/// Adapt the registry catalog to the app-server's experimental
/// `thread/start.dynamicTools` shape: `{ type:"function", name,
/// description, inputSchema }` (our `parameters` schema passes through
/// unchanged; `timeout_ms` is bus-internal and dropped).
pub fn dynamic_tool_specs() -> Vec<Value> {
    registry::tool_definitions()
        .into_iter()
        .map(|t| {
            json!({
                "type": "function",
                "name": t.name,
                "description": t.description,
                "inputSchema": t.parameters,
            })
        })
        .collect()
}

/// Adapt a bus tool result to the `item/tool/call` response shape
/// (`DynamicToolCallResponse`: `{ success, contentItems }`). Errors go back
/// as unsuccessful text content so the model can react to them.
pub fn tool_call_response(result: &Result<Value, String>) -> Value {
    match result {
        Ok(v) => {
            // plain strings pass through unquoted; everything else compact JSON
            let text = match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            json!({
                "success": true,
                "contentItems": [{ "type": "inputText", "text": text }],
            })
        }
        Err(e) => json!({
            "success": false,
            "contentItems": [{ "type": "inputText", "text": format!("ERROR: {e}") }],
        }),
    }
}

/// `item/tool/call` arguments arrive as a JSON object in practice; be
/// tolerant of null (no-arg tools) and of models that stringify their JSON.
pub fn normalize_tool_args(args: Option<&Value>) -> Value {
    match args {
        None | Some(Value::Null) => json!({}),
        Some(Value::String(s)) => {
            serde_json::from_str::<Value>(s).unwrap_or_else(|_| json!({}))
        }
        Some(other) => other.clone(),
    }
}

/// One-line, capped summary of tool-call arguments for the event stream.
pub fn summarize_args(args: &Value) -> String {
    const MAX: usize = 160;
    let s = args.to_string();
    if s.chars().count() <= MAX {
        s
    } else {
        let cut: String = s.chars().take(MAX).collect();
        format!("{cut}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- fixture lines captured from a real `codex app-server` 0.142.5 run ----

    const FIX_RESPONSE: &str = r#"{"id":3,"result":{"turn":{"id":"019f3bb5-7c19-7333-b5c4-82061b6ad4e1","items":[],"itemsView":"notLoaded","status":"inProgress","error":null,"startedAt":null,"completedAt":null,"durationMs":null}}}"#;
    const FIX_TOOL_CALL: &str = r#"{"method":"item/tool/call","id":0,"params":{"threadId":"019f3bb5-7b8c-7da1-a256-0a2549b0454f","turnId":"019f3bb5-7c19-7333-b5c4-82061b6ad4e1","callId":"call_MRL4QG5Mmi1BTmRl0FsxfdFe","namespace":null,"tool":"ping","arguments":{}}}"#;
    const FIX_DELTA: &str = r#"{"method":"item/agentMessage/delta","params":{"threadId":"019f3bb5-7b8c-7da1-a256-0a2549b0454f","turnId":"019f3bb5-7c19-7333-b5c4-82061b6ad4e1","itemId":"msg_0d5403","delta":"pong"}}"#;
    const FIX_TURN_DONE: &str = r#"{"method":"turn/completed","params":{"threadId":"019f3bb5-7b8c-7da1-a256-0a2549b0454f","turn":{"id":"019f3bb5-7c19-7333-b5c4-82061b6ad4e1","items":[],"itemsView":"notLoaded","status":"completed","error":null,"startedAt":1783413177,"completedAt":1783413181,"durationMs":4383}}}"#;
    const FIX_ERROR: &str = r#"{"id":7,"error":{"code":-32600,"message":"thread not found"}}"#;

    #[test]
    fn parses_a_response() {
        match parse_line(FIX_RESPONSE) {
            Some(Incoming::Response { id, result }) => {
                assert_eq!(id, 3);
                let v = result.expect("ok result");
                assert_eq!(v["turn"]["status"], "inProgress");
            }
            other => panic!("expected Response, got {other:?}"),
        }
    }

    #[test]
    fn parses_a_server_request() {
        match parse_line(FIX_TOOL_CALL) {
            Some(Incoming::ServerRequest { id, method, params }) => {
                assert_eq!(id, json!(0));
                assert_eq!(method, "item/tool/call");
                assert_eq!(params["tool"], "ping");
                assert_eq!(params["arguments"], json!({}));
            }
            other => panic!("expected ServerRequest, got {other:?}"),
        }
    }

    #[test]
    fn parses_notifications() {
        match parse_line(FIX_DELTA) {
            Some(Incoming::Notification { method, params }) => {
                assert_eq!(method, "item/agentMessage/delta");
                assert_eq!(params["delta"], "pong");
            }
            other => panic!("expected Notification, got {other:?}"),
        }
        match parse_line(FIX_TURN_DONE) {
            Some(Incoming::Notification { method, params }) => {
                assert_eq!(method, "turn/completed");
                assert_eq!(params["turn"]["status"], "completed");
            }
            other => panic!("expected Notification, got {other:?}"),
        }
    }

    #[test]
    fn parses_error_responses_into_err() {
        match parse_line(FIX_ERROR) {
            Some(Incoming::Response { id, result }) => {
                assert_eq!(id, 7);
                let e = result.expect_err("error result");
                assert!(e.contains("thread not found"), "{e}");
                assert!(e.contains("-32600"), "{e}");
            }
            other => panic!("expected Response, got {other:?}"),
        }
    }

    #[test]
    fn garbage_lines_are_none() {
        assert!(parse_line("not json").is_none());
        assert!(parse_line("42").is_none());
        assert!(parse_line(r#"{"nothing":"here"}"#).is_none());
        // response with a non-numeric id we never issue → unparseable
        assert!(parse_line(r#"{"id":"weird","result":{}}"#).is_none());
    }

    #[test]
    fn outgoing_lines_omit_the_jsonrpc_header() {
        let line = request_line(1, "initialize", &json!({ "x": 1 }));
        let v: Value = serde_json::from_str(&line).unwrap();
        assert!(v.get("jsonrpc").is_none(), "wire format must omit jsonrpc");
        assert_eq!(v["id"], 1);
        assert_eq!(v["method"], "initialize");
        assert_eq!(v["params"]["x"], 1);
        assert!(!line.contains('\n'), "one line per message");

        let note: Value = serde_json::from_str(&notification_line("initialized")).unwrap();
        assert_eq!(note["method"], "initialized");
        assert!(note.get("id").is_none());

        let resp: Value =
            serde_json::from_str(&response_line(&json!(0), &json!({ "ok": true }))).unwrap();
        assert_eq!(resp["id"], 0);
        assert_eq!(resp["result"]["ok"], true);

        let err: Value =
            serde_json::from_str(&error_response_line(&json!(9), -32601, "nope")).unwrap();
        assert_eq!(err["id"], 9);
        assert_eq!(err["error"]["code"], -32601);
    }

    #[test]
    fn dynamic_tool_specs_match_the_registry() {
        let specs = dynamic_tool_specs();
        assert_eq!(specs.len(), registry::tool_definitions().len());
        for spec in &specs {
            assert_eq!(spec["type"], "function");
            assert!(spec["name"].is_string());
            assert!(spec["description"].is_string());
            assert_eq!(spec["inputSchema"]["type"], "object");
            assert!(spec.get("timeout_ms").is_none(), "bus-internal field leaked");
            assert!(spec.get("parameters").is_none(), "must be renamed to inputSchema");
        }
        assert!(specs.iter().any(|s| s["name"] == "fleet_snapshot"));
    }

    #[test]
    fn tool_call_response_adapts_ok_and_err() {
        let ok = tool_call_response(&Ok(json!({ "summary": "8 panes" })));
        assert_eq!(ok["success"], true);
        assert_eq!(ok["contentItems"][0]["type"], "inputText");
        assert!(ok["contentItems"][0]["text"]
            .as_str()
            .unwrap()
            .contains("8 panes"));

        // plain string results pass through without JSON quoting
        let s = tool_call_response(&Ok(json!("pong")));
        assert_eq!(s["contentItems"][0]["text"], "pong");

        let err = tool_call_response(&Err("unknown pane_id \"x\"".into()));
        assert_eq!(err["success"], false);
        let text = err["contentItems"][0]["text"].as_str().unwrap();
        assert!(text.starts_with("ERROR:"), "{text}");
        assert!(text.contains("unknown pane_id"), "{text}");
    }

    #[test]
    fn tool_args_are_normalized() {
        assert_eq!(normalize_tool_args(None), json!({}));
        assert_eq!(normalize_tool_args(Some(&Value::Null)), json!({}));
        assert_eq!(
            normalize_tool_args(Some(&json!({ "pane_id": "a" }))),
            json!({ "pane_id": "a" })
        );
        // stringified JSON from a confused model is unwrapped
        assert_eq!(
            normalize_tool_args(Some(&json!("{\"pane_id\":\"a\"}"))),
            json!({ "pane_id": "a" })
        );
    }

    #[test]
    fn args_summaries_are_capped_to_one_line() {
        let short = summarize_args(&json!({ "a": 1 }));
        assert_eq!(short, "{\"a\":1}");
        let long = summarize_args(&json!({ "text": "x".repeat(500) }));
        assert!(long.chars().count() <= 161);
        assert!(long.ends_with('…'));
    }
}
