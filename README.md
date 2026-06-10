<div align="center">

# ⚡ SwarmZ

**Run, tile and monitor a swarm of Claude Code agents — real terminals, live tokens & cost.**

Native macOS app · Local web app · 100% local — nothing ever leaves your machine

</div>

---

Each agent is a real PTY-backed terminal running `claude` from your system `PATH`, tiled into a resizable split-grid with per-agent usage tracking parsed straight from `~/.claude`.

One codebase, two ways to run it:

- **Native macOS app** — Tauri 2 (Apple Silicon), PTYs handled in Rust.
- **Local web app** — open `localhost` in any browser; a small Node "engine" spawns the PTYs locally and streams them over WebSocket.

Built with **React 19 + TypeScript + Tailwind v4**. Dark mode only — by design.

## ✨ Features

- 🖥️ **Real terminals** — every agent is a PTY-backed login shell (`xterm.js` ↔ `node-pty` / `portable-pty`). `claude`, nvm, aliases and your environment resolve exactly like in iTerm or Terminal.
- 🧱 **Tiling split-grid** — split any pane right (`⌘D`) or down (`⌘⇧D`), drag dividers to resize. Splitting opens the New Agent dialog prefilled with the source pane's folder, profile and startup command. Panes never remount when the grid is rearranged, so scrollback survives.
- 📊 **Usage tracking** — model, tokens and estimated USD cost per agent, parsed from `~/.claude/projects/*.jsonl`. Shown on demand: a stats button in every pane header and a global usage drawer — headers stay clean.
- 🍩 **Context gauge** — a donut plus a `free/total` readout in each pane header shows how much of the agent's context window is left (turns amber/red as it fills).
- 📈 **Plan limits** — the title bar shows the Claude subscription limits of the account logged into Claude Code on this machine: 5-hour session window, weekly windows and reset times.
- 💾 **All-time statistics** — every Claude session launched inside SwarmZ is persisted across restarts. The usage drawer toggles between **Session** (what's open right now) and **All time** (everything you've ever run here), with a per-model cost breakdown and session history.
- 🏷️ **Auto-naming** — Claude Code generates a topic title for every session (and updates it on `/rename`); SwarmZ captures it from the terminal title and names the pane after it. Rename a pane yourself and the auto-title backs off; clear the name to hand it back.
- 🚦 **Live status** — the pane status dot mirrors what Claude is actually doing: amber while it's working, green when idle, blue when it waits for input. Captured from Claude Code's terminal progress reporting (plus the bell), no polling involved.
- 🔔 **Notifications** — when an agent rings the terminal bell (Claude waiting or done), the pane pulses and a native (or browser) notification fires.
- 🎛️ **Profiles** — presets for startup command, flags and default working directory, persisted across restarts. New agents prefill the profile's default folder, or the last folder you used.
- 🔄 **Auto-updates** — the native app checks GitHub Releases in the background and updates in-app; manual check via the refresh button in the title bar.

## 📦 Download

