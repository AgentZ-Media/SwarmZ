use super::*;

static ACTIVE_COMMANDS: Lazy<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

struct ActiveCommandGuard {
    run_id: String,
}

impl Drop for ActiveCommandGuard {
    fn drop(&mut self) {
        ACTIVE_COMMANDS.lock().remove(&self.run_id);
    }
}

fn register_command(run_id: &str) -> Result<(Arc<AtomicBool>, ActiveCommandGuard), String> {
    let run_id = checked_id(run_id, "runtime command run id")?;
    let cancel = Arc::new(AtomicBool::new(false));
    let mut active = ACTIVE_COMMANDS.lock();
    if active.contains_key(&run_id) {
        return Err("refused: runtime command run id is already active".into());
    }
    active.insert(run_id.clone(), Arc::clone(&cancel));
    Ok((cancel, ActiveCommandGuard { run_id }))
}

pub fn command_cancel(run_id: &str) -> bool {
    let cancel = ACTIVE_COMMANDS.lock().get(run_id.trim()).cloned();
    if let Some(cancel) = cancel {
        cancel.store(true, Ordering::Release);
        true
    } else {
        false
    }
}

pub(super) fn cancel_all_commands() {
    let cancels: Vec<_> = ACTIVE_COMMANDS.lock().values().cloned().collect();
    for cancel in cancels {
        cancel.store(true, Ordering::Release);
    }
}

pub(super) fn wait_for_all_commands(timeout: Duration) -> Vec<String> {
    let deadline = Instant::now() + timeout;
    loop {
        let active: Vec<_> = ACTIVE_COMMANDS.lock().keys().cloned().collect();
        if active.is_empty() || Instant::now() >= deadline {
            return active;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

pub(super) fn active_command_count() -> usize {
    ACTIVE_COMMANDS.lock().len()
}

pub(super) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

pub(super) fn checked_id(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 120
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(format!("refused: invalid {label}"));
    }
    Ok(value.to_string())
}

pub(super) fn valid_env_name(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(b'A'..=b'Z' | b'_'))
        && bytes.all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        && value.len() <= 80
}

fn validate_argv(argv: &[String]) -> Result<(), String> {
    if argv.is_empty() || argv.len() > MAX_ARGS {
        return Err("refused: argv must contain 1-128 entries".into());
    }
    let mut total = 0_usize;
    for argument in argv {
        if argument.is_empty() || argument.len() > MAX_ARG_BYTES || argument.contains('\0') {
            return Err("refused: invalid or oversized argv entry".into());
        }
        total = total.saturating_add(argument.len());
    }
    if total > MAX_ARGV_BYTES {
        return Err("refused: argv exceeds 32 KiB".into());
    }
    let executable = Path::new(&argv[0])
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(
        executable.as_str(),
        "sh" | "bash" | "zsh" | "fish" | "dash" | "cmd" | "cmd.exe" | "powershell" | "pwsh"
    ) {
        return Err("refused: runtime commands must not invoke a shell".into());
    }
    Ok(())
}

fn validate_env(env: &BTreeMap<String, String>) -> Result<(), String> {
    if env.len() > MAX_ENV {
        return Err("refused: too many runtime environment variables".into());
    }
    let mut total = 0_usize;
    for (key, value) in env {
        if !valid_env_name(key) || value.len() > MAX_ENV_VALUE_BYTES || value.contains('\0') {
            return Err("refused: invalid or oversized runtime environment variable".into());
        }
        let upper = key.to_ascii_uppercase();
        if upper.starts_with("DYLD_")
            || upper.starts_with("LD_")
            || upper.starts_with("GIT_")
            || upper.starts_with("SSH_")
            || matches!(
                upper.as_str(),
                "BASH_ENV"
                    | "ENV"
                    | "NODE_OPTIONS"
                    | "PYTHONPATH"
                    | "RUSTC_WRAPPER"
                    | "PATH"
                    | "HOME"
                    | "TMPDIR"
                    | "CODEX_HOME"
                    | "CARGO_HOME"
                    | "RUSTUP_HOME"
                    | "RUSTUP_TOOLCHAIN"
                    | "COREPACK_HOME"
                    | "PNPM_HOME"
                    | "NODE_PATH"
            )
        {
            return Err("refused: dangerous runtime environment variable".into());
        }
        total = total.saturating_add(key.len() + value.len());
    }
    if total > MAX_ENV_BYTES {
        return Err("refused: runtime environment exceeds 32 KiB".into());
    }
    Ok(())
}

pub(super) fn confined_cwd(
    project_root: &str,
    relative: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let root_input = Path::new(project_root.trim());
    if !root_input.is_absolute() {
        return Err("refused: project root must be absolute".into());
    }
    let root = fs::canonicalize(root_input)
        .map_err(|_| "refused: project root does not exist".to_string())?;
    if !root.is_dir() {
        return Err("refused: project root is not a directory".into());
    }
    let relative = Path::new(relative.trim());
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("refused: runtime cwd must stay inside the project root".into());
    }
    let cwd = fs::canonicalize(root.join(relative))
        .map_err(|_| "refused: runtime cwd does not exist".to_string())?;
    if !cwd.is_dir() || !cwd.starts_with(&root) {
        return Err("refused: runtime cwd escapes the project root".into());
    }
    Ok((root, cwd))
}

