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
- 🧱 **Tiling split-grid** — split any pane right (`⌘D`) or down (`⌘⇧D`), drag dividers to resize. Panes never remount when the grid is rearranged, so scrollback survives.
- 📊 **Live usage** — model, tokens and **USD cost** per agent in real time, parsed from `~/.claude/projects/*.jsonl`.
- 💾 **All-time statistics** — every Claude session launched inside SwarmZ is persisted across restarts. The usage drawer toggles between **Session** (what's open right now) and **All time** (everything you've ever run here), with a per-model cost breakdown and session history.
- 🔔 **Notifications** — when an agent rings the terminal bell (Claude waiting or done), the pane pulses and a native (or browser) notification fires.
- 🎛️ **Profiles** — presets for startup command, flags and default working directory, persisted across restarts.

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
  components/
    Terminal.tsx          xterm ↔ PTY bridge
    TilingGrid.tsx        absolute-positioned pane layout + resizers
    AgentPane.tsx         pane header (model / tokens / cost / controls)
    UsageDashboard.tsx    usage drawer — Session & All-time views
    WebDirectoryPicker.tsx server-backed folder picker (web mode)

server/                   the Node "engine" (web mode)
  index.mjs               http + static + WebSocket PTYs + usage SSE + fs browser
  usage.mjs               JSONL parsing, pricing, mtime-cached aggregation

src-tauri/src/            the Rust backend (native mode)
  pty.rs                  PTY spawn / read / write / resize / kill
  usage.rs                JSONL parsing, pricing, mtime-cached aggregation
  lib.rs                  commands, plugins, usage file-watcher
```

### Cost model

Pricing (USD / 1M tokens), applied per model family while parsing usage:

| Family | Input | Output | Cache write | Cache read |
| --- | --- | --- | --- | --- |
| Opus | 15 | 75 | 18.75 | 1.50 |
| Sonnet | 3 | 15 | 3.75 | 0.30 |
| Haiku | 1 | 5 | 1.25 | 0.10 |

### Persistence

| Data | Persisted | Where |
| --- | --- | --- |
| Profiles | ✅ | Tauri store (`swarmz.json`) / localStorage |
| Usage history (all-time stats) | ✅ | Tauri store (`swarmz.json`) / localStorage |
| Agents & layout | ❌ per session | in-memory |

Usage history only records Claude sessions launched **inside SwarmZ** — plain shells and dev servers never show up in the stats. Snapshots are stored locally, so all-time numbers survive even if `~/.claude` session files are cleaned up.

## 📝 Notes

- The terminal runs whatever your `claude` resolves to. If a pane shows `zsh: permission denied: claude`, your Claude Code install is missing its platform-native binary — reinstall Claude Code, not SwarmZ.
- Everything is local: PTYs, usage parsing and persistence all happen on your machine. SwarmZ makes no network requests of its own.

## 🤝 Contributing

Issues and PRs welcome. Before submitting:

- `./node_modules/.bin/tsc --noEmit` must pass.
- UI changes should follow the design system in [`DESIGN.md`](DESIGN.md) (monochrome first, blue is a signal, numbers are mono).
- New backend capabilities go into `backend-types.ts` and must be implemented for **both** Tauri and web mode.
