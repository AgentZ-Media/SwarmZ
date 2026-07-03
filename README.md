<div align="center">

# ⚡ SwarmZ

**Run, tile and monitor a swarm of Claude Code and Codex CLI agents — real terminals, live tokens & cost.**

Native macOS app · 100% local — nothing ever leaves your machine

</div>

---

Each agent is a real PTY-backed terminal running Claude Code or ChatGPT Codex CLI from your system `PATH`, tiled into a resizable split-grid with per-agent usage tracking parsed from `~/.claude` and `~/.codex`. Native macOS app — Tauri 2 (Apple Silicon), PTYs handled in Rust.

Built with **React 19 + TypeScript + Tailwind v4**. Dark mode only — by design.

## ✨ Features

- 🖥️ **Real terminals** — every agent is a PTY-backed login shell (`xterm.js` ↔ `portable-pty`). `claude`, `codex`, nvm, aliases and your environment resolve exactly like in iTerm or Terminal.
- 🗂️ **Workspaces** — tabs in the title bar, each with its own tiling grid. A workspace is whatever you need it to be: one repo, one feature with several worktrees, or a mixed monitoring wall. The first project folder names the tab automatically; every tab shows a live status dot and `busy/total` count. Switch with `⌘1–9` (or `⌘⇧[` / `⌘⇧]`), rename with a double-click, reorder by dragging, and drag any pane's header onto a tab to move that agent — terminal, scrollback and running processes come along untouched. Tabs (name, order, default folder) survive restarts.
- 🧩 **Workspace presets** — don't start from an empty window: every empty workspace offers preset cards with a mini layout thumbnail — one click spawns the whole grid (`⌘⇧N` → pick a card = a full new setup in two keystrokes). Ships with editable starter grids (Solo, 1×2, 2×2, 1+2); save your own via `⌘K` → **Save workspace as preset**, which captures the current layout plus each pane's folder, startup command and profile. Panes can pin a fixed folder or **inherit** one — then loading asks for the folder once and all inheriting panes start there. The tab takes the preset's name. Manage everything in Settings → Presets: rename, change a pane's folder or command, remove panes, delete presets.
- 🔁 **Session restore** — quit SwarmZ and the next launch brings everything back: every workspace, the exact pane layout, and each Claude/Codex pane reopens its previous conversation (`claude --resume` or `codex resume`). The grid is saved continuously, so even after a crash the last state comes back. Off by default — enable it in Settings (floating terminals don't come back — they're plain shells).
- 🛰️ **Fleet overview** — `⌘E` zooms out to every workspace at once, live: real terminals scaled down, not snapshots. Workspaces needing attention pulse blue; click any pane to jump straight to it. The perfect second-monitor view while a dozen agents work.
- ⌨️ **Command palette** — `⌘K` fuzzy-jumps to any agent or workspace and reaches every global action without the mouse. `⌘⇧A` cycles through agents waiting for your input, across all workspaces.
- 📋 **Custom commands** — `⌘⇧K` opens an insert picker with your saved prompt snippets, global or per project folder. Selecting one **pastes** it into the active pane without submitting (`⌘↵` pastes & runs), so you can still edit before sending. Snippets support placeholders: `{{folder}}`, `{{cwd}}`, `{{branch}}` and `{{agent}}` fill in from the pane, `{{input:Label}}` asks for a value right before inserting. Saved commands also show up in the `⌘K` palette once you start typing a search — same semantics, straight from there. Manage them in Settings → Commands, or save new ones straight from the picker.
- 📝 **Quick notes** — `⌘N` (or the note button in the title bar) slides in a lightweight checklist drawer: type, Enter, captured — no switching to a notes app mid-flow. Items check off, edit inline, reorder by drag, or turn into plain text lines. One **global** list plus one **per project folder** — the drawer opens in the context of the active pane (worktree panes count as their main repo), and everything survives restarts.
- 🎙️ **Voice dictation** — hold plain `⌘` (push-to-talk: recording arms after a brief moment, so ordinary ⌘-shortcuts never trigger it; release to transcribe — or switch to `⌘⇧M` toggle mode in Settings) or click the mic in any pane or floating-terminal header and just speak. Recordings under ~1 s are discarded silently. A small pill with a live waveform shows the recording; on release the audio is transcribed and pasted into that terminal — review and hit Enter, or enable auto-submit. Up to 5 minutes per dictation (long recordings are transcribed in segments). Two engines (Settings → Voice): **Cloud** via OpenRouter speech-to-text (default: `microsoft/mai-transcribe-1.5`, 100+ languages with auto-detection; needs an API key, stored in the macOS Keychain — all requests run natively, without a key the mic UI stays hidden) or **Local** via [NVIDIA Parakeet TDT 0.6b v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) (int8 ONNX, 25 languages) running fully on-device through a statically linked ONNX Runtime — no internet, key or extra installs needed; a one-time ~670 MB model download from Settings, ~1.5–2 GB of RAM while transcribing (loaded on first dictation, freed when switching back to Cloud). An optional cleanup pass sends the transcript through an LLM of your choice (default `google/gemini-3.5-flash`, picked from the live OpenRouter catalog, reasoning minimized for speed) with an editable prompt that strips filler words but never translates — cleanup always runs via OpenRouter, so it needs a key even with the local engine.
- 📎 **Drag & drop files** — drag an image (or any file) from Finder onto a terminal and its path is pasted in, escaped exactly like Terminal.app does. While dragging, every terminal shows a drop zone and the one under the cursor lights up; works on panes and floating terminals alike.
- 🧱 **Tiling split-grid** — split any pane right (`⌘D`) or down (`⌘⇧D`), drag dividers to resize, or grab a pane's header to rearrange: drop it on another pane's edge to dock it there (left/right/top/bottom) or on the center to swap the two. Both gestures show a translucent preview while dragging; the layout applies on release, so terminals don't reflow mid-drag (`Esc` cancels). Splitting opens the New Agent dialog prefilled with the source pane's folder, profile and startup command. Panes never remount when the grid is rearranged, so scrollback survives.
- 🪟 **Floating terminals** — open a small picture-in-picture shell on top of any pane (`⌘J`, the terminal button in the header, or the ⋯ menu), running in the pane's folder — perfect for a dev server or quick git commands without leaving SwarmZ. Drag it anywhere, resize it from the corner, or collapse it to a slim pill while the process keeps running. A quick-command bar offers one-click **presets saved per project folder** plus commands **auto-detected from the project**: `package.json` scripts (run with the package manager your lockfile implies), Cargo targets, Makefile and justfile recipes. Everything is editable in place — editing a detected command saves it as a preset that **overrides** the original, and detected commands can be hidden per folder (and restored). The window names itself after the last command you ran, typed or clicked. Closing a pane checks its floating terminals first — if a process is still running you choose between killing it or **detaching** the terminal, which keeps it alive as an unowned floating pill.
- 🔍 **Focus mode** — the maximize button in any pane header (or a double-click on the header) zooms that pane into an overlay above the dimmed grid, for when one agent needs your full attention. Everything else keeps running underneath — click the backdrop or the button again to drop back into the grid. Nothing remounts, so scrollback and sessions are untouched.
- 📊 **Usage tracking** — model, tokens, context and tracked/estimated cost per agent, parsed from Claude (`~/.claude/projects/*.jsonl`) and Codex (`~/.codex/sessions/**/*.jsonl`) session files. Shown on demand: a stats button in every pane header and a global usage drawer — headers stay clean.
- 🍩 **Context gauge** — a donut plus a `free/total` readout in each pane header shows how much of the agent's context window is left (turns amber/red as it fills).
- 🌿 **Git at a glance** — panes whose folder is inside a git repo show the branch plus live diff counters: `+added` / `−removed` lines (green/red) and untracked files, refreshed every few seconds, strictly read-only. Repo name and an **Open repo in browser** action (from the `origin` remote) live in the pane menu and stats popover.
- 🌳 **Git worktrees** — let several agents change the *same repo* in parallel without stepping on each other: flip the **worktree toggle** in the New Agent dialog (shown whenever the chosen folder is a git repo) and the pane gets its own branch and folder under `<repo>/.worktrees/` (ignored via the repo-local `.git/info/exclude` — your `.gitignore` is never touched). Branch names are generated (`myrepo/brave-falcon-7341` — reroll with the dice, or type your own); **Copy environment** (on by default) brings every untracked file along — `.env`s, local configs, keys — while skipping heavyweights like `node_modules`. Splitting a worktree pane preselects the toggle with a fresh branch, so "one more parallel worker" takes two clicks. Closing the pane cleans up smartly: a clean worktree (nothing uncommitted, no commits only it has) is removed silently along with its branch — re-checked right before deletion, so work that appeared while a dialog was open is never lost; one that still holds work asks **keep or delete**. Heads-up: gitignored files (like the copied `.env`s or local scratch files) don't count as work — they go down with a clean close, so keep anything irreplaceable out of the worktree or commit it. Kept and orphaned worktrees live in a title-bar panel (it appears only while worktrees exist), grouped per repo with live uncommitted/unmerged state and open-in-pane / reveal-in-Finder / delete actions. Merging back stays your (or your agent's) call — a worktree is a normal checkout, so commit, push or merge right from the pane.
- 📐 **Responsive pane headers** — as a pane gets narrower it sheds secondary info (folder path, git counters, gauge readout, split buttons) until only the title, model, context donut and focus button remain; everything stays reachable via tooltips and the ⋯ menu.
- 📈 **Plan limits** — the title bar shows Claude subscription limits from the local Claude Code login and Codex limit windows reported by active Codex sessions.
- 💾 **All-time statistics** — every tracked Claude or Codex session launched inside SwarmZ is persisted across restarts. The usage drawer toggles between **Session** (what's open right now) and **All time** (everything you've ever run here), with per-model/runtime breakdowns and session history.
- 🏷️ **Auto-naming** — Claude terminal titles and Codex thread names are captured automatically. Rename a pane yourself and the auto-title backs off; clear the name to hand it back.
- 🚦 **Live status** — the pane status dot mirrors what the agent is doing: amber while it's working, green when idle, blue when it waits for input. Claude status comes from terminal progress reporting; Codex status comes from its local session events. Every workspace tab sums up its agents live (`2/4` busy), and quitting the app raises a warning first whenever it would lose something — agents still working, or open terminals that wouldn't be restored.
- 🔔 **Notifications** — when an agent rings the terminal bell or asks for attention, the pane pulses and a native notification fires.
- 🎛️ **Profiles** — presets for runtime, startup command, flags and default working directory, persisted across restarts. New agents prefill the profile's default folder, or the last folder you used.
- 🔄 **Auto-updates** — the native app checks GitHub Releases in the background and updates in-app; manual check and an automatic-download toggle live in Settings.
- ⚙️ **Settings** — `⌘,` (or the gear in the title bar) opens a settings window: session restore, workspace presets, custom commands, voice dictation (engine cloud/local incl. local-model download, OpenRouter key, hotkey mode, auto-submit, cleanup model & prompt), default terminal font size, default startup command, path overrides for the `claude`, `codex` and `git` binaries, update controls and an About panel.