#[cfg(unix)]
fn open_cwd(cwd: &Path) -> Result<std::fs::File, String> {
    use std::ffi::CString;
    use std::os::fd::FromRawFd;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;

    let expected = fs::metadata(cwd).map_err(|_| "runtime cwd vanished".to_string())?;
    let path = CString::new(cwd.as_os_str().as_bytes()).map_err(|_| "invalid runtime cwd")?;
    let fd = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err("refused: runtime cwd could not be opened safely".into());
    }
    let file = unsafe { std::fs::File::from_raw_fd(fd) };
    let observed = file.metadata().map_err(|_| "runtime cwd vanished")?;
    if expected.dev() != observed.dev() || expected.ino() != observed.ino() {
        return Err("refused: runtime cwd changed during validation".into());
    }
    Ok(file)
}

pub(super) fn drain_bounded<R: Read + Send + 'static>(
    pipe: Option<R>,
    cap: usize,
) -> Arc<Mutex<Capture>> {
    let capture = Arc::new(Mutex::new(Capture {
        bytes: Vec::new(),
        truncated: false,
    }));
    if let Some(mut pipe) = pipe {
        let shared = Arc::clone(&capture);
        std::thread::spawn(move || {
            let mut chunk = [0_u8; 8192];
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        let mut capture = shared.lock();
                        let remaining = cap.saturating_sub(capture.bytes.len());
                        let take = remaining.min(read);
                        capture.bytes.extend_from_slice(&chunk[..take]);
                        capture.truncated |= take < read;
                    }
                }
            }
        });
    }
    capture
}

pub(super) fn kill_group(child: &mut std::process::Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

pub(super) fn kill_pid_group(pid: u32) -> bool {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as libc::pid_t), libc::SIGKILL) == 0
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

pub(super) fn capture_text(capture: &Arc<Mutex<Capture>>, secrets: &[String]) -> (String, bool) {
    let mut capture = capture.lock();
    let bytes = std::mem::take(&mut capture.bytes);
    let truncated = capture.truncated;
    drop(capture);
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    for secret in secrets.iter().filter(|value| !value.is_empty()) {
        text = text.replace(secret, "[redacted]");
    }
    let lines = text
        .lines()
        .map(|line| {
            let upper = line.to_ascii_uppercase();
            if ["TOKEN=", "TOKEN:", "SECRET=", "PASSWORD=", "API_KEY="]
                .iter()
                .any(|marker| upper.contains(marker))
            {
                "[redacted sensitive output]".into()
            } else {
                line.chars()
                    .filter(|character| *character == '\t' || !character.is_control())
                    .collect::<String>()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    (lines, truncated)
}

fn keychain_value(source_key: &str) -> Result<Option<String>, String> {
    if source_key.is_empty()
        || source_key.len() > 256
        || !source_key.contains('/')
        || !source_key.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/' | b':')
        })
    {
        return Err("invalid keychain reference".into());
    }
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("/usr/bin/security");
        command
            .args(["find-generic-password", "-s", source_key, "-w"])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .stdin(Stdio::null());
        let output = crate::git::output_with_timeout(&mut command, Duration::from_secs(5))
            .map_err(|_| "keychain lookup failed".to_string())?;
        if !output.status.success() {
            return Ok(None);
        }
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if value.len() > MAX_ENV_VALUE_BYTES {
            return Err("keychain value exceeds runtime limit".into());
        }
        Ok(Some(value))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = source_key;
        Ok(None)
    }
}

