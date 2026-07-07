// Orchestrator brain, provider B (Phase 6): ONE streamed OpenRouter
// chat-completion call per loop iteration. The tool LOOP itself lives in the
// webview (src/lib/orchestrator/openrouter-loop.ts) because the executors do
// — this side only owns what must not reach JS (the keychain key) and what
// Rust does better (SSE streaming with timeouts).
//
// Contract with the TS loop:
//   - `chat_completion` POSTs /chat/completions with `stream:true`, `tools`,
//     `tool_choice:"auto"`, emits every content token as the SAME
//     `orchestrator://chat-event` `{chat_id, kind:"delta", data:{text}}`
//     payload the app-server client emits (chat_id = the STORE chat id the
//     frontend passed — the controller self-links it), and resolves with the
//     assembled assistant message
//     `{ content, tool_calls: [{id,name,arguments_json}]|null, finish_reason }`.
//   - `cancel` flips a per-chat flag checked between stream chunks; the call
//     then resolves early with `finish_reason:"cancelled"` (partial content
//     kept — the deltas already streamed).
//
// The SSE / tool-call-fragment assembly is tauri-free (`SseAssembler`) and
// unit-tested against fixture chunks below. OpenAI-format streaming tool
// calls arrive as index-keyed deltas — id/name/arguments accumulate per
// index until the stream ends.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

const API_URL: &str = "https://openrouter.ai/api/v1/chat/completions";
/// TCP/TLS connect budget — a dead network must fail fast.
const CONNECT_TIMEOUT_S: u64 = 15;
/// Max silence BETWEEN stream chunks (not the whole response — a long
/// generation keeps ticking as long as tokens arrive).
const READ_TIMEOUT_S: u64 = 120;

// ---------------------------------------------------------------------------
// SSE assembly (tauri-free, unit-tested)
// ---------------------------------------------------------------------------

/// One streaming tool call being accumulated (OpenAI fragment format:
/// the first fragment carries id + function.name, all fragments append
/// function.arguments pieces).
#[derive(Debug, Default, Clone)]
struct PartialToolCall {
    id: String,
    name: String,
    arguments: String,
}

/// Incremental parser for an OpenRouter/OpenAI SSE chat-completion stream.
/// Feed raw byte chunks (they may split lines and UTF-8 sequences anywhere);
/// get back the content deltas of each chunk; `finish()` yields the
/// assembled assistant message.
#[derive(Debug, Default)]
pub struct SseAssembler {
    /// unconsumed bytes (partial line at a chunk boundary)
    buf: Vec<u8>,
    content: String,
    /// index-keyed accumulation — BTreeMap keeps the call order stable
    tool_calls: BTreeMap<u64, PartialToolCall>,
    finish_reason: Option<String>,
    /// a `data: {"error": …}` event mid-stream (OpenRouter reports provider
    /// failures this way even on a 200 response)
    error: Option<String>,
    done: bool,
}

impl SseAssembler {
    /// Feed one raw chunk; returns the content deltas it contained (in order).
    pub fn push_chunk(&mut self, chunk: &[u8]) -> Vec<String> {
        let mut deltas = Vec::new();
        self.buf.extend_from_slice(chunk);
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            self.process_line(line.trim_end_matches(['\n', '\r']), &mut deltas);
        }
        deltas
    }

    fn process_line(&mut self, line: &str, deltas: &mut Vec<String>) {
        // SSE comments (": OPENROUTER PROCESSING" keep-alives), blank event
        // separators and any non-data field fall out here
        let Some(data) = line.strip_prefix("data:") else {
            return;
        };
        let data = data.trim();
        if data == "[DONE]" {
            self.done = true;
            return;
        }
        let Ok(v) = serde_json::from_str::<Value>(data) else {
            return; // torn/unknown payload: skip the line, keep the stream
        };
        if let Some(err) = v.get("error") {
            self.error = Some(
                err.get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("stream error")
                    .to_string(),
            );
            return;
        }
        let Some(choice) = v.pointer("/choices/0") else {
            return;
        };
        if let Some(delta) = choice.get("delta") {
            if let Some(text) = delta.get("content").and_then(|c| c.as_str()) {
                if !text.is_empty() {
                    self.content.push_str(text);
                    deltas.push(text.to_string());
                }
            }
            if let Some(calls) = delta.get("tool_calls").and_then(|t| t.as_array()) {
                for frag in calls {
                    let index = frag.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
                    let entry = self.tool_calls.entry(index).or_default();
                    if let Some(id) = frag.get("id").and_then(|i| i.as_str()) {
                        if entry.id.is_empty() {
                            entry.id = id.to_string();
                        }
                    }
                    if let Some(name) = frag.pointer("/function/name").and_then(|n| n.as_str()) {
                        entry.name.push_str(name);
                    }
                    if let Some(args) =
                        frag.pointer("/function/arguments").and_then(|a| a.as_str())
                    {
                        entry.arguments.push_str(args);
                    }
                }
            }
        }
        if let Some(reason) = choice.get("finish_reason").and_then(|r| r.as_str()) {
            self.finish_reason = Some(reason.to_string());
        }
    }

    pub fn is_done(&self) -> bool {
        self.done
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    /// The assembled assistant message the TS loop consumes.
    pub fn finish(self, cancelled: bool) -> Value {
        let tool_calls: Vec<Value> = self
            .tool_calls
            .into_values()
            .filter(|c| !c.name.is_empty())
            .map(|c| {
                json!({ "id": c.id, "name": c.name, "arguments_json": c.arguments })
            })
            .collect();
        json!({
            "content": if self.content.is_empty() { Value::Null } else { json!(self.content) },
            "tool_calls": if tool_calls.is_empty() { Value::Null } else { json!(tool_calls) },
            "finish_reason": if cancelled {
                json!("cancelled")
            } else {
                self.finish_reason.map(Value::from).unwrap_or(Value::Null)
            },
        })
    }
}

