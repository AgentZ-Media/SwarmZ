use super::*;
use crate::codex::host::{handshake, Client, ServerEvent};

fn project() -> ProjectContext {
    ProjectContext {
        id: "p1".into(),
        dir: std::env::temp_dir().to_string_lossy().into_owned(),
        name: "api".into(),
    }
}

#[test]
fn model_list_keeps_routing_metadata_and_filters_hidden_and_ultra() {
    // shape from the generated 0.144.1 `ModelListResponse` schema
    let res = json!({ "data": [
            {
                "id": "gpt-5.6-sol", "model": "gpt-5.6-sol",
                "displayName": "GPT-5.6 Sol", "description": "Frontier model",
                "hidden": false, "isDefault": true,
                "defaultReasoningEffort": "low",
                "supportedReasoningEfforts": [
                    { "reasoningEffort": "low", "description": "Fast" },
                    { "reasoningEffort": "max", "description": "Deep" },
                    { "reasoningEffort": "ultra", "description": "Multi-agent" }
                ]
            },
            { "id": "gpt-5.5-internal", "hidden": true },
            { "id": "gpt-5.6-luna", "displayName": "GPT-5.6 Luna", "hidden": false },
            { "displayName": "no id — dropped", "hidden": false },
        ], "nextCursor": "page-2" });
    let (models, next) = parse_model_page(&res).expect("valid page");
    assert_eq!(next.as_deref(), Some("page-2"));
    assert_eq!(models.len(), 2);
    assert_eq!(models[0].model, "gpt-5.6-sol");
    assert!(models[0].is_default);
    assert_eq!(models[0].default_reasoning_effort, "low");
    assert_eq!(
        models[0]
            .supported_reasoning_efforts
            .iter()
            .map(|entry| entry.effort.as_str())
            .collect::<Vec<_>>(),
        vec!["low", "max"]
    );
    assert!(parse_model_page(&json!({})).is_err());
}

#[test]
fn version_guard_wraps_dynamic_tool_failures_only() {
    let wrapped = guard_dynamic_tools_error(
        "unknown field `dynamicTools` (code -32602)".into(),
        Some("codex/0.99.0"),
    );
    assert!(wrapped.contains("codex/0.99.0"), "{wrapped}");
    assert!(wrapped.contains(KNOWN_GOOD_VERSION), "{wrapped}");

    let untouched = guard_dynamic_tools_error("network unreachable".into(), None);
    assert_eq!(untouched, "network unreachable");
}

#[test]
fn thread_params_carry_project_cwd_tools_sandbox_and_instructions() {
    let project = project();
    let start = thread_start_params(&project, &MemoryBlocks::default());
    assert_eq!(start["sandbox"], "read-only");
    assert_eq!(start["approvalPolicy"], "never");
    // the Conductor works IN the project — cwd is the project dir
    assert_eq!(start["cwd"], json!(project.dir));
    let instructions = start["developerInstructions"].as_str().unwrap();
    assert!(instructions.contains("Conductor of THIS project"));
    // the single fixed identity is compiled ahead of the operative core
    assert!(instructions.contains("You are Orchestrator"));
    assert!(!instructions.contains("Maestro"));
    assert!(!instructions.contains("Hive"));
    // the project block names the project (quoted literal since the
    // injection hardening)
    assert!(instructions.contains("Name: \"api\""));
    // the approval doctrine is single-source here
    assert!(instructions.contains("the HUMAN holds final authority over what an agent may do"));
    let tools = start["dynamicTools"].as_array().unwrap();
    assert_eq!(tools.len(), crate::orchestrator::tool_definitions().len());
    assert!(tools.iter().any(|t| t["name"] == "spawn_agents"));
    assert!(tools.iter().any(|t| t["name"] == "list_models"));

    let catalog = vec![ModelCatalogEntry {
        id: "gpt-5.6-terra".into(),
        model: "gpt-5.6-terra".into(),
        display_name: "GPT-5.6 Terra".into(),
        description: "Balanced everyday model".into(),
        is_default: false,
        default_reasoning_effort: "medium".into(),
        supported_reasoning_efforts: vec![ReasoningEffortEntry {
            effort: "medium".into(),
            description: String::new(),
        }],
    }];
    let with_models =
        thread_start_params_with_models(&project, &MemoryBlocks::default(), Some(&catalog));
    let model_instructions = with_models["developerInstructions"].as_str().unwrap();
    assert!(model_instructions.contains("gpt-5.6-terra"));
    assert!(model_instructions.contains("supported efforts [medium]"));

    // memory snapshots flow into developerInstructions when present
    let with_mem = thread_start_params(
        &project,
        &MemoryBlocks {
            global: "- 2026-07-07 reviews go to Opus".into(),
            project: "- 2026-07-08 uses pnpm".into(),
        },
    );
    let text = with_mem["developerInstructions"].as_str().unwrap();
    assert!(text.contains("reviews go to Opus"));
    assert!(text.contains("uses pnpm"));

    // resume must NOT re-declare dynamicTools (restored from the rollout)
    let resume = thread_resume_params("t-1", &project, &MemoryBlocks::default());
    assert_eq!(resume["threadId"], "t-1");
    assert!(resume.get("dynamicTools").is_none());
    assert_eq!(resume["sandbox"], "read-only");
    assert_eq!(resume["cwd"], json!(project.dir));
    assert!(resume["developerInstructions"]
        .as_str()
        .unwrap()
        .contains("Conductor of THIS project"));
}

/// Insert a bare test chat into SHARED (unique ids per test — SHARED is
/// process-global).
fn insert_test_chat(chat_id: &str, project_id: &str, generation: u64) {
    let mut shared = SHARED.lock();
    shared
        .thread_to_chat
        .insert(format!("thread-{chat_id}"), chat_id.to_string());
    shared.chats.insert(
        chat_id.to_string(),
        ChatState {
            thread_id: format!("thread-{chat_id}"),
            generation,
            fence_generation: generation,
            project: ProjectContext {
                id: project_id.into(),
                dir: String::new(),
                name: String::new(),
            },
            ..Default::default()
        },
    );
}