pub(super) fn resolved_env(
    explicit: &BTreeMap<String, String>,
    bindings: &[RuntimeSecretBinding],
) -> Result<(BTreeMap<String, String>, Vec<String>), String> {
    validate_env(explicit)?;
    if bindings.len() > MAX_SECRETS {
        return Err("refused: too many runtime secret references".into());
    }
    let mut env = explicit.clone();
    let mut values = Vec::new();
    let mut targets = HashSet::new();
    for binding in bindings {
        if !valid_env_name(&binding.target_env) || !targets.insert(binding.target_env.clone()) {
            return Err("refused: invalid or duplicate secret target".into());
        }
        if env.contains_key(&binding.target_env) {
            return Err("refused: secret target collides with explicit environment".into());
        }
        let value = match binding.source {
            SecretSource::HostEnv => {
                if !valid_env_name(&binding.source_key) {
                    return Err("refused: invalid host environment reference".into());
                }
                std::env::var(&binding.source_key).ok()
            }
            SecretSource::Keychain => keychain_value(&binding.source_key)?,
        };
        match value {
            Some(value) if value.len() <= MAX_ENV_VALUE_BYTES => {
                values.push(value.clone());
                env.insert(binding.target_env.clone(), value);
            }
            Some(_) => return Err("resolved secret exceeds runtime limit".into()),
            None if binding.required => {
                return Err(format!(
                    "required {} secret reference could not be resolved",
                    binding.target_env
                ))
            }
            None => {}
        }
    }
    Ok((env, values))
}

pub(super) struct PreparedCommand {
    pub(super) command: Command,
    #[cfg(unix)]
    pub(super) cwd_handle: std::fs::File,
}

#[cfg(target_os = "macos")]
const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";
#[cfg(target_os = "macos")]
const MAX_SANDBOX_READ_ROOTS: usize = 16;

/// Fixed, application-owned SBPL. Canonical paths are supplied through a
/// fixed set of `sandbox-exec -D` parameters; no environment value, secret,
/// command argument or project text is interpolated into SBPL source.
///
/// `system.sb` supplies the minimum platform/dyld plumbing required to start
/// normal macOS executables. The rules below add read/write access to the
/// attempt worktree and read/exec access to immutable platform/toolchain
/// locations. Network remains denied unless the service-only profile adds
/// loopback. In particular, the user's home, Keychain, Unix sockets and
/// non-loopback IP traffic are not reachable by the child.
#[cfg(target_os = "macos")]
const SANDBOX_PROFILE_BASE: &str = r#"
(version 1)
(import "system.sb")
(deny default)
(allow process-fork)
(allow process-exec*
  (subpath (param "SWARMZ_ROOT"))
  (subpath "/System")
  (subpath "/usr")
  (subpath "/bin")
  (subpath "/sbin")
  (subpath "/opt/homebrew")
  (subpath "/Library/Apple")
  (subpath "/Library/Developer/CommandLineTools")
  (subpath "/Applications/Xcode.app"))
(allow file-read* file-test-existence file-map-executable
  (subpath (param "SWARMZ_ROOT"))
  (subpath "/usr/bin")
  (subpath "/bin")
  (subpath "/usr/sbin")
  (subpath "/sbin")
  (subpath "/private/etc/ssl")
  (subpath "/opt/homebrew")
  (subpath "/Library/Developer/CommandLineTools")
  (subpath "/Applications/Xcode.app")
  (literal "/private/var/select/developer_dir"))
(allow file-read-metadata file-test-existence
  (path-ancestors (param "SWARMZ_ROOT"))
  (path-ancestors "/Library/Developer/CommandLineTools")
  (path-ancestors "/Applications/Xcode.app"))
(allow file-read* file-test-existence file-map-executable
  (literal "/private/var/select/sh"))
(allow file-write* (subpath (param "SWARMZ_ROOT")))
"#;

