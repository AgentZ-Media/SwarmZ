use super::*;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::json;
use serde_json::Value;
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// The integration flag + write gate are process-global — tests that
/// toggle them must not interleave.
static GATE_TEST_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

#[test]
fn gh_outcome_serializes_typed() {
    let ok: GhOutcome<u32> = GhOutcome::Ok(7);
    assert_eq!(
        serde_json::to_value(&ok).unwrap(),
        json!({ "status": "ok", "data": 7 })
    );
    let ni: GhOutcome<u32> = GhOutcome::NotInstalled;
    assert_eq!(
        serde_json::to_value(&ni).unwrap(),
        json!({ "status": "not_installed" })
    );
    let na: GhOutcome<u32> = GhOutcome::NotAuthenticated;
    assert_eq!(
        serde_json::to_value(&na).unwrap(),
        json!({ "status": "not_authenticated" })
    );
    let nr: GhOutcome<u32> = GhOutcome::NoRemote;
    assert_eq!(
        serde_json::to_value(&nr).unwrap(),
        json!({ "status": "no_remote" })
    );
    let err: GhOutcome<u32> = GhOutcome::Error("boom".into());
    assert_eq!(
        serde_json::to_value(&err).unwrap(),
        json!({ "status": "error", "data": "boom" })
    );
}

#[test]
fn issue_list_parser_sanitizes_and_bounds_github_data() {
    let long_body = "x".repeat(BODY_CHAR_CAP + 50);
    let long_title = "t".repeat(350);
    let mut labels = vec![json!({ "name": "bug" }), json!({ "name": "bug" })];
    labels.extend((0..40).map(|index| json!({ "name": format!("label-{index}") })));
    let payload = json!([
        {
            "number": 42,
            "title": long_title,
            "body": long_body,
            "labels": labels,
            "state": "open",
            "url": "https://github.com/example/repo/issues/42"
        },
        {
            "number": 0,
            "title": "invalid",
            "body": "",
            "labels": [],
            "state": "OPEN",
            "url": ""
        },
        {
            "number": 43,
            "title": "unknown state",
            "body": "",
            "labels": [],
            "state": "MERGED",
            "url": ""
        }
    ]);

    let GhOutcome::Ok(issues) = parse_issue_list_output(&payload.to_string()) else {
        panic!("expected parsed issues")
    };
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].number, 42);
    assert_eq!(issues[0].state, "OPEN");
    assert_eq!(issues[0].title.chars().count(), 301); // 300 + ellipsis
    assert_eq!(issues[0].body.chars().count(), BODY_CHAR_CAP + 1);
    assert_eq!(issues[0].labels.len(), 30);
    assert_eq!(issues[0].labels[0], "bug");
}

#[test]
fn issue_list_parser_caps_records_and_rejects_wrong_shapes() {
    let records: Vec<Value> = (1..=ISSUE_LIST_MAX + 25)
        .map(|number| {
            json!({
                "number": number,
                "title": format!("Issue {number}"),
                "body": "",
                "labels": [],
                "state": "CLOSED",
                "url": ""
            })
        })
        .collect();
    let GhOutcome::Ok(issues) = parse_issue_list_output(&serde_json::to_string(&records).unwrap())
    else {
        panic!("expected parsed issues")
    };
    assert_eq!(issues.len(), ISSUE_LIST_MAX);

    assert!(matches!(
        parse_issue_list_output("{}"),
        GhOutcome::Error(message) if message.contains("unexpected")
    ));
    assert!(matches!(
        parse_issue_list_output("not json"),
        GhOutcome::Error(message) if message.contains("unparseable")
    ));
    let oversized = " ".repeat(ISSUE_JSON_BYTE_CAP + 1);
    assert!(matches!(
        parse_issue_list_output(&oversized),
        GhOutcome::Error(message) if message.contains("8 MiB")
    ));
}

