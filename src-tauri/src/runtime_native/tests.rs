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
        main_root: root.to_string_lossy().into_owned(),
        project_root: root.to_string_lossy().into_owned(),
        cwd_relative: ".".into(),
        argv: argv.into_iter().map(str::to_string).collect(),
        env: BTreeMap::new(),
        secret_bindings: Vec::new(),
        timeout_ms: 2_000,
        max_output_bytes: 4_096,
    }
}

fn worktree_command(main_root: &Path, worktree: &Path, argv: Vec<&str>) -> RuntimeCommandRequest {
    let mut request = command(worktree, argv);
    request.main_root = main_root.to_string_lossy().into_owned();
    request
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

#[cfg(target_os = "macos")]
#[test]
fn sandbox_denies_host_files_outside_writes_and_external_network() {
    let root = temp_dir();
    let outside = temp_dir().join("host-secret.txt");
    fs::write(&outside, "must-not-be-readable").unwrap();

    let read = command_run(command(&root, vec!["/bin/cat", outside.to_str().unwrap()])).unwrap();
    assert_ne!(read.exit_code, Some(0));
    assert!(!read.stdout.contains("must-not-be-readable"));

    let write_target = outside.with_file_name("sandbox-escape.txt");
    let write = command_run(command(
        &root,
        vec!["/usr/bin/touch", write_target.to_str().unwrap()],
    ))
    .unwrap();
    assert_ne!(write.exit_code, Some(0));
    assert!(!write_target.exists());

    let network = command_run(command(
        &root,
        vec!["/usr/bin/nc", "-w", "1", "1.1.1.1", "80"],
    ))
    .unwrap();
    assert_ne!(network.exit_code, Some(0));

    fs::remove_dir_all(root).ok();
    fs::remove_dir_all(outside.parent().unwrap()).ok();
}

#[cfg(target_os = "macos")]
#[test]
fn sandbox_reads_main_dependencies_but_not_main_source_or_secrets() {
    let main_root = temp_dir();
    let worktree = main_root.join(".worktrees").join("attempt");
    let sibling = main_root.join(".worktrees").join("sibling");
    let module = main_root.join("node_modules/swarmz-sandbox-probe");
    fs::create_dir_all(&worktree).unwrap();
    fs::create_dir_all(&sibling).unwrap();
    fs::create_dir_all(&module).unwrap();
    fs::create_dir_all(main_root.join(".git")).unwrap();
    fs::write(
        module.join("index.js"),
        "module.exports = 'dependency-ok';\n",
    )
    .unwrap();
    fs::write(main_root.join("package.json"), "{\"private\":true}\n").unwrap();
    fs::write(main_root.join(".env"), "MAIN_SECRET=must-not-leak\n").unwrap();
    fs::write(main_root.join(".git/config"), "git-secret=must-not-leak\n").unwrap();
    fs::write(
        worktree.join("probe.js"),
        "console.log(require('swarmz-sandbox-probe'));\n",
    )
    .unwrap();

    let dependency = command_run(worktree_command(
        &main_root,
        &worktree,
        vec!["node", "probe.js"],
    ))
    .unwrap();
    assert_eq!(dependency.exit_code, Some(0), "{}", dependency.stderr);
    assert_eq!(dependency.stdout, "dependency-ok");

    for protected in [
        main_root.join("package.json"),
        main_root.join(".env"),
        main_root.join(".git/config"),
    ] {
        let read = command_run(worktree_command(
            &main_root,
            &worktree,
            vec!["/bin/cat", protected.to_str().unwrap()],
        ))
        .unwrap();
        assert_ne!(read.exit_code, Some(0));
        assert!(!read.stdout.contains("must-not-leak"));
    }

    let mutation = main_root.join("main-mutation.txt");
    let write = command_run(worktree_command(
        &main_root,
        &worktree,
        vec!["/usr/bin/touch", mutation.to_str().unwrap()],
    ))
    .unwrap();
    assert_ne!(write.exit_code, Some(0));
    assert!(!mutation.exists());
    let sibling_mutation = sibling.join("sibling-mutation.txt");
    let write = command_run(worktree_command(
        &main_root,
        &worktree,
        vec!["/usr/bin/touch", sibling_mutation.to_str().unwrap()],
    ))
    .unwrap();
    assert_ne!(write.exit_code, Some(0));
    assert!(!sibling_mutation.exists());
    fs::remove_dir_all(main_root).ok();
}

#[cfg(target_os = "macos")]
#[test]
fn sandbox_runs_local_node_pnpm_and_rust_toolchains() {
    let main_root = temp_dir();
    let worktree = main_root.join(".worktrees").join("toolchain");
    fs::create_dir_all(&worktree).unwrap();
    for executable in ["node", "pnpm", "cargo", "rustc"] {
        let result = command_run(worktree_command(
            &main_root,
            &worktree,
            vec![executable, "--version"],
        ))
        .unwrap();
        assert_eq!(
            result.exit_code,
            Some(0),
            "{executable} failed in sandbox: {}",
            result.stderr
        );
        assert!(
            !result.stdout.trim().is_empty(),
            "{executable} had no version output"
        );
    }
    fs::create_dir_all(worktree.join("src")).unwrap();
    fs::write(
        worktree.join("Cargo.toml"),
        "[package]\nname = \"sandbox_probe\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
    )
    .unwrap();
    fs::write(worktree.join("src/main.rs"), "fn main() {}\n").unwrap();
    let mut cargo_check =
        worktree_command(&main_root, &worktree, vec!["cargo", "check", "--offline"]);
    cargo_check.timeout_ms = 30_000;
    cargo_check.max_output_bytes = 16_384;
    let result = command_run(cargo_check).unwrap();
    assert_eq!(
        result.exit_code,
        Some(0),
        "cargo check failed in sandbox: {}",
        result.stderr
    );
    assert!(worktree.join("target").is_dir());
    fs::remove_dir_all(main_root).ok();
}

#[cfg(target_os = "macos")]
#[test]
fn sandbox_rejects_reserved_environment_overrides_at_shared_boundary() {
    let root = temp_dir();
    for key in ["PATH", "HOME", "TMPDIR", "CARGO_HOME", "NODE_PATH"] {
        let mut request = command(&root, vec!["/usr/bin/true"]);
        request
            .env
            .insert(key.into(), "/tmp/host-controlled".into());
        assert!(command_run(request)
            .unwrap_err()
            .contains("dangerous runtime environment"));
    }
    fs::remove_dir_all(root).ok();
}

#[cfg(target_os = "macos")]
#[test]
fn sandbox_uses_confined_ambient_env_and_never_puts_secret_in_profile_or_argv() {
    let root = temp_dir();
    let (_, cwd) = confined_cwd(root.to_str().unwrap(), ".").unwrap();
    let secret = "never-in-sandbox-profile-or-arguments";
    let env = BTreeMap::from([("TARGET_SECRET".to_string(), secret.to_string())]);
    let argv = vec!["/usr/bin/printenv".to_string(), "HOME".to_string()];
    let prepared = prepare_command(&root, &cwd, &root, &argv, &env, false).unwrap();
    let rendered_args = prepared
        .command
        .get_args()
        .map(|value| value.to_string_lossy())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!rendered_args.contains(secret));
    assert!(rendered_args.contains("(deny default)"));
    assert!(!rendered_args.contains("network-outbound"));
    let inherited = prepared
        .command
        .get_envs()
        .filter_map(|(key, value)| value.map(|value| (key, value)))
        .collect::<BTreeMap<_, _>>();
    assert_eq!(
        *inherited.get(std::ffi::OsStr::new("HOME")).unwrap(),
        root.join(".swarmz/runtime-process/home").as_os_str()
    );
    assert!(!inherited.contains_key(std::ffi::OsStr::new("CODEX_HOME")));
    fs::remove_dir_all(root).ok();
}