#[cfg(target_os = "macos")]
const SANDBOX_PROFILE_LOOPBACK: &str = r#"
(allow network-outbound (remote ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
"#;

#[cfg(target_os = "macos")]
fn sandbox_profile(allow_loopback: bool) -> String {
    let mut profile = String::from(SANDBOX_PROFILE_BASE);
    // The clauses are generated exclusively from this fixed numeric range.
    // User/project text is supplied only as sandbox-exec `-D` values and is
    // never interpolated into SBPL source.
    for index in 0..MAX_SANDBOX_READ_ROOTS {
        profile.push_str(&format!(
            "\n(allow file-read* file-test-existence file-map-executable (subpath (param \"SWARMZ_READ_{index}\")))\n"
        ));
        profile.push_str(&format!(
            "\n(allow file-read-metadata file-test-existence (path-ancestors (param \"SWARMZ_READ_{index}\")))\n"
        ));
        profile.push_str(&format!(
            "\n(allow process-exec* (subpath (param \"SWARMZ_EXEC_{index}\")))\n"
        ));
    }
    if allow_loopback {
        profile.push_str(SANDBOX_PROFILE_LOOPBACK);
    }
    profile
}

#[derive(Default)]
struct SandboxCapabilities {
    read_roots: Vec<PathBuf>,
    exec_roots: Vec<PathBuf>,
    path_dirs: Vec<PathBuf>,
    internal_env: BTreeMap<String, String>,
}

#[cfg(target_os = "macos")]
fn trusted_dir(path: PathBuf, owner_uid: u32) -> Option<PathBuf> {
    use std::os::unix::fs::MetadataExt;

    let canonical = fs::canonicalize(path).ok()?;
    let metadata = fs::metadata(&canonical).ok()?;
    (metadata.is_dir() && metadata.uid() == owner_uid && metadata.mode() & 0o022 == 0)
        .then_some(canonical)
}

#[cfg(target_os = "macos")]
fn active_rust_toolchain(home: &Path, owner_uid: u32) -> Option<PathBuf> {
    let rustup = home.join(".rustup");
    let settings = fs::read_to_string(rustup.join("settings.toml")).ok()?;
    if settings.len() > 32 * 1024 {
        return None;
    }
    let name = settings.lines().find_map(|line| {
        let value = line.trim().strip_prefix("default_toolchain")?.trim();
        let value = value.strip_prefix('=')?.trim();
        value.strip_prefix('"')?.strip_suffix('"')
    })?;
    if name.is_empty()
        || name.len() > 120
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return None;
    }
    let toolchains = fs::canonicalize(rustup.join("toolchains")).ok()?;
    let selected = trusted_dir(toolchains.join(name), owner_uid)?;
    selected.starts_with(&toolchains).then_some(selected)
}

#[cfg(target_os = "macos")]
fn sandbox_capabilities(main_root: &Path) -> Result<SandboxCapabilities, String> {
    let main_root = fs::canonicalize(main_root)
        .map_err(|_| "refused: sandbox main root does not exist".to_string())?;
    if !main_root.is_dir() {
        return Err("refused: sandbox main root is not a directory".into());
    }
    let mut capabilities = SandboxCapabilities::default();

    let dependency = main_root.join("node_modules");
    if dependency.exists() {
        let metadata = fs::symlink_metadata(&dependency)
            .map_err(|_| "refused: main dependency root could not be inspected".to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("refused: main node_modules must be a real directory".into());
        }
        let canonical = fs::canonicalize(&dependency)
            .map_err(|_| "refused: main dependency root could not be canonicalized".to_string())?;
        if canonical.parent() != Some(main_root.as_path())
            || canonical.file_name().and_then(|value| value.to_str()) != Some("node_modules")
        {
            return Err("refused: dependency root escapes the canonical main project".into());
        }
        capabilities.path_dirs.push(canonical.join(".bin"));
        capabilities
            .internal_env
            .insert("NODE_PATH".into(), canonical.to_string_lossy().into_owned());
        capabilities.exec_roots.push(canonical.clone());
        capabilities.read_roots.push(canonical);
    }

    let root_uid = 0;
    for path in [
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/local/lib/node_modules/corepack"),
    ] {
        if let Some(path) = trusted_dir(path, root_uid) {
            if path.ends_with("bin") {
                capabilities.path_dirs.push(path.clone());
            }
            capabilities.exec_roots.push(path.clone());
            capabilities.read_roots.push(path);
        }
    }

    let owner_uid = unsafe { libc::geteuid() };
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        let home = fs::canonicalize(home).map_err(|_| {
            "refused: host home could not be canonicalized for tool discovery".to_string()
        })?;
        let local_bin = trusted_dir(home.join(".local/bin"), owner_uid);
        if let Some(path) = local_bin {
            capabilities.path_dirs.push(path.clone());
            capabilities.exec_roots.push(path.clone());
            capabilities.read_roots.push(path);
        }
        if let Some(path) = trusted_dir(home.join(".cache/node/corepack"), owner_uid) {
            capabilities
                .internal_env
                .insert("COREPACK_HOME".into(), path.to_string_lossy().into_owned());
            capabilities.read_roots.push(path);
        }
        if let Some(path) = trusted_dir(home.join(".cargo/registry"), owner_uid) {
            capabilities.read_roots.push(path);
        }
        if let Some(path) = trusted_dir(home.join(".cargo/git"), owner_uid) {
            capabilities.read_roots.push(path);
        }
        if let Some(toolchain) = active_rust_toolchain(&home, owner_uid) {
            capabilities.path_dirs.push(toolchain.join("bin"));
            capabilities.exec_roots.push(toolchain.clone());
            capabilities.read_roots.push(toolchain);
        }
        // CARGO_HOME is useful for registry lookup, but the sandbox grants no
        // read access to credentials/config files in that directory.
        capabilities.internal_env.insert(
            "CARGO_HOME".into(),
            home.join(".cargo").to_string_lossy().into_owned(),
        );
    }
    capabilities
        .internal_env
        .insert("CARGO_NET_OFFLINE".into(), "true".into());
    capabilities
        .internal_env
        .insert("COREPACK_ENABLE_DOWNLOAD_PROMPT".into(), "0".into());
    capabilities
        .internal_env
        .insert("COREPACK_ENABLE_NETWORK".into(), "0".into());

    let mut read_seen = HashSet::new();
    capabilities
        .read_roots
        .retain(|path| read_seen.insert(path.clone()));
    let mut exec_seen = HashSet::new();
    capabilities
        .exec_roots
        .retain(|path| exec_seen.insert(path.clone()));
    capabilities.path_dirs.retain(|path| path.is_dir());
    let mut path_seen = HashSet::new();
    capabilities
        .path_dirs
        .retain(|path| path_seen.insert(path.clone()));
    if capabilities.read_roots.len() > MAX_SANDBOX_READ_ROOTS
        || capabilities.exec_roots.len() > MAX_SANDBOX_READ_ROOTS
    {
        return Err("refused: sandbox read capability cap is exceeded".into());
    }
    Ok(capabilities)
}