#[test]
fn stderr_classification_is_typed() {
    match classify_gh_stderr::<()>("To get started with GitHub CLI, please run:  gh auth login") {
        GhOutcome::NotAuthenticated => {}
        other => panic!("expected NotAuthenticated, got {other:?}"),
    }
    match classify_gh_stderr::<()>("HTTP 401: Bad credentials") {
        GhOutcome::NotAuthenticated => {}
        other => panic!("expected NotAuthenticated, got {other:?}"),
    }
    match classify_gh_stderr::<()>("no git remotes found") {
        GhOutcome::NoRemote => {}
        other => panic!("expected NoRemote, got {other:?}"),
    }
    match classify_gh_stderr::<()>(
        "fatal: not a git repository (or any of the parent directories): .git",
    ) {
        GhOutcome::NoRemote => {}
        other => panic!("expected NoRemote, got {other:?}"),
    }
    match classify_gh_stderr::<()>("could not determine base repo: whatever") {
        GhOutcome::NoRemote => {}
        other => panic!("expected NoRemote, got {other:?}"),
    }
    match classify_gh_stderr::<()>("GraphQL: something exploded") {
        GhOutcome::Error(e) => assert!(e.contains("exploded")),
        other => panic!("expected Error, got {other:?}"),
    }
    match classify_gh_stderr::<()>("") {
        GhOutcome::Error(e) => assert!(e.contains("without an error message")),
        other => panic!("expected Error, got {other:?}"),
    }
}

/// Frozen against REAL gh 2.95.0 output (AgentZ-Media/SwarmZ PR #2,
/// 2026-07-11): the same check name appears once per workflow RUN — the
/// newest run must win, mixed CheckRun/StatusContext entries both count.
#[test]
fn checks_summary_dedupes_reruns_by_newest_start() {
    let rollup = json!([
        { "__typename": "CheckRun", "name": "Type-check & build frontend",
          "status": "COMPLETED", "conclusion": "SUCCESS", "startedAt": "2026-07-09T17:42:31Z" },
        { "__typename": "CheckRun", "name": "Type-check & build frontend",
          "status": "COMPLETED", "conclusion": "SUCCESS", "startedAt": "2026-07-08T17:14:07Z" },
        { "__typename": "CheckRun", "name": "Rust tests",
          "status": "COMPLETED", "conclusion": "SUCCESS", "startedAt": "2026-07-09T17:42:32Z" },
        { "__typename": "CheckRun", "name": "Rust tests",
          "status": "COMPLETED", "conclusion": "SUCCESS", "startedAt": "2026-07-08T17:14:08Z" },
        { "__typename": "StatusContext", "context": "CodeRabbit",
          "state": "SUCCESS", "startedAt": "2026-07-09T17:58:14Z" }
    ]);
    let s = summarize_checks(&rollup);
    assert_eq!(
        s,
        ChecksSummary {
            passing: 3,
            failing: 0,
            pending: 0,
            total: 3
        }
    );
}

#[test]
fn checks_summary_buckets_failures_and_pending() {
    let rollup = json!([
        { "name": "build", "status": "COMPLETED", "conclusion": "FAILURE", "startedAt": "b" },
        { "name": "lint", "status": "IN_PROGRESS", "conclusion": null, "startedAt": "b" },
        { "name": "deploy", "status": "COMPLETED", "conclusion": "CANCELLED", "startedAt": "b" },
        { "name": "docs", "status": "COMPLETED", "conclusion": "SKIPPED", "startedAt": "b" },
        { "context": "external", "state": "ERROR", "startedAt": "b" },
        { "context": "pending-ext", "state": "PENDING", "startedAt": "b" }
    ]);
    let s = summarize_checks(&rollup);
    assert_eq!(
        s,
        ChecksSummary {
            passing: 1,
            failing: 3,
            pending: 2,
            total: 6
        }
    );
    // a rerun that flips pass → fail must surface the failure
    let flipped = json!([
        { "name": "build", "status": "COMPLETED", "conclusion": "SUCCESS", "startedAt": "2026-01-01T00:00:00Z" },
        { "name": "build", "status": "COMPLETED", "conclusion": "FAILURE", "startedAt": "2026-01-02T00:00:00Z" }
    ]);
    assert_eq!(summarize_checks(&flipped).failing, 1);
    // empty / missing rollup
    assert_eq!(summarize_checks(&Value::Null), ChecksSummary::default());
    assert_eq!(summarize_checks(&json!([])), ChecksSummary::default());
}