// ---------------------------------------------------------------------------
// Streaming call + cancel
// ---------------------------------------------------------------------------

/// Per-chat cancel flags — set by `cancel`, checked between stream chunks.
/// One in-flight completion per chat (the TS loop is strictly sequential).
static CANCELS: Lazy<Mutex<HashMap<String, Arc<AtomicBool>>>> = Lazy::new(Default::default);

/// Ask the chat's in-flight completion (if any) to stop at the next chunk
/// boundary. The TS loop additionally checks its own abort flag between
/// iterations, so a cancel always lands within one chunk/tool call.
pub fn cancel(chat_id: &str) {
    if let Some(flag) = CANCELS.lock().get(chat_id) {
        flag.store(true, Ordering::SeqCst);
    }
}

/// Human-actionable message for the OpenRouter failure modes users actually
/// hit; everything else goes through the shared error-body extraction.
fn status_error(status: reqwest::StatusCode, body: &str) -> String {
    match status.as_u16() {
        401 | 403 => format!(
            "OpenRouter rejected the API key ({status}) — the key is invalid or was revoked. Check the key in Settings → Voice."
        ),
        402 => "OpenRouter: out of credits (402) — top up your OpenRouter balance.".to_string(),
        429 => "OpenRouter: rate limited (429) — too many requests; wait a moment and try again."
            .to_string(),
        _ => crate::openrouter::api_error(status, body),
    }
}

/// One streamed chat-completion call. `messages` is the OpenAI-format wire
/// history the TS loop maintains, `tools` the adapted registry catalog.
/// Content tokens emit as `delta` chat events under `chat_id`; the resolved
/// value is the assembled assistant message (see module docs).
pub async fn chat_completion(
    app: &AppHandle,
    chat_id: String,
    model: String,
    messages: Value,
    tools: Value,
) -> Result<Value, String> {
    let key = crate::openrouter::read_key_blocking()
        .await
        .ok_or("No OpenRouter API key set — add one in Settings → Voice")?;
    let flag = Arc::new(AtomicBool::new(false));
    CANCELS.lock().insert(chat_id.clone(), flag.clone());
    let result = run_stream(app, &chat_id, &key, &model, messages, tools, &flag).await;
    CANCELS.lock().remove(&chat_id);
    result
}

async fn run_stream(
    app: &AppHandle,
    chat_id: &str,
    key: &str,
    model: &str,
    messages: Value,
    tools: Value,
    cancel_flag: &AtomicBool,
) -> Result<Value, String> {
    let body = json!({
        "model": model,
        "messages": messages,
        "tools": tools,
        "tool_choice": "auto",
        "stream": true,
    });
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_S))
        .read_timeout(Duration::from_secs(READ_TIMEOUT_S))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(API_URL)
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("OpenRouter request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(status_error(status, &text));
    }

    let mut assembler = SseAssembler::default();
    let mut stream = resp.bytes_stream();
    let mut cancelled = false;
    while let Some(chunk) = stream.next().await {
        if cancel_flag.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }
        let chunk = chunk.map_err(|e| format!("OpenRouter stream error: {e}"))?;
        for delta in assembler.push_chunk(&chunk) {
            let _ = app.emit(
                "orchestrator://chat-event",
                json!({ "chat_id": chat_id, "kind": "delta", "data": { "text": delta } }),
            );
        }
        if let Some(err) = assembler.error() {
            return Err(format!("OpenRouter: {err}"));
        }
        if assembler.is_done() {
            break;
        }
    }
    Ok(assembler.finish(cancelled))
}

