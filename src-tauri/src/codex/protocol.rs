// Wire protocol for `codex app-server`: JSON-RPC 2.0 over newline-delimited
// stdio — WITHOUT the `"jsonrpc":"2.0"` header field. Verified against codex
// 0.142.5 (the server neither sends nor expects it).
//
// This module is pure (no process, no tauri): message framing and the
// incoming-line classifier only. Everything here is unit-tested against
// fixture lines captured from real codex 0.142.5 runs — including the
// notification shapes the native session integration (Vibe Mode) consumes
// (command executions, file changes, diffs, token usage, approvals).
// Consumer-specific payload adapters live with their consumer (e.g. the
// orchestrator's dynamic-tool adapters in `orchestrator/adapter.rs`).

use serde_json::{json, Value};

/// One parsed incoming line from the app-server's stdout.
#[derive(Debug)]
pub enum Incoming {
    /// Answer to one of OUR requests (`id` echoes the numeric id we sent).
    Response { id: u64, result: Result<Value, String> },
    /// SERVER-initiated request (e.g. `item/tool/call`, approvals) — must be
    /// answered. `id` is kept as raw JSON so the response echoes it exactly
    /// (`RequestId` is `number | string` on the wire).
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

#[cfg(test)]
mod tests {
    use super::*;

    // ---- fixture lines captured from real `codex app-server` 0.142.5 runs ----
    // (paths and long outputs shortened; structure and key names verbatim)

    const FIX_RESPONSE: &str = r#"{"id":3,"result":{"turn":{"id":"019f3bb5-7c19-7333-b5c4-82061b6ad4e1","items":[],"itemsView":"notLoaded","status":"inProgress","error":null,"startedAt":null,"completedAt":null,"durationMs":null}}}"#;
    const FIX_TOOL_CALL: &str = r#"{"method":"item/tool/call","id":0,"params":{"threadId":"019f3bb5-7b8c-7da1-a256-0a2549b0454f","turnId":"019f3bb5-7c19-7333-b5c4-82061b6ad4e1","callId":"call_MRL4QG5Mmi1BTmRl0FsxfdFe","namespace":null,"tool":"ping","arguments":{}}}"#;
    const FIX_DELTA: &str = r#"{"method":"item/agentMessage/delta","params":{"threadId":"019f3d01-7098-7341-a5a9-88ad8245e07f","turnId":"019f3d01-712a-7e61-907d-89bb92f8d1cf","itemId":"msg_019daad29134e9a1016a4d0eb7018081918d350eb572ede66c","delta":"I"}}"#;
    const FIX_TURN_DONE: &str = r#"{"method":"turn/completed","params":{"threadId":"019f3bb5-7b8c-7da1-a256-0a2549b0454f","turn":{"id":"019f3bb5-7c19-7333-b5c4-82061b6ad4e1","items":[],"itemsView":"notLoaded","status":"completed","error":null,"startedAt":1783413177,"completedAt":1783413181,"durationMs":4383}}}"#;
    const FIX_ERROR: &str = r#"{"id":7,"error":{"code":-32600,"message":"thread not found"}}"#;

    // item lifecycle around a commandExecution item (run-A): started with
    // status inProgress / null output, completed with aggregatedOutput+exitCode
    const FIX_CMD_STARTED: &str = r#"{"method":"item/started","params":{"item":{"type":"commandExecution","id":"call_o8hWKlCoCOgSRo987XU58FUQ","command":"/bin/zsh -lc 'ls -la'","cwd":"/tmp/worktest-a","processId":"31794","source":"unifiedExecStartup","status":"inProgress","commandActions":[{"type":"listFiles","command":"ls -la","path":null}],"aggregatedOutput":null,"exitCode":null,"durationMs":null},"threadId":"019f3d01-7098-7341-a5a9-88ad8245e07f","turnId":"019f3d01-712a-7e61-907d-89bb92f8d1cf","startedAtMs":1783434938103}}"#;
    const FIX_CMD_COMPLETED: &str = r#"{"method":"item/completed","params":{"item":{"type":"commandExecution","id":"call_o8hWKlCoCOgSRo987XU58FUQ","command":"/bin/zsh -lc 'ls -la'","cwd":"/tmp/worktest-a","processId":"31794","source":"unifiedExecStartup","status":"completed","commandActions":[{"type":"listFiles","command":"ls -la","path":null}],"aggregatedOutput":"total 8\n-rw-r--r--@ 1 user wheel 3 Jul 7 16:35 hello.txt\n","exitCode":0,"durationMs":0},"threadId":"019f3d01-7098-7341-a5a9-88ad8245e07f","turnId":"019f3d01-712a-7e61-907d-89bb92f8d1cf","completedAtMs":1783434938103}}"#;

