# AGENTS.md

SwarmZ — run, tile and monitor multiple Claude Code, Codex and shell agents in parallel. React frontend + native macOS app (Tauri 2 / Rust). Deep per-subsystem details live in `docs/ARCHITECTURE.md` — read the relevant section there (or the code) before changing a subsystem, and keep it in sync.

**Native-only app.** The old browser/Node web mode has been removed. New features are native-only; use Tauri/Rust commands for backend capabilities and do not reintroduce web-mode parity paths.

## Stack & commands

- React 19 + TypeScript + Tailwind v4 (dark only — follow `DESIGN.md`), Zustand, xterm.js, pnpm
- Type-check: `./node_modules/.bin/tsc --noEmit` · Build: `pnpm build` · Dev: `pnpm tauri dev` · Rust tests: `cargo test` in `src-tauri/`

## Map

Frontend (`src/`):

- `store.ts` — all app state + persistence (Tauri store `swarmz.json`; settings always via `updateSettings`) + the agent/workspace/worktree lifecycle actions. Fresh installs default new panes to Codex in full-access mode.
- `lib/transport.ts` → `backend-types.ts` / `backend-tauri.ts` — backend interface; native-only features may skip it and `invoke` directly (`lib/dnd.ts`, `lib/openrouter.ts`, `lib/worktree.ts`)
- `lib/term-host.ts` — xterm + PTY per id, **outside React**; `lib/term-registry.ts` exposes the xterm instances
- `lib/quit.ts` — quit guard; `lib/git.ts` — 7s status poll; `lib/limits.ts` — subscription meters (Claude OAuth + account-level Codex); `lib/events.ts` — in-memory fleet event feed (Deck ticker + fleet-card event lines); `lib/triage.ts` — shared needs-you ordering (Deck queue + fleet ops board); `lib/updates.ts` — auto-updater; `lib/dictation.ts` — voice recording; `lib/presets.ts` — workspace presets; `lib/layout.ts` — tiling trees; `lib/insert-command.ts` / `lib/command-vars.ts` — paste/submit + placeholders; `lib/orchestrator/` — orchestrator sensing + tool bus + chat plumbing: pure fleet snapshot, native wrappers for transcript/docs/discovery, `bus.ts`/`executors.ts` (webview half of the tool bus — executes Rust-dispatched tool requests against the store), `chat.ts` (typed `orchestrator_chat_*` wrappers + `orchestrator://chat-event` listener), `chat-store.ts` (chat-sidebar state, standalone zustand store, persisted key `orchestratorChats`, flushed via `flushAllPersists`), `controller.ts` (chat events → store bridge with delta batching + per-chat provider routing, **outside React**), `openrouter-loop.ts` (Phase-6 OpenRouter brain: webview tool loop over the same registry/executors, persisted wire history) + dev hook `window.__orch`
- `components/` — `App.tsx` (global shortcuts, dialog mounts), `WorkspaceLayer`/`TilingGrid`/`AgentPane`/`Terminal` (grid + panes + the ⌘E fleet ops board: per-pane card chrome, header line, keyboard selection), `TitleBar` (tabs, panel buttons), `Deck` (bottom status bar: triage queue, event ticker, subscription meters, orch dot), `FloatingTerminals`, `CommandPalette` (⌘K) / `InsertCommandPalette` (⌘⇧K), `NewAgentDialog`, `SettingsDialog`, `UsageDashboard`, `QuickNotesPanel` (⌘N, global + per-project checklists), `OrchestratorPanel` (⌘⇧O, resizable right chat sidebar — a flex sibling that squeezes the grid, not an overlay), `WorktreePanel`, the `Close*Dialog`s, `Dictation`

Backend (`src-tauri/src/`):