// ---------------------------------------------------------------------------
// Tests — fixture chunks in the exact wire shape OpenRouter streams
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(assembler: &mut SseAssembler, chunks: &[&str]) -> Vec<String> {
        let mut deltas = Vec::new();
        for c in chunks {
            deltas.extend(assembler.push_chunk(c.as_bytes()));
        }
        deltas
    }

    #[test]
    fn content_deltas_stream_and_assemble() {
        let mut a = SseAssembler::default();
        let deltas = feed(
            &mut a,
            &[
                ": OPENROUTER PROCESSING\n\n",
                "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"Hal\"}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"lo!\"},\"finish_reason\":null}]}\n\n",
                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
            ],
        );
        assert_eq!(deltas, vec!["Hal", "lo!"]);
        assert!(a.is_done());
        let msg = a.finish(false);
        assert_eq!(msg["content"], "Hallo!");
        assert_eq!(msg["tool_calls"], Value::Null);
        assert_eq!(msg["finish_reason"], "stop");
    }

    #[test]
    fn chunk_boundaries_may_split_lines_and_utf8() {
        let mut a = SseAssembler::default();
        // "ö" is 0xC3 0xB6 — split the two bytes across chunks, and also
        // split the SSE line itself mid-JSON
        let line = "data: {\"choices\":[{\"delta\":{\"content\":\"schön\"}}]}\n".as_bytes();
        let (first, second) = line.split_at(43); // between the two ö bytes
        let mut deltas = a.push_chunk(first);
        deltas.extend(a.push_chunk(second));
        assert_eq!(deltas, vec!["schön"]);
        assert_eq!(a.finish(false)["content"], "schön");
    }

    #[test]
    fn tool_call_fragments_accumulate_per_index() {
        let mut a = SseAssembler::default();
        let deltas = feed(
            &mut a,
            &[
                // first fragment: id + name + argument prefix
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"type\":\"function\",\"function\":{\"name\":\"prompt_pane\",\"arguments\":\"{\\\"pane\"}}]}}]}\n\n",
                // second tool call opens while the first still streams args
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":1,\"id\":\"call_b\",\"type\":\"function\",\"function\":{\"name\":\"git_status\",\"arguments\":\"\"}}]}}]}\n\n",
                // later fragments carry only index + argument pieces
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"_id\\\":\\\"p1\\\"}\"}}]}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":1,\"function\":{\"arguments\":\"{\\\"pane_id\\\":\\\"p2\\\"}\"}}]}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n",
            ],
        );
        assert!(deltas.is_empty(), "tool fragments are not content deltas");
        let msg = a.finish(false);
        assert_eq!(msg["finish_reason"], "tool_calls");
        let calls = msg["tool_calls"].as_array().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0]["id"], "call_a");
        assert_eq!(calls[0]["name"], "prompt_pane");
        assert_eq!(calls[0]["arguments_json"], "{\"pane_id\":\"p1\"}");
        assert_eq!(calls[1]["id"], "call_b");
        assert_eq!(calls[1]["name"], "git_status");
        assert_eq!(calls[1]["arguments_json"], "{\"pane_id\":\"p2\"}");
    }

    #[test]
    fn mixed_content_then_tool_calls() {
        let mut a = SseAssembler::default();
        let deltas = feed(
            &mut a,
            &[
                "data: {\"choices\":[{\"delta\":{\"content\":\"Ich schaue nach. \"}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"fleet_snapshot\",\"arguments\":\"{}\"}}]}}]}\n\n",
                "data: [DONE]\n\n",
            ],
        );
        assert_eq!(deltas, vec!["Ich schaue nach. "]);
        let msg = a.finish(false);
        assert_eq!(msg["content"], "Ich schaue nach. ");
        assert_eq!(msg["tool_calls"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn error_events_surface_and_torn_lines_are_skipped() {
        let mut a = SseAssembler::default();
        feed(&mut a, &["data: {not json at all\n\n"]);
        assert!(a.error().is_none(), "unparseable lines are skipped");
        feed(
            &mut a,
            &["data: {\"error\":{\"message\":\"Provider returned error\",\"code\":502}}\n\n"],
        );
        assert_eq!(a.error(), Some("Provider returned error"));
    }

    #[test]
    fn cancelled_finish_keeps_partial_content() {
        let mut a = SseAssembler::default();
        feed(
            &mut a,
            &["data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n"],
        );
        let msg = a.finish(true);
        assert_eq!(msg["content"], "partial");
        assert_eq!(msg["finish_reason"], "cancelled");
    }

    #[test]
    fn empty_stream_finishes_null() {
        let msg = SseAssembler::default().finish(false);
        assert_eq!(msg["content"], Value::Null);
        assert_eq!(msg["tool_calls"], Value::Null);
        assert_eq!(msg["finish_reason"], Value::Null);
    }

    #[test]
    fn cancel_flag_roundtrip() {
        let flag = Arc::new(AtomicBool::new(false));
        CANCELS.lock().insert("chat-x".into(), flag.clone());
        cancel("chat-x");
        assert!(flag.load(Ordering::SeqCst));
        CANCELS.lock().remove("chat-x");
        // unknown ids are a no-op, not a panic
        cancel("chat-never");
    }
}