Grab the latest `.dmg` from [**Releases**](https://github.com/AgentZ-Media/SwarmZ/releases) (macOS, Apple Silicon).

SwarmZ is **not notarized by Apple** (indie release) — after installing, clear the quarantine flag once:

```bash
xattr -cr /Applications/SwarmZ.app
```

(or right-click the app → **Open** → **Open**). Updates after that are delivered in-app.

## 🚀 Quick start

Requires [pnpm](https://pnpm.io) and a working [Claude Code](https://claude.com/claude-code) install (`claude` on your `PATH`).

### Native app (Tauri)

```bash
pnpm install
pnpm tauri dev          # dev
pnpm tauri build        # → src-tauri/target/release/bundle/
```

### Local web app (browser)

```bash
pnpm install
pnpm dev:web            # engine + Vite with HMR → http://localhost:1420
```

Or serve the production build from a single local server:

```bash
pnpm build
pnpm engine             # → http://localhost:4178
```

## ⌨️ Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘T` | New agent |
| `⌘D` | Split active pane right |
| `⌘⇧D` | Split active pane down |
| `⌘W` | Close active agent |
| `⌘+` / `⌘−` | Zoom active pane in / out (per-pane font size) |
| `⌘0` | Reset active pane zoom |

## 🏗️ Architecture

A single React frontend talks to a **transport layer** that auto-detects its host at runtime:

```
src/lib/transport.ts      picks the backend at runtime
  backend-types.ts        the Backend interface — every capability lives here
  backend-tauri.ts        Tauri webview → Rust invoke + events
  backend-web.ts          browser → WebSocket (PTY) + HTTP/SSE (usage) to the engine

src/
  store.ts                zustand store (agents, layout tree, profiles, usage history)
  lib/layout.ts           tiling binary-tree ops (split / remove / resize)
  lib/updates.ts          auto-updater (background poll + manual check, Tauri only)
  components/
    Terminal.tsx          xterm ↔ PTY bridge
    TilingGrid.tsx        absolute-positioned pane layout + resizers
    AgentPane.tsx         pane header (model / context gauge / tokens / cost / controls)
    UsageDashboard.tsx    usage drawer — Session & All-time views
    WebDirectoryPicker.tsx server-backed folder picker (web mode)

server/                   the Node "engine" (web mode)
  index.mjs               http + static + WebSocket PTYs + usage SSE + fs browser
  usage.mjs               incremental JSONL parsing (per-file offset cache), pricing

src-tauri/src/            the Rust backend (native mode)
  pty.rs                  PTY spawn / read / write / resize / kill (output coalesced)
  usage.rs                incremental JSONL parsing (per-file offset cache), pricing
  lib.rs                  commands, plugins, usage file-watcher
```

### Cost model

Per-model pricing (USD / 1M tokens, incl. cache write/read) is fetched live from the free, key-less [OpenRouter model catalog](https://openrouter.ai/api/v1/models) — once per run, refreshed daily, matched by normalized model id. While offline (or for unknown ids) a hardcoded per-family fallback applies:

| Family | Input | Output | Cache write | Cache read |
| --- | --- | --- | --- | --- |
| Fable | 10 | 50 | 12.50 | 1.00 |
| Opus | 5 | 25 | 6.25 | 0.50 |
| Sonnet | 3 | 15 | 3.75 | 0.30 |
| Haiku | 1 | 5 | 1.25 | 0.10 |

### Persistence

| Data | Persisted | Where |
| --- | --- | --- |
| Profiles | ✅ | Tauri store (`swarmz.json`) / localStorage |
| Usage history (all-time stats) | ✅ | Tauri store (`swarmz.json`) / localStorage |
| App settings (last used folder) | ✅ | Tauri store (`swarmz.json`) / localStorage |
| Window size & position | ✅ native app | `tauri-plugin-window-state` (browser handles its own window in web mode) |
| Agents & layout | ❌ per session | in-memory |

Usage history only records Claude sessions launched **inside SwarmZ** — plain shells and dev servers never show up in the stats. Snapshots are stored locally, so all-time numbers survive even if `~/.claude` session files are cleaned up.

## 📝 Notes

- The terminal runs whatever your `claude` resolves to. If a pane shows `zsh: permission denied: claude`, your Claude Code install is missing its platform-native binary — reinstall Claude Code, not SwarmZ.
- Everything is local: PTYs, usage parsing and persistence all happen on your machine. SwarmZ's only own network requests are the key-less OpenRouter pricing catalog and the Anthropic usage endpoint for your plan limits (authenticated with your local Claude Code login; the token never leaves your machine except to Anthropic).

## 🤝 Contributing

Issues and PRs welcome. Before submitting:

- `./node_modules/.bin/tsc --noEmit` must pass.
- UI changes should follow the design system in [`DESIGN.md`](DESIGN.md) (monochrome first, blue is a signal, numbers are mono).
- New backend capabilities go into `backend-types.ts` and must be implemented for **both** Tauri and web mode.