/// Double-review LOW 11: same-named jobs in DIFFERENT workflows are
/// different checks — collapsing them could hide a failure — and
/// nameless entries never collapse onto each other.
#[test]
fn checks_summary_keys_by_workflow_and_keeps_nameless_apart() {
    let two_workflows = json!([
        { "name": "test", "workflowName": "CI", "status": "COMPLETED", "conclusion": "SUCCESS", "startedAt": "b" },
        { "name": "test", "workflowName": "Nightly", "status": "COMPLETED", "conclusion": "FAILURE", "startedAt": "b" }
    ]);
    let s = summarize_checks(&two_workflows);
    assert_eq!(
        s,
        ChecksSummary {
            passing: 1,
            failing: 1,
            pending: 0,
            total: 2
        }
    );
    // a rerun WITHIN one workflow still dedupes (newest start wins)
    let rerun = json!([
        { "name": "test", "workflowName": "CI", "status": "COMPLETED", "conclusion": "FAILURE", "startedAt": "2026-01-01T00:00:00Z" },
        { "name": "test", "workflowName": "CI", "status": "COMPLETED", "conclusion": "SUCCESS", "startedAt": "2026-01-02T00:00:00Z" }
    ]);
    assert_eq!(
        summarize_checks(&rerun),
        ChecksSummary {
            passing: 1,
            failing: 0,
            pending: 0,
            total: 1
        }
    );
    // nameless entries: a failing anonymous check must not hide behind a
    // passing one
    let nameless = json!([
        { "status": "COMPLETED", "conclusion": "SUCCESS", "startedAt": "b" },
        { "status": "COMPLETED", "conclusion": "FAILURE", "startedAt": "b" }
    ]);
    let s = summarize_checks(&nameless);
    assert_eq!(
        s,
        ChecksSummary {
            passing: 1,
            failing: 1,
            pending: 0,
            total: 2
        }
    );
}

fn pr(number: u64, title: &str, checks: ChecksSummary) -> GhPr {
    GhPr {
        number,
        title: title.into(),
        author: "x".into(),
        head_ref: "feat".into(),
        base_ref: "main".into(),
        is_draft: false,
        mergeable: "MERGEABLE".into(),
        review_decision: String::new(),
        url: format!("https://example.com/pull/{number}"),
        updated_at: String::new(),
        checks,
    }
}

#[test]
fn pr_diffing_reports_opened_closed_and_field_changes() {
    let ok = ChecksSummary {
        passing: 2,
        failing: 0,
        pending: 0,
        total: 2,
    };
    let bad = ChecksSummary {
        passing: 1,
        failing: 1,
        pending: 0,
        total: 2,
    };

    // first poll = baseline, silent
    assert!(diff_pr_sets(&HashMap::new(), &[pr(1, "a", ok.clone())], true).is_empty());

    let mut old = HashMap::new();
    old.insert(1, PrSig::of(&pr(1, "a", ok.clone())));
    old.insert(2, PrSig::of(&pr(2, "b", ok.clone())));

    // unchanged → silent
    assert!(diff_pr_sets(
        &old,
        &[pr(1, "a", ok.clone()), pr(2, "b", ok.clone())],
        false
    )
    .is_empty());

    // checks flip + a new PR + a closed PR, sorted by number
    let changes = diff_pr_sets(
        &old,
        &[pr(1, "a", bad.clone()), pr(3, "c", ok.clone())],
        false,
    );
    assert_eq!(changes.len(), 3);
    assert_eq!(changes[0].number, 1);
    assert_eq!(changes[0].kind, "checks");
    assert!(changes[0].note.contains("1 failing"), "{}", changes[0].note);
    assert_eq!(changes[1].number, 2);
    assert_eq!(changes[1].kind, "closed");
    assert_eq!(changes[2].number, 3);
    assert_eq!(changes[2].kind, "opened");

    // review decision change
    let mut approved = pr(1, "a", ok.clone());
    approved.review_decision = "APPROVED".into();
    let changes = diff_pr_sets(&old, &[approved, pr(2, "b", ok.clone())], false);
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].kind, "review");
    assert!(changes[0].note.contains("APPROVED"));

    // draft flip
    let mut drafted = pr(2, "b", ok.clone());
    drafted.is_draft = true;
    let changes = diff_pr_sets(&old, &[pr(1, "a", ok.clone()), drafted], false);
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].kind, "draft");
    assert!(changes[0].note.contains("draft"));
}