fn remove_test_chat(chat_id: &str) {
    let mut shared = SHARED.lock();
    if let Some(chat) = shared.chats.remove(chat_id) {
        shared.thread_to_chat.remove(&chat.thread_id);
    }
}

/// Audit C4 (frozen): the Conductor respawn race. `chat_send` installs
/// its `done_tx` while the chat still carries the OLD generation; a
/// delayed old-generation `Exited` must NOT take and fail that sender —
/// the send would then start the real turn anyway, the webview would
/// clear busy + the autonomous marker, and the still-running autonomous
/// turn's tool calls would count as human-triggered. The operation
/// binding (`done_gen`) plus the pre-`turn/start` gate close both halves.
#[test]
fn respawn_race_never_fails_a_mid_setup_operation() {
    let cid = format!("c4-race-{}", std::process::id());
    let pid = format!("c4-project-{}", std::process::id());
    insert_test_chat(&cid, &pid, 1);

    // the operation claims the slot (still on generation 1)
    let (tx, mut rx) = oneshot::channel();
    let (token, ..) = claim_turn_slot(&cid, tx, "busy").expect("claim");

    // the delayed gen-1 Exited straggler arrives MID-SETUP: it must not
    // touch the operation (its turn never ran on gen 1)
    assert!(
        take_exit_failures(&pid, 1).is_empty(),
        "an exit must never fail an operation that has not started a turn"
    );
    assert!(
        rx.try_recv().is_err(),
        "the fresh done_tx must survive the stale exit"
    );

    // chat_send advances the FENCE before awaiting the resume — from now
    // on gen-1 stragglers are dropped by the event guards
    advance_fence(&cid, 2);
    assert_eq!(chat_fence(&cid), Some(2));
    // (and the fence never moves backwards)
    advance_fence(&cid, 1);
    assert_eq!(chat_fence(&cid), Some(2));

    // the turn starts on generation 2
    assert!(
        try_mark_turn_started(&cid, token, 2),
        "the live op must start"
    );
    // another late gen-1 exit: the turn runs on gen 2 → untouched
    assert!(take_exit_failures(&pid, 1).is_empty());
    // a GENUINE gen-2 exit fails exactly this operation
    let failed = take_exit_failures(&pid, 2);
    assert_eq!(failed.len(), 1);
    assert_eq!(failed[0].0, cid);
    assert!(failed[0].1.is_some(), "the sender is taken for failing");
    remove_test_chat(&cid);
}

/// C4 companion: once an operation's sender was consumed, the operation
/// must NEVER start its turn (`try_mark_turn_started` refuses) — and a
/// stale token can neither free nor hijack a successor's slot.
#[test]
fn failed_operations_cannot_start_turns_and_stale_tokens_are_inert() {
    let cid = format!("c4-token-{}", std::process::id());
    let pid = format!("c4-token-project-{}", std::process::id());
    insert_test_chat(&cid, &pid, 1);

    let (tx1, _rx1) = oneshot::channel();
    let (token1, ..) = claim_turn_slot(&cid, tx1, "busy").expect("claim 1");
    // simulate the operation being failed (its sender consumed)
    SHARED
        .lock()
        .chats
        .get_mut(&cid)
        .unwrap()
        .done_tx
        .take()
        .unwrap()
        .send(TurnOutcome {
            status: "failed".into(),
            error: Some("codex app-server exited".into()),
            message: None,
        })
        .ok();
    assert!(
        !try_mark_turn_started(&cid, token1, 2),
        "a failed operation must never start a turn"
    );

    // a successor claims the slot — the stale token is inert against it
    let (tx2, mut rx2) = oneshot::channel();
    let (token2, ..) = claim_turn_slot(&cid, tx2, "busy").expect("claim 2");
    assert_ne!(token1, token2);
    clear_op(&cid, token1); // stale clear → no effect
    assert!(try_mark_turn_started(&cid, token2, 2));
    assert!(rx2.try_recv().is_err(), "successor's sender untouched");
    // the successor's own clear works
    clear_op(&cid, token2);
    assert!(SHARED.lock().chats.get(&cid).unwrap().done_tx.is_none());
    remove_test_chat(&cid);
}

/// C4 companion: a STALE `turn/completed` (a previous timed-out turn
/// ending late) must not steal a fresh operation's sender while that
/// operation is still setting up — `take_completion` only consumes once
/// a turn was genuinely started.
#[test]
fn stale_completion_never_steals_a_fresh_slot() {
    let cid = format!("c4-completion-{}", std::process::id());
    let pid = format!("c4-completion-project-{}", std::process::id());
    insert_test_chat(&cid, &pid, 1);

    let (tx, mut rx) = oneshot::channel();
    let (token, ..) = claim_turn_slot(&cid, tx, "busy").expect("claim");
    // stale completion arrives before the op started its turn → not taken
    let (taken, _) = take_completion(&cid);
    assert!(taken.is_none(), "mid-setup sender must not be consumed");
    assert!(rx.try_recv().is_err());
    // once the turn started, a completion IS taken
    assert!(try_mark_turn_started(&cid, token, 1));
    let (taken, _) = take_completion(&cid);
    assert!(taken.is_some(), "a started turn's completion resolves");
    remove_test_chat(&cid);
}

#[test]
fn thread_cwd_falls_back_to_home_when_the_dir_is_gone() {
    let mut p = project();
    assert_eq!(thread_cwd(&p), p.dir);
    p.dir = "/definitely/not/a/real/folder-83651".into();
    assert_eq!(thread_cwd(&p), home_dir_string());
    p.dir = "  ".into();
    assert_eq!(thread_cwd(&p), home_dir_string());
}

