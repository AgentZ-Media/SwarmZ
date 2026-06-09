mod pty;
mod usage;

use notify::RecursiveMode;
use notify_debouncer_mini::new_debouncer;
use pty::{PtyManager, SharedPtyManager};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use usage::{SessionUsage, UsageTotals};

#[tauri::command]
fn pty_spawn(
    app: AppHandle,
    state: State<'_, SharedPtyManager>,
    id: String,
    cwd: Option<String>,
    startup: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.spawn(app, id, cwd, startup, cols, rows)
}

#[tauri::command]
fn pty_write(state: State<'_, SharedPtyManager>, id: String, data: String) -> Result<(), String> {
    state.write(&id, &data)
}

#[tauri::command]
fn pty_resize(
    state: State<'_, SharedPtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.resize(&id, cols, rows)
}

#[tauri::command]
fn pty_kill(state: State<'_, SharedPtyManager>, id: String) -> Result<(), String> {
    state.kill(&id)
}

#[tauri::command]
fn usage_for_dir(cwd: String) -> Option<SessionUsage> {
    usage::usage_for_dir(&cwd)
}

#[tauri::command]
fn usage_for_session(cwd: String, since: f64, session: Option<String>) -> Option<SessionUsage> {
    usage::usage_for_session(&cwd, since as u64, session.as_deref())
}

#[tauri::command]
fn usage_totals() -> UsageTotals {
    usage::usage_totals()
}

fn start_usage_watcher(app: AppHandle) {
    let dir = match usage::claude_projects_dir() {
        Some(d) if d.exists() => d,
        _ => return,
    };
    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut debouncer = match new_debouncer(Duration::from_millis(600), tx) {
            Ok(d) => d,
            Err(_) => return,
        };
        if debouncer
            .watcher()
            .watch(&dir, RecursiveMode::Recursive)
            .is_err()
        {
            return;
        }
        // keep the debouncer alive for the lifetime of this thread
        for res in rx {
            if res.is_ok() {
                let _ = app.emit("usage://changed", ());
            }
        }
        drop(debouncer);
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let manager: SharedPtyManager = Arc::new(PtyManager::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(manager.clone())
        .setup(move |app| {
            start_usage_watcher(app.handle().clone());
            Ok(())
        })
        .on_window_event(move |_window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                manager.kill_all();
            }
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            usage_for_dir,
            usage_for_session,
            usage_totals,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