/// A ZERO-PR baseline is not the same as "never polled": the first PR
/// opened after an empty baseline MUST report — the explicit `first_poll`
/// flag disambiguates the empty old map (double-review MEDIUM 7).
#[test]
fn first_pr_after_a_zero_pr_baseline_reports_opened() {
    let ok = ChecksSummary {
        passing: 1,
        failing: 0,
        pending: 0,
        total: 1,
    };
    // baseline with zero PRs: silent
    assert!(diff_pr_sets(&HashMap::new(), &[], true).is_empty());
    // next poll (NOT first): a PR appeared against the empty known set
    let changes = diff_pr_sets(&HashMap::new(), &[pr(7, "first", ok)], false);
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].number, 7);
    assert_eq!(changes[0].kind, "opened");
}

#[test]
fn integration_gate_refuses_writes_when_off() {
    let _serial = GATE_TEST_LOCK.lock();
    set_integration(false);
    assert!(require_integration().is_err());
    // the write entry points refuse BEFORE touching gh
    assert!(pr_comment("/nonexistent", 1, "hi", None).is_err());
    assert!(pr_review("/nonexistent", 1, "approve", None, None).is_err());
    assert!(pr_create("/nonexistent", "t", "b", None, false, None, None).is_err());
    set_integration(true);
    assert!(require_integration().is_ok());
    // input validation still guards
    assert!(pr_comment("/nonexistent", 1, "   ", None).is_err());
    assert!(pr_review("/nonexistent", 1, "merge", None, None).is_err());
    assert!(
        pr_review("/nonexistent", 1, "comment", None, None).is_err(),
        "comment review needs a body"
    );
    set_integration(false);
}

/// Final hardening F2 (frozen): agent-run gh writes are gated on the
/// CONJUNCTION of the integration master toggle and the
/// autonomous-writes opt-in — either flag off means the Conductor's
/// strict approval path refuses (a prompt-injected agent can never get
/// a PR approved/commented autonomously without the explicit opt-in).
#[test]
fn agent_gh_writes_require_integration_and_autonomous_opt_in() {
    let _serial = GATE_TEST_LOCK.lock();
    // fail-closed defaults: both flags start (and end) off
    set_integration(false);
    set_autonomous_writes(false);
    assert!(!agent_gh_writes_allowed());
    // integration alone is NOT enough — the opt-in is required
    set_integration(true);
    assert!(!agent_gh_writes_allowed());
    // the opt-in alone is not enough either
    set_integration(false);
    set_autonomous_writes(true);
    assert!(!agent_gh_writes_allowed());
    // only BOTH open the agent-side gate
    set_integration(true);
    assert!(agent_gh_writes_allowed());
    // and it closes again the moment either flag drops
    set_autonomous_writes(false);
    assert!(!agent_gh_writes_allowed());
    set_integration(false);
}

