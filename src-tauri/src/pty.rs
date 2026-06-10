use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use parking_lot::Mutex;
use portable_pty::{Child, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Emitter};

type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

/// A single live PTY-backed terminal session.
struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: SharedWriter,
    child: Box<dyn Child + Send + Sync>,
    /// pid of the spawned shell — used for the has-children check
    pid: Option<u32>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
}

#[derive(Clone, Serialize)]
struct PtyDataPayload {
    id: String,
    /// base64-encoded raw bytes from the pty
    data: String,
}

#[derive(Clone, Serialize)]
struct PtyExitPayload {
    id: String,
}

impl PtyManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Spawn a login shell in a fresh PTY. `startup` (if any) is typed into the
    /// shell after launch — e.g. `claude --dangerously-skip-permissions`.
    pub fn spawn(
        &self,
        app: AppHandle,
        id: String,
        cwd: Option<String>,
        startup: Option<String>,
        cols: u16,
        rows: u16,
    ) -> Result<(), String> {
        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        // Use the user's login shell so PATH / nvm / etc. resolve exactly like a
        // normal terminal (important when the app is launched from Finder).
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut cmd = CommandBuilder::new(&shell);
        cmd.arg("-i");
        cmd.arg("-l");
        if let Some(dir) = cwd.as_ref().filter(|d| !d.is_empty()) {
            cmd.cwd(dir);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("SWARMZ", "1");
        // Claude Code only emits OSC 9;4 progress (busy/idle, shown as the
        // pane status dot) for terminals it recognizes as supporting it. The
        // ConEmu marker is the least invasive way to opt in — nothing else on
        // macOS reads it, unlike TERM_PROGRAM which changes other behaviors.
        cmd.env("ConEmuANSI", "ON");

        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        // Slave is held by the child; drop our handle so EOF propagates on exit.
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer: SharedWriter =
            Arc::new(Mutex::new(pair.master.take_writer().map_err(|e| e.to_string())?));

        // Type the startup command into the shell once the prompt is ready.
        // `clear` wipes the screen + scrollback so the pane boots straight into
        // the program (no shell prompt / typed-command echo left visible).
        if let Some(line) = startup.filter(|s| !s.trim().is_empty()) {
            let w = Arc::clone(&writer);
            let line = format!("clear; {}\r", line);
            thread::spawn(move || {
                thread::sleep(std::time::Duration::from_millis(700));
                let mut guard = w.lock();
                let _ = guard.write_all(line.as_bytes());
                let _ = guard.flush();
            });
        }

        let pid = child.process_id();
        let session = PtySession {
            master: pair.master,
            writer,
            child,
            pid,
        };
        self.sessions.lock().insert(id.clone(), session);

        // Reader thread streams raw bytes into a channel; the emitter thread
        // coalesces bursts (≤12 ms / 128 KiB) into one IPC event so the webview
        // isn't woken for every 8 KiB chunk a TUI redraw produces. Events are
        // addressed per agent (`pty://data/<id>`) so only the owning terminal's
        // listener fires instead of every pane filtering a global stream.
        let app_for_reader = app.clone();
        let read_id = id.clone();
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            // dropping tx disconnects the channel → emitter flushes and exits
        });
        thread::spawn(move || {
            use std::sync::mpsc::RecvTimeoutError;
            use std::time::{Duration, Instant};
            let data_event = format!("pty://data/{}", read_id);
            while let Ok(first) = rx.recv() {
                let mut chunk = first;
                let deadline = Instant::now() + Duration::from_millis(12);
                while chunk.len() < 128 * 1024 {
                    let now = Instant::now();
                    if now >= deadline {
                        break;
                    }
                    match rx.recv_timeout(deadline - now) {
                        Ok(more) => chunk.extend_from_slice(&more),
                        Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => break,
                    }
                }
                let payload = PtyDataPayload {
                    id: read_id.clone(),
                    data: B64.encode(&chunk),
                };
                let _ = app_for_reader.emit(&data_event, payload);
            }
            let _ = app_for_reader.emit(
                &format!("pty://exit/{}", read_id),
                PtyExitPayload { id: read_id },
            );
        });

        Ok(())
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let guard = self.sessions.lock();
        let session = guard.get(id).ok_or("no such session")?;
        let mut w = session.writer.lock();
        w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let guard = self.sessions.lock();
        let session = guard.get(id).ok_or("no such session")?;
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    }

    /// True when the session's shell has at least one child process — i.e.
    /// something (dev server, build, …) is still running in this terminal.
    /// Unknown sessions and failed checks report false.
    /// Keep in sync with `/api/pty/has-children` in `server/index.mjs`.
    pub fn has_children(&self, id: &str) -> bool {
        let pid = match self.sessions.lock().get(id).and_then(|s| s.pid) {
            Some(p) => p,
            None => return false,
        };
        std::process::Command::new("pgrep")
            .arg("-P")
            .arg(pid.to_string())
            .output()
            .map(|o| o.status.success() && !o.stdout.is_empty())
            .unwrap_or(false)
    }

    pub fn kill(&self, id: &str) -> Result<(), String> {
        let mut guard = self.sessions.lock();
        if let Some(mut session) = guard.remove(id) {
            let _ = session.child.kill();
        }
        Ok(())
    }

    pub fn kill_all(&self) {
        let mut guard = self.sessions.lock();
        for (_, mut session) in guard.drain() {
            let _ = session.child.kill();
        }
    }
}

pub type SharedPtyManager = Arc<PtyManager>;
