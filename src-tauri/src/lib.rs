mod codex;
mod codex_usage;
mod fsx;
mod git;
mod github;
mod orchestrator;
mod plans;
mod projects;
mod storefile;
mod transcript;
mod worktree;

use tauri::{AppHandle, Emitter, Manager};

// The pre-rebuild per-session usage commands (usage_for_dir/_session/_totals)
// are GONE (audit R13): session accounting mirrors codex `token_usage`
// events frontend-side, so they had no caller left.

/// Account-level Codex rate limits: the newest `rate_limits` event across all
/// of `~/.codex/sessions` (bounded tail reads, newest file first — see
/// `codex_usage::account_limits`). `limits: null` = no data ever seen.
#[tauri::command]
async fn codex_account_limits() -> codex_usage::CodexAccountLimits {
    // file walk + tail reads — keep them off the async runtime's core threads
    tauri::async_runtime::spawn_blocking(codex_usage::account_limits)
        .await
        .unwrap_or_default()
}

/// Does this absolute path point at an existing file? Powers the inline
/// validation of the codex/git binary overrides in Settings — a typo there
/// would otherwise silently degrade several features at once.
#[tauri::command]
async fn path_is_file(path: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || std::path::Path::new(&path).is_file())
        .await
        .unwrap_or(false)
}

/// Canonicalize a path (symlinks, `/var` → `/private/var` aliasing) — the
/// strong half of the project-tab dedupe key (frontend `openProject`).
/// Falls back to the input when resolution fails (folder gone), so opening
/// a project never hard-fails on the resolver.
#[tauri::command]
async fn canonicalize_path(path: String) -> String {
    let input = path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::canonicalize(&path)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or(path)
    })
    .await
    .unwrap_or(input)
}

#[tauri::command]
async fn git_info(cwd: String, bin: Option<String>) -> Option<git::GitInfo> {
    // subprocess work — keep it off the async runtime's core threads
    tauri::async_runtime::spawn_blocking(move || git::git_info(&cwd, bin.as_deref()))
        .await
        .ok()
        .flatten()
}

#[tauri::command]
async fn worktree_add(
    cwd: String,
    branch: String,
    copy_env: bool,
    bin: Option<String>,
) -> Result<worktree::WorktreeInfo, String> {
    // git subprocesses + file copies — keep them off the async runtime's core threads
    tauri::async_runtime::spawn_blocking(move || {
        worktree::add(&cwd, &branch, copy_env, bin.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn worktree_status(path: String, bin: Option<String>) -> Result<worktree::WorktreeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || worktree::status(&path, bin.as_deref()))
        .await
        .map_err(|e| e.to_string())
}

/// `force: false` is the gated path — the removal re-checks dirty/ahead
/// inside worktree::remove and runs `git worktree remove` WITHOUT --force
/// (git refuses late-appearing work). `true` = the user-confirmed force
/// path; an OMITTED flag defaults to the GATED path (audit R5 — force must
/// always be an explicit, deliberate claim). The path is confined to
/// `<root>/.worktrees` and the branch is derived from git inside
/// `worktree::remove`.
#[tauri::command]
async fn worktree_remove(
    root: String,
    path: String,
    branch: String,
    force: Option<bool>,
    bin: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        worktree::remove(&root, &path, &branch, force.unwrap_or(false), bin.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn worktree_list(
    roots: Vec<String>,
    bin: Option<String>,
) -> Result<worktree::WorktreeScan, String> {
    tauri::async_runtime::spawn_blocking(move || worktree::list(&roots, bin.as_deref()))
        .await
        .map_err(|e| e.to_string())
}

// ---- GitHub integration — see github.rs (local `gh` CLI, no OAuth) ----
//
// All async + spawn_blocking (gh is a network subprocess). Read commands work
// unconditionally and degrade typed (`GhOutcome`); write commands are
// additionally Rust-gated on the integration flag (`github_set_integration`,
// mirrored from the Settings master toggle) — they error while it is off.

/// Is gh installed + logged in, and as whom? Never errors.
#[tauri::command]
async fn gh_auth_status(bin: Option<String>) -> github::GhAuthStatus {
    tauri::async_runtime::spawn_blocking(move || github::auth_status(bin.as_deref()))
        .await
        .unwrap_or_default()
}

/// GitHub remote of a project folder (owner/repo, default branch, …).
#[tauri::command]
async fn gh_repo_info(
    dir: String,
    bin: Option<String>,
) -> Result<github::GhOutcome<github::GhRepoInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || github::repo_info(&dir, bin.as_deref()))
        .await
        .map_err(|e| e.to_string())
}

/// Open PRs of the repo behind `dir`, with derived check summaries.
#[tauri::command]
async fn gh_pr_list(
    dir: String,
    bin: Option<String>,
) -> Result<github::GhOutcome<Vec<github::GhPr>>, String> {
    tauri::async_runtime::spawn_blocking(move || github::pr_list(&dir, bin.as_deref()))
        .await
        .map_err(|e| e.to_string())
}

/// One PR in detail (checks, reviews, files, capped unified diff).
#[tauri::command]
async fn gh_pr_view(
    dir: String,
    number: u64,
    include_diff: Option<bool>,
    bin: Option<String>,
) -> Result<github::GhOutcome<github::GhPrDetail>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        github::pr_view(&dir, number, include_diff.unwrap_or(true), bin.as_deref())
    })
    .await
    .map_err(|e| e.to_string())
}