/// Double-review HIGH 3: disabling drains in-flight writes — a write
/// holding the gate delays `set_integration(false)` until it finishes,
/// and after the ack no new write can pass.
#[test]
fn disable_waits_for_in_flight_writes() {
    let _serial = GATE_TEST_LOCK.lock();
    set_integration(true);
    let guard = require_integration().expect("gate must open while enabled");
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let handle = std::thread::spawn(move || {
        set_integration(false); // blocks on the held read guard
        tx.send(()).unwrap();
    });
    // the disable must NOT complete while the write guard is held
    assert!(
        rx.recv_timeout(Duration::from_millis(150)).is_err(),
        "set_integration(false) returned while a write was in flight"
    );
    drop(guard); // the write finishes → the disable drains through
    rx.recv_timeout(Duration::from_secs(5))
        .expect("set_integration(false) must complete once writes drained");
    handle.join().unwrap();
    assert!(require_integration().is_err());
}

#[test]
fn capped_diff_reader_streams_and_trims_lines() {
    // bounded drain: only `cap` bytes are kept, the excess is discarded
    let big = "x".repeat(64 * 1024);
    let buf = drain_capped(Some(std::io::Cursor::new(big.into_bytes())), 1000);
    let grace = Instant::now() + Duration::from_secs(2);
    while std::sync::Arc::strong_count(&buf) > 1 && Instant::now() < grace {
        std::thread::sleep(Duration::from_millis(5));
    }
    let (bytes, clipped) = {
        let g = buf.lock();
        (g.0.clone(), g.1)
    };
    assert_eq!(bytes.len(), 1000);
    assert!(clipped);
    // line trimming of a clipped diff
    let (text, truncated) = finish_capped_diff("line one\nline tw".into(), true);
    assert_eq!(text, "line one");
    assert!(truncated);
    // unclipped passes through untouched
    let (text, truncated) = finish_capped_diff("a\nb\n".into(), false);
    assert_eq!(text, "a\nb\n");
    assert!(!truncated);
}