/// Full ping-tool loop against the REAL installed codex CLI. Ignored by
/// default (needs codex + login + network — CI stays green); run with:
///   cargo test appserver_spike -- --ignored --nocapture
#[tokio::test]
#[ignore = "live spike — needs the codex CLI, a login and network"]
async fn appserver_spike() {
    let (events_tx, mut events_rx) = mpsc::channel(4_096);
    // resolve exactly like production — doubles as a regression test for
    // the built app's minimal GUI PATH (run with PATH=/usr/bin:/bin …)
    let program = crate::codex::host::resolve_codex_program(None).expect("resolve codex binary");
    println!("resolved codex: {program}");
    let client = Arc::new(
        Client::spawn(&program, events_tx)
            .await
            .expect("spawn codex app-server"),
    );

    let version = handshake(&client).await.expect("initialize");
    println!("initialize ok — userAgent: {version}");

    let tmp = std::env::temp_dir().join("swarmz-appserver-spike");
    std::fs::create_dir_all(&tmp).unwrap();
    let started = client
        .request(
            "thread/start",
            json!({
                "cwd": tmp.to_string_lossy(),
                "sandbox": "read-only",
                "approvalPolicy": "never",
                "ephemeral": true,
                "developerInstructions": "You are a connectivity test agent.",
                "dynamicTools": [{
                    "type": "function",
                    "name": "ping",
                    "description": "Health check of the host app; returns the answer string.",
                    "inputSchema": { "type": "object", "properties": {} },
                }],
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
    println!("thread started: {thread_id}");

    client
            .request(
                "turn/start",
                json!({
                    "threadId": thread_id,
                    "input": [{
                        "type": "text",
                        "text": "Call the ping tool exactly once and reply with exactly what it returned.",
                    }],
                }),
                RPC_TIMEOUT_MS,
            )
            .await
            .expect("turn/start");

    let mut tool_called = false;
    let mut final_message: Option<String> = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(240);
    loop {
        let ev = tokio::time::timeout_at(deadline, events_rx.recv())
            .await
            .expect("spike timed out waiting for the turn")
            .expect("event stream closed");
        match ev {
            ServerEvent::Request { id, method, params } => {
                assert_eq!(method, "item/tool/call", "unexpected server request");
                assert_eq!(params["tool"], "ping");
                println!("tool call: {} args={}", params["tool"], params["arguments"]);
                tool_called = true;
                client.respond(
                    &id,
                    &adapter::tool_call_response(&Ok(json!("pong from the spike host"))),
                );
            }
            ServerEvent::Notification { method, params } => match method.as_str() {
                "item/completed"
                    if params.pointer("/item/type").and_then(|v| v.as_str())
                        == Some("agentMessage") =>
                {
                    final_message = params
                        .pointer("/item/text")
                        .and_then(|v| v.as_str())
                        .map(str::to_string);
                }
                "turn/completed" => {
                    let status = params.pointer("/turn/status").and_then(|v| v.as_str());
                    println!("turn completed: {status:?}");
                    assert_eq!(status, Some("completed"));
                    break;
                }
                _ => {}
            },
            ServerEvent::Exited => panic!("app-server exited mid-spike"),
        }
    }

    println!("tool_called: {tool_called}");
    println!("final agent message: {final_message:?}");
    assert!(tool_called, "the model never called the dynamic tool");
    let msg = final_message.expect("no final agent message");
    assert!(
        msg.to_lowercase().contains("pong"),
        "final message does not reference the tool result: {msg}"
    );
}

// ---- conductor instances spike (Phase 3) ----
//
// Live proof against the REAL installed codex CLI: TWO Conductor
// instances (two scratch projects) run in parallel over SEPARATE
// processes with SEPARATE cwds, using the production thread params
// (fixed identity + project + operative core + dynamic tools, read-only sandbox,
// approvalPolicy never). Each runs a mini-turn that must report ITS
// project folder; then instance A's process is shut down (the idle-reap
// path) and transparently resumed — proving respawn transparency of one
// instance never touches the other. Ignored by default; run with:
//   cargo test conductor_instances_spike -- --ignored --nocapture

struct SpikeConductor {
    label: &'static str,
    project: ProjectContext,
    host: ProcessHost,
    conn: Arc<Connection>,
    generation: u64,
    sink_rx: mpsc::Receiver<ThreadEvent>,
    thread_id: String,
}

async fn spike_start_conductor(label: &'static str, project: ProjectContext) -> SpikeConductor {
    let host = ProcessHost::new();
    let (conn, generation) = host.ensure().await.expect("spawn conductor app-server");
    println!(
        "[{label}] process up (generation {generation}, {})",
        conn.version()
    );
    let started = conn
        .request(
            "thread/start",
            thread_start_params(&project, &MemoryBlocks::default()),
            THREAD_TIMEOUT_MS,
        )
        .await
        .expect("thread/start with production params");
    let thread_id = started
        .pointer("/thread/id")
        .and_then(|v| v.as_str())
        .expect("thread id")
        .to_string();
    let (sink_tx, sink_rx) = mpsc::channel(crate::codex::host::ROUTE_CHANNEL_CAPACITY);
    conn.register_thread(&thread_id, sink_tx);
    println!(
        "[{label}] thread started: {thread_id} (cwd {})",
        project.dir
    );
    SpikeConductor {
        label,
        project,
        host,
        conn,
        generation,
        sink_rx,
        thread_id,
    }
}

/// Run one turn asking the model for its working directory; return the
/// final assistant message. Dynamic tool calls are answered with a
/// minimal fake so the production registry never blocks the turn.
async fn spike_run_cwd_turn(c: &mut SpikeConductor) -> String {
    c.conn
            .request(
                "turn/start",
                json!({
                    "threadId": c.thread_id,
                    "input": [{
                        "type": "text",
                        "text": "What is your current working directory? Reply with the absolute path only — no other words, no tool calls needed.",
                    }],
                }),
                RPC_TIMEOUT_MS,
            )
            .await
            .expect("turn/start");
    let mut final_message = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(240);
    loop {
        let ev = tokio::time::timeout_at(deadline, c.sink_rx.recv())
            .await
            .unwrap_or_else(|_| panic!("[{}] spike turn timed out", c.label))
            .expect("event sink closed");
        match ev {
            ThreadEvent::Request {
                method,
                params,
                responder,
            } => {
                // the production registry is declared — answer any tool
                // call the model makes with a tiny fake result
                println!("[{}] server request {method} ({})", c.label, params["tool"]);
                if method == "item/tool/call" {
                    responder.ok(&adapter::tool_call_response(&Ok(json!(
                        "spike: tool unavailable in this probe"
                    ))));
                } else {
                    responder.error(-32601, "not supported by the spike");
                }
            }
            ThreadEvent::Notification { method, params } => match method.as_str() {
                "item/completed"
                    if params.pointer("/item/type").and_then(|v| v.as_str())
                        == Some("agentMessage") =>
                {
                    final_message = params
                        .pointer("/item/text")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                }
                "turn/completed" => {
                    let status = params.pointer("/turn/status").and_then(|v| v.as_str());
                    println!("[{}] turn completed: {status:?}", c.label);
                    assert_eq!(status, Some("completed"));
                    break;
                }
                _ => {}
            },
            ThreadEvent::Exited => panic!("[{}] app-server exited mid-turn", c.label),
        }
    }
    println!("[{}] final message: {final_message:?}", c.label);
    final_message
}

#[tokio::test]
#[ignore = "live spike — needs the codex CLI, a login and network"]
async fn conductor_instances_spike() {
    let base = std::env::temp_dir().join("swarmz-conductor-spike");
    let dir_a = base.join("project-a");
    let dir_b = base.join("project-b");
    std::fs::create_dir_all(&dir_a).unwrap();
    std::fs::create_dir_all(&dir_b).unwrap();
    // canonicalize — the model reports the resolved path (/private/var…)
    let canon_a = std::fs::canonicalize(&dir_a).unwrap();
    let canon_b = std::fs::canonicalize(&dir_b).unwrap();

    let project_a = ProjectContext {
        id: "spike-a".into(),
        dir: canon_a.to_string_lossy().into_owned(),
        name: "project-a".into(),
    };
    let project_b = ProjectContext {
        id: "spike-b".into(),
        dir: canon_b.to_string_lossy().into_owned(),
        name: "project-b".into(),
    };

    // two instances, spawned + started in parallel (separate processes)
    let (mut a, mut b) = tokio::join!(
        spike_start_conductor("A", project_a),
        spike_start_conductor("B", project_b),
    );
    assert!(
        !Arc::ptr_eq(&a.conn, &b.conn),
        "instances must run on separate processes"
    );

    // both mini-turns in parallel — each must report ITS project dir
    let (msg_a, msg_b) = tokio::join!(spike_run_cwd_turn(&mut a), spike_run_cwd_turn(&mut b));
    assert!(
        msg_a.contains(&a.project.dir),
        "[A] cwd answer must name project A's dir: {msg_a}"
    );
    assert!(
        msg_b.contains(&b.project.dir),
        "[B] cwd answer must name project B's dir: {msg_b}"
    );
    assert!(
        !msg_a.contains(&b.project.dir) && !msg_b.contains(&a.project.dir),
        "cwd answers must not cross projects"
    );

    // ---- respawn transparency: shut A down (the idle-reap path) ----
    a.host.shutdown().await;
    // the shutdown surfaces as Exited on A's sink (event routing correct)
    let exited = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            match a.sink_rx.recv().await {
                Some(ThreadEvent::Exited) => break true,
                Some(_) => continue,
                None => break false,
            }
        }
    })
    .await
    .expect("no Exited after shutdown");
    assert!(exited, "A must observe its process exit");
    println!("[A] process shut down (idle-reap path)");
    // B is untouched: still alive, same generation
    assert!(
        b.host.alive().await.is_some(),
        "B's process must survive A's reap"
    );
    assert!(b.conn.is_alive());

    // next use of A: fresh spawn (generation bump) + transparent resume
    let (conn2, gen2) = a.host.ensure().await.expect("respawn A");
    assert!(gen2 > a.generation, "respawn must bump the generation");
    host::resume_thread(
        &conn2,
        thread_resume_params(&a.thread_id, &a.project, &MemoryBlocks::default()),
    )
    .await
    .expect("thread/resume after respawn");
    let (sink_tx, sink_rx) = mpsc::channel(crate::codex::host::ROUTE_CHANNEL_CAPACITY);
    conn2.register_thread(&a.thread_id, sink_tx);
    a.conn = conn2;
    a.generation = gen2;
    a.sink_rx = sink_rx;
    println!("[A] respawned (generation {gen2}) + thread resumed");

    // A works again after the respawn — and still knows ITS cwd
    let msg_a2 = spike_run_cwd_turn(&mut a).await;
    assert!(
        msg_a2.contains(&a.project.dir),
        "[A] post-respawn cwd answer must still name project A's dir: {msg_a2}"
    );

    // B still healthy and functional after A's whole respawn cycle
    assert!(b.host.alive().await.is_some());
    let (_, gen_b) = b.host.ensure().await.unwrap();
    assert_eq!(gen_b, b.generation, "B must never have respawned");
    let msg_b2 = spike_run_cwd_turn(&mut b).await;
    assert!(msg_b2.contains(&b.project.dir));

    println!("==== conductor instances spike: all assertions passed ====");
}