- `pty.rs` — PTY sessions (writer thread per session, coalesced output events) · `lib.rs` — commands, watchers, quit/exit handling, store rescue at setup
- `usage.rs` / `codex_usage.rs` — incremental jsonl usage parsing + live pricing; `codex_usage.rs` also serves account-level Codex rate limits (`codex_account_limits`, bounded newest-first tail scan) · `limits.rs` — Anthropic OAuth limits
- `git.rs` — read-only git status (with subprocess timeouts) · `worktree.rs` — worktree create/status/remove/list (the only git-writing module)
- `openrouter.rs` — dictation cloud engine + keychain key · `localstt.rs` — local Parakeet STT (pinned + hash-verified model download)
- `project.rs` — auto-detected quick commands · `storefile.rs` — swarmz.json backup/rescue
- `transcript.rs` — orchestrator sensing (read-only): session-transcript tails + project docs · `projects.rs` — project discovery (Claude/Codex history, known folders, shallow git scan)
- `orchestrator/` — tool bus + brains: `registry.rs` (the single-source tool catalog: names, descriptions, JSON-Schema params, timeouts) + `bus.rs` (Rust↔webview roundtrip with pending map + per-tool timeouts) + `protocol.rs`/`appserver.rs` (long-lived `codex app-server` child — chats ↔ threads, registry as experimental dynamicTools, `item/tool/call` answered via the bus, streaming `orchestrator://chat-event`s, auto-declined approvals, lazy respawn + thread/resume; also home of the single-source `ORCHESTRATOR_INSTRUCTIONS`) + `openrouter.rs` (Phase-6 second brain: streamed OpenRouter chat completion with SSE/tool-call assembly + per-chat cancel — the loop itself runs in the webview)

## Load-bearing invariants (don't break these)

- PTYs die exactly on store removal (`removeAgent`/`removeFloatingTerminal` → `destroyTerm`), **never** on React unmount — that's what lets panes remount across workspaces. All grids stay mounted; inactive ones are `visibility:hidden`.
- Into-terminal text (drops, dictation, command inserts) goes through `term.paste()`, never raw `ptyWrite` — bracketed paste is what makes Claude attach image paths; submit is a **separate** `\r` write.
- `ConEmuANSI=ON` in the PTY env is the OSC 9;4 opt-in (pane status badges); don't remove. OSC 21337 is pre-wired but dormant.
- Persistence distinctions: `workspacePresets` `null` = seed, `[]` = stays empty · limits `null` = no usable login (hide meters) vs reject = transient (keep last values) · `Agent.resume` is transient, `--resume` is injected only at PTY spawn.
- Worktree deletion is gated: silent cleanup only after a re-check at execution time (`pendingWorktreeCleanup`, `confirmed` flag); "detach"/"cancel" abort it. Workspace close keeps worktrees by default, but its explicit "clean safe" path removes only worktrees that re-check clean/no-local-only-commits.
- Global shortcuts early-return while a dialog is open (⌘K/⌘⇧K may close their palettes); ⌘W is always `preventDefault`ed; the ⌘⇧K branch stays before plain ⌘K.
- Sync Tauri commands run on the main thread — anything blocking (subprocesses, file walks, keychain, inference) must be async + `spawn_blocking`. `pty_write`/`pty_spawn`/`pty_resize` stay sync on purpose (ordering); writes are non-blocking via the per-session writer channel.
- Quit flushes **all** debounced persists (`flushAllPersists`); the quit/close choreography in `lib/quit.ts` + `lib.rs` looks redundant but every leg is load-bearing (window-state save, updater restart code).
- Title-bar dragging relies **only** on `data-tauri-drag-region="deep"` on the `<header>` in `TitleBar.tsx` — WKWebView ignores `-webkit-app-region`, so the `drag-region`/`no-drag` CSS classes are no-ops on macOS. `"deep"` makes the whole subtree draggable; Tauri's `drag.js` auto-excludes real `<button>`/`<input>`/`role` elements. The workspace tab is a plain `<div>` (activate + close buttons as siblings inside), so it opts out explicitly via `data-tauri-drag-region="false"` — keep that attribute when touching the tab markup. Don't switch back to bare `data-tauri-drag-region` (drags only direct hits on the header itself = just the flex gaps).

## Releases & updates

- Auto-updater polls `latest.json` on GitHub Releases (`lib/updates.ts`; pill in `TitleBar.tsx`, toggle in Settings). About shows `__APP_VERSION__` (Vite define). Builds are ad-hoc signed only.
- Release checklist: bump version in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (keep in sync) → create `docs/release-notes/v<X.Y.Z>.md` (CI fails without it) → tag `v<X.Y.Z>` + push → `.github/workflows/release.yml` publishes incl. updater manifest.
- Updater signing key: `~/.tauri/swarmz_updater.key` (no password), repo secret `TAURI_SIGNING_PRIVATE_KEY`. Losing it breaks updates for existing installs.

## Ground rules

1. **Never start the dev server** or any long-running app process (`pnpm tauri dev`, `pnpm dev`, …) without explicit approval first. Type-checks, builds and `cargo test` are fine.
2. **Never commit or push on your own.** Only when explicitly asked or approved.
3. **Keep docs in sync.** If a change affects anything stated in `AGENTS.md`, `docs/ARCHITECTURE.md` or `README.md`, update them in the same change — proactively, without being asked.
