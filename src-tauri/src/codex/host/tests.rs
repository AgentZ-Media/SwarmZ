use super::*;

#[tokio::test]
async fn pending_rpc_resolves_and_fails_all() {
    let pending = PendingRpc::default();
    let rx1 = pending.register(1);
    let rx2 = pending.register(2);
    assert_eq!(pending.len(), 2);

    assert!(pending.resolve(1, Ok(json!({ "ok": true }))));
    assert_eq!(rx1.await.unwrap().unwrap()["ok"], true);

    // unknown ids are a no-op, not a panic
    assert!(!pending.resolve(99, Ok(Value::Null)));

    pending.fail_all("process died");
    let err = rx2.await.unwrap().unwrap_err();
    assert!(err.contains("process died"), "{err}");
    assert_eq!(pending.len(), 0);
}

#[tokio::test]
async fn removed_ids_do_not_resolve() {
    let pending = PendingRpc::default();
    let rx = pending.register(7);
    pending.remove(7);
    assert!(!pending.resolve(7, Ok(Value::Null)));
    assert!(rx.await.is_err(), "sender must be gone after remove");
}

#[test]
fn codex_resolution_prefers_override_and_scans_dirs() {
    // explicit override wins untouched (even if it doesn't exist)
    assert_eq!(
        resolve_codex_program(Some("  /custom/codex  ")).unwrap(),
        "/custom/codex"
    );
    // pure dir scan: only the dir that actually holds a codex file hits
    let dir = std::env::temp_dir().join(format!(
        "swarmz-codex-resolve-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    assert_eq!(
        find_codex_in([dir.join("missing"), dir.clone()].into_iter()),
        None
    );
    std::fs::write(dir.join("codex"), "").unwrap();
    assert_eq!(
        find_codex_in([dir.join("missing"), dir.clone()].into_iter()),
        Some(dir.join("codex").to_string_lossy().into_owned())
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn mcp_disable_args_enumerate_the_users_servers() {
    // shape of the user's real config (ChatGPT desktop app entries)
    let config = r#"
model = "gpt-5.6-sol"

[mcp_servers.node_repl]
command = "/Applications/ChatGPT.app/…/node_repl"
startup_timeout_sec = 120

[mcp_servers.node_repl.env]
CODEX_HOME = "/Users/x/.codex"

[mcp_servers.computer-use]
command = "…"
enabled = false
"#;
    let args = mcp_disable_args_from(config).unwrap();
    assert_eq!(args[0..2], ["--disable".to_string(), "apps".to_string()]);
    assert!(args
        .chunks(2)
        .any(|c| c == ["-c", "mcp_servers.node_repl.enabled=false"]));
    // already-disabled entries get the (harmless) explicit disable too
    assert!(args
        .chunks(2)
        .any(|c| c == ["-c", "mcp_servers.computer-use.enabled=false"]));
    assert_eq!(args.len(), 6);
}

#[test]
fn mcp_disable_args_handle_edge_configs() {
    // no config / no mcp_servers table → just the built-in apps opt-out
    for text in ["", "model = \"o3\""] {
        assert_eq!(
            mcp_disable_args_from(text).unwrap(),
            vec!["--disable".to_string(), "apps".to_string()],
            "{text:?}"
        );
    }
    // Parse and schema doubt are fail-closed locally; never assume a
    // downstream Codex build will reject exactly the same malformed form.
    for text in ["not [ valid toml", "mcp_servers = \"wrong-type\""] {
        let err = mcp_disable_args_from(text).unwrap_err();
        assert!(err.contains("refusing to start codex"), "{err}");
    }
    // inline-table form counts too
    let args = mcp_disable_args_from(r#"mcp_servers = { foo = { command = "x" } }"#).unwrap();
    assert!(args
        .chunks(2)
        .any(|c| c == ["-c", "mcp_servers.foo.enabled=false"]));
    // FAIL-CLOSED (audit R12): an ENABLED server whose name can't ride a
    // bare dotted -c path refuses the spawn — never silently boots
    let err = mcp_disable_args_from("[mcp_servers.\"we ird\"]\ncommand = \"x\"\n").unwrap_err();
    assert!(err.contains("cannot be disabled"), "{err}");
    // …but a quoted-name server that is ALREADY disabled is safely skipped
    let args =
        mcp_disable_args_from("[mcp_servers.\"we ird\"]\ncommand = \"x\"\nenabled = false\n")
            .unwrap();
    assert_eq!(args, vec!["--disable".to_string(), "apps".to_string()]);
}

#[test]
fn mcp_config_read_errors_fail_closed_but_missing_is_empty() {
    let root = std::env::temp_dir().join(format!(
        "swarmz-mcp-read-test-{}-{}",
        std::process::id(),
        std::thread::current().name().unwrap_or("thread")
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();

    let missing = root.join("missing.toml");
    assert_eq!(
        mcp_disable_args_at(Some(&missing)).unwrap(),
        vec!["--disable".to_string(), "apps".to_string()]
    );

    // Reading a directory as a file fails reliably across the supported
    // platforms and models an unreadable/invalid config path.
    let err = mcp_disable_args_at(Some(&root)).unwrap_err();
    assert!(err.contains("refusing to start codex"), "{err}");
    assert!(err.contains("MCP config"), "{err}");

    std::fs::remove_dir_all(root).unwrap();
}

/// Audit R8 (frozen): the bounded line reader never buffers more than the
/// cap — an endless line is consumed and DROPPED, framing stays intact.
#[tokio::test]
async fn bounded_line_reader_drops_oversize_and_keeps_framing() {
    let data = {
        let mut v = Vec::new();
        v.extend_from_slice(b"short line\n");
        v.extend_from_slice(&vec![b'x'; 1024]); // oversized (cap below: 64)
        v.push(b'\n');
        v.extend_from_slice(b"after\r\n");
        v.extend_from_slice(b"tail without newline");
        v
    };
    let mut reader = BufReader::new(std::io::Cursor::new(data));
    assert!(matches!(
        next_line_bounded(&mut reader, 64).await.unwrap(),
        BoundedLine::Line(l) if l == "short line"
    ));
    assert!(matches!(
        next_line_bounded(&mut reader, 64).await.unwrap(),
        BoundedLine::Oversize
    ));
    // the NEXT line still parses cleanly (framing preserved, \r stripped)
    assert!(matches!(
        next_line_bounded(&mut reader, 64).await.unwrap(),
        BoundedLine::Line(l) if l == "after"
    ));
    assert!(matches!(
        next_line_bounded(&mut reader, 64).await.unwrap(),
        BoundedLine::Line(l) if l == "tail without newline"
    ));
    assert!(matches!(
        next_line_bounded(&mut reader, 64).await.unwrap(),
        BoundedLine::Eof
    ));
}

/// A reader blocked on a full event queue must still observe cancellation,
/// reap the child/process group and return its global process permit.
#[tokio::test]
#[cfg(unix)]
async fn saturated_event_queue_cancels_and_releases_process_budget() {
    use std::os::unix::fs::PermissionsExt as _;

    let root = std::env::temp_dir().join(format!(
        "swarmz-host-cancel-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let program = root.join("fake-codex");
    std::fs::write(
            &program,
            "#!/bin/sh\nprintf '%s\\n' '{\"method\":\"one\",\"params\":{}}' '{\"method\":\"two\",\"params\":{}}'\nsleep 30\n",
        )
        .unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();

    let before = CODEX_PROCESS_BUDGET.available_permits();
    let (events_tx, _events_rx) = mpsc::channel(1);
    let client = Client::spawn(&program.to_string_lossy(), events_tx)
        .await
        .unwrap();
    assert_eq!(CODEX_PROCESS_BUDGET.available_permits() + 1, before);

    // Give the reader time to fill slot one and block on notification two.
    tokio::time::sleep(Duration::from_millis(100)).await;
    client.kill.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while client.is_alive() || CODEX_PROCESS_BUDGET.available_permits() < before {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("cancel must reap and release the permit even behind backpressure");

    std::fs::remove_dir_all(root).ok();
}

#[test]
fn unknown_thread_errors_are_classified() {
    for msg in [
        // verbatim live answer from codex (0.142.5 spike, re-verified on 0.144.1)
        "no rollout found for thread id 019f0000-0000-7000-8000-000000000000 (code -32600)",
        "thread not found (code -32600)",
        "Unknown thread id 019f…",
        "thread 019f… does not exist",
        "No such thread",
    ] {
        assert!(is_unknown_thread_error(msg), "{msg}");
    }
    for msg in ["network unreachable", "timed out after 120000 ms"] {
        assert!(!is_unknown_thread_error(msg), "{msg}");
    }
}

#[tokio::test]
async fn route_table_routes_and_broadcasts_exit_once_per_sink() {
    let routes = RouteTable::default();
    let (shared_tx, mut shared_rx) = mpsc::channel(ROUTE_CHANNEL_CAPACITY);
    let (solo_tx, mut solo_rx) = mpsc::channel(ROUTE_CHANNEL_CAPACITY);
    // two threads share one sink (orchestrator pattern), one has its own
    routes.insert("t-1", shared_tx.clone());
    routes.insert("t-2", shared_tx.clone());
    routes.insert("t-3", solo_tx);

    assert!(routes.get("t-1").is_some());
    assert!(routes.get("nope").is_none());
    routes.remove("t-2");
    assert!(routes.get("t-2").is_none());
    routes.insert("t-2", shared_tx);

    // process death: each distinct sink hears Exited exactly once
    for sink in routes.drain_distinct() {
        let _ = sink.send(ThreadEvent::Exited).await;
    }
    assert!(matches!(shared_rx.recv().await, Some(ThreadEvent::Exited)));
    assert!(matches!(solo_rx.recv().await, Some(ThreadEvent::Exited)));
    assert!(
        shared_rx.try_recv().is_err(),
        "shared sink must get exactly ONE Exited despite two routes"
    );
    assert!(
        routes.get("t-1").is_none(),
        "routes drained with the process"
    );
}

// ---- session spike (Vibe Mode Phase 1) ----
//
// Live proof against the REAL installed codex CLI: two SESSIONS with a
// dedicated process each (strategy b), running turns in parallel under
// sandbox workspace-write + approvalPolicy "untrusted" (forces a command
// approval), with a real approval accept-roundtrip, fileChange items,
// turn/diff/updated and token usage observed. Ignored by default (needs
// codex + login + network — CI stays green); run with:
//   cargo test session_spike -- --ignored --nocapture

struct SessionOutcome {
    label: &'static str,
    thread_id: String,
    turn_status: String,
    cmd_approvals: usize,
    file_approvals: usize,
    approved_cmd_completed_ok: bool,
    file_change_completed: bool,
    last_diff: Option<String>,
    last_token_total: Option<u64>,
    started_at: std::time::Instant,
    finished_at: std::time::Instant,
}

async fn drive_spike_session(
    label: &'static str,
    cwd: std::path::PathBuf,
    file_name: &str,
    log: Arc<Mutex<Vec<String>>>,
    t0: std::time::Instant,
) -> SessionOutcome {
    let push = |log: &Arc<Mutex<Vec<String>>>, line: String| {
        let stamped = format!("[{:>7.3}s] [{label}] {line}", t0.elapsed().as_secs_f64());
        println!("{stamped}");
        log.lock().push(stamped);
    };

    // strategy (b): a private ProcessHost slot for this one session
    let host = ProcessHost::new();
    let (conn, generation) = host.ensure().await.expect("spawn dedicated app-server");
    push(
        &log,
        format!("process up (generation {generation}, {})", conn.version()),
    );

    let started = conn
            .request(
                "thread/start",
                json!({
                    "cwd": cwd.to_string_lossy(),
                    "sandbox": "workspace-write",
                    "approvalPolicy": "untrusted",
                    "ephemeral": true,
                    "developerInstructions": "You are a test agent. Do exactly what the user asks, nothing more.",
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
    push(&log, format!("thread started: {thread_id}"));

    let (sink_tx, mut sink_rx) = mpsc::channel(ROUTE_CHANNEL_CAPACITY);
    conn.register_thread(&thread_id, sink_tx);

    // apply_patch under "untrusted" triggers a fileChange approval;
    // `touch` is not on the trusted-command list and forces a
    // commandExecution approval (`cat` alone would NOT — it counts as
    // trusted; live-verified)
    let prompt = format!(
        "Two steps, in order: (1) create a file named {file_name} with the exact \
             content 'alpha' (use apply_patch); (2) run the shell command \
             `touch done.marker && cat {file_name}` and reply with exactly what it printed."
    );
    let started_at = std::time::Instant::now();
    conn.request(
        "turn/start",
        json!({ "threadId": thread_id, "input": [{ "type": "text", "text": prompt }] }),
        RPC_TIMEOUT_MS,
    )
    .await
    .expect("turn/start");

    let mut cmd_approvals = 0usize;
    let mut file_approvals = 0usize;
    let mut approved_cmd_ids: Vec<String> = Vec::new();
    let mut approved_cmd_completed_ok = false;
    let mut file_change_completed = false;
    let mut last_diff: Option<String> = None;
    let mut last_token_total: Option<u64> = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
    let turn_status = loop {
        let ev = tokio::time::timeout_at(deadline, sink_rx.recv())
            .await
            .expect("spike session timed out")
            .expect("event sink closed");
        match ev {
            ThreadEvent::Request {
                method,
                params,
                responder,
            } => {
                match method.as_str() {
                    "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
                        push(
                            &log,
                            format!(
                                "APPROVAL request: {method} — reason={:?} command={:?} decisions={}",
                                params.get("reason").and_then(|v| v.as_str()),
                                params.get("command").and_then(|v| v.as_str()),
                                params.get("availableDecisions").cloned().unwrap_or(Value::Null),
                            ),
                        );
                        if method == "item/commandExecution/requestApproval" {
                            cmd_approvals += 1;
                            if let Some(item_id) = params.get("itemId").and_then(|v| v.as_str()) {
                                approved_cmd_ids.push(item_id.to_string());
                            }
                        } else {
                            file_approvals += 1;
                        }
                        responder.ok(&json!({ "decision": "accept" }));
                    }
                    other => {
                        push(
                            &log,
                            format!("unexpected server request {other} — refusing"),
                        );
                        responder.error(-32601, "not supported by the spike");
                    }
                }
            }
            ThreadEvent::Notification { method, params } => match method.as_str() {
                "item/completed" => {
                    let item = params.get("item").cloned().unwrap_or(Value::Null);
                    let ty = item.get("type").and_then(|v| v.as_str()).unwrap_or("?");
                    let status = item.get("status").and_then(|v| v.as_str()).unwrap_or("-");
                    match ty {
                        "fileChange" => {
                            push(&log, format!("fileChange completed: {}", item["changes"]));
                            if status == "completed" {
                                file_change_completed = true;
                            }
                        }
                        "commandExecution" => {
                            let exit = item.get("exitCode").cloned().unwrap_or(Value::Null);
                            push(
                                    &log,
                                    format!(
                                        "commandExecution completed: status={status} exit={exit} cmd={:?}",
                                        item.get("command").and_then(|v| v.as_str())
                                    ),
                                );
                            let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
                            if approved_cmd_ids.iter().any(|a| a == id)
                                && status == "completed"
                                && exit == json!(0)
                            {
                                approved_cmd_completed_ok = true;
                            }
                        }
                        "agentMessage" => {
                            push(
                                &log,
                                format!(
                                    "agentMessage: {:?}",
                                    item.get("text").and_then(|v| v.as_str())
                                ),
                            );
                        }
                        _ => {}
                    }
                }
                "turn/diff/updated" => {
                    let diff = params.get("diff").and_then(|v| v.as_str()).unwrap_or("");
                    push(
                        &log,
                        format!("turn/diff/updated ({} chars): {diff:?}", diff.len()),
                    );
                    last_diff = Some(diff.to_string());
                }
                "thread/tokenUsage/updated" => {
                    let total = params
                        .pointer("/tokenUsage/total/totalTokens")
                        .and_then(|v| v.as_u64());
                    push(&log, format!("tokenUsage: total={total:?}"));
                    last_token_total = total;
                }
                "turn/completed" => {
                    let status = params
                        .pointer("/turn/status")
                        .and_then(|v| v.as_str())
                        .unwrap_or("?")
                        .to_string();
                    push(&log, format!("turn completed: {status}"));
                    break status;
                }
                _ => {}
            },
            ThreadEvent::Exited => panic!("[{label}] app-server exited mid-spike"),
        }
    };
    let finished_at = std::time::Instant::now();

    // t3code fallback, live: resuming a thread this process never saw
    // must classify as ThreadNotFound (the cue for a fresh thread/start)
    let bogus = resume_thread(
        &conn,
        json!({ "threadId": "019f0000-0000-7000-8000-000000000000" }),
    )
    .await;
    match &bogus {
        Err(ResumeError::ThreadNotFound(m)) => {
            push(&log, format!("bogus thread/resume → ThreadNotFound: {m}"))
        }
        Err(ResumeError::Other(m)) => push(
            &log,
            format!("bogus thread/resume → OTHER (classifier miss!): {m}"),
        ),
        Ok(_) => push(&log, "bogus thread/resume unexpectedly SUCCEEDED".into()),
    }
    assert!(
        matches!(bogus, Err(ResumeError::ThreadNotFound(_))),
        "resume of an unknown thread must classify as ThreadNotFound"
    );

    SessionOutcome {
        label,
        thread_id,
        turn_status,
        cmd_approvals,
        file_approvals,
        approved_cmd_completed_ok,
        file_change_completed,
        last_diff,
        last_token_total,
        started_at,
        finished_at,
    }
}

#[tokio::test]
#[ignore = "live spike — needs the codex CLI, a login and network"]
async fn session_spike() {
    let base = std::env::temp_dir().join("swarmz-session-spike");
    let cwd_a = base.join("a");
    let cwd_b = base.join("b");
    for (cwd, file) in [(&cwd_a, "probe_a.txt"), (&cwd_b, "probe_b.txt")] {
        std::fs::create_dir_all(cwd).unwrap();
        std::fs::remove_file(cwd.join(file)).ok(); // the write must be real
        std::fs::remove_file(cwd.join("done.marker")).ok(); // so must the command
    }

    let log = Arc::new(Mutex::new(Vec::new()));
    let t0 = std::time::Instant::now();
    // two dedicated processes, both turns genuinely in parallel
    let (a, b) = tokio::join!(
        drive_spike_session("A", cwd_a.clone(), "probe_a.txt", log.clone(), t0),
        drive_spike_session("B", cwd_b.clone(), "probe_b.txt", log.clone(), t0),
    );

    println!("\n==== session spike summary ====");
    for s in [&a, &b] {
        println!(
                "[{}] thread={} status={} cmd_approvals={} file_approvals={} approved_cmd_ok={} file_change={} tokens={:?} diff={} chars",
                s.label,
                s.thread_id,
                s.turn_status,
                s.cmd_approvals,
                s.file_approvals,
                s.approved_cmd_completed_ok,
                s.file_change_completed,
                s.last_token_total,
                s.last_diff.as_deref().map(str::len).unwrap_or(0),
            );
    }
    let overlapped = a.started_at < b.finished_at && b.started_at < a.finished_at;
    println!("turn windows overlapped (true parallelism): {overlapped}");

    for (s, cwd, file) in [(&a, &cwd_a, "probe_a.txt"), (&b, &cwd_b, "probe_b.txt")] {
        assert_eq!(
            s.turn_status, "completed",
            "[{}] turn must complete",
            s.label
        );
        assert!(
            s.cmd_approvals >= 1,
            "[{}] untrusted policy must force a command approval for `touch`",
            s.label
        );
        assert!(
            s.approved_cmd_completed_ok,
            "[{}] the accepted command must run to exitCode 0",
            s.label
        );
        assert!(
            s.file_change_completed,
            "[{}] a completed fileChange item must be observed",
            s.label
        );
        let content = std::fs::read_to_string(cwd.join(file))
            .unwrap_or_else(|e| panic!("[{}] {file} missing: {e}", s.label));
        assert!(
            content.contains("alpha"),
            "[{}] {file} content unexpected: {content:?}",
            s.label
        );
        assert!(
            cwd.join("done.marker").is_file(),
            "[{}] the approved command's side effect (done.marker) is missing",
            s.label
        );
    }
}

// ---- MCP-disable spike (Phase 6 live-fix) ----
//
// Live proof against the REAL installed codex CLI that a SwarmZ-spawned
// app-server (a) boots NO MCP servers — neither the user's global
// `[mcp_servers.*]` entries nor the built-in `codex_apps` — and (b) runs
// a FIRST dynamic tool call cleanly on the first attempt (the bug this
// fixes: the inherited node_repl boot raced the Conductor's first
// spawn_agents call into `timeout_ms must be at least 10000` + "dynamic
// tool call was cancelled before receiving a response"). Requires codex
// + login + a config.toml with MCP servers to be meaningful; run with:
//   cargo test mcp_disable_spike -- --ignored --nocapture

#[tokio::test]
#[ignore = "live spike — needs the codex CLI, a login and network"]
async fn mcp_disable_spike() {
    let cwd = std::env::temp_dir().join("swarmz-mcp-disable-spike");
    std::fs::create_dir_all(&cwd).unwrap();

    // context: what the user's config would boot WITHOUT the fix
    let disable_args = mcp_disable_args().expect("mcp disable args");
    println!("disable args: {disable_args:?}");

    let host = ProcessHost::new();
    let (conn, generation) = host.ensure().await.expect("spawn app-server");
    println!("process up (generation {generation}, {})", conn.version());

    // one dynamic tool, exactly the Conductor's spec shape (adapter.rs)
    let started = conn
            .request(
                "thread/start",
                json!({
                    "cwd": cwd.to_string_lossy(),
                    "sandbox": "read-only",
                    "approvalPolicy": "never",
                    "ephemeral": true,
                    "developerInstructions":
                        "You are a test agent with one dynamic tool. Use it exactly as asked.",
                    "dynamicTools": [{
                        "type": "function",
                        "name": "ping",
                        "description": "Answers with pong. Call it whenever asked.",
                        "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
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
    let (sink_tx, mut sink_rx) = mpsc::channel(ROUTE_CHANNEL_CAPACITY);
    conn.register_thread(&thread_id, sink_tx);

    // the FIRST turn asks for the tool immediately — without the fix this
    // is the turn that raced the user's MCP boot
    let t_turn = std::time::Instant::now();
    conn.request(
            "turn/start",
            json!({
                "threadId": thread_id,
                "input": [{ "type": "text", "text":
                    "Call the ping tool once (empty arguments), then reply with exactly the text it returned." }],
            }),
            RPC_TIMEOUT_MS,
        )
        .await
        .expect("turn/start");

    let mut mcp_boots: Vec<String> = Vec::new();
    let mut tool_calls = 0usize;
    let mut first_tool_call_ms: Option<u128> = None;
    let mut final_message = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(240);
    let turn_status = loop {
        let ev = tokio::time::timeout_at(deadline, sink_rx.recv())
            .await
            .expect("mcp spike timed out")
            .expect("event sink closed");
        match ev {
            ThreadEvent::Request {
                method,
                params,
                responder,
            } => match method.as_str() {
                "item/tool/call" => {
                    tool_calls += 1;
                    first_tool_call_ms.get_or_insert(t_turn.elapsed().as_millis());
                    println!(
                        "[{:>6} ms] item/tool/call #{tool_calls}: {}",
                        t_turn.elapsed().as_millis(),
                        params.get("tool").and_then(|v| v.as_str()).unwrap_or("?"),
                    );
                    responder.ok(&json!({
                        "success": true,
                        "contentItems": [{ "type": "inputText", "text": "pong" }],
                    }));
                }
                other => {
                    println!("unexpected server request {other} — refusing");
                    responder.error(-32601, "not supported by the spike");
                }
            },
            ThreadEvent::Notification { method, params } => match method.as_str() {
                "mcpServer/startupStatus/updated" => {
                    let line = format!(
                        "{}: {}",
                        params.get("name").and_then(|v| v.as_str()).unwrap_or("?"),
                        params.get("status").and_then(|v| v.as_str()).unwrap_or("?"),
                    );
                    println!("MCP STARTUP (must not happen): {line}");
                    mcp_boots.push(line);
                }
                "item/completed" => {
                    let item = params.get("item").cloned().unwrap_or(Value::Null);
                    if item.get("type").and_then(|v| v.as_str()) == Some("agentMessage") {
                        final_message = item
                            .get("text")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                    }
                }
                "turn/completed" => {
                    break params
                        .pointer("/turn/status")
                        .and_then(|v| v.as_str())
                        .unwrap_or("?")
                        .to_string();
                }
                _ => {}
            },
            ThreadEvent::Exited => panic!("app-server exited mid-spike"),
        }
    };

    println!("\n==== mcp disable spike summary ====");
    println!("turn status: {turn_status}");
    println!("mcp servers booted: {}", mcp_boots.len());
    println!("dynamic tool calls: {tool_calls} (first after {first_tool_call_ms:?} ms)");
    println!("final message: {final_message:?}");

    assert_eq!(
        turn_status, "completed",
        "the FIRST turn must complete cleanly"
    );
    assert!(
        mcp_boots.is_empty(),
        "a SwarmZ-spawned app-server must boot NO MCP servers, got: {mcp_boots:?}"
    );
    assert!(
        tool_calls >= 1,
        "the first dynamic tool call must arrive on the first attempt"
    );
    assert!(
        final_message.to_lowercase().contains("pong"),
        "the tool result must round-trip into the reply: {final_message:?}"
    );
}