    // fileChange item (run-A): changes[].kind is the tagged PatchChangeKind
    // object; for "add" the diff is the RAW new content, not a unified diff
    const FIX_FILECHANGE_STARTED: &str = r#"{"method":"item/started","params":{"item":{"type":"fileChange","id":"call_ee95UPJLeYsSl91AgvLbYt9X","changes":[{"path":"/tmp/worktest-a/hello.txt","kind":{"type":"add"},"diff":"hi\n"}],"status":"inProgress"},"threadId":"019f3d01-7098-7341-a5a9-88ad8245e07f","turnId":"019f3d01-712a-7e61-907d-89bb92f8d1cf","startedAtMs":1783434935651}}"#;
    const FIX_FILECHANGE_COMPLETED: &str = r#"{"method":"item/completed","params":{"item":{"type":"fileChange","id":"call_ee95UPJLeYsSl91AgvLbYt9X","changes":[{"path":"/tmp/worktest-a/hello.txt","kind":{"type":"add"},"diff":"hi\n"}],"status":"completed"},"threadId":"019f3d01-7098-7341-a5a9-88ad8245e07f","turnId":"019f3d01-712a-7e61-907d-89bb92f8d1cf","completedAtMs":1783434935766}}"#;

    // the aggregated unified diff of the whole turn (run-A, fired 4×)
    const FIX_TURN_DIFF: &str = r#"{"method":"turn/diff/updated","params":{"threadId":"019f3d01-7098-7341-a5a9-88ad8245e07f","turnId":"019f3d01-712a-7e61-907d-89bb92f8d1cf","diff":"diff --git a/hello.txt b/hello.txt\nnew file mode 100644\n--- /dev/null\n+++ b/hello.txt\n@@ -0,0 +1 @@\n+hi\n"}}"#;

    // NOT live-captured: turn/plan/updated never fired in the 0.142.5 probe
    // runs — this line is constructed from the generated schema
    // (TurnPlanUpdatedNotification: explanation:string|null, plan:TurnPlanStep[])
    const FIX_TURN_PLAN: &str = r#"{"method":"turn/plan/updated","params":{"threadId":"019f3d01-7098-7341-a5a9-88ad8245e07f","turnId":"019f3d01-712a-7e61-907d-89bb92f8d1cf","explanation":null,"plan":[{"step":"Write the file","status":"completed"},{"step":"Run the command","status":"inProgress"}]}}"#;

    // per-thread token usage (run-A, fired multiple times per turn):
    // total = cumulative over the thread, last = the last turn
    const FIX_TOKEN_USAGE: &str = r#"{"method":"thread/tokenUsage/updated","params":{"threadId":"019f3d01-7098-7341-a5a9-88ad8245e07f","turnId":"019f3d01-712a-7e61-907d-89bb92f8d1cf","tokenUsage":{"total":{"totalTokens":15043,"inputTokens":14992,"cachedInputTokens":4992,"outputTokens":51,"reasoningOutputTokens":0},"last":{"totalTokens":15043,"inputTokens":14992,"cachedInputTokens":4992,"outputTokens":51,"reasoningOutputTokens":0},"modelContextWindow":258400}}}"#;