#[test]
#[cfg(unix)]
fn capped_diff_timeout_kills_the_entire_helper_process_group() {
    use std::os::unix::fs::PermissionsExt as _;

    let root = std::env::temp_dir().join(format!(
        "swarmz-gh-group-kill-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let pidfile = root.join("helper.pid");
    let fake = root.join("fake-gh");
    std::fs::write(
        &fake,
        format!(
            "#!/bin/sh\nsleep 30 &\necho $! > '{}'\nwait\n",
            pidfile.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o700)).unwrap();

    assert!(gh_diff_capped_with_timeout(
        &fake.to_string_lossy(),
        &root.to_string_lossy(),
        "1",
        1024,
        Duration::from_millis(500),
    )
    .is_none());
    let helper_pid: libc::pid_t = std::fs::read_to_string(&pidfile)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let alive = unsafe { libc::kill(helper_pid, 0) } == 0;
        if !alive {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "gh timeout left helper process {helper_pid} alive"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    std::fs::remove_dir_all(root).ok();
}

/// Double-review HIGH 4: failed-push stderr is redacted before it can
/// reach the webview / Conductor transcript.
#[test]
fn credential_redaction_scrubs_tokens_and_userinfo() {
    // URL userinfo (user:token@) → ***@
    let s = redact_credentials(
        "fatal: unable to access 'https://user:hunter2@github.com/o/r.git/'",
        800,
    );
    assert!(!s.contains("hunter2"), "{s}");
    assert!(s.contains("https://***@github.com/o/r.git"), "{s}");
    // GitHub token shapes
    let s = redact_credentials(
        "remote: https://ghp_abcDEF123456789012345678@x.test failed",
        800,
    );
    assert!(!s.contains("ghp_abc"), "{s}");
    let s = redact_credentials("token github_pat_11ABCDEF0_abcdefghij was rejected", 800);
    assert!(!s.contains("github_pat_11"), "{s}");
    assert!(s.contains("[redacted]"), "{s}");
    // long opaque hex/base64 runs
    let hex = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef42";
    let s = redact_credentials(&format!("helper printed {hex} here"), 800);
    assert!(!s.contains(hex), "{s}");
    // ordinary output survives: branch names, hints, short words
    let plain =
        "error: failed to push some refs to 'origin'\nhint: Updates were rejected (fetch first)";
    assert_eq!(redact_credentials(plain, 800), plain);
    // the cap applies last
    let long = "e".repeat(2000);
    assert!(redact_credentials(&long, 100).chars().count() <= 101);
}

/// Double-review MEDIUM 5: an UNKNOWN default branch fails closed.
#[test]
fn lane_branch_guard_fails_closed_on_unknown_default() {
    assert!(ensure_lane_branch("feature/x", "main").is_ok());
    let err = ensure_lane_branch("main", "main").unwrap_err();
    assert!(err.contains("default branch"), "{err}");
    // missing/malformed defaultBranchRef → refuse, never fall open
    let err = ensure_lane_branch("feature/x", "").unwrap_err();
    assert!(err.contains("could not determine"), "{err}");
    assert!(ensure_lane_branch("feature/x", "  ").is_err());
}

/// LIVE spike (read-only): parse REAL gh output against this repo —
/// `cd src-tauri && cargo test github_live_spike -- --ignored --nocapture`.
/// Requires an installed, logged-in gh and the SwarmZ checkout's GitHub
/// remote (AgentZ-Media/SwarmZ). Runs no write commands.
#[test]
#[ignore = "live spike — needs the codex CLI, a login and network"]
fn github_live_spike() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_string_lossy()
        .into_owned();

    let auth = auth_status(None);
    println!("auth: {auth:?}");
    assert!(auth.installed, "gh must be installed for the live spike");
    assert!(
        auth.authenticated,
        "gh must be logged in for the live spike"
    );
    assert!(auth.login.is_some());
    assert!(auth.version.unwrap().starts_with("gh version"));

    let repo = match repo_info(&dir, None) {
        GhOutcome::Ok(r) => r,
        other => panic!("repo_info failed: {other:?}"),
    };
    println!("repo: {repo:?}");
    assert_eq!(repo.full_name, "AgentZ-Media/SwarmZ");
    assert!(!repo.default_branch.is_empty());
    assert!(repo.url.starts_with("https://github.com/"));

    let prs = match pr_list(&dir, None) {
        GhOutcome::Ok(p) => p,
        other => panic!("pr_list failed: {other:?}"),
    };
    println!("{} open PRs", prs.len());
    for pr in &prs {
        println!(
            "  #{} {:?} by {} [{} → {}] draft={} mergeable={} review={:?} checks={:?}",
            pr.number,
            pr.title,
            pr.author,
            pr.head_ref,
            pr.base_ref,
            pr.is_draft,
            pr.mergeable,
            pr.review_decision,
            pr.checks
        );
        assert!(pr.number > 0);
        assert!(!pr.title.is_empty());
        assert!(pr.url.starts_with("https://github.com/"));
        // every check lands in exactly one bucket
        assert_eq!(
            pr.checks.total,
            pr.checks.passing + pr.checks.failing + pr.checks.pending
        );
    }

    if let Some(first) = prs.first() {
        let detail = match pr_view(&dir, first.number, true, None) {
            GhOutcome::Ok(d) => d,
            other => panic!("pr_view failed: {other:?}"),
        };
        println!(
            "detail #{}: {} files, +{} −{}, {} reviews, diff {} bytes (truncated {})",
            detail.pr.number,
            detail.files.len(),
            detail.additions,
            detail.deletions,
            detail.reviews.len(),
            detail.diff.as_deref().map(str::len).unwrap_or(0),
            detail.diff_truncated,
        );
        assert_eq!(detail.pr.number, first.number);
        assert!(!detail.files.is_empty());
        assert!(detail.diff.is_some(), "the live PR diff must parse");
    }
}

#[test]
fn gh_bin_prefers_override_then_known_paths() {
    assert_eq!(gh_bin(Some("/custom/gh")), "/custom/gh");
    assert!(!gh_bin(Some("  ")).is_empty());
    let resolved = gh_bin(None);
    assert!(resolved.ends_with("gh"), "{resolved}");
}
