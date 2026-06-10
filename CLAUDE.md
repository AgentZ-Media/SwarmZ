# CLAUDE.md

SwarmZ — run, tile and monitor multiple Claude Code agents in parallel. One React frontend, two backends: native macOS app (Tauri 2 / Rust) and a local web mode (Node engine).

## Stack & commands

- React 19 + TypeScript + Tailwind v4 (dark only — follow `DESIGN.md`), Zustand, xterm.js, pnpm
- Type-check: `./node_modules/.bin/tsc --noEmit` · Build: `pnpm build` · Dev: `pnpm tauri dev` (native) / `pnpm dev:web` (browser)

## Architecture in 10 seconds

- `src/lib/transport.ts` picks the backend at runtime. Every backend capability is declared in `backend-types.ts` and must be implemented in **both** `backend-tauri.ts` and `backend-web.ts`.
- `src/store.ts` holds all app state. Persisted: profiles, usage history + app settings (`AppSettings`: last used folder, default font size, default startup command, claude/git path overrides, auto-update — edited in `SettingsDialog.tsx`, opened via the title-bar gear or `⌘,`) (Tauri store `swarmz.json` / localStorage). Always mutate settings through `updateSettings` (merges + persists the whole object). In-memory only: agents, layout. Window size/position persists natively via `tauri-plugin-window-state`. New agents and splits go through the New Agent dialog; splits prefill it from the source pane (cwd, profile, startup), plain "new" prefills the configured default startup command (picking a profile overrides it) and profile default cwd → last used folder. The claude path override is applied at PTY spawn (`applyClaudePath` in `utils.ts` — replaces a leading `claude` token only).
- Usage is parsed from `~/.claude/projects/*.jsonl` by `src-tauri/src/usage.rs` (native) and `server/usage.mjs` (web) — keep the two implementations in sync. Parsing is **incremental**: a per-(file, since) offset cache only reads appended bytes; costs/by_model are recomputed from cached counters on every read (so pricing updates need no cache invalidation). Pricing is fetched live from the OpenRouter model catalog (daily refresh) with a hardcoded per-family fallback for offline; fallback tables in both files and in `README.md` must match.
- Subscription limits (5h/weekly windows in the title bar) come from the Anthropic OAuth usage endpoint, authenticated with the local Claude Code login (macOS Keychain `Claude Code-credentials`, fallback `~/.claude/.credentials.json`) — implemented in `src-tauri/src/limits.rs` (native) and `/api/limits` in `server/index.mjs` (web), polled once a minute by `src/lib/limits.ts` (paused while hidden). A `null` result means "no Claude login" and hides the meters; transient fetch errors reject (native) / respond 502 (web) instead, and the store keeps the last known values — preserve this distinction in both backends. Tokens/cost are tracked but only shown on demand (per-pane stats popover, usage drawer) — not in pane headers or the title bar.
- Per-pane git status (repo, branch, ±lines, untracked, `origin` URL for "Open repo in browser") is strictly read-only and shells out to the git binary: `src-tauri/src/git.rs` (native, prefers the Settings `gitPath` override, else `/usr/bin/git` because GUI apps get a minimal PATH) and `/api/git` in `server/index.mjs` (web, same override via `?bin=`) — keep the two in sync. `src/lib/git.ts` polls every 7 s, one fetch per distinct cwd, paused while the window is hidden; `null` on an agent means "checked, not a repo".
- Pane headers are container-query responsive (`@container` on the header in `AgentPane.tsx`): below ~36rem the folder path, gauge readout and split buttons collapse, below ~28rem also the git chip and stats button — title, model badge, context donut and the ⋯ menu always remain.
- Pane title & live status come from terminal escape sequences, handled in `Terminal.tsx`: OSC 0/2 titles (claude's auto-generated topic) rename the agent unless the user renamed it manually (`renamed` flag; clearing the name re-enables auto-titles), OSC 9;4 progress reporting maps to `Agent.activity` busy/idle (the status dot). Claude Code only emits OSC 9;4 if the terminal advertises support — both PTY backends set `ConEmuANSI=ON` for that (deliberately, least invasive marker; don't remove). OSC 21337 (claude's idle/busy/waiting tab-status pill) is pre-wired but dormant — current Claude Code builds never emit it.
- Perf invariants: PTY output is coalesced (≤12 ms / 128 KiB) and addressed per agent (`pty://data/<id>`); the usage file-watcher emits the changed project-dir names and the frontend skips refreshes for dirs it doesn't display, throttles to ≥2 s, and pauses while the window is hidden.

## Releases & updates

- In-app auto-updater (`tauri-plugin-updater`) polls `latest.json` on GitHub Releases; frontend logic in `src/lib/updates.ts`, UI: status pill in `TitleBar.tsx`, manual check + auto-download toggle (`settings.autoUpdate` — downloads on discovery, installs on restart) in `SettingsDialog.tsx`. The About panel shows `__APP_VERSION__` (injected from `package.json` via Vite `define`). Builds are ad-hoc signed only (no Apple notarization).
- Release checklist: bump version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` (keep in sync) → create `docs/release-notes/v<X.Y.Z>.md` (CI fails without it) → tag `v<X.Y.Z>` and push the tag → `.github/workflows/release.yml` builds macOS (Apple Silicon) and publishes the release incl. updater manifest.
- Updater signing key: `~/.tauri/swarmz_updater.key` (no password), repo secret `TAURI_SIGNING_PRIVATE_KEY`. Losing it breaks updates for existing installs.

## Ground rules

1. **Never start the dev server** or any long-running app process (`pnpm dev:web`, `pnpm tauri dev`, `pnpm engine`, …) without explicit approval first. Type-checks and builds that don't launch the app are fine.
2. **Never commit or push on your own.** Only when explicitly asked or approved.
3. **Keep docs in sync.** If a change affects anything stated in `CLAUDE.md` or `README.md`, update them in the same change — proactively, without being asked.
