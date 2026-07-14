//! Shared filesystem hardening helpers (security audit R3/R4/R5).
//!
//! Two families live here:
//!
//! 1. **Path containment** (`fold_absolute`, `canonicalize_lenient`,
//!    `path_within`) — the fail-closed "is this path strictly inside that
//!    root after full symlink/`..` resolution?" check the approval
//!    classifier, the worktree confinement and the operand gates share.
//!    Any doubt (relative path, traversal, broken link, IO error) → `false`.
//!
//! 2. **Anchored no-follow directory handles** (`DirHandle`, unix-only) —
//!    open a directory chain component by component with
//!    `O_NOFOLLOW | O_DIRECTORY` and operate via the `*at` syscalls on the
//!    anchored fd. A path-based re-open ("check `.swarmz` is no symlink,
//!    then open `.swarmz/plans/x.md`") leaves a TOCTOU window in which an
//!    agent can swap an intermediate component for a symlink; the anchored
//!    handle closes that window: once a component is opened no-follow, every
//!    later operation goes through ITS fd, so a swapped path element on disk
//!    can no longer redirect the operation.

use std::path::{Path, PathBuf};

use once_cell::sync::Lazy;
use parking_lot::Mutex;

/// Serializes the repo-local `.git/info/exclude` read-modify-write inside
/// this process. The file lock inside `ensure_git_exclude` also coordinates
/// multiple SwarmZ processes.
static GIT_EXCLUDE_LOCK: Lazy<Mutex<()>> = Lazy::new(Mutex::default);

