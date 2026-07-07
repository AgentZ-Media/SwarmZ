// Orchestrator-specific adapters between the tool registry / tool bus and
// the app-server's experimental dynamic-tools wire shapes. Deliberately NOT
// part of `crate::codex` — the generic host knows nothing about tools; only
// the orchestrator declares its registry as dynamicTools and answers
// `item/tool/call` server requests.

use serde_json::{json, Value};

use super::registry;

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
