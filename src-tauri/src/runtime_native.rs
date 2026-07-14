//! Native Runtime Environment lifecycle.
//!
//! The durable frontend stores only environment specifications and opaque
//! secret references. Values are resolved here at the last possible moment,
//! injected into an `env_clear` child and redacted from captured output.
//! Commands are direct argv arrays; no shell is ever introduced.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::fs::OpenOptions;
use std::io::Read;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_ARGS: usize = 128;
const MAX_ARG_BYTES: usize = 4 * 1024;
const MAX_ARGV_BYTES: usize = 32 * 1024;
const MAX_ENV: usize = 64;
const MAX_ENV_BYTES: usize = 32 * 1024;
const MAX_ENV_VALUE_BYTES: usize = 4 * 1024;
const MAX_SECRETS: usize = 32;
const MIN_TIMEOUT_MS: u64 = 100;
const MAX_TIMEOUT_MS: u64 = 15 * 60 * 1_000;
const MIN_OUTPUT_BYTES: usize = 1024;
const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const SERVICE_START_GRACE_MS: u64 = 250;
const SERVICE_HEALTH_TIMEOUT: Duration = Duration::from_secs(10);
const SERVICE_STOP_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_LEASES: usize = 256;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretSource {
    HostEnv,
    Keychain,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSecretBinding {
    pub target_env: String,
    pub source: SecretSource,
    pub source_key: String,
    pub required: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCommandRequest {
    pub run_id: String,
    pub main_root: String,
    pub project_root: String,
    pub cwd_relative: String,
    pub argv: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub secret_bindings: Vec<RuntimeSecretBinding>,
    pub timeout_ms: u64,
    pub max_output_bytes: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeCommandStatus {
    Completed,
    TimedOut,
    Cancelled,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCommandResult {
    pub status: RuntimeCommandStatus,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePortRequest {
    pub env: String,
    pub preferred: Option<u16>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeServiceStartRequest {
    pub instance_id: String,
    pub service_id: String,
    pub owner_project_id: String,
    pub owner_mission_id: String,
    pub owner_attempt_id: String,
    pub main_root: String,
    pub project_root: String,
    pub cwd_relative: String,
    pub argv: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub secret_bindings: Vec<RuntimeSecretBinding>,
    #[serde(default)]
    pub ports: Vec<RuntimePortRequest>,
    pub database_namespace: String,
    pub healthcheck_url: Option<String>,
    pub max_output_bytes: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeServiceState {
    Starting,
    Running,
    Exited,
    Stopping,
    Orphaned,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeServiceSnapshot {
    pub instance_id: String,
    pub service_id: String,
    pub owner_project_id: String,
    pub owner_mission_id: String,
    pub owner_attempt_id: String,
    pub main_root: String,
    pub project_root: String,
    pub state: RuntimeServiceState,
    pub pid: Option<u32>,
    pub ports: BTreeMap<String, u16>,
    pub started_at: u64,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeReconcileResult {
    pub cleaned: Vec<String>,
    pub stale: Vec<String>,
    pub unresolved: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceLease {
    version: u8,
    key: String,
    instance_id: String,
    service_id: String,
    #[serde(default)]
    owner_project_id: String,
    #[serde(default)]
    owner_mission_id: String,
    #[serde(default)]
    owner_attempt_id: String,
    #[serde(default)]
    main_root: String,
    project_root: String,
    pid: u32,
    process_identity: Option<String>,
    ports: BTreeMap<String, u16>,
    started_at: u64,
}

struct Capture {
    bytes: Vec<u8>,
    truncated: bool,
}

struct ActiveService {
    cancel: Arc<AtomicBool>,
    snapshot: Arc<Mutex<RuntimeServiceSnapshot>>,
}

static ACTIVE_SERVICES: Lazy<Mutex<HashMap<String, ActiveService>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static SERVICE_LIFECYCLE_LOCK: Lazy<Mutex<()>> = Lazy::new(Mutex::default);

pub fn operations_in_flight() -> usize {
    ACTIVE_SERVICES
        .lock()
        .len()
        .saturating_add(process::active_command_count())
}

mod process;

pub(crate) use process::spawn_sandboxed_process;
use process::*;
pub use process::{command_cancel, command_run};
fn service_key(instance_id: &str, service_id: &str) -> String {
    // Length-prefix both model-supplied ids. Delimiter-only concatenation is
    // ambiguous because validated run ids may contain `:`.
    format!(
        "{}:{instance_id}|{}:{service_id}",
        instance_id.len(),
        service_id.len()
    )
}

fn lease_file(lease_root: &Path, key: &str) -> PathBuf {
    let digest = Sha256::digest(key.as_bytes());
    lease_root.join(format!("{:x}.json", digest))
}

fn write_lease(lease_root: &Path, lease: &ServiceLease) -> Result<PathBuf, String> {
    fs::create_dir_all(lease_root)
        .map_err(|error| format!("could not create lease store: {error}"))?;
    let path = lease_file(lease_root, &lease.key);
    if path.exists() {
        return Err("refused: a runtime service lease already exists".into());
    }
    let tmp = path.with_extension(format!("tmp-{}-{}", std::process::id(), now_ms()));
    let bytes = serde_json::to_vec(lease).map_err(|error| error.to_string())?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|error| format!("could not create service lease: {error}"))?;
    if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("could not write service lease: {error}"));
    }
    // hard_link is the portable same-filesystem NOREPLACE commit primitive:
    // unlike rename it can never overwrite an existing lease for this key.
    if let Err(error) = fs::hard_link(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "could not exclusively commit service lease: {error}"
        ));
    }
    if let Err(error) = fs::remove_file(&tmp) {
        let _ = fs::remove_file(&path);
        return Err(format!("could not finalize service lease: {error}"));
    }
    Ok(path)
}

fn remove_lease(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("could not remove service lease: {error}")),
    }
}

fn process_identity(pid: u32) -> Option<String> {
    #[cfg(unix)]
    {
        let mut command = Command::new("/bin/ps");
        command
            .args(["-p", &pid.to_string(), "-o", "lstart="])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .stdin(Stdio::null());
        let output = crate::git::output_with_timeout(&mut command, Duration::from_secs(2)).ok()?;
        if !output.status.success() {
            return None;
        }
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        (!value.is_empty() && value.len() <= 120).then_some(value)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        None
    }
}

fn port_available(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn allocate_ports(
    key: &str,
    requests: &[RuntimePortRequest],
    lease_root: &Path,
) -> Result<BTreeMap<String, u16>, String> {
    if requests.len() > 16 {
        return Err("refused: service port cap is 16".into());
    }
    let mut used: HashSet<u16> = ACTIVE_SERVICES
        .lock()
        .values()
        .flat_map(|service| {
            service
                .snapshot
                .lock()
                .ports
                .values()
                .copied()
                .collect::<Vec<_>>()
        })
        .collect();
    used.extend(
        read_leases(lease_root)?
            .into_iter()
            .flat_map(|(_, lease)| lease.ports.into_values()),
    );
    let mut result = BTreeMap::new();
    for request in requests {
        if !valid_env_name(&request.env) || result.contains_key(&request.env) {
            return Err("refused: invalid or duplicate service port environment".into());
        }
        let candidate = request
            .preferred
            .filter(|port| *port >= 1024 && !used.contains(port) && port_available(*port))
            .or_else(|| {
                let digest = Sha256::digest(format!("{key}:{}", request.env).as_bytes());
                let start = u16::from_be_bytes([digest[0], digest[1]]) as usize % 9_000;
                (0..9_000).find_map(|offset| {
                    let port = (41_000 + ((start + offset) % 9_000)) as u16;
                    (!used.contains(&port) && port_available(port)).then_some(port)
                })
            })
            .ok_or_else(|| "no runtime port is available in the bounded range".to_string())?;
        used.insert(candidate);
        result.insert(request.env.clone(), candidate);
    }
    Ok(result)
}

fn resolve_healthcheck(
    template: Option<&str>,
    ports: &BTreeMap<String, u16>,
) -> Result<Option<(String, u16, String)>, String> {
    let Some(template) = template else {
        return Ok(None);
    };
    if template.len() > 1_024 || template.chars().any(char::is_control) {
        return Err("refused: invalid runtime healthcheck URL".into());
    }
    let mut resolved = template.to_string();
    for (env, port) in ports {
        resolved = resolved.replace(&format!("${{{env}}}"), &port.to_string());
    }
    if resolved.contains("${") {
        return Err("refused: healthcheck references an undeclared port".into());
    }
    let rest = resolved
        .strip_prefix("http://")
        .ok_or_else(|| "refused: healthcheck must use local HTTP".to_string())?;
    let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
    let (host, port) = authority
        .rsplit_once(':')
        .ok_or_else(|| "refused: healthcheck must contain an assigned port".to_string())?;
    if !matches!(host, "127.0.0.1" | "localhost") {
        return Err("refused: healthcheck host must be 127.0.0.1 or localhost".into());
    }
    let port: u16 = port
        .parse()
        .map_err(|_| "refused: invalid healthcheck port".to_string())?;
    if !ports.values().any(|assigned| *assigned == port) {
        return Err("refused: healthcheck port is not owned by this service".into());
    }
    let path = format!("/{path}");
    if path.contains('#') || path.contains(' ') {
        return Err("refused: invalid healthcheck path".into());
    }
    Ok(Some((host.to_string(), port, path)))
}

fn healthcheck_ready(host: &str, port: u16, path: &str) -> bool {
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = std::net::TcpStream::connect_timeout(&address, Duration::from_millis(300))
    else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    if write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n"
    )
    .is_err()
    {
        return false;
    }
    let mut response = [0_u8; 64];
    let Ok(read) = stream.read(&mut response) else {
        return false;
    };
    let first = String::from_utf8_lossy(&response[..read]);
    first.starts_with("HTTP/1.0 2")
        || first.starts_with("HTTP/1.1 2")
        || first.starts_with("HTTP/1.0 3")
        || first.starts_with("HTTP/1.1 3")
}

pub fn service_start(
    lease_root: &Path,
    request: RuntimeServiceStartRequest,
) -> Result<RuntimeServiceSnapshot, String> {
    let _lifecycle = SERVICE_LIFECYCLE_LOCK.lock();
    let instance_id = checked_id(&request.instance_id, "runtime instance id")?;
    let service_id = checked_id(&request.service_id, "runtime service id")?;
    let owner_project_id = checked_id(&request.owner_project_id, "runtime owner project id")?;
    let owner_mission_id = checked_id(&request.owner_mission_id, "runtime owner mission id")?;
    let owner_attempt_id = checked_id(&request.owner_attempt_id, "runtime owner attempt id")?;
    let key = service_key(&instance_id, &service_id);
    if ACTIVE_SERVICES.lock().contains_key(&key) {
        return Err("refused: runtime service is already active".into());
    }
    let leases = read_leases(lease_root)?;
    if leases
        .iter()
        .any(|(_, lease)| lease.instance_id == instance_id && lease.service_id == service_id)
    {
        return Err(
            "refused: runtime service has an existing durable lease; reconcile it first".into(),
        );
    }
    if leases.len() >= MAX_LEASES {
        return Err("refused: runtime service lease cap is reached".into());
    }
    if request.database_namespace.is_empty()
        || request.database_namespace.len() > 63
        || !request
            .database_namespace
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    {
        return Err("refused: invalid database namespace".into());
    }
    if !(MIN_OUTPUT_BYTES..=MAX_OUTPUT_BYTES).contains(&request.max_output_bytes) {
        return Err("refused: runtime output limit is outside the allowed range".into());
    }
    let (root, cwd) = confined_cwd(&request.project_root, &request.cwd_relative)?;
    let main_root = fs::canonicalize(request.main_root.trim())
        .map_err(|_| "refused: runtime main root does not exist".to_string())?;
    if !main_root.is_dir() || (!root.starts_with(&main_root) && root != main_root) {
        return Err("refused: runtime worktree is outside its owner main root".into());
    }
    let ports = allocate_ports(&key, &request.ports, lease_root)?;
    let healthcheck = resolve_healthcheck(request.healthcheck_url.as_deref(), &ports)?;
    let mut explicit = request.env.clone();
    explicit.insert("SWARMZ_DB_NAMESPACE".into(), request.database_namespace);
    for (env, port) in &ports {
        if explicit.insert(env.clone(), port.to_string()).is_some() {
            return Err("refused: port environment collides with explicit environment".into());
        }
    }
    let (env, secrets) = resolved_env(&explicit, &request.secret_bindings)?;
    // Services may bind/connect only on loopback for their declared local
    // health surface. Non-loopback IPs and Unix sockets remain denied.
    let mut child = spawn_sandboxed_process(&root, &cwd, &main_root, &request.argv, &env, true)
        .map_err(|error| format!("could not start runtime service: {error}"))?;
    let pid = child.id();
    let stdout = drain_bounded(child.stdout.take(), request.max_output_bytes);
    let stderr = drain_bounded(child.stderr.take(), request.max_output_bytes);
    let started_at = now_ms();
    let snapshot = Arc::new(Mutex::new(RuntimeServiceSnapshot {
        instance_id: instance_id.clone(),
        service_id: service_id.clone(),
        owner_project_id: owner_project_id.clone(),
        owner_mission_id: owner_mission_id.clone(),
        owner_attempt_id: owner_attempt_id.clone(),
        main_root: main_root.to_string_lossy().into_owned(),
        project_root: root.to_string_lossy().into_owned(),
        state: RuntimeServiceState::Starting,
        pid: Some(pid),
        ports: ports.clone(),
        started_at,
        exit_code: None,
        stdout: String::new(),
        stderr: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
    }));
    let lease = ServiceLease {
        version: 2,
        key: key.clone(),
        instance_id,
        service_id,
        owner_project_id,
        owner_mission_id,
        owner_attempt_id,
        main_root: main_root.to_string_lossy().into_owned(),
        project_root: root.to_string_lossy().into_owned(),
        pid,
        process_identity: process_identity(pid),
        ports,
        started_at,
    };
    let lease_path = match write_lease(lease_root, &lease) {
        Ok(path) => path,
        Err(error) => {
            kill_group(&mut child);
            return Err(error);
        }
    };
    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_for_start = Arc::clone(&cancel);
    ACTIVE_SERVICES.lock().insert(
        key.clone(),
        ActiveService {
            cancel: Arc::clone(&cancel),
            snapshot: Arc::clone(&snapshot),
        },
    );
    let monitor_snapshot = Arc::clone(&snapshot);
    let monitor_key = key.clone();
    std::thread::spawn(move || {
        let exit = loop {
            if cancel.load(Ordering::Acquire) {
                monitor_snapshot.lock().state = RuntimeServiceState::Stopping;
                kill_group(&mut child);
                break None;
            }
            match child.try_wait() {
                Ok(Some(status)) => break status.code(),
                Ok(None) => {
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(_) => {
                    kill_group(&mut child);
                    break None;
                }
            }
        };
        let grace = Instant::now() + Duration::from_secs(1);
        while (Arc::strong_count(&stdout) > 1 || Arc::strong_count(&stderr) > 1)
            && Instant::now() < grace
        {
            std::thread::sleep(Duration::from_millis(5));
        }
        let (out, out_truncated) = capture_text(&stdout, &secrets);
        let (err, err_truncated) = capture_text(&stderr, &secrets);
        {
            let mut state = monitor_snapshot.lock();
            state.state = RuntimeServiceState::Exited;
            state.pid = None;
            state.exit_code = exit;
            state.stdout = out;
            state.stderr = err;
            state.stdout_truncated = out_truncated;
            state.stderr_truncated = err_truncated;
        }
        let _ = fs::remove_file(lease_path);
        ACTIVE_SERVICES.lock().remove(&monitor_key);
    });

    if let Some((host, port, path)) = healthcheck {
        let deadline = Instant::now() + SERVICE_HEALTH_TIMEOUT;
        loop {
            if snapshot.lock().state == RuntimeServiceState::Exited {
                break;
            }
            if healthcheck_ready(&host, port, &path) {
                snapshot.lock().state = RuntimeServiceState::Running;
                break;
            }
            if Instant::now() >= deadline {
                cancel_for_start.store(true, Ordering::Release);
                let stop_deadline = Instant::now() + SERVICE_STOP_TIMEOUT;
                while ACTIVE_SERVICES.lock().contains_key(&key) && Instant::now() < stop_deadline {
                    std::thread::sleep(Duration::from_millis(20));
                }
                if ACTIVE_SERVICES.lock().contains_key(&key)
                    || read_leases(lease_root)?
                        .iter()
                        .any(|(_, lease)| lease.key == key)
                {
                    return Err(
                        "runtime service healthcheck timed out and owned cleanup could not be confirmed"
                            .into(),
                    );
                }
                return Err(
                    "runtime service healthcheck timed out; owned process was stopped".into(),
                );
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    } else {
        std::thread::sleep(Duration::from_millis(SERVICE_START_GRACE_MS));
        let mut state = snapshot.lock();
        if state.state != RuntimeServiceState::Exited {
            state.state = RuntimeServiceState::Running;
        }
    }
    let current = snapshot.lock().clone();
    if current.state == RuntimeServiceState::Exited {
        let stop_deadline = Instant::now() + SERVICE_STOP_TIMEOUT;
        while ACTIVE_SERVICES.lock().contains_key(&key) && Instant::now() < stop_deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        if ACTIVE_SERVICES.lock().contains_key(&key)
            || read_leases(lease_root)?
                .iter()
                .any(|(_, lease)| lease.key == key)
        {
            return Err("runtime service exited during startup but cleanup is unresolved".into());
        }
        let diagnostic = current.stderr.trim();
        let diagnostic = (!diagnostic.is_empty()).then(|| {
            let clipped = diagnostic.chars().take(1_024).collect::<String>();
            format!("; stderr: {clipped}")
        });
        return Err(format!(
            "runtime service exited during startup{}{}",
            current
                .exit_code
                .map(|code| format!(" (exit {code})"))
                .unwrap_or_default(),
            diagnostic.unwrap_or_default()
        ));
    }
    Ok(current)
}

fn read_leases(lease_root: &Path) -> Result<Vec<(PathBuf, ServiceLease)>, String> {
    let entries = match fs::read_dir(lease_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("could not read runtime service leases: {error}")),
    };
    let mut leases = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("could not inspect service lease: {error}"))?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        if leases.len() >= MAX_LEASES {
            return Err("refused: runtime service lease cap is exceeded".into());
        }
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("could not inspect service lease metadata: {error}"))?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 32 * 1024 {
            return Err("refused: runtime service lease store contains an unsafe entry".into());
        }
        let bytes =
            fs::read(&path).map_err(|error| format!("could not read service lease: {error}"))?;
        let lease = serde_json::from_slice::<ServiceLease>(&bytes)
            .map_err(|_| "refused: runtime service lease is corrupt".to_string())?;
        if !matches!(lease.version, 1 | 2) || lease_file(lease_root, &lease.key) != path {
            return Err("refused: runtime service lease identity is invalid".into());
        }
        leases.push((path, lease));
    }
    Ok(leases)
}

pub fn service_list(lease_root: &Path) -> Result<Vec<RuntimeServiceSnapshot>, String> {
    let mut snapshots: Vec<_> = ACTIVE_SERVICES
        .lock()
        .values()
        .map(|service| service.snapshot.lock().clone())
        .collect();
    let active: HashSet<_> = snapshots
        .iter()
        .map(|snapshot| service_key(&snapshot.instance_id, &snapshot.service_id))
        .collect();
    for (_, lease) in read_leases(lease_root)? {
        if active.contains(&lease.key) {
            continue;
        }
        snapshots.push(RuntimeServiceSnapshot {
            instance_id: lease.instance_id,
            service_id: lease.service_id,
            owner_project_id: lease.owner_project_id,
            owner_mission_id: lease.owner_mission_id,
            owner_attempt_id: lease.owner_attempt_id,
            main_root: if lease.main_root.is_empty() {
                lease.project_root.clone()
            } else {
                lease.main_root
            },
            project_root: lease.project_root,
            state: RuntimeServiceState::Orphaned,
            pid: Some(lease.pid),
            ports: lease.ports,
            started_at: lease.started_at,
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            stdout_truncated: false,
            stderr_truncated: false,
        });
    }
    snapshots.sort_by(|a, b| {
        a.instance_id
            .cmp(&b.instance_id)
            .then(a.service_id.cmp(&b.service_id))
    });
    Ok(snapshots)
}

pub fn service_stop(
    lease_root: &Path,
    instance_id: &str,
    service_id: &str,
    project_root: &str,
) -> Result<bool, String> {
    let expected_root = fs::canonicalize(project_root.trim())
        .map_err(|_| "refused: runtime service owner root does not exist".to_string())?;
    let instance_id = checked_id(instance_id, "runtime instance id")?;
    let service_id = checked_id(service_id, "runtime service id")?;
    let key = service_key(&instance_id, &service_id);
    let active_cancel = {
        let active = ACTIVE_SERVICES.lock();
        active.get(&key).map(|service| {
            let snapshot = service.snapshot.lock();
            if Path::new(&snapshot.project_root) != expected_root {
                return Err("refused: runtime service is owned by another worktree".to_string());
            }
            Ok(Arc::clone(&service.cancel))
        })
    };
    if let Some(cancel) = active_cancel {
        let cancel = cancel?;
        cancel.store(true, Ordering::Release);
        let deadline = Instant::now() + SERVICE_STOP_TIMEOUT;
        while ACTIVE_SERVICES.lock().contains_key(&key) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        if ACTIVE_SERVICES.lock().contains_key(&key) {
            return Err("runtime service did not stop before the ownership deadline".into());
        }
        if read_leases(lease_root)?
            .iter()
            .any(|(_, lease)| lease.key == key)
        {
            return Err(
                "runtime service stopped but its durable lease could not be cleared".into(),
            );
        }
        return Ok(true);
    }
    let Some((path, lease)) = read_leases(lease_root)?
        .into_iter()
        .find(|(_, lease)| lease.instance_id == instance_id && lease.service_id == service_id)
    else {
        return Ok(false);
    };
    if Path::new(&lease.project_root) != expected_root {
        return Err("refused: runtime service lease is owned by another worktree".into());
    }
    let Some(identity) = lease.process_identity.as_deref() else {
        return Err("refused: orphaned service ownership cannot be verified".into());
    };
    if process_identity(lease.pid).as_deref() != Some(identity) {
        remove_lease(&path)?;
        return Ok(false);
    }
    if !kill_pid_group(lease.pid) {
        return Err("could not stop the verified orphaned service group".into());
    }
    if !wait_for_identity_exit(lease.pid, identity, SERVICE_STOP_TIMEOUT) {
        return Err("verified orphaned service did not exit before the ownership deadline".into());
    }
    remove_lease(&path)?;
    Ok(true)
}

fn wait_for_identity_exit(pid: u32, identity: &str, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if process_identity(pid).as_deref() != Some(identity) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    process_identity(pid).as_deref() != Some(identity)
}

pub fn service_reconcile(lease_root: &Path) -> Result<RuntimeReconcileResult, String> {
    let active: HashSet<_> = ACTIVE_SERVICES.lock().keys().cloned().collect();
    let mut result = RuntimeReconcileResult {
        cleaned: Vec::new(),
        stale: Vec::new(),
        unresolved: Vec::new(),
    };
    for (path, lease) in read_leases(lease_root)? {
        if active.contains(&lease.key) {
            continue;
        }
        match (
            lease.process_identity.as_deref(),
            process_identity(lease.pid),
        ) {
            (_, None) => {
                if remove_lease(&path).is_ok() {
                    result.stale.push(lease.key);
                } else {
                    result.unresolved.push(lease.key);
                }
            }
            (Some(expected), Some(observed)) if expected == observed => {
                if kill_pid_group(lease.pid)
                    && wait_for_identity_exit(lease.pid, expected, SERVICE_STOP_TIMEOUT)
                    && remove_lease(&path).is_ok()
                {
                    result.cleaned.push(lease.key);
                } else {
                    result.unresolved.push(lease.key);
                }
            }
            _ => result.unresolved.push(lease.key),
        }
    }
    Ok(result)
}

pub fn service_stop_all(lease_root: &Path) -> Result<RuntimeReconcileResult, String> {
    process::cancel_all_commands();
    let cancels: Vec<_> = ACTIVE_SERVICES
        .lock()
        .values()
        .map(|service| Arc::clone(&service.cancel))
        .collect();
    for cancel in cancels {
        cancel.store(true, Ordering::Release);
    }
    let deadline = Instant::now() + SERVICE_STOP_TIMEOUT;
    while !ACTIVE_SERVICES.lock().is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let active_unresolved: Vec<_> = ACTIVE_SERVICES.lock().keys().cloned().collect();
    let command_unresolved = process::wait_for_all_commands(SERVICE_STOP_TIMEOUT);
    let mut result = service_reconcile(lease_root)?;
    result.unresolved.extend(active_unresolved);
    result.unresolved.extend(
        command_unresolved
            .into_iter()
            .map(|run_id| format!("command:{run_id}")),
    );
    result.unresolved.sort();
    result.unresolved.dedup();
    Ok(result)
}

#[cfg(test)]
mod tests;