    // account-level rate limits (run-A) — note: NO threadId in params
    const FIX_RATE_LIMITS: &str = r#"{"method":"account/rateLimits/updated","params":{"rateLimits":{"limitId":"codex","limitName":null,"primary":{"usedPercent":0,"windowDurationMins":300,"resetsAt":1783452933},"secondary":{"usedPercent":13,"windowDurationMins":10080,"resetsAt":1783705917},"credits":null,"individualLimit":null,"planType":"pro","rateLimitReachedType":null}}}"#;

    // command approval server request (run-D): numeric id 0, human-readable
    // reason, the shell line + parsed actions, and the live-only extra
    // `availableDecisions` (not in the generated schema — don't rely on it)
    const FIX_CMD_APPROVAL: &str = r#"{"method":"item/commandExecution/requestApproval","id":0,"params":{"threadId":"019f3d03-8b98-7c32-ad34-36d666c71dd8","turnId":"019f3d03-8c08-7241-874e-2686e0ec7f04","itemId":"call_KgTwkJVDRr0mqb8XA5Ym1cee","startedAtMs":1783435074869,"environmentId":"local","reason":"Do you want to allow creating approval_probe.txt in the current directory?","command":"/bin/zsh -lc 'touch approval_probe.txt'","cwd":"/tmp/worktest-b","commandActions":[{"type":"unknown","command":"touch approval_probe.txt"}],"proposedExecpolicyAmendment":["touch"],"availableDecisions":["accept",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["touch"]}},"cancel"]}}"#;

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
                assert_eq!(params["delta"], "I");
                assert!(params["itemId"].is_string());
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

    // ---- frozen session-facing notification shapes (Vibe Mode) ----

    #[test]
    fn command_execution_item_lifecycle_shapes() {
        let started = match parse_line(FIX_CMD_STARTED) {
            Some(Incoming::Notification { method, params }) => {
                assert_eq!(method, "item/started");
                params
            }
            other => panic!("expected Notification, got {other:?}"),
        };
        // every item notification carries threadId + turnId → routable
        assert!(started["threadId"].is_string());
        assert!(started["turnId"].is_string());
        assert!(started["startedAtMs"].is_u64());
        let item = &started["item"];
        assert_eq!(item["type"], "commandExecution");
        assert_eq!(item["status"], "inProgress");
        // the real shell line codex wraps the command in
        assert_eq!(item["command"], "/bin/zsh -lc 'ls -la'");
        assert_eq!(item["commandActions"][0]["type"], "listFiles");
        // output fields are null until completion
        assert!(item["aggregatedOutput"].is_null());
        assert!(item["exitCode"].is_null());

        let completed = match parse_line(FIX_CMD_COMPLETED) {
            Some(Incoming::Notification { method, params }) => {
                assert_eq!(method, "item/completed");
                params
            }
            other => panic!("expected Notification, got {other:?}"),
        };
        let item = &completed["item"];
        assert_eq!(item["status"], "completed");
        assert_eq!(item["exitCode"], 0);
        assert!(item["aggregatedOutput"]
            .as_str()
            .unwrap()
            .contains("hello.txt"));
        // same item id across started → completed (lifecycle correlation key)
        assert_eq!(started["item"]["id"], item["id"]);
    }

    #[test]
    fn file_change_item_shapes() {
        for (line, expected_status) in [
            (FIX_FILECHANGE_STARTED, "inProgress"),
            (FIX_FILECHANGE_COMPLETED, "completed"),
        ] {
            let params = match parse_line(line) {
                Some(Incoming::Notification { params, .. }) => params,
                other => panic!("expected Notification, got {other:?}"),
            };
            let item = &params["item"];
            assert_eq!(item["type"], "fileChange");
            assert_eq!(item["status"], expected_status);
            let change = &item["changes"][0];
            assert!(change["path"].as_str().unwrap().ends_with("hello.txt"));
            // PatchChangeKind is a tagged object, not a plain string
            assert_eq!(change["kind"]["type"], "add");
            // for "add" the diff is the raw new file content — the unified
            // diff comes separately via turn/diff/updated
            assert_eq!(change["diff"], "hi\n");
        }
    }