fn service_request(root: &Path, instance: &str) -> RuntimeServiceStartRequest {
    RuntimeServiceStartRequest {
        instance_id: instance.into(),
        service_id: "api".into(),
        owner_project_id: "project".into(),
        owner_mission_id: "mission".into(),
        owner_attempt_id: instance.into(),
        main_root: root.to_string_lossy().into_owned(),
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
    assert!(service_stop(&leases, "attempt_one", "api", root.to_str().unwrap()).unwrap());
    let second = service_start(&leases, service_request(&root, "attempt_one")).unwrap();
    assert_eq!(second.ports["API_PORT"], port);
    assert!(service_stop(&leases, "attempt_one", "api", root.to_str().unwrap()).unwrap());
    assert!(service_list(&leases).unwrap().is_empty());
    fs::remove_dir_all(root).ok();
    fs::remove_dir_all(leases).ok();
}

#[test]
fn reconcile_drops_stale_leases_without_killing_unknown_pids() {
    let leases = temp_dir();
    let lease = ServiceLease {
        version: 1,
        key: service_key("old", "api"),
        instance_id: "old".into(),
        service_id: "api".into(),
        owner_project_id: "project".into(),
        owner_mission_id: "mission".into(),
        owner_attempt_id: "old".into(),
        main_root: "/tmp".into(),
        project_root: "/tmp".into(),
        pid: u32::MAX,
        process_identity: Some("never".into()),
        ports: BTreeMap::new(),
        started_at: 0,
    };
    write_lease(&leases, &lease).unwrap();
    let result = service_reconcile(&leases).unwrap();
    assert_eq!(result.stale, vec![service_key("old", "api")]);
    assert!(read_leases(&leases).unwrap().is_empty());
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
        "node".into(),
        "-e".into(),
        "require('http').createServer((_,res)=>{res.writeHead(204);res.end()}).listen(Number(process.env.API_PORT),'127.0.0.1')".into(),
    ];
    request.healthcheck_url = Some("http://127.0.0.1:${API_PORT}/".into());
    let service = service_start(&leases, request).unwrap();
    assert_eq!(service.state, RuntimeServiceState::Running);
    assert!(service_stop(&leases, "attempt_health", "api", root.to_str().unwrap()).unwrap());
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
    let result = service_reconcile(&leases).unwrap();
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

#[test]
fn orphan_lease_cannot_be_overwritten_and_stop_is_root_scoped() {
    let root = temp_dir();
    let foreign = temp_dir();
    let leases = temp_dir();
    let service = service_start(&leases, service_request(&root, "attempt_owned")).unwrap();
    let key = service_key(&service.instance_id, &service.service_id);
    assert!(
        service_stop(&leases, "attempt_owned", "api", foreign.to_str().unwrap())
            .unwrap_err()
            .contains("another worktree")
    );
    ACTIVE_SERVICES.lock().remove(&key);
    assert!(
        service_start(&leases, service_request(&root, "attempt_owned"))
            .unwrap_err()
            .contains("existing durable lease")
    );
    let result = service_reconcile(&leases).unwrap();
    assert!(result.cleaned.contains(&key));
    assert!(result.unresolved.is_empty());
    fs::remove_dir_all(root).ok();
    fs::remove_dir_all(foreign).ok();
    fs::remove_dir_all(leases).ok();
}