/// GATED write: push the branch checked out in `dir` (never force, never the
/// default branch) and open a PR from it.
#[tauri::command]
async fn gh_pr_create(
    dir: String,
    title: String,
    body: String,
    base: Option<String>,
    draft: Option<bool>,
    bin: Option<String>,
    git_bin: Option<String>,
) -> Result<github::GhOutcome<github::GhPrCreated>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        github::pr_create(
            &dir,
            &title,
            &body,
            base.as_deref(),
            draft.unwrap_or(false),
            bin.as_deref(),
            git_bin.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// GATED write: comment on a PR.
#[tauri::command]
async fn gh_pr_comment(
    dir: String,
    number: u64,
    body: String,
    bin: Option<String>,
) -> Result<github::GhOutcome<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        github::pr_comment(&dir, number, &body, bin.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// GATED write: submit a PR review (approve | request_changes | comment).
#[tauri::command]
async fn gh_pr_review(
    dir: String,
    number: u64,
    action: String,
    body: Option<String>,
    bin: Option<String>,
) -> Result<github::GhOutcome<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        github::pr_review(&dir, number, &action, body.as_deref(), bin.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Mirror the Settings "GitHub integration" master toggle into Rust — the
/// server-side gate for the gh write commands AND for `classify_approval`'s
/// gh-write routing (agent-run `gh pr comment` is routine only while ON).
/// Async + spawn_blocking because DISABLING drains in-flight writes (it may
/// wait behind a running `git push`) — the ack means "no write is running
/// and none can start".
#[tauri::command]
async fn github_set_integration(enabled: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || github::set_integration(enabled))
        .await
        .map_err(|e| format!("github_set_integration failed: {e}"))
}

/// Mirror the Settings "autonomous GitHub writes" opt-in into Rust (final
/// hardening F2). It gates the AGENT-side gh writes server-side: an agent-run
/// `gh pr comment`/`gh pr review` approval is routine-decidable by the
/// Conductor ONLY while integration AND this opt-in are both on — the strict
/// respond path re-reads the live flags, so a flip applies to already-pending
/// approvals too. Fail-closed default: off.
#[tauri::command]
fn github_set_autonomous_writes(enabled: bool) {
    github::set_autonomous_writes(enabled);
}

/// Number of gh/git WRITE ops currently in flight (a `git push` or PR
/// mutation) — the quit guard reads this so quitting mid-write warns.
#[tauri::command]
fn github_writes_in_flight() -> usize {
    github::writes_in_flight()
}

/// Declaratively (re)configure the PR watcher: poll the given repos every
/// `interval_secs`, emit `github://pr-changed` on real changes. An empty
/// list stops polling.
#[tauri::command]
fn github_watch_configure(
    app: AppHandle,
    repos: Vec<github::WatchRepo>,
    interval_secs: u64,
    bin: Option<String>,
) {
    github::watch_configure(&app, repos, interval_secs, bin);
}

// ---- Orchestrator sensing — read-only, see transcript.rs / projects.rs ----

#[tauri::command]
async fn transcript_read(
    session_id: String,
    tail_messages: Option<usize>,
    max_bytes: Option<u64>,
    include_first_user_message: Option<bool>,
) -> Result<transcript::TranscriptView, String> {
    // file reads (possibly a seek into a huge jsonl) — off the core threads
    tauri::async_runtime::spawn_blocking(move || {
        let defaults = transcript::TranscriptOpts::default();
        // audit R12: caller-supplied window sizes are CLAMPED — a huge
        // max_bytes/tail request must not turn the tail read into a slurp
        const MAX_TAIL_MESSAGES: usize = 500;
        const MAX_WINDOW_BYTES: u64 = 8 * 1024 * 1024;
        let opts = transcript::TranscriptOpts {
            tail_messages: tail_messages
                .unwrap_or(defaults.tail_messages)
                .clamp(1, MAX_TAIL_MESSAGES),
            max_bytes: max_bytes
                .unwrap_or(defaults.max_bytes)
                .clamp(4_096, MAX_WINDOW_BYTES),
            include_first_user_message: include_first_user_message
                .unwrap_or(defaults.include_first_user_message),
        };
        transcript::read(&session_id, &opts)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn project_docs(root: String) -> Result<transcript::ProjectDocs, String> {
    tauri::async_runtime::spawn_blocking(move || transcript::project_docs(&root))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn discover_projects(
    scan_roots: Vec<String>,
    known: Vec<projects::KnownFolder>,
) -> Result<Vec<projects::ProjectEntry>, String> {
    // directory walks + jsonl head reads — off the core threads
    tauri::async_runtime::spawn_blocking(move || projects::discover_default(&scan_roots, &known))
        .await
        .map_err(|e| e.to_string())
}

// ---- Orchestrator tool bus — see orchestrator/ ----

/// The tool catalog + the Conductor system instructions, both single-source
/// in Rust. The catalog is handed to Codex as `dynamicTools` (and the
/// instructions as `developerInstructions`). `persona` is the current
/// Settings persona (None = the Maestro seed), `project` the Conductor's
/// project context (None = no project block — dev hook); memory (global +
/// project) is read fresh so every consumer compiles the SAME instructions
/// from one source.
#[tauri::command]
async fn orchestrator_tools(
    app: AppHandle,
    persona: Option<orchestrator::PersonaSpec>,
    project: Option<orchestrator::ProjectContext>,
) -> serde_json::Value {
    let persona = persona.unwrap_or_default();
    let project = project.unwrap_or_default();
    let memory = orchestrator_memory_blocks(&app, &project.id).await;
    serde_json::json!({
        "instructions": orchestrator::build_instructions(&persona, &project, &memory),
        "tools": orchestrator::tool_definitions(),
    })
}

/// The app data dir (holds `swarmz.json` and `orchestrator-memory/`).
fn orchestrator_data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// Render both memory scopes as prompt-ready blocks (empty on failure).
async fn orchestrator_memory_blocks(
    app: &AppHandle,
    project_id: &str,
) -> orchestrator::MemoryBlocks {
    let Ok(dir) = orchestrator_data_dir(app) else {
        return orchestrator::MemoryBlocks::default();
    };
    let pid = project_id.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let render = |entries: &[orchestrator::MemoryEntry]| {
            entries
                .iter()
                .map(|e| {
                    if e.date.is_empty() {
                        format!("- {}", e.text)
                    } else {
                        format!("- {} {}", e.date, e.text)
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        };
        let global = render(&orchestrator::memory_read(
            &dir,
            &orchestrator::MemoryScope::Global,
        ));
        // strict scope construction — invalid/reserved/empty ids read nothing
        let project = match orchestrator::MemoryScope::project(&pid) {
            Ok(scope) => render(&orchestrator::memory_read(&dir, &scope)),
            Err(_) => String::new(),
        };
        orchestrator::MemoryBlocks { global, project }
    })
    .await
    .unwrap_or_default()
}

/// Read one scope of the curated memory (Settings UI). `scope` ∈
/// "global" | "project" (the latter needs `project_id`).
#[tauri::command]
async fn orchestrator_memory_read(
    app: AppHandle,
    scope: String,
    project_id: Option<String>,
) -> Result<Vec<orchestrator::MemoryEntry>, String> {
    let dir = orchestrator_data_dir(&app)?;
    let scope = orchestrator::MemoryScope::parse(&scope, project_id.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || orchestrator::memory_read(&dir, &scope))
        .await
        .map_err(|e| e.to_string())
}

/// Append one fact to a memory scope (the `remember` tool executor). The
/// caps are enforced here; the result reports any FIFO drop.
#[tauri::command]
async fn orchestrator_memory_append(
    app: AppHandle,
    text: String,
    scope: String,
    project_id: Option<String>,
) -> Result<orchestrator::AppendResult, String> {
    let dir = orchestrator_data_dir(&app)?;
    let scope = orchestrator::MemoryScope::parse(&scope, project_id.as_deref())?;
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    tauri::async_runtime::spawn_blocking(move || {
        orchestrator::memory_append(&dir, &scope, &text, &today)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Remove one memory entry by index from a scope (Settings UI). Returns the
/// remaining list.
#[tauri::command]
async fn orchestrator_memory_remove(
    app: AppHandle,
    index: usize,
    scope: String,
    project_id: Option<String>,
) -> Result<Vec<orchestrator::MemoryEntry>, String> {
    let dir = orchestrator_data_dir(&app)?;
    let scope = orchestrator::MemoryScope::parse(&scope, project_id.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || orchestrator::memory_remove(&dir, &scope, index))
        .await
        .map_err(|e| e.to_string())?
}

/// Run one tool through the roundtrip bus (Rust → webview executor → Rust).
/// Async: it awaits the webview's response (or the tool's timeout) — no
/// blocking work happens on this side.
///
/// DEV-ONLY (audit R13): this is the `window.__orch` dev hook's unscoped
/// surface — release builds refuse it (the Conductor's real tool calls go
/// through the app-server adapter, never through this command).
#[tauri::command]
async fn orchestrator_run_tool(
    app: AppHandle,
    tool: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if !cfg!(debug_assertions) {
        return Err("orchestrator_run_tool is a dev-only hook and disabled in release builds".into());
    }
    // dev-hook surface — no chat/project context (executors skip
    // touched-session tracking and resolve sessions unscoped)
    orchestrator::run_tool(&app, &tool, args, None, None).await
}

/// Webview → Rust leg of the roundtrip. Sync on purpose: it only resolves a
/// oneshot in the pending map (fast, non-blocking). Unknown/expired ids are
/// a logged no-op — a late response after a timeout is normal, not an error.
#[tauri::command]
fn orchestrator_tool_response(id: String, ok: bool, payload: serde_json::Value) {
    orchestrator::resolve_tool_response(&id, ok, payload);
}

// ---- Orchestrator brain — see orchestrator/appserver.rs ----
//
// All async: they await JSON-RPC roundtrips against the long-lived
// `codex app-server` child (spawned lazily; tokio::process — no blocking
// work on the main thread). Progress streams as `orchestrator://chat-event`.

/// Start a fresh Conductor chat for one project (app-server thread with
/// dynamic tools on that project's instance). `codex_path` is the Settings
/// codex-binary override, passed on every call.
#[tauri::command]
async fn orchestrator_chat_start(
    app: AppHandle,
    codex_path: Option<String>,
    persona: Option<orchestrator::PersonaSpec>,
    project: Option<orchestrator::ProjectContext>,
) -> Result<serde_json::Value, String> {
    orchestrator::chat_start(&app, codex_path, persona, project).await
}

/// Send one user message; resolves with the final assistant text when the
/// turn completes (deltas/tool calls stream as events meanwhile).
#[tauri::command]
async fn orchestrator_chat_send(
    app: AppHandle,
    chat_id: String,
    text: String,
    model: Option<String>,
    effort: Option<String>,
) -> Result<serde_json::Value, String> {
    orchestrator::chat_send(&app, &chat_id, &text, model, effort).await
}

/// Interrupt the chat's running turn (turn/interrupt).
#[tauri::command]
async fn orchestrator_chat_interrupt(chat_id: String) -> Result<(), String> {
    orchestrator::chat_interrupt(&chat_id).await
}

/// Compact the chat's thread (thread/compact/start) — summarizes the
/// model-visible history without touching the UI transcript. Blocks until the
/// compaction turn completes.
#[tauri::command]
async fn orchestrator_chat_compact(
    app: AppHandle,
    chat_id: String,
) -> Result<serde_json::Value, String> {
    orchestrator::chat_compact(&app, &chat_id).await
}

/// Reopen a persisted app-server thread as a chat (thread/resume on its
/// project's instance).
#[tauri::command]
async fn orchestrator_chat_resume(
    app: AppHandle,
    thread_id: String,
    persona: Option<orchestrator::PersonaSpec>,
    project: Option<orchestrator::ProjectContext>,
) -> Result<serde_json::Value, String> {
    orchestrator::chat_resume(&app, &thread_id, persona, project).await
}

/// Liveness + codex version + account summary. Never errors — spawn
/// failures come back as `{ running: false, error }`. Reuses any alive
/// Conductor process, else spawns the given project's (or a neutral probe).
#[tauri::command]
async fn orchestrator_chat_status(
    app: AppHandle,
    codex_path: Option<String>,
    project: Option<orchestrator::ProjectContext>,
) -> serde_json::Value {
    orchestrator::chat_status(&app, codex_path, project).await
}

/// The model ids the installed codex offers (`model/list`, hidden entries
/// dropped, server order = default first) — the pickers' "Available" section.
#[tauri::command]
async fn codex_list_models(app: AppHandle) -> Result<Vec<String>, String> {
    orchestrator::list_models(&app).await
}

// ---- Native Codex sessions — see codex/sessions.rs ----
//
// All async: they await JSON-RPC roundtrips against a PRIVATE `codex
// app-server` child per session (crash isolation). Progress streams as
// `vibe://session-event` `{session_id, kind, data}`. `session_id` is
// assigned by the frontend (it keys the store's VibeSession); `codex_path`
// is the Settings codex-binary override, passed on the start/resume calls.

/// Start a fresh session (dedicated process + thread/start). `access`
/// ∈ workspace | full maps to the sandbox/approval policy. Returns `{thread_id}`.
#[tauri::command]
async fn vibe_session_start(
    app: AppHandle,
    session_id: String,
    cwd: String,
    model: Option<String>,
    effort: Option<String>,
    access: String,
    codex_path: Option<String>,
) -> Result<serde_json::Value, String> {
    codex::sessions::session_start(&app, &session_id, cwd, model, effort, &access, codex_path).await
}

/// Reopen a persisted session across an app restart (thread/resume, with a
/// fresh-start fallback when the rollout is gone). Returns `{thread_id, resumed}`.
// 8 args mirror the session_resume wire 1:1 (audit R13).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn vibe_session_resume(
    app: AppHandle,
    session_id: String,
    thread_id: String,
    cwd: String,
    model: Option<String>,
    effort: Option<String>,
    access: String,
    codex_path: Option<String>,
) -> Result<serde_json::Value, String> {
    codex::sessions::session_resume(
        &app,
        &session_id,
        &thread_id,
        cwd,
        model,
        effort,
        &access,
        codex_path,
    )
    .await
}

/// Send one user message — non-blocking; returns `{turn_id}` after the
/// turn/start ack. The transcript + completion arrive as events.
/// `output_schema` (optional) constrains this ONE turn's final assistant
/// message to a JSON Schema (the structured agent→Conductor status reports).
/// `require_workspace: true` is the STRICT Conductor path (final hardening
/// F5): Rust refuses when the session runs with FULL access — the Conductor
/// may not repurpose human-granted full authority. The human composer omits
/// it / passes false.
#[tauri::command]
async fn vibe_session_send(
    app: AppHandle,
    session_id: String,
    text: String,
    output_schema: Option<serde_json::Value>,
    require_workspace: Option<bool>,
) -> Result<serde_json::Value, String> {
    codex::sessions::session_send(
        &app,
        &session_id,
        &text,
        output_schema,
        require_workspace.unwrap_or(false),
    )
    .await
}

/// Interrupt the session's running turn (turn/interrupt).
#[tauri::command]
async fn vibe_session_interrupt(session_id: String) -> Result<(), String> {
    codex::sessions::session_interrupt(&session_id).await
}

/// Compact the session's thread (thread/compact/start) — summarizes the
/// model-visible history without touching the UI transcript. BLOCKS until
/// the compaction turn completed (busy clears before this resolves, so a
/// send fired right after never races the compaction).
#[tauri::command]
async fn vibe_session_compact(
    app: AppHandle,
    session_id: String,
) -> Result<serde_json::Value, String> {
    codex::sessions::session_compact(&app, &session_id).await
}

/// Answer a pending approval — `decision` ∈ accept | acceptForSession |
/// decline | cancel. `require_routine: true` is the STRICT Conductor path:
/// Rust refuses (atomically, server-side) unless the request was classified
/// "routine" — destructive approvals stay with the human no matter what the
/// caller claims. The human UI omits it / passes false.
#[tauri::command]
async fn vibe_session_respond_approval(
    session_id: String,
    approval_id: String,
    decision: String,
    require_routine: Option<bool>,
) -> Result<(), String> {
    codex::sessions::session_respond_approval(
        &session_id,
        &approval_id,
        &decision,
        require_routine.unwrap_or(false),
    )
    .await
}

/// Change the session's access mode (takes effect on the next turn).
#[tauri::command]
async fn vibe_session_set_access(session_id: String, access: String) -> Result<(), String> {
    codex::sessions::session_set_access(&session_id, &access).await
}

/// Change the session's model / reasoning effort (takes effect on the next
/// turn). Empty/null clears back to the user's codex default.
#[tauri::command]
async fn vibe_session_set_model_effort(
    session_id: String,
    model: Option<String>,
    effort: Option<String>,
) -> Result<(), String> {
    codex::sessions::session_set_model_effort(&session_id, model, effort).await
}

/// Close a session: interrupt, cancel pending approvals, drop the process.
#[tauri::command]
async fn vibe_session_close(session_id: String) -> Result<(), String> {
    codex::sessions::session_close(&session_id).await
}

/// Steer the session's RUNNING turn (turn/steer, race-safe via
/// expectedTurnId). Errors when no turn runs — callers send normally then.
/// `require_workspace: true` is the STRICT Conductor path (final hardening
/// F5): a FULL-access session refuses.
#[tauri::command]
async fn vibe_session_steer(
    session_id: String,
    text: String,
    require_workspace: Option<bool>,
) -> Result<serde_json::Value, String> {
    codex::sessions::session_steer(&session_id, &text, require_workspace.unwrap_or(false)).await
}

/// Move a session to a new working directory (worktree assignment) — the
/// live thread is retuned via thread/settings/update, the profile for good.
#[tauri::command]
async fn vibe_session_set_cwd(session_id: String, cwd: String) -> Result<(), String> {
    codex::sessions::session_set_cwd(&session_id, &cwd).await
}

/// Run a detached codex review over the session's work; blocks until the
/// review turn completes and returns `{status, review, review_thread_id}`.
/// `require_workspace: true` is the STRICT Conductor path (audit C3): the
/// review runs on the parent session's access profile, so a human-granted
/// FULL-access session refuses — an autonomous review must never reuse that
/// authority (danger-full-access + approvalPolicy "never" would execute
/// without any approval to cancel). Every current caller IS a Conductor
/// path, so an omitted flag defaults to the strict gate (fail closed).
#[tauri::command]
async fn vibe_session_review(
    session_id: String,
    target: String,
    require_workspace: Option<bool>,
) -> Result<serde_json::Value, String> {
    codex::sessions::session_review(&session_id, &target, require_workspace.unwrap_or(true)).await
}

// ---- Conductor plan documents — see plans.rs ----
//
// The ONE sanctioned write surface of the orchestrator: Markdown documents
// under `<project>/.swarmz/plans/` (slug-confined — a title or slug can never
// escape the folder). The project dir comes from the trusted chat context.

#[tauri::command]
async fn conductor_plan_write(
    project_dir: String,
    title: String,
    markdown: String,
) -> Result<plans::PlanInfo, String> {
    tauri::async_runtime::spawn_blocking(move || plans::write(&project_dir, &title, &markdown))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn conductor_plan_list(project_dir: String) -> Result<Vec<plans::PlanInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || plans::list(&project_dir))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn conductor_plan_read(
    project_dir: String,
    slug: String,
) -> Result<plans::PlanDocument, String> {
    tauri::async_runtime::spawn_blocking(move || plans::read(&project_dir, &slug))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // remember window size/position/maximized across restarts
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(move |app| {
            // before the webview can touch the store: rescue a corrupt
            // swarmz.json / refresh its backup (see storefile.rs)
            if let Ok(dir) = app.path().app_data_dir() {
                storefile::rescue(&dir);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            codex_account_limits,
            path_is_file,
            canonicalize_path,
            git_info,
            worktree_add,
            worktree_status,
            worktree_remove,
            worktree_list,
            gh_auth_status,
            gh_repo_info,
            gh_pr_list,
            gh_pr_view,
            gh_pr_create,
            gh_pr_comment,
            gh_pr_review,
            github_set_integration,
            github_set_autonomous_writes,
            github_writes_in_flight,
            github_watch_configure,
            transcript_read,
            project_docs,
            discover_projects,
            orchestrator_tools,
            orchestrator_run_tool,
            orchestrator_tool_response,
            orchestrator_memory_read,
            orchestrator_memory_append,
            orchestrator_memory_remove,
            orchestrator_chat_start,
            orchestrator_chat_send,
            orchestrator_chat_interrupt,
            orchestrator_chat_compact,
            orchestrator_chat_resume,
            orchestrator_chat_status,
            codex_list_models,
            vibe_session_start,
            vibe_session_resume,
            vibe_session_send,
            vibe_session_interrupt,
            vibe_session_compact,
            vibe_session_respond_approval,
            vibe_session_set_access,
            vibe_session_set_model_effort,
            vibe_session_close,
            vibe_session_steer,
            vibe_session_set_cwd,
            vibe_session_review,
            conductor_plan_write,
            conductor_plan_list,
            conductor_plan_read,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // ⌘Q / menu quit (code Some(0)): hand the decision to the frontend,
            // which warns when sessions are still working and closes the window
            // on confirm (→ ExitRequested with code None, which passes here).
            // prevent_exit() is a built-in no-op for the updater's restart
            // (RESTART_EXIT_CODE), so updates keep working.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_some() {
                    api.prevent_exit();
                    let _ = app.emit("app://quit-requested", ());
                }
            }
        });
}