    #[test]
    fn turn_diff_and_plan_shapes() {
        match parse_line(FIX_TURN_DIFF) {
            Some(Incoming::Notification { method, params }) => {
                assert_eq!(method, "turn/diff/updated");
                let diff = params["diff"].as_str().unwrap();
                assert!(diff.starts_with("diff --git"), "aggregated unified diff");
                assert!(params["threadId"].is_string());
            }
            other => panic!("expected Notification, got {other:?}"),
        }
        match parse_line(FIX_TURN_PLAN) {
            Some(Incoming::Notification { method, params }) => {
                assert_eq!(method, "turn/plan/updated");
                assert!(params["explanation"].is_null());
                assert_eq!(params["plan"].as_array().unwrap().len(), 2);
                assert_eq!(params["plan"][1]["status"], "inProgress");
            }
            other => panic!("expected Notification, got {other:?}"),
        }
    }

    #[test]
    fn token_usage_and_rate_limit_shapes() {
        match parse_line(FIX_TOKEN_USAGE) {
            Some(Incoming::Notification { method, params }) => {
                assert_eq!(method, "thread/tokenUsage/updated");
                let usage = &params["tokenUsage"];
                assert_eq!(usage["total"]["totalTokens"], 15043);
                assert_eq!(usage["total"]["cachedInputTokens"], 4992);
                assert_eq!(usage["last"]["outputTokens"], 51);
                assert_eq!(usage["modelContextWindow"], 258400);
            }
            other => panic!("expected Notification, got {other:?}"),
        }
        match parse_line(FIX_RATE_LIMITS) {
            Some(Incoming::Notification { method, params }) => {
                assert_eq!(method, "account/rateLimits/updated");
                // account-scoped: no threadId — must not be thread-routed
                assert!(params.get("threadId").is_none());
                let rl = &params["rateLimits"];
                assert_eq!(rl["limitId"], "codex");
                assert_eq!(rl["primary"]["windowDurationMins"], 300);
                assert_eq!(rl["secondary"]["usedPercent"], 13);
                assert_eq!(rl["planType"], "pro");
            }
            other => panic!("expected Notification, got {other:?}"),
        }
    }

    #[test]
    fn command_approval_request_shape_and_decisions() {
        let (id, params) = match parse_line(FIX_CMD_APPROVAL) {
            Some(Incoming::ServerRequest { id, method, params }) => {
                assert_eq!(method, "item/commandExecution/requestApproval");
                (id, params)
            }
            other => panic!("expected ServerRequest, got {other:?}"),
        };
        // server-request ids are their own numeric sequence starting at 0
        assert_eq!(id, json!(0));
        assert!(params["threadId"].is_string());
        // itemId links the approval to its commandExecution item
        assert!(params["itemId"].as_str().unwrap().starts_with("call_"));
        assert!(params["reason"].as_str().unwrap().contains("allow"));
        assert_eq!(params["command"], "/bin/zsh -lc 'touch approval_probe.txt'");
        // availableDecisions is a live-only extra (absent from the generated
        // schema) — parse defensively, never require it
        let decisions = params["availableDecisions"].as_array().unwrap();
        assert!(decisions.contains(&json!("accept")));
        assert!(decisions.iter().any(|d| d.get("acceptWithExecpolicyAmendment").is_some()));

        // the four plain response decisions (CommandExecutionApprovalDecision)
        // — "accept"/"decline" live-verified on 0.142.5
        for decision in ["accept", "acceptForSession", "decline", "cancel"] {
            let line = response_line(&id, &json!({ "decision": decision }));
            let v: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(v["id"], 0);
            assert_eq!(v["result"]["decision"], decision);
            assert!(v.get("jsonrpc").is_none());
        }
    }
}