#[cfg(target_os = "macos")]
fn verify_sandbox_exec() -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;

    let metadata = fs::symlink_metadata(SANDBOX_EXEC)
        .map_err(|_| "refused: the macOS process sandbox is unavailable".to_string())?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.uid() != 0
        || metadata.mode() & 0o022 != 0
    {
        return Err("refused: the macOS process sandbox is not a trusted system binary".into());
    }
    Ok(())
}

fn runtime_private_dirs(root: &Path) -> Result<(PathBuf, PathBuf), String> {
    let state = root.join(".swarmz").join("runtime-process");
    let home = state.join("home");
    let tmp = state.join("tmp");
    fs::create_dir_all(&home)
        .and_then(|_| fs::create_dir_all(&tmp))
        .map_err(|error| format!("could not create confined runtime state: {error}"))?;
    let home = fs::canonicalize(home)
        .map_err(|_| "refused: runtime HOME could not be confined".to_string())?;
    let tmp = fs::canonicalize(tmp)
        .map_err(|_| "refused: runtime TMPDIR could not be confined".to_string())?;
    if !home.starts_with(root) || !tmp.starts_with(root) {
        return Err("refused: runtime state escapes the worktree".into());
    }
    Ok((home, tmp))
}

pub(super) fn prepare_command(
    root: &Path,
    cwd: &Path,
    main_root: &Path,
    argv: &[String],
    env: &BTreeMap<String, String>,
    allow_loopback: bool,
) -> Result<PreparedCommand, String> {
    validate_argv(argv)?;
    validate_env(env)?;
    let (runtime_home, runtime_tmp) = runtime_private_dirs(root)?;
    #[cfg(target_os = "macos")]
    verify_sandbox_exec()?;
    #[cfg(target_os = "macos")]
    let capabilities = sandbox_capabilities(main_root)?;

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new(SANDBOX_EXEC);
        command
            .arg("-D")
            .arg(format!("SWARMZ_ROOT={}", root.to_string_lossy()));
        for index in 0..MAX_SANDBOX_READ_ROOTS {
            let read_path: &Path = capabilities
                .read_roots
                .get(index)
                .map(PathBuf::as_path)
                .unwrap_or(root);
            let exec_path: &Path = capabilities
                .exec_roots
                .get(index)
                .map(PathBuf::as_path)
                .unwrap_or(root);
            command
                .arg("-D")
                .arg(format!(
                    "SWARMZ_READ_{index}={}",
                    read_path.to_string_lossy()
                ))
                .arg("-D")
                .arg(format!(
                    "SWARMZ_EXEC_{index}={}",
                    exec_path.to_string_lossy()
                ));
        }
        command
            .arg("-p")
            .arg(sandbox_profile(allow_loopback))
            .arg("--")
            .args(argv);
        command
    };
    #[cfg(not(target_os = "macos"))]
    let mut command = {
        let _ = (
            main_root,
            allow_loopback,
            argv,
            env,
            runtime_home,
            runtime_tmp,
        );
        return Err(
            "refused: Runtime Environments require the native macOS process sandbox".into(),
        );
    };

    command
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut path_entries: Vec<String> = capabilities
        .path_dirs
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    path_entries.extend(
        [
            "/opt/homebrew/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]
        .into_iter()
        .map(str::to_string),
    );
    command
        .env("PATH", path_entries.join(":"))
        .env("HOME", &runtime_home)
        .env("TMPDIR", &runtime_tmp)
        .env("LANG", "C.UTF-8")
        .env("LC_ALL", "C");
    command.envs(env);
    command.envs(capabilities.internal_env);
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        use std::os::unix::process::CommandExt;
        let cwd_handle = open_cwd(cwd)?;
        let cwd_fd = cwd_handle.as_raw_fd();
        unsafe {
            command.pre_exec(move || {
                if libc::setsid() < 0 || libc::fchdir(cwd_fd) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        Ok(PreparedCommand {
            command,
            cwd_handle,
        })
    }
    #[cfg(not(unix))]
    {
        command.current_dir(cwd);
        Ok(PreparedCommand { command })
    }
}

pub(crate) fn spawn_sandboxed_process(
    root: &Path,
    cwd: &Path,
    main_root: &Path,
    argv: &[String],
    env: &BTreeMap<String, String>,
    allow_loopback: bool,
) -> Result<std::process::Child, String> {
    let mut prepared = prepare_command(root, cwd, main_root, argv, env, allow_loopback)?;
    let child = prepared
        .command
        .spawn()
        .map_err(|error| format!("could not start sandboxed process: {error}"))?;
    #[cfg(unix)]
    drop(prepared.cwd_handle);
    Ok(child)
}

pub fn command_run(request: RuntimeCommandRequest) -> Result<RuntimeCommandResult, String> {
    let (root, cwd) = confined_cwd(&request.project_root, &request.cwd_relative)?;
    if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&request.timeout_ms)
        || !(MIN_OUTPUT_BYTES..=MAX_OUTPUT_BYTES).contains(&request.max_output_bytes)
    {
        return Err("refused: runtime timeout or output limit is outside the allowed range".into());
    }
    let (env, secrets) = resolved_env(&request.env, &request.secret_bindings)?;
    let (cancel, _active_guard) = register_command(&request.run_id)?;
    // One-shot setup/cleanup commands have no network authority. Only owned
    // background services receive the explicit loopback-only exception.
    let main_root = fs::canonicalize(&request.main_root)
        .map_err(|_| "refused: runtime main root does not exist".to_string())?;
    if !main_root.is_dir() || (!root.starts_with(&main_root) && root != main_root) {
        return Err("refused: runtime worktree is outside its owner main root".into());
    }
    let mut child = spawn_sandboxed_process(&root, &cwd, &main_root, &request.argv, &env, false)?;
    let started = Instant::now();
    let stdout = drain_bounded(child.stdout.take(), request.max_output_bytes);
    let stderr = drain_bounded(child.stderr.take(), request.max_output_bytes);
    let deadline = started + Duration::from_millis(request.timeout_ms);
    let (status, exit): (RuntimeCommandStatus, Option<ExitStatus>) = loop {
        if cancel.load(Ordering::Acquire) {
            kill_group(&mut child);
            break (RuntimeCommandStatus::Cancelled, None);
        }
        if let Some(exit) = child
            .try_wait()
            .map_err(|error| format!("could not observe runtime command: {error}"))?
        {
            break (RuntimeCommandStatus::Completed, Some(exit));
        }
        if Instant::now() >= deadline {
            kill_group(&mut child);
            break (RuntimeCommandStatus::TimedOut, None);
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let grace = Instant::now() + Duration::from_secs(1);
    while (Arc::strong_count(&stdout) > 1 || Arc::strong_count(&stderr) > 1)
        && Instant::now() < grace
    {
        std::thread::sleep(Duration::from_millis(5));
    }
    let (stdout, stdout_truncated) = capture_text(&stdout, &secrets);
    let (stderr, stderr_truncated) = capture_text(&stderr, &secrets);
    Ok(RuntimeCommandResult {
        status,
        exit_code: exit.and_then(|value| value.code()),
        duration_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        stdout,
        stderr,
        stdout_truncated,
        stderr_truncated,
    })
}
