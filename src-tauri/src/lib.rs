mod git;
mod limits;
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
fn usage_for_session(
    cwd: String,
    since: f64,
    session: Option<String>,
    exclude: Option<Vec<String>>,
) -> Option<SessionUsage> {
    usage::usage_for_session(
        &cwd,
        since as u64,
        session.as_deref(),
        exclude.as_deref().unwrap_or(&[]),
    )
}

#[tauri::command]
fn usage_totals() -> UsageTotals {
    usage::usage_totals()
}

#[tauri::command]
async fn subscription_limits() -> Result<Option<limits::SubscriptionLimits>, String> {
    limits::fetch_limits().await
}

#[tauri::command]
async fn git_info(cwd: String, bin: Option<String>) -> Option<git::GitInfo> {
    // subprocess work — keep it off the async runtime's core threads
    tauri::async_runtime::spawn_blocking(move || git::git_info(&cwd, bin.as_deref()))
        .await
        .ok()
        .flatten()
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
        // keep the debouncer alive for the lifetime of this thread.
        // Emit the *project dir names* that changed so the frontend can skip
        // refreshes for sessions it isn't displaying (an empty list means
        // "unknown / everything", e.g. after a pricing refresh).
        for res in rx {
            if let Ok(events) = res {
                let mut dirs: Vec<String> = events
                    .iter()
                    .filter_map(|e| {
                        e.path
                            .strip_prefix(&dir)
                            .ok()?
                            .components()
                            .next()
                            .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    })
                    .collect();
                dirs.sort();
                dirs.dedup();
                if !dirs.is_empty() {
                    let _ = app.emit("usage://changed", dirs);
                }
            }
        }
        drop(debouncer);
    });
}

/// Pull live model pricing once per run; retry while offline, refresh daily.
fn start_pricing_refresher(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let delay = if usage::refresh_pricing().await {
                // empty list = "everything changed" (all costs were repriced)
                let _ = app.emit("usage://changed", Vec::<String>::new());
                std::time::Duration::from_secs(24 * 60 * 60)
            } else {
                std::time::Duration::from_secs(5 * 60)
            };
            tokio::time::sleep(delay).await;
        }
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // remember window size/position/maximized across restarts
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(manager.clone())
        .setup(move |app| {
            start_usage_watcher(app.handle().clone());
            start_pricing_refresher(app.handle().clone());
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
            subscription_limits,
            git_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