// ---- Phase-5 autonomy-loop spike ----
//
// Live end-to-end proof of the loop's substance against the REAL codex
// CLI: (1) a real AGENT session executes a small task in a scratch repo
// with the Phase-5 report `outputSchema` and returns a machine-readable
// status report; (2) a real CONDUCTOR thread (production instructions +
// dynamic tools) receives the exact `[agent finished]` autonomous wire
// text the trigger router builds (marker + report + diff line) and must
// act like a lead: acknowledge the work and report — without a user in
// the loop. The webview glue (trigger router, budget) is covered by the
// vitest suite; this spike proves the two real model turns around it.
// Ignored by default; run with:
//   SWARMZ_SPIKE_DIR=<scratch> cargo test phase5_autonomy_loop_spike -- --ignored --nocapture
#[tokio::test]
#[ignore = "live spike — needs the codex CLI, a login and network"]
async fn phase5_autonomy_loop_spike() {
    use std::path::PathBuf;
    let base = std::env::var("SWARMZ_SPIKE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("swarmz-phase5-loop-spike"));
    let repo = base.join("repo");
    std::fs::remove_dir_all(&repo).ok();
    std::fs::create_dir_all(&repo).unwrap();
    let repo = repo.canonicalize().unwrap();
    let repo_str = repo.to_string_lossy().into_owned();

    // ---- (1) the agent: a real task turn constrained by the report schema
    let report_schema = json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "done": { "type": "boolean" },
            "summary": { "type": "string" },
            "files_changed": { "type": "array", "items": { "type": "string" } },
            "tests_pass": { "type": ["boolean", "null"] },
            "needs_human": { "type": "boolean" },
            "question": { "type": ["string", "null"] },
            "followups": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["done", "summary", "files_changed", "tests_pass", "needs_human", "question", "followups"]
    });
    let agent_host = ProcessHost::new();
    let (agent_conn, _g) = agent_host.ensure().await.expect("spawn agent");
    let started = agent_conn
        .request(
            "thread/start",
            json!({
                "cwd": repo_str,
                "sandbox": "danger-full-access",
                "approvalPolicy": "never",
            }),
            THREAD_TIMEOUT_MS,
        )
        .await
        .expect("agent thread/start");
    let agent_tid = started
        .pointer("/thread/id")
        .and_then(|v| v.as_str())
        .unwrap()
        .to_string();
    let (atx, mut arx) = mpsc::channel(crate::codex::host::ROUTE_CHANNEL_CAPACITY);
    agent_conn.register_thread(&agent_tid, atx);
    agent_conn
            .request(
                "turn/start",
                json!({
                    "threadId": agent_tid,
                    "effort": "low",
                    "input": [{ "type": "text", "text": "Create a file named GREETING.md in your current working directory containing the single line 'hello from the swarm'. End your work by filling the required status report." }],
                    "outputSchema": report_schema,
                }),
                RPC_TIMEOUT_MS,
            )
            .await
            .expect("agent turn/start");
    let mut report_text = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(240);
    loop {
        let ev = tokio::time::timeout_at(deadline, arx.recv())
            .await
            .expect("agent turn timed out")
            .expect("agent sink closed");
        match ev {
            ThreadEvent::Request { responder, .. } => {
                responder.ok(&json!({ "decision": "accept" }))
            }
            ThreadEvent::Notification { method, params } => {
                if method == "item/completed"
                    && params.pointer("/item/type").and_then(|v| v.as_str()) == Some("agentMessage")
                {
                    report_text = params
                        .pointer("/item/text")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                }
                if method == "turn/completed" {
                    assert_eq!(
                        params.pointer("/turn/status").and_then(|v| v.as_str()),
                        Some("completed")
                    );
                    break;
                }
            }
            ThreadEvent::Exited => panic!("agent process exited mid-spike"),
        }
    }
    let report: Value =
        serde_json::from_str(report_text.trim()).expect("agent report must be pure JSON");
    println!("[loop] agent report: {report}");
    assert_eq!(report["done"], true, "agent must report done");
    assert!(
        repo.join("GREETING.md").is_file(),
        "agent must have created the file"
    );

    // ---- (2) the Conductor: the [agent finished] autonomous turn
    let project = ProjectContext {
        id: "phase5-loop".into(),
        dir: repo_str.clone(),
        name: "phase5-loop".into(),
    };
    let cond_host = ProcessHost::new();
    let (cond_conn, _g) = cond_host.ensure().await.expect("spawn conductor");
    let cstarted = cond_conn
        .request(
            "thread/start",
            thread_start_params(&project, &MemoryBlocks::default()),
            THREAD_TIMEOUT_MS,
        )
        .await
        .expect("conductor thread/start");
    let cond_tid = cstarted
        .pointer("/thread/id")
        .and_then(|v| v.as_str())
        .unwrap()
        .to_string();
    let (ctx, mut crx) = mpsc::channel(crate::codex::host::ROUTE_CHANNEL_CAPACITY);
    cond_conn.register_thread(&cond_tid, ctx);
    // the EXACT wire shape the trigger router builds (triggers-core.ts)
    let wire = format!(
            "[agent finished] Agent «Maya» (id spike-maya) finished its turn.\nStructured report: {report}\nWorking tree: no uncommitted changes reported\n\nThis is an autonomous turn — no user message triggered it. Act as the lead: judge the result (read_agent / git_status / review_agent when warranted), hand out follow-up tasks yourself when they clearly serve the user's standing goal, and close the loop with a compact report of what got done and what you suggest next. Escalate to the user only what genuinely needs their call."
        );
    cond_conn
        .request(
            "turn/start",
            json!({ "threadId": cond_tid, "input": [{ "type": "text", "text": wire }] }),
            RPC_TIMEOUT_MS,
        )
        .await
        .expect("conductor turn/start");
    let mut tool_calls: Vec<String> = Vec::new();
    let mut final_message = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
    loop {
        let ev = tokio::time::timeout_at(deadline, crx.recv())
            .await
            .expect("conductor turn timed out")
            .expect("conductor sink closed");
        match ev {
            ThreadEvent::Request {
                method,
                params,
                responder,
            } => {
                if method == "item/tool/call" {
                    let tool = params
                        .get("tool")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    println!("[loop] conductor tool call: {tool}");
                    // canned answers standing in for the webview executors
                    let answer = match tool.as_str() {
                        "fleet_snapshot" => json!({
                            "project": { "id": "phase5-loop", "name": "phase5-loop", "dir": repo_str },
                            "summary": "1 session · 0 working · 0 wait approval",
                            "sessions": [{ "id": "spike-maya", "name": "Maya", "cwd": repo_str, "status": "idle", "worktree": null, "pendingApprovals": [] }],
                            "worktrees": [], "timers": [],
                        }),
                        "git_status" => json!({
                            "agent": { "id": "spike-maya", "name": "Maya" },
                            "cwd": repo_str,
                            "git": null,
                            "note": format!("not a git repository: {repo_str}"),
                        }),
                        "read_agent" => json!({
                            "agent": { "id": "spike-maya", "name": "Maya", "cwd": repo_str },
                            "transcript": format!("user: create GREETING.md\nassistant: {}", report_text.trim()),
                        }),
                        _ => json!("spike: tool unavailable in this probe"),
                    };
                    tool_calls.push(tool);
                    responder.ok(&adapter::tool_call_response(&Ok(answer)));
                } else {
                    responder.error(-32601, "not supported by the spike");
                }
            }
            ThreadEvent::Notification { method, params } => match method.as_str() {
                "item/completed"
                    if params.pointer("/item/type").and_then(|v| v.as_str())
                        == Some("agentMessage") =>
                {
                    final_message = params
                        .pointer("/item/text")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                }
                "turn/completed" => {
                    assert_eq!(
                        params.pointer("/turn/status").and_then(|v| v.as_str()),
                        Some("completed")
                    );
                    break;
                }
                _ => {}
            },
            ThreadEvent::Exited => panic!("conductor process exited mid-spike"),
        }
    }
    println!("[loop] conductor tool calls: {tool_calls:?}");
    println!("[loop] conductor final message: {final_message}");
    // the Conductor closed the loop: a non-empty lead-style report that
    // references the agent by name (never the raw session id)
    assert!(!final_message.trim().is_empty(), "conductor must report");
    assert!(
        final_message.contains("Maya"),
        "the report must reference the agent by name: {final_message}"
    );
    assert!(
        !final_message.contains("spike-maya"),
        "raw session ids must not surface to the user: {final_message}"
    );
    println!("==== phase5 autonomy loop spike: all assertions passed ====");
    std::fs::remove_dir_all(&base).ok();
}