/// Shared, anchored manager for SwarmZ's repo-local exclude entries. Callers
/// provide accepted spellings and the canonical block to append. The update
/// is bounded, no-follow, cross-process locked and atomic, so worktree and
/// plan writers cannot race and overwrite each other's rule.
pub(crate) fn ensure_git_exclude(
    root: &Path,
    accepted: &[&str],
    block: &str,
) -> Result<(), String> {
    use std::io::{Read as _, Write as _};
    use std::os::fd::AsRawFd as _;

    let _process_guard = GIT_EXCLUDE_LOCK.lock();
    let root = DirHandle::open_root(root)?;
    let git = root
        .open_dir(".git")
        .map_err(|e| format!("refusing the .git component (symlink?): {e}"))?;
    let info = git
        .ensure_dir("info")
        .map_err(|e| format!("refusing the .git/info component (symlink?): {e}"))?;

    let lock_name = ".swarmz-exclude.lock";
    let lock_file = match info.open_file(lock_name) {
        Ok(Some(file)) => file,
        Ok(None) => match info.create_new(lock_name) {
            Ok(file) => file,
            Err(_) => info
                .open_file(lock_name)?
                .ok_or("could not establish git-exclude lock file")?,
        },
        Err(e) => return Err(format!("refusing git-exclude lock file: {e}")),
    };
    let locked = unsafe { libc::flock(lock_file.as_raw_fd(), libc::LOCK_EX) };
    if locked != 0 {
        return Err(format!(
            "could not lock .git/info/exclude: {}",
            std::io::Error::last_os_error()
        ));
    }

    const EXCLUDE_CAP: u64 = 1024 * 1024;
    let (current, oversized) = match info.open_file("exclude") {
        Ok(Some(file)) => {
            let mut s = String::new();
            let read = file
                .take(EXCLUDE_CAP + 1)
                .read_to_string(&mut s)
                .map_err(|e| e.to_string())?;
            (s, read as u64 > EXCLUDE_CAP)
        }
        Ok(None) => (String::new(), false),
        Err(e) => return Err(format!("refusing the exclude file (symlink?): {e}")),
    };
    if current.lines().any(|line| accepted.contains(&line.trim())) {
        return Ok(());
    }
    if oversized {
        return Err(format!(
            ".git/info/exclude is larger than {EXCLUDE_CAP} bytes — refusing to rewrite it"
        ));
    }

    let mut next = current;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(block);
    if !next.ends_with('\n') {
        next.push('\n');
    }
    let tmp_name = format!(
        ".exclude.tmp-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let mut tmp = info.create_new(&tmp_name)?;
    if let Err(e) = tmp.write_all(next.as_bytes()) {
        let _ = info.unlink(&tmp_name);
        return Err(e.to_string());
    }
    drop(tmp);
    if let Err(e) = info.rename(&tmp_name, "exclude") {
        let _ = info.unlink(&tmp_name);
        return Err(e);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Path containment (fail closed)
// ---------------------------------------------------------------------------

/// Lexically fold an ABSOLUTE path: `.` drops, any `..` component or a
/// relative path returns None — traversal is never resolved lexically.
pub(crate) fn fold_absolute(p: &Path) -> Option<PathBuf> {
    use std::path::Component;
    let mut out = PathBuf::new();
    let mut seen_root = false;
    for c in p.components() {
        match c {
            Component::RootDir => {
                out.push("/");
                seen_root = true;
            }
            Component::Prefix(_) | Component::ParentDir => return None,
            Component::CurDir => {}
            Component::Normal(n) => out.push(n),
        }
    }
    if seen_root && out.as_os_str().len() > 1 {
        Some(out)
    } else {
        None
    }
}

/// Canonicalize with a missing leaf allowed: an EXISTING path (including a
/// symlink leaf) must fully resolve; for a missing leaf the deepest existing
/// ancestor is canonicalized (resolving symlink chains) and the missing
/// remainder re-appended. A broken symlink anywhere, `..`, a relative path or
/// IO doubt → None (fail closed).
pub(crate) fn canonicalize_lenient(p: &Path) -> Option<PathBuf> {
    let folded = fold_absolute(p)?;
    // an existing leaf (file, dir or symlink) must RESOLVE — a broken symlink
    // fails canonicalize and correctly classifies as unsafe
    if folded.symlink_metadata().is_ok() {
        return folded.canonicalize().ok();
    }
    // missing leaf: climb to the deepest existing ancestor
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = folded.as_path();
    loop {
        let parent = cur.parent()?;
        rest.push(cur.file_name()?.to_os_string());
        if parent.symlink_metadata().is_ok() {
            let base = parent.canonicalize().ok()?;
            let mut out = base;
            for seg in rest.iter().rev() {
                out.push(seg);
            }
            return Some(out);
        }
        cur = parent;
    }
}

/// Is `target` inside `root` (or equal to it) after full symlink/`..`
/// resolution? Any doubt (relative paths, traversal, broken links, IO
/// errors) → false.
pub(crate) fn path_within(root: &str, target: &str) -> bool {
    let root = root.trim();
    let target = target.trim();
    if root.is_empty() || target.is_empty() {
        return false;
    }
    let (Some(r), Some(t)) = (
        canonicalize_lenient(Path::new(root)),
        canonicalize_lenient(Path::new(target)),
    ) else {
        return false;
    };
    t.starts_with(&r)
}

/// Like `path_within`, but STRICT: `target` must be inside `root` and not
/// `root` itself (the worktree-removal confinement — the `.worktrees` folder
/// itself is never a removable worktree).
pub(crate) fn path_strictly_within(root: &str, target: &str) -> bool {
    let root = root.trim();
    let target = target.trim();
    if root.is_empty() || target.is_empty() {
        return false;
    }
    let (Some(r), Some(t)) = (
        canonicalize_lenient(Path::new(root)),
        canonicalize_lenient(Path::new(target)),
    ) else {
        return false;
    };
    t.starts_with(&r) && t != r
}

// ---------------------------------------------------------------------------
// Anchored no-follow directory handles (unix)
// ---------------------------------------------------------------------------

#[cfg(unix)]
mod anchored {
    use std::ffi::CString;
    use std::fs::File;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::path::Path;

    /// A directory opened `O_DIRECTORY | O_CLOEXEC` (and, for every non-root
    /// component, `O_NOFOLLOW`). All operations go through the fd — the path
    /// on disk can change under us without redirecting anything.
    pub struct DirHandle {
        fd: OwnedFd,
    }

    fn cstr(name: &str) -> Result<CString, String> {
        CString::new(name).map_err(|_| format!("path component contains NUL: {name:?}"))
    }

    /// A single path component only — no separators, no traversal. Everything
    /// this module opens relative to a handle must be one hop deep.
    fn assert_component(name: &str) -> Result<(), String> {
        if name.is_empty() || name == "." || name == ".." || name.contains('/') {
            return Err(format!("invalid path component {name:?}"));
        }
        Ok(())
    }

    impl DirHandle {
        /// Open a TRUSTED root directory (absolute path; symlinks in the root
        /// itself are allowed — the root comes from a trusted record, and
        /// canonical roots are symlink-free anyway).
        pub fn open_root(path: &Path) -> Result<DirHandle, String> {
            let c = cstr(&path.to_string_lossy())?;
            let fd = unsafe {
                libc::open(
                    c.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                return Err(format!(
                    "could not open directory {}: {}",
                    path.display(),
                    std::io::Error::last_os_error()
                ));
            }
            Ok(DirHandle {
                fd: unsafe { OwnedFd::from_raw_fd(fd) },
            })
        }

        /// Open one child directory NO-FOLLOW — a symlink (or non-directory)
        /// at `name` refuses.
        pub fn open_dir(&self, name: &str) -> Result<DirHandle, String> {
            assert_component(name)?;
            let c = cstr(name)?;
            let fd = unsafe {
                libc::openat(
                    self.fd.as_raw_fd(),
                    c.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                return Err(format!(
                    "could not open directory component {name:?} (symlink or missing?): {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(DirHandle {
                fd: unsafe { OwnedFd::from_raw_fd(fd) },
            })
        }

        /// mkdir the child if missing (EEXIST is fine), then open it no-follow.
        pub fn ensure_dir(&self, name: &str) -> Result<DirHandle, String> {
            assert_component(name)?;
            let c = cstr(name)?;
            let rc = unsafe { libc::mkdirat(self.fd.as_raw_fd(), c.as_ptr(), 0o755) };
            if rc < 0 {
                let err = std::io::Error::last_os_error();
                if err.raw_os_error() != Some(libc::EEXIST) {
                    return Err(format!("could not create directory {name:?}: {err}"));
                }
            }
            self.open_dir(name)
        }

        /// lstat one child (never follows a symlink). None = missing.
        pub fn stat(&self, name: &str) -> Result<Option<libc::stat>, String> {
            assert_component(name)?;
            let c = cstr(name)?;
            let mut st: libc::stat = unsafe { std::mem::zeroed() };
            let rc = unsafe {
                libc::fstatat(
                    self.fd.as_raw_fd(),
                    c.as_ptr(),
                    &mut st,
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            };
            if rc < 0 {
                let err = std::io::Error::last_os_error();
                return if err.raw_os_error() == Some(libc::ENOENT) {
                    Ok(None)
                } else {
                    Err(format!("could not stat {name:?}: {err}"))
                };
            }
            Ok(Some(st))
        }

        /// Is the child present as a REGULAR file (no-follow)? Missing = Ok(None).
        pub fn is_regular_file(&self, name: &str) -> Result<Option<bool>, String> {
            Ok(self
                .stat(name)?
                .map(|st| (st.st_mode & libc::S_IFMT) == libc::S_IFREG))
        }

        /// Open one child for reading, NO-FOLLOW, and require a regular file.
        /// The open itself is `O_NONBLOCK` (final hardening F7): a race-swap
        /// to a FIFO between the pre-check and the open must not park the
        /// thread in a blocking `openat` — the FIFO opens instantly instead
        /// and the authoritative post-open `fstat` refuses it. For the
        /// regular file that passes, `O_NONBLOCK` is cleared again before
        /// the handle is returned (it has no read semantics on regular
        /// files, but callers get a plain blocking File either way).
        /// None = missing.
        pub fn open_file(&self, name: &str) -> Result<Option<File>, String> {
            assert_component(name)?;
            // pre-check for friendly errors/missing semantics — NOT the gate
            match self.is_regular_file(name)? {
                None => return Ok(None),
                Some(false) => return Err(format!("not a regular file (or a symlink): {name:?}")),
                Some(true) => {}
            }
            let c = cstr(name)?;
            let fd = unsafe {
                libc::openat(
                    self.fd.as_raw_fd(),
                    c.as_ptr(),
                    libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
                )
            };
            if fd < 0 {
                let err = std::io::Error::last_os_error();
                return if err.raw_os_error() == Some(libc::ENOENT) {
                    Ok(None) // vanished between stat and open — treat as missing
                } else {
                    Err(format!("could not open {name:?}: {err}"))
                };
            }
            let file = unsafe { File::from_raw_fd(fd) };
            // re-check ON THE OPEN FD — the authoritative no-TOCTOU answer
            let meta = file.metadata().map_err(|e| e.to_string())?;
            if !meta.is_file() {
                return Err(format!("not a regular file: {name:?}"));
            }
            // drop O_NONBLOCK for the returned handle
            unsafe {
                let flags = libc::fcntl(file.as_raw_fd(), libc::F_GETFL);
                if flags >= 0 {
                    let _ = libc::fcntl(file.as_raw_fd(), libc::F_SETFL, flags & !libc::O_NONBLOCK);
                }
            }
            Ok(Some(file))
        }

        /// Create one child EXCLUSIVELY for writing (fails when it exists —
        /// used for fresh temp files that a later `rename` moves into place).
        pub fn create_new(&self, name: &str) -> Result<File, String> {
            self.create_new_with_mode(name, 0o644)
        }

        /// Create one child exclusively with its FINAL initial Unix mode. This
        /// is required for secrets: creating 0644 and chmodding after the copy
        /// leaves a disclosure window and may stay open if chmod fails.
        pub fn create_new_with_mode(&self, name: &str, mode: u32) -> Result<File, String> {
            assert_component(name)?;
            let c = cstr(name)?;
            let fd = unsafe {
                libc::openat(
                    self.fd.as_raw_fd(),
                    c.as_ptr(),
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC,
                    mode as libc::c_uint,
                )
            };
            if fd < 0 {
                return Err(format!(
                    "could not create {name:?}: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(unsafe { File::from_raw_fd(fd) })
        }

        /// Atomically rename `from` → `to` WITHIN this directory (replaces a
        /// planted symlink at `to` instead of following it).
        pub fn rename(&self, from: &str, to: &str) -> Result<(), String> {
            assert_component(from)?;
            assert_component(to)?;
            let cf = cstr(from)?;
            let ct = cstr(to)?;
            let rc = unsafe {
                libc::renameat(
                    self.fd.as_raw_fd(),
                    cf.as_ptr(),
                    self.fd.as_raw_fd(),
                    ct.as_ptr(),
                )
            };
            if rc < 0 {
                return Err(format!(
                    "could not rename {from:?} → {to:?}: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(())
        }

        /// Remove one child file (best-effort callers ignore the result).
        pub fn unlink(&self, name: &str) -> Result<(), String> {
            assert_component(name)?;
            let c = cstr(name)?;
            let rc = unsafe { libc::unlinkat(self.fd.as_raw_fd(), c.as_ptr(), 0) };
            if rc < 0 {
                return Err(format!(
                    "could not remove {name:?}: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(())
        }

        /// Duplicate the handle (dup the fd) — lets callers walk component
        /// chains starting from a borrowed handle.
        pub fn try_clone(&self) -> Result<DirHandle, String> {
            self.fd
                .try_clone()
                .map(|fd| DirHandle { fd })
                .map_err(|e| format!("could not duplicate directory handle: {e}"))
        }

        /// The handle's own filesystem identity `(device, inode)` — the
        /// anchored truth a PATH-resolved view can be verified against
        /// (audit C7: same identity = the pathname still names this very
        /// directory).
        pub fn identity(&self) -> Result<(u64, u64), String> {
            let mut st: libc::stat = unsafe { std::mem::zeroed() };
            let rc = unsafe { libc::fstat(self.fd.as_raw_fd(), &mut st) };
            if rc < 0 {
                return Err(format!(
                    "could not stat directory handle: {}",
                    std::io::Error::last_os_error()
                ));
            }
            #[allow(clippy::unnecessary_cast)]
            Ok((st.st_dev as u64, st.st_ino as u64))
        }

        /// What is the child entry (lstat semantics — a symlink reports as
        /// Symlink, never followed)? None = missing.
        pub fn kind(&self, name: &str) -> Result<Option<super::EntryKind>, String> {
            Ok(self.stat(name)?.map(|st| match st.st_mode & libc::S_IFMT {
                libc::S_IFREG => super::EntryKind::File,
                libc::S_IFDIR => super::EntryKind::Dir,
                libc::S_IFLNK => super::EntryKind::Symlink,
                _ => super::EntryKind::Other,
            }))
        }

        /// Read one child SYMLINK's target string (readlinkat — nothing is
        /// followed). None = missing.
        #[allow(dead_code)]
        pub fn read_link(&self, name: &str) -> Result<Option<std::path::PathBuf>, String> {
            assert_component(name)?;
            let c = cstr(name)?;
            let mut buf = vec![0u8; libc::PATH_MAX as usize + 1];
            let n = unsafe {
                libc::readlinkat(
                    self.fd.as_raw_fd(),
                    c.as_ptr(),
                    buf.as_mut_ptr() as *mut libc::c_char,
                    buf.len(),
                )
            };
            if n < 0 {
                let err = std::io::Error::last_os_error();
                return if err.raw_os_error() == Some(libc::ENOENT) {
                    Ok(None)
                } else {
                    Err(format!("could not readlink {name:?}: {err}"))
                };
            }
            buf.truncate(n as usize);
            use std::os::unix::ffi::OsStringExt;
            Ok(Some(std::path::PathBuf::from(
                std::ffi::OsString::from_vec(buf),
            )))
        }

        /// Create one child as a SYMLINK to `target` (symlinkat; fails when
        /// the name already exists — never overwrites).
        #[allow(dead_code)]
        pub fn symlink(&self, target: &Path, name: &str) -> Result<(), String> {
            use std::os::unix::ffi::OsStrExt;
            assert_component(name)?;
            let c = cstr(name)?;
            let t = CString::new(target.as_os_str().as_bytes())
                .map_err(|_| format!("symlink target contains NUL: {}", target.display()))?;
            let rc = unsafe { libc::symlinkat(t.as_ptr(), self.fd.as_raw_fd(), c.as_ptr()) };
            if rc < 0 {
                return Err(format!(
                    "could not create symlink {name:?}: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(())
        }
    }
}

/// What a directory child is (lstat semantics — see `DirHandle::kind`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum EntryKind {
    File,
    Dir,
    Symlink,
    Other,
}

#[cfg(unix)]
pub(crate) use anchored::DirHandle;

/// Non-unix fallback: the same API, path-based with per-operation no-follow
/// checks (best effort — without `*at` syscalls the intermediate-component
/// TOCTOU cannot be fully closed; SwarmZ ships on macOS where the anchored
/// implementation above is used).
#[cfg(not(unix))]
mod anchored_fallback {
    use std::fs::{self, File};
    use std::path::{Path, PathBuf};

    pub struct DirHandle {
        path: PathBuf,
    }

    fn assert_component(name: &str) -> Result<(), String> {
        // ':' included: a `C:`-prefixed component would make `PathBuf::join`
        // DISCARD the base path on Windows (drive-prefix semantics)
        if name.is_empty()
            || name == "."
            || name == ".."
            || name.contains('/')
            || name.contains('\\')
            || name.contains(':')
        {
            return Err(format!("invalid path component {name:?}"));
        }
        Ok(())
    }

    fn refuse_symlink(p: &Path) -> Result<(), String> {
        match p.symlink_metadata() {
            Ok(m) if m.file_type().is_symlink() => {
                Err(format!("refusing to follow the symlink at {}", p.display()))
            }
            _ => Ok(()),
        }
    }

    impl DirHandle {
        pub fn open_root(path: &Path) -> Result<DirHandle, String> {
            if !path.is_dir() {
                return Err(format!("not a directory: {}", path.display()));
            }
            Ok(DirHandle {
                path: path.to_path_buf(),
            })
        }

        pub fn open_dir(&self, name: &str) -> Result<DirHandle, String> {
            assert_component(name)?;
            let p = self.path.join(name);
            refuse_symlink(&p)?;
            if !p.is_dir() {
                return Err(format!("not a directory: {}", p.display()));
            }
            Ok(DirHandle { path: p })
        }

        pub fn ensure_dir(&self, name: &str) -> Result<DirHandle, String> {
            assert_component(name)?;
            let p = self.path.join(name);
            refuse_symlink(&p)?;
            if !p.exists() {
                fs::create_dir(&p).map_err(|e| e.to_string())?;
            }
            self.open_dir(name)
        }

        pub fn is_regular_file(&self, name: &str) -> Result<Option<bool>, String> {
            assert_component(name)?;
            let p = self.path.join(name);
            match p.symlink_metadata() {
                Err(_) => Ok(None),
                Ok(m) => Ok(Some(m.is_file())),
            }
        }

        pub fn open_file(&self, name: &str) -> Result<Option<File>, String> {
            assert_component(name)?;
            match self.is_regular_file(name)? {
                None => Ok(None),
                Some(false) => Err(format!("not a regular file (or a symlink): {name:?}")),
                Some(true) => File::open(self.path.join(name))
                    .map(Some)
                    .map_err(|e| e.to_string()),
            }
        }

        pub fn create_new(&self, name: &str) -> Result<File, String> {
            assert_component(name)?;
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(self.path.join(name))
                .map_err(|e| e.to_string())
        }

        pub fn create_new_with_mode(&self, name: &str, _mode: u32) -> Result<File, String> {
            // SwarmZ ships on Unix/macOS. Non-Unix platforms have no portable
            // Unix permission mode; retain exclusive no-overwrite semantics.
            self.create_new(name)
        }

        pub fn rename(&self, from: &str, to: &str) -> Result<(), String> {
            assert_component(from)?;
            assert_component(to)?;
            fs::rename(self.path.join(from), self.path.join(to)).map_err(|e| e.to_string())
        }

        pub fn unlink(&self, name: &str) -> Result<(), String> {
            assert_component(name)?;
            fs::remove_file(self.path.join(name)).map_err(|e| e.to_string())
        }

        pub fn try_clone(&self) -> Result<DirHandle, String> {
            Ok(DirHandle {
                path: self.path.clone(),
            })
        }

        pub fn identity(&self) -> Result<(u64, u64), String> {
            Err("directory identity is not supported on this platform".into())
        }

        pub fn kind(&self, name: &str) -> Result<Option<super::EntryKind>, String> {
            assert_component(name)?;
            match self.path.join(name).symlink_metadata() {
                Err(_) => Ok(None),
                Ok(m) => Ok(Some(if m.file_type().is_symlink() {
                    super::EntryKind::Symlink
                } else if m.is_file() {
                    super::EntryKind::File
                } else if m.is_dir() {
                    super::EntryKind::Dir
                } else {
                    super::EntryKind::Other
                })),
            }
        }

        #[allow(dead_code)]
        pub fn read_link(&self, name: &str) -> Result<Option<PathBuf>, String> {
            assert_component(name)?;
            match fs::read_link(self.path.join(name)) {
                Ok(t) => Ok(Some(t)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(e.to_string()),
            }
        }

        #[allow(dead_code)]
        pub fn symlink(&self, _target: &Path, _name: &str) -> Result<(), String> {
            Err("symlink creation is not supported on this platform".into())
        }
    }
}

#[cfg(not(unix))]
pub(crate) use anchored_fallback::DirHandle;

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::{Read, Write};

    fn temp_dir() -> PathBuf {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "swarmz-fsx-test-{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        ));
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn path_within_resolves_and_fails_closed() {
        assert!(path_within("/repo/wt", "/repo/wt/src/a.rs"));
        assert!(path_within("/repo/wt", "/repo/wt"));
        assert!(!path_within("/repo/wt", "/repo/wt2/a.rs"));
        assert!(!path_within("/repo/wt", "/repo/wt/../../etc/passwd"));
        assert!(!path_within("/repo/wt", "/etc/hosts"));
        assert!(!path_within("/repo/wt", "relative/path"));
        assert!(!path_within("", "/x"));
        assert!(!path_within("/repo/wt", ""));
        // strict: the root itself does not count
        assert!(path_strictly_within("/repo/wt", "/repo/wt/sub"));
        assert!(!path_strictly_within("/repo/wt", "/repo/wt"));
        assert!(!path_strictly_within("/repo/wt", "/repo"));
        // symlinked roots resolve consistently (macOS /tmp → /private/tmp)
        let tmp = std::env::temp_dir();
        let real = tmp.canonicalize().unwrap();
        assert!(path_within(
            &tmp.to_string_lossy(),
            &real.join("x").to_string_lossy()
        ));
    }

    #[test]
    fn git_exclude_manager_preserves_concurrent_swarmz_rules() {
        let root = temp_dir();
        fs::create_dir_all(root.join(".git/info")).unwrap();
        let a = root.clone();
        let b = root.clone();
        let one = std::thread::spawn(move || {
            ensure_git_exclude(&a, &["/.worktrees/"], "# worktrees\n/.worktrees/")
        });
        let two = std::thread::spawn(move || {
            ensure_git_exclude(&b, &["/.swarmz/"], "# plans\n/.swarmz/")
        });
        one.join().unwrap().unwrap();
        two.join().unwrap().unwrap();
        let exclude = fs::read_to_string(root.join(".git/info/exclude")).unwrap();
        assert!(exclude.contains("/.worktrees/"), "{exclude}");
        assert!(exclude.contains("/.swarmz/"), "{exclude}");
        fs::remove_dir_all(root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn create_new_with_mode_is_private_from_first_open() {
        use std::os::unix::fs::PermissionsExt as _;

        let root = temp_dir();
        let handle = DirHandle::open_root(&root).unwrap();
        let file = handle.create_new_with_mode("secret.env", 0o600).unwrap();
        assert_eq!(file.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        drop(file);
        fs::remove_dir_all(root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn dir_handle_refuses_symlinked_components_and_leaves() {
        let root = temp_dir();
        let outside = temp_dir();
        fs::write(outside.join("victim.txt"), "secret").unwrap();

        // regular chain works
        fs::create_dir_all(root.join("a/b")).unwrap();
        fs::write(root.join("a/b/f.md"), "hello").unwrap();
        let h = DirHandle::open_root(&root).unwrap();
        let a = h.open_dir("a").unwrap();
        let b = a.open_dir("b").unwrap();
        let mut s = String::new();
        b.open_file("f.md")
            .unwrap()
            .unwrap()
            .read_to_string(&mut s)
            .unwrap();
        assert_eq!(s, "hello");

        // symlinked INTERMEDIATE component refuses
        std::os::unix::fs::symlink(&outside, root.join("evil")).unwrap();
        assert!(h.open_dir("evil").is_err());
        assert!(h.ensure_dir("evil").is_err());

        // symlinked LEAF refuses (read + create paths)
        std::os::unix::fs::symlink(outside.join("victim.txt"), root.join("a/b/link.md")).unwrap();
        assert!(b.open_file("link.md").is_err());
        assert_eq!(b.is_regular_file("link.md").unwrap(), Some(false));
        // rename over a planted symlink REPLACES it, never follows
        let mut tmp = b.create_new(".t.tmp").unwrap();
        tmp.write_all(b"safe").unwrap();
        drop(tmp);
        b.rename(".t.tmp", "link.md").unwrap();
        assert_eq!(
            fs::read_to_string(root.join("a/b/link.md")).unwrap(),
            "safe"
        );
        assert_eq!(
            fs::read_to_string(outside.join("victim.txt")).unwrap(),
            "secret"
        );

        // traversal components are rejected outright
        assert!(h.open_dir("..").is_err());
        assert!(h.open_file("a/b").is_err());
        assert!(b.unlink("link.md").is_ok());

        // FIFO with a safe name is refused before any open can hang
        let fifo = root.join("a/b/pipe.md");
        let c = std::ffi::CString::new(fifo.to_string_lossy().as_bytes()).unwrap();
        unsafe { libc::mkfifo(c.as_ptr(), 0o644) };
        assert!(b.open_file("pipe.md").is_err());

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[cfg(unix)]
    #[test]
    fn dir_handle_ensure_and_missing_semantics() {
        let root = temp_dir();
        let h = DirHandle::open_root(&root).unwrap();
        // ensure_dir creates once, then reopens
        let d1 = h.ensure_dir("x").unwrap();
        let _d2 = h.ensure_dir("x").unwrap();
        assert!(d1.open_file("missing.md").unwrap().is_none());
        assert!(d1.stat("missing.md").unwrap().is_none());
        // create_new is exclusive
        drop(d1.create_new("f").unwrap());
        assert!(d1.create_new("f").is_err());
        fs::remove_dir_all(&root).ok();
    }
}
