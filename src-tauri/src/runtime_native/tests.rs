use super::*;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

static SEQ: AtomicU64 = AtomicU64::new(0);

fn temp_dir() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "swarmz-runtime-native-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, AtomicOrdering::Relaxed)
    ));
    fs::create_dir_all(&path).unwrap();
    path.canonicalize().unwrap()
}

fn command(root: &Path, argv: Vec<&str>) -> RuntimeCommandRequest {
    RuntimeCommandRequest {
        run_id: format!("run-{}", SEQ.fetch_add(1, AtomicOrdering::Relaxed)),
        project_root: root.to_string_lossy().into_owned(),
        cwd_relative: ".".into(),
        argv: argv.into_iter().map(str::to_string).collect(),
        env: BTreeMap::new(),
        secret_bindings: Vec::new(),
        timeout_ms: 2_000,
        max_output_bytes: 4_096,
    }
}

#[test]
fn command_is_confined_argv_only_and_bounded() {
    let root = temp_dir();
    let result = command_run(command(
        &root,
        vec!["/usr/bin/printf", "hello %s", "runtime"],
    ))
    .unwrap();
    assert_eq!(result.stdout, "hello runtime");
    assert_eq!(result.exit_code, Some(0));
    let mut escaped = command(&root, vec!["/usr/bin/true"]);
    escaped.cwd_relative = "..".into();
    assert!(command_run(escaped).unwrap_err().contains("inside"));
    let shell = command(&root, vec!["/bin/sh", "-c", "true"]);
    assert!(command_run(shell).unwrap_err().contains("shell"));
    fs::remove_dir_all(root).ok();
}

#[test]
fn command_timeout_kills_group_and_caps_output() {
    let root = temp_dir();
    let mut request = command(&root, vec!["/usr/bin/yes"]);
    request.timeout_ms = 150;
    request.max_output_bytes = 1_024;
    let result = command_run(request).unwrap();
    assert_eq!(result.status, RuntimeCommandStatus::TimedOut);
    assert!(result.stdout_truncated);
    assert!(result.stdout.len() <= 1_024);
    fs::remove_dir_all(root).ok();
}

#[test]
fn command_can_be_cancelled_by_owned_run_id() {
    let root = temp_dir();
    let request = command(&root, vec!["/bin/sleep", "5"]);
    let run_id = request.run_id.clone();
    let handle = std::thread::spawn(move || command_run(request).unwrap());
    let deadline = Instant::now() + Duration::from_secs(2);
    while !command_cancel(&run_id) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    let result = handle.join().unwrap();
    assert_eq!(result.status, RuntimeCommandStatus::Cancelled);
    fs::remove_dir_all(root).ok();
}

#[test]
fn host_secret_is_late_bound_and_redacted() {
    let root = temp_dir();
    let key = format!("SWARMZ_TEST_SECRET_{}", std::process::id());
    unsafe { std::env::set_var(&key, "runtime-secret-value") };
    let mut request = command(&root, vec!["/usr/bin/printenv", "TARGET_SECRET"]);
    request.secret_bindings.push(RuntimeSecretBinding {
        target_env: "TARGET_SECRET".into(),
        source: SecretSource::HostEnv,
        source_key: key.clone(),
        required: true,
    });
    let result = command_run(request).unwrap();
    assert_eq!(result.stdout, "[redacted]");
    unsafe { std::env::remove_var(key) };
    fs::remove_dir_all(root).ok();
}

fn service_request(root: &Path, instance: &str) -> RuntimeServiceStartRequest {
    RuntimeServiceStartRequest {
        instance_id: instance.into(),
        service_id: "api".into(),
        project_root: root.to_string_lossy().into_owned(),
        cwd_relative: ".".into(),
        argv: vec!["/bin/sleep".into(), "10".into()],
        env: BTreeMap::new(),
        secret_bindings: Vec::new(),
        ports: vec![RuntimePortRequest {
            env: "API_PORT".into(),
            preferred: None,
        }],
        database_namespace: "test_namespace".into(),
        healthcheck_url: None,
        max_output_bytes: 4_096,
    }
}

#[test]
fn service_ports_are_deterministic_and_lifecycle_is_owned() {
    let root = temp_dir();
    let leases = temp_dir();
    let first = service_start(&leases, service_request(&root, "attempt_one")).unwrap();
    assert_eq!(first.state, RuntimeServiceState::Running);
    let port = first.ports["API_PORT"];
    assert!(service_stop(&leases, "attempt_one", "api").unwrap());
    let second = service_start(&leases, service_request(&root, "attempt_one")).unwrap();
    assert_eq!(second.ports["API_PORT"], port);
    assert!(service_stop(&leases, "attempt_one", "api").unwrap());
    assert!(service_list(&leases).is_empty());
    fs::remove_dir_all(root).ok();
    fs::remove_dir_all(leases).ok();
}

#[test]
fn reconcile_drops_stale_leases_without_killing_unknown_pids() {
    let leases = temp_dir();
    let lease = ServiceLease {
        version: 1,
        key: "old:api".into(),
        instance_id: "old".into(),
        service_id: "api".into(),
        project_root: "/tmp".into(),
        pid: u32::MAX,
        process_identity: Some("never".into()),
        ports: BTreeMap::new(),
        started_at: 0,
    };
    write_lease(&leases, &lease).unwrap();
    let result = service_reconcile(&leases);
    assert_eq!(result.stale, vec!["old:api"]);
    assert!(read_leases(&leases).is_empty());
    fs::remove_dir_all(leases).ok();
}

#[test]
fn healthcheck_is_local_owned_and_waits_for_readiness() {
    let root = temp_dir();
    let leases = temp_dir();
    let ports = BTreeMap::from([("API_PORT".into(), 43_210)]);
    assert!(
        resolve_healthcheck(Some("http://metadata.internal:${API_PORT}/latest"), &ports)
            .unwrap_err()
            .contains("host")
    );
    assert!(resolve_healthcheck(Some("file:///etc/passwd"), &ports).is_err());
    assert!(resolve_healthcheck(Some("http://127.0.0.1:${OTHER}/health"), &ports).is_err());

    let mut request = service_request(&root, "attempt_health");
    request.argv = vec![
            "/usr/bin/python3".into(),
            "-c".into(),
            "import http.server,os; http.server.HTTPServer(('127.0.0.1',int(os.environ['API_PORT'])),http.server.SimpleHTTPRequestHandler).serve_forever()".into(),
        ];
    request.healthcheck_url = Some("http://127.0.0.1:${API_PORT}/".into());
    let service = service_start(&leases, request).unwrap();
    assert_eq!(service.state, RuntimeServiceState::Running);
    assert!(service_stop(&leases, "attempt_health", "api").unwrap());
    fs::remove_dir_all(root).ok();
    fs::remove_dir_all(leases).ok();
}

#[test]
fn reconcile_kills_only_identity_verified_orphan_group() {
    let root = temp_dir();
    let leases = temp_dir();
    let service = service_start(&leases, service_request(&root, "attempt_orphan")).unwrap();
    let key = service_key(&service.instance_id, &service.service_id);
    ACTIVE_SERVICES.lock().remove(&key);
    let result = service_reconcile(&leases);
    assert_eq!(result.cleaned, vec![key]);
    assert!(result.unresolved.is_empty());
    let deadline = Instant::now() + Duration::from_secs(2);
    while service
        .pid
        .is_some_and(|pid| process_identity(pid).is_some())
        && Instant::now() < deadline
    {
        std::thread::sleep(Duration::from_millis(20));
    }
    fs::remove_dir_all(root).ok();
    fs::remove_dir_all(leases).ok();
}
