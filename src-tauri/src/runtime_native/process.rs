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
                "BASH_ENV" | "ENV" | "NODE_OPTIONS" | "PYTHONPATH" | "RUSTC_WRAPPER"
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

pub(super) fn prepare_command(
    cwd: &Path,
    argv: &[String],
    env: &BTreeMap<String, String>,
) -> Result<PreparedCommand, String> {
    validate_argv(argv)?;
    let mut command = Command::new(&argv[0]);
    command
        .args(&argv[1..])
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for key in ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "CODEX_HOME"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command.envs(env);
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

pub fn command_run(request: RuntimeCommandRequest) -> Result<RuntimeCommandResult, String> {
    let (_root, cwd) = confined_cwd(&request.project_root, &request.cwd_relative)?;
    if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&request.timeout_ms)
        || !(MIN_OUTPUT_BYTES..=MAX_OUTPUT_BYTES).contains(&request.max_output_bytes)
    {
        return Err("refused: runtime timeout or output limit is outside the allowed range".into());
    }
    let (env, secrets) = resolved_env(&request.env, &request.secret_bindings)?;
    let (cancel, _active_guard) = register_command(&request.run_id)?;
    let mut prepared = prepare_command(&cwd, &request.argv, &env)?;
    let started = Instant::now();
    let mut child = prepared
        .command
        .spawn()
        .map_err(|error| format!("could not start runtime command: {error}"))?;
    #[cfg(unix)]
    drop(prepared.cwd_handle);
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