// ---- Phase-8 codex-facing swarm integration spike ----
//
// The heart of the Phase-8 acceptance: the CODEX-FACING swarm mechanics
// against the REAL codex 0.144.1 CLI, driven through the PRODUCTION Rust
// codepaths — NOT an end-to-end test of the webview half (the Conductor's
// tool calls are answered with canned results here, see the honest
// boundary below)
// (production thread params + operative core + dynamic tools for the
// Conductor, `worktree::add/remove` for the git worktrees, the real
// `classify_approval` router). In a fresh scratch git repo it proves:
//   (a) an UNDECOMPOSED goal makes the Conductor sense the fleet
//       (fleet_snapshot) and DECOMPOSE onto ≥2 agents (spawn_agents), one
//       placed in a NEW worktree and one worktree-less;
//   (b) two REAL agent sessions run in SEPARATE cwds and each writes only
//       into its own directory (worktree isolation);
//   (c) an agent ends with the `outputSchema`-forced status report;
//   (d) approval classification is correct (a destructive command stays
//       human, a read-only one is routine) — the Rust-anchored router;
//   (e) the gated worktree cleanup refuses dirty work without --force and
//       removes it with force (a human decision).
//
// What is NOT in this Rust spike (and why): the timer-fire → autonomous
// turn path is webview/TS state (conductorTimers store + trigger router)
// and is covered by the vitest suite (timers-core / triggers-core) plus
// the phase5 wire spike; the webview EXECUTORS behind spawn_agents (which
// actually start the sessions) are TS — here the Conductor's tool calls
// are answered with production-shaped canned results, and part (b) starts
// the two real sessions directly through the same host layer the executors
// use. Honest boundary: this proves the codex-facing swarm mechanics
// end-to-end; the TS glue around them has its own tests.
//
// Ignored by default (needs codex + login + network + git); run with:
//   SWARMZ_SPIKE_DIR=<scratch> cargo test phase8_codex_swarm_integration_spike -- --ignored --nocapture
#[tokio::test]
#[ignore = "live spike — needs the codex CLI, a login and network"]
async fn phase8_codex_swarm_integration_spike() {
    use crate::codex::sessions::classify_approval;
    use std::path::PathBuf;
    use std::process::Command as StdCommand;

    fn git(repo: &std::path::Path, args: &[&str]) {
        let ok = StdCommand::new("git")
            .args(args)
            .current_dir(repo)
            .status()
            .expect("run git")
            .success();
        assert!(ok, "git {args:?} failed");
    }

    let base = std::env::var("SWARMZ_SPIKE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("swarmz-phase8-e2e-spike"));
    std::fs::remove_dir_all(&base).ok();
    let repo = base.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    // a real git repo so worktree::add works
    git(&repo, &["init", "-q"]);
    git(&repo, &["config", "user.email", "spike@swarmz.test"]);
    git(&repo, &["config", "user.name", "SwarmZ Spike"]);
    std::fs::write(repo.join("README.md"), "# spike\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "init"]);
    let repo = repo.canonicalize().unwrap();
    let repo_str = repo.to_string_lossy().into_owned();

    // =====================================================================
    // (a) the Conductor decomposes an undecomposed goal onto ≥2 agents
    // =====================================================================
    let project = ProjectContext {
        id: "phase8-e2e".into(),
        dir: repo_str.clone(),
        name: "phase8-e2e".into(),
    };
    let cond_host = ProcessHost::new();
    let (cond_conn, _g) = cond_host.ensure().await.expect("spawn conductor");
    let cstarted = cond_conn
        .request(
            "thread/start",
            thread_start_params(&project, &MemoryBlocks::default()),
            THREAD_TIMEOUT_MS,
        )
        .await
        .expect("conductor thread/start");
    let cond_tid = cstarted
        .pointer("/thread/id")
        .and_then(|v| v.as_str())
        .unwrap()
        .to_string();
    let (ctx, mut crx) = mpsc::channel(crate::codex::host::ROUTE_CHANNEL_CAPACITY);
    cond_conn.register_thread(&cond_tid, ctx);
    cond_conn
            .request(
                "turn/start",
                json!({ "threadId": cond_tid, "input": [{ "type": "text", "text":
                    "Goal: add a small greeting feature to this project — a function that returns a greeting string, plus a test for it. Split this into TWO parallel agents: one for the implementation, one for the test. First check the fleet, then spawn both agents with clear tasks. Put the implementation agent in a NEW worktree and keep the test agent worktree-less."
                }] }),
                RPC_TIMEOUT_MS,
            )
            .await
            .expect("conductor turn/start");

    let mut tool_calls: Vec<String> = Vec::new();
    let mut spawn_agent_count = 0usize;
    let mut spawn_placements: Vec<String> = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
    loop {
        let ev = tokio::time::timeout_at(deadline, crx.recv())
            .await
            .expect("conductor turn timed out")
            .expect("conductor sink closed");
        match ev {
            ThreadEvent::Request {
                method,
                params,
                responder,
            } => {
                if method == "item/tool/call" {
                    let tool = params
                        .get("tool")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let args = params.get("arguments").cloned().unwrap_or(Value::Null);
                    tool_calls.push(tool.clone());
                    let answer = match tool.as_str() {
                        "fleet_snapshot" => json!({
                            "project": { "id": "phase8-e2e", "name": "phase8-e2e", "dir": repo_str },
                            "summary": "0 sessions",
                            "sessions": [], "worktrees": [], "timers": [],
                        }),
                        "spawn_agents" => {
                            let specs = args
                                .get("agents")
                                .and_then(|a| a.as_array())
                                .cloned()
                                .unwrap_or_default();
                            spawn_agent_count += specs.len();
                            let mut spawned = Vec::new();
                            for (i, s) in specs.iter().enumerate() {
                                let wt = s
                                    .get("worktree")
                                    .and_then(|w| w.as_str())
                                    .unwrap_or("none")
                                    .to_string();
                                spawn_placements.push(wt);
                                spawned.push(json!({
                                    "name": format!("Agent{}", i + 1),
                                    "id": format!("spike-agent-{}", i + 1),
                                }));
                            }
                            json!({ "spawned": spawned })
                        }
                        _ => json!("spike: tool result unavailable"),
                    };
                    responder.ok(&adapter::tool_call_response(&Ok(answer)));
                } else {
                    responder.error(-32601, "not supported by the spike");
                }
            }
            ThreadEvent::Notification { method, params } => {
                if method == "turn/completed" {
                    assert_eq!(
                        params.pointer("/turn/status").and_then(|v| v.as_str()),
                        Some("completed"),
                        "conductor turn must complete"
                    );
                    break;
                }
            }
            ThreadEvent::Exited => panic!("conductor exited mid-spike"),
        }
    }
    println!("[e2e] conductor tool calls: {tool_calls:?}");
    println!("[e2e] spawn_agents specs: {spawn_agent_count}, placements: {spawn_placements:?}");
    assert!(
        tool_calls.iter().any(|t| t == "fleet_snapshot"),
        "the Conductor must sense the fleet before decomposing"
    );
    assert!(
        tool_calls.iter().any(|t| t == "spawn_agents"),
        "the Conductor must delegate via spawn_agents"
    );
    assert!(
        spawn_agent_count >= 2,
        "the Conductor must decompose onto ≥2 agents, got {spawn_agent_count}"
    );
    assert!(
        spawn_placements.iter().any(|p| p == "new"),
        "at least one agent must be placed in a NEW worktree, got {spawn_placements:?}"
    );

    // =====================================================================
    // (b)+(c) two REAL agents in SEPARATE cwds; one returns a report
    // =====================================================================
    // a real production worktree for the implementation agent
    let wt = crate::worktree::add(&repo_str, "swarm/impl-agent", false, None, None)
        .expect("worktree::add");
    let wt_path = std::fs::canonicalize(&wt.path).unwrap();
    let wt_str = wt_path.to_string_lossy().into_owned();
    println!("[e2e] worktree created: {wt_str}");
    assert_ne!(wt_str, repo_str, "the worktree must be a distinct dir");

    let report_schema = json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "done": { "type": "boolean" },
            "summary": { "type": "string" },
            "files_changed": { "type": "array", "items": { "type": "string" } },
            "tests_pass": { "type": ["boolean", "null"] },
            "needs_human": { "type": "boolean" },
            "question": { "type": ["string", "null"] },
            "followups": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["done", "summary", "files_changed", "tests_pass", "needs_human", "question", "followups"]
    });

    // run one real agent turn in `cwd`; returns the final assistant text
    async fn run_agent(cwd: &str, task: &str, schema: Option<&Value>) -> String {
        let host = ProcessHost::new();
        let (conn, _g) = host.ensure().await.expect("spawn agent");
        let started = conn
            .request(
                "thread/start",
                json!({ "cwd": cwd, "sandbox": "danger-full-access", "approvalPolicy": "never" }),
                THREAD_TIMEOUT_MS,
            )
            .await
            .expect("agent thread/start");
        let tid = started
            .pointer("/thread/id")
            .and_then(|v| v.as_str())
            .unwrap()
            .to_string();
        let (tx, mut rx) = mpsc::channel(crate::codex::host::ROUTE_CHANNEL_CAPACITY);
        conn.register_thread(&tid, tx);
        let mut turn = json!({
            "threadId": tid,
            "effort": "low",
            "input": [{ "type": "text", "text": task }],
        });
        if let Some(s) = schema {
            turn["outputSchema"] = s.clone();
        }
        conn.request("turn/start", turn, RPC_TIMEOUT_MS)
            .await
            .expect("agent turn/start");
        let mut final_text = String::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(240);
        loop {
            let ev = tokio::time::timeout_at(deadline, rx.recv())
                .await
                .expect("agent timed out")
                .expect("agent sink closed");
            match ev {
                ThreadEvent::Request { responder, .. } => {
                    responder.ok(&json!({ "decision": "accept" }))
                }
                ThreadEvent::Notification { method, params } => {
                    if method == "item/completed"
                        && params.pointer("/item/type").and_then(|v| v.as_str())
                            == Some("agentMessage")
                    {
                        final_text = params
                            .pointer("/item/text")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                    }
                    if method == "turn/completed" {
                        assert_eq!(
                            params.pointer("/turn/status").and_then(|v| v.as_str()),
                            Some("completed"),
                            "agent turn must complete"
                        );
                        break;
                    }
                }
                ThreadEvent::Exited => panic!("agent process exited mid-turn"),
            }
        }
        // host drops here → child killed
        final_text
    }

    // agent ONE — in the worktree, with the report schema
    let report_text = run_agent(
            &wt_str,
            "Create a file GREETING.txt in your current working directory containing exactly the line 'hello from the swarm'. Then fill the required status report.",
            Some(&report_schema),
        )
        .await;
    let report: Value =
        serde_json::from_str(report_text.trim()).expect("agent report must be pure JSON");
    println!("[e2e] impl-agent report: {report}");
    assert_eq!(report["done"], true, "impl agent must report done");
    assert!(
        wt_path.join("GREETING.txt").is_file(),
        "impl agent's file must land IN THE WORKTREE"
    );
    assert!(
        !repo.join("GREETING.txt").is_file(),
        "impl agent's file must NOT leak into the repo root (worktree isolation)"
    );

    // agent TWO — worktree-less, in the repo root
    let _ = run_agent(
            &repo_str,
            "Create a file TEST_MARKER.txt in your current working directory containing exactly the line 'test agent was here'. No other changes.",
            None,
        )
        .await;
    assert!(
        repo.join("TEST_MARKER.txt").is_file(),
        "worktree-less agent's file must land in the repo root"
    );
    assert!(
        !wt_path.join("TEST_MARKER.txt").is_file(),
        "the two agents must not cross cwds"
    );

    // =====================================================================
    // (d) approval classification — the Rust-anchored router
    // =====================================================================
    let destructive = classify_approval(
        "command",
        &json!({ "command": "rm -rf /", "cwd": wt_str }),
        &wt_str,
        false,
    );
    assert_eq!(destructive, "destructive", "rm -rf must stay human-only");
    let routine = classify_approval(
        "command",
        &json!({ "command": "cat README.md", "cwd": repo_str }),
        &repo_str,
        false,
    );
    assert_eq!(routine, "routine", "a read-only cat must be routine");
    println!("[e2e] approval classification: rm -rf → destructive, cat → routine ✓");

    // =====================================================================
    // (e) gated worktree cleanup — refuses dirty, forces on a human call
    // =====================================================================
    // the impl agent left uncommitted work in the worktree → non-force refuses
    let refused = crate::worktree::remove(&wt.root, &wt.path, &wt.branch, false, None);
    assert!(
        refused.is_err(),
        "non-force cleanup must REFUSE a worktree with uncommitted work"
    );
    println!(
        "[e2e] gated cleanup correctly refused dirty worktree: {:?}",
        refused.err()
    );
    // a human decision force-removes it
    crate::worktree::remove(&wt.root, &wt.path, &wt.branch, true, None)
        .expect("force remove must succeed");
    assert!(
        !wt_path.exists(),
        "the worktree folder must be gone after force remove"
    );
    println!("[e2e] worktree force-removed ✓");

    // cleanup all scratch artifacts (processes died with their hosts)
    std::fs::remove_dir_all(&base).ok();
    println!("==== phase8 full-swarm E2E spike: all assertions passed ====");
}