## 📦 Download

Grab the latest `.dmg` from [**Releases**](https://github.com/AgentZ-Media/SwarmZ/releases) (macOS, Apple Silicon).

SwarmZ is **not notarized by Apple** (indie release) — after installing, clear the quarantine flag once:

```bash
xattr -cr /Applications/SwarmZ.app
```

(or right-click the app → **Open** → **Open**). Updates after that are delivered in-app.

## 🚀 Quick start

Requires [pnpm](https://pnpm.io) and at least one agent CLI: [Claude Code](https://claude.com/claude-code) (`claude` on your `PATH`) or [ChatGPT Codex CLI](https://developers.openai.com/codex) (`codex` on your `PATH`).

```bash
pnpm install
pnpm tauri dev          # dev
pnpm tauri build        # → src-tauri/target/release/bundle/
```

## ⌨️ Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘T` | New agent |
| `⌘K` | Command palette |
| `⌘⇧K` | Insert a custom command into the active pane |
| `⌘` (hold) | Voice dictation into the active pane — push-to-talk, release to transcribe |
| `⌘⇧M` | Voice dictation in toggle mode (press to start/stop — see Settings → Voice) |
| `⌘N` | Quick notes drawer (global + per-project checklists) |
| `⌘E` | Fleet overview (all workspaces live) |
| `⌘⇧A` | Jump to the next agent waiting for input |
| `⌘1` … `⌘9` | Switch workspace |
| `⌘⇧[` / `⌘⇧]` | Previous / next workspace |
| `⌘⇧N` | New workspace |
| `⌘⇧W` | Close current workspace |
| `⌘D` | Split active pane right |
| `⌘⇧D` | Split active pane down |
| `⌘W` | Close active agent |
| `⌘J` | Floating terminal on the active pane |
| `⌘+` / `⌘−` | Zoom active pane in / out (per-pane font size) |
| `⌘0` | Reset active pane zoom |

## 🏗️ Architecture

```
src/lib/transport.ts      the transport layer — frontend ↔ backend
  backend-types.ts        the Backend interface — every capability lives here
  backend-tauri.ts        Tauri webview → Rust invoke + events

src/
  store.ts                zustand store (workspaces, agents, layout trees, profiles, usage history)
  lib/layout.ts           tiling binary-tree ops (split / remove / resize / move-swap / rects)
  lib/term-host.ts        terminals live HERE, outside React — xterm + PTY per id,
                          panes only attach/detach the DOM (move across workspaces freely)
  lib/updates.ts          auto-updater (background poll + manual check)
  lib/git.ts              per-pane git status poller (branch, ±lines, untracked)
  lib/dnd.ts              OS file drag & drop → escaped path typed into the target terminal
  components/
    Terminal.tsx          thin attach-wrapper around term-host
    WorkspaceLayer.tsx    always-mounted grid per workspace + fleet overview (⌘E)
    TilingGrid.tsx        absolute-positioned pane layout + resizers (per workspace)
    TitleBar.tsx          workspace tab strip + limits / update / global actions
    CommandPalette.tsx    ⌘K palette (cmdk) — jump to agents, workspaces, actions
    InsertCommandPalette.tsx  ⌘⇧K insert picker — custom prompt snippets, pasted not run
    AgentPane.tsx         pane header (model / context gauge / tokens / cost / controls)
    FloatingTerminals.tsx PiP shell windows + per-project quick-command bar
    UsageDashboard.tsx    usage drawer — Session & All-time views
    QuickNotesPanel.tsx   ⌘N quick-notes drawer — global + per-project checklists

src-tauri/src/            the Rust backend
  pty.rs                  PTY spawn / read / write / resize / kill (output coalesced)
  usage.rs                incremental JSONL parsing (per-file offset cache), pricing
  git.rs                  read-only git status (branch, ±lines, untracked, remote)
  project.rs              auto-detected project commands (scripts / cargo / make / just)
  openrouter.rs           voice dictation backend — Keychain key, speech-to-text, cleanup
  localstt.rs             local voice dictation — Parakeet via ONNX Runtime, model download
  lib.rs                  commands, plugins, usage file-watcher
```

### Cost model

Claude per-model pricing (USD / 1M tokens, incl. cache write/read) is fetched live from the free, key-less [OpenRouter model catalog](https://openrouter.ai/api/v1/models) — once per run, refreshed daily, matched by normalized model id. Codex sessions report tokens/context/limits locally; ChatGPT-plan Codex rollouts do not include a reliable USD cost, so SwarmZ shows tracked cost only where a parser can estimate it. While offline (or for unknown Claude ids) a hardcoded per-family fallback applies:

| Family | Input | Output | Cache write | Cache read |
| --- | --- | --- | --- | --- |
| Fable | 10 | 50 | 12.50 | 1.00 |
| Opus | 5 | 25 | 6.25 | 0.50 |
| Sonnet | 3 | 15 | 3.75 | 0.30 |
| Haiku | 1 | 5 | 1.25 | 0.10 |

### Persistence

| Data | Persisted | Where |
| --- | --- | --- |
| Profiles | ✅ | Tauri store (`swarmz.json`) |
| Usage history (all-time stats) | ✅ | Tauri store (`swarmz.json`) |
| Command presets (per project folder) | ✅ | Tauri store (`swarmz.json`) |
| Custom commands (global + per project folder) | ✅ | Tauri store (`swarmz.json`) |
| App settings (Settings window: last used folder, font size, default command, binary paths, auto-update, dictation preferences) | ✅ | Tauri store (`swarmz.json`) |
| OpenRouter API key (voice dictation) | ✅ | macOS Keychain (`SwarmZ-OpenRouter`) |
| Workspace tabs (name, order, default folder, active tab) | ✅ | Tauri store (`swarmz.json`) |
| Workspace presets (layouts + pane templates) | ✅ | Tauri store (`swarmz.json`) |
| Agents & layout (grid snapshot for session restore) | ✅ | Tauri store (`swarmz.json`) |
| Window size & position | ✅ | `tauri-plugin-window-state` |
| Floating terminals | ❌ per session | in-memory |

Usage history only records Claude/Codex sessions launched **inside SwarmZ** — plain shells and dev servers never show up in the stats. Snapshots are stored locally, so all-time numbers survive even if the upstream session files are cleaned up.

## 📝 Notes

- The terminal runs whatever your `claude` or `codex` resolves to. If a pane shows `zsh: permission denied`, fix or reinstall that CLI rather than SwarmZ.
- Everything is local: PTYs, usage parsing and persistence all happen on your machine. SwarmZ's only own network requests are the key-less OpenRouter pricing/model catalog, the Anthropic usage endpoint for Claude plan limits (authenticated with your local Claude Code login; the token never leaves your machine except to Anthropic), and — only when you use voice dictation with the Cloud engine — your recordings to the OpenRouter transcription/chat endpoints, authenticated with your own key from the Keychain. Codex usage/limits are read from local Codex session files. With the Local engine recordings never leave the machine (the one-time model download comes from Hugging Face).

## 🤝 Contributing

Issues and PRs welcome. Before submitting:

- `./node_modules/.bin/tsc --noEmit` must pass.
- UI changes should follow the design system in [`DESIGN.md`](DESIGN.md) (monochrome first, blue is a signal, numbers are mono).
- New backend capabilities go into `backend-types.ts` and are implemented in `backend-tauri.ts`.