// ---- Phase-8 compaction spike ----
//
// Live proof that `thread/compact/start` (the compact feature) genuinely
// works on 0.144.1 AND that the turn AFTER compaction still carries the
// pre-compaction context: turn 1 plants a codeword, compaction runs
// (observed as the `contextCompaction` item + a completed turn), turn 2
// asks for the codeword and must still know it. Ignored by default; run:
//   cargo test phase8_compact_spike -- --ignored --nocapture
#[tokio::test]
#[ignore = "live spike — needs the codex CLI, a login and network"]
async fn phase8_compact_spike() {
    let cwd = std::env::temp_dir().join("swarmz-phase8-compact-spike");
    std::fs::create_dir_all(&cwd).unwrap();
    let host = ProcessHost::new();
    let (conn, _g) = host.ensure().await.expect("spawn app-server");
    let started = conn
        .request(
            "thread/start",
            json!({
                "cwd": cwd.to_string_lossy(),
                "sandbox": "read-only",
                "approvalPolicy": "never",
                "ephemeral": true,
            }),
            THREAD_TIMEOUT_MS,
        )
        .await
        .expect("thread/start");
    let tid = started
        .pointer("/thread/id")
        .and_then(|v| v.as_str())
        .unwrap()
        .to_string();
    let (tx, mut rx) = mpsc::channel(crate::codex::host::ROUTE_CHANNEL_CAPACITY);
    conn.register_thread(&tid, tx);

    // drive one turn/method and collect (final_message, saw_compaction)
    async fn drive(
        conn: &Arc<Connection>,
        rx: &mut mpsc::Receiver<ThreadEvent>,
        method: &str,
        params: Value,
    ) -> (String, bool) {
        conn.request(method, params, RPC_TIMEOUT_MS)
            .await
            .expect("request");
        let mut final_message = String::new();
        let mut saw_compaction = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
        loop {
            let ev = tokio::time::timeout_at(deadline, rx.recv())
                .await
                .expect("timed out")
                .expect("sink closed");
            match ev {
                ThreadEvent::Request { responder, .. } => {
                    responder.ok(&json!({ "decision": "accept" }))
                }
                ThreadEvent::Notification { method, params } => {
                    if method == "item/completed" {
                        match params.pointer("/item/type").and_then(|v| v.as_str()) {
                            Some("agentMessage") => {
                                final_message = params
                                    .pointer("/item/text")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                            }
                            Some("contextCompaction") => saw_compaction = true,
                            _ => {}
                        }
                    }
                    if method == "turn/completed" {
                        break;
                    }
                }
                ThreadEvent::Exited => panic!("process exited mid-turn"),
            }
        }
        (final_message, saw_compaction)
    }

    // turn 1: plant a codeword
    drive(
        &conn,
        &mut rx,
        "turn/start",
        json!({ "threadId": tid, "effort": "low", "input": [{ "type": "text", "text":
                "Remember this codeword for later: BANANA-42. Reply with just 'ok'." }] }),
    )
    .await;

    // compaction turn
    let (_m, saw_compaction) = drive(
        &conn,
        &mut rx,
        "thread/compact/start",
        json!({ "threadId": tid }),
    )
    .await;
    println!("[compact] contextCompaction item observed: {saw_compaction}");
    assert!(
        saw_compaction,
        "compaction must emit a contextCompaction item"
    );

    // turn 2: the codeword must survive compaction
    let (answer, _) = drive(
        &conn,
        &mut rx,
        "turn/start",
        json!({ "threadId": tid, "effort": "low", "input": [{ "type": "text", "text":
                "What was the codeword I gave you earlier? Reply with just the codeword." }] }),
    )
    .await;
    println!("[compact] post-compaction answer: {answer:?}");
    assert!(
        answer.contains("BANANA-42"),
        "the post-compaction turn must still know the pre-compaction context: {answer}"
    );
    std::fs::remove_dir_all(&cwd).ok();
    println!("==== phase8 compact spike: compaction preserved context ====");
}
