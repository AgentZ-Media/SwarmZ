<div align="center">

# ⚡ SwarmZ

**Run and monitor a swarm of native Codex agents — structured sessions, live diffs & approvals, with an AI Conductor on top.**

Native macOS app · your app state stays local — model traffic goes to OpenAI via the Codex CLI (ChatGPT login)

</div>

---

> **Rebuild in progress (branch `rebuild/codex-only-v1`).** SwarmZ is being
> rebuilt as a pure swarm manager over the `codex app-server` (ChatGPT
> subscription). The former terminal/PTY grid, the Claude runtime, the
> OpenRouter brain and voice dictation were removed in Phase 1 of
> `docs/plans/rebuild-codex-only-v1.md` — the released terminal-grid app
> lives on the `main` branch and in the published releases. This README is
> an interim snapshot; the full rewrite lands at the end of the rebuild.

Each agent is a **native Codex session** driven directly through the Codex app-server — no PTY, no terminal emulation. Work arrives as structured cards: streaming assistant messages (rendered as markdown), collapsible command output, syntax-highlighted **diff cards**, plans, and **approval prompts** you allow or decline right in the composer (`⏎` allow · `⎋` decline).

Built with **React 19 + TypeScript + Tailwind v4** on Tauri 2 (Rust). Dark mode only — by design.

## ✨ What works in the current interim state

- 🌈 **Native Codex sessions** — start a session on any folder (a git worktree folder works too), pick its model, reasoning effort and access (`workspace-write` or full). A left rail lists every session with its live signal (working / needs you / finished / idle) and diff counter; sessions resume their thread across app restarts.
- 🤖 **Conductor (orchestrator)** — `⌘⇧O` focuses an AI team lead PER PROJECT: each project tab gets its own Conductor (own process, own chats, own memory) that inspects that project's sessions and transcripts, checks git status, discovers your projects, prompts sessions and spins up new ones via project-scoped tools — and pings you (and its own context) when a session it tasked finishes or waits for an approval. Runs on your ChatGPT subscription via the codex CLI. Persona (Maestro/Hive/Orchestrator presets, editable voice) + a small curated memory it writes via an explicit `remember` tool (global + per-project scope).
- ✅ **Approvals stay human** — session approvals surface as cards in the composer; the orchestrator can never approve anything itself.
- 🗂️ **`@session` routing** — in the Conductor composer, `@name …` sends a message straight to that session instead of the orchestrator.
- 📊 **Deck** — a slim status bar with the needs-you triage queue (`⌘⇧A` jumps to the oldest), a fleet event ticker, the account-level Codex plan meters and the orchestrator status dot.
- 🌳 **Git worktrees** — the worktree management panel (title bar) lists SwarmZ worktrees per repo with live dirty/ahead state, reveal-in-Finder, open-in-session and a safe bulk cleanup. (Creating worktrees from the UI returns with the orchestrator's worktree tools in a later phase.)
- 📝 **Quick notes** (`⌘N`), **command palette** (`⌘K`), **usage dashboard** (all-time Codex history), auto-updates.

## 🚀 Quick start

1. Install the [Codex CLI](https://developers.openai.com/codex/cli) (≥ 0.144) and log in with your ChatGPT account.
2. `pnpm install` · `pnpm tauri dev` (or grab a release build from `main` for the released terminal-grid app).
3. `⌘T` starts a session; `⌘⇧O` talks to the Conductor.

## ⌨️ Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘T` | New session |
| `⌘⇧O` | Focus the Conductor (orchestrator chat) |
| `⌘⇧A` | Jump to the oldest session waiting for you |
| `⌘K` | Command palette |
| `⌘N` | Quick notes |
| `⌘,` | Settings |
| `⏎` / `⎋` | Allow / decline a pending approval (in the composer takeover) |

## 🏗️ Architecture

See `AGENTS.md` (map + invariants) and `docs/ARCHITECTURE.md` (per-subsystem deep dive). Short version: a generic `codex app-server` host in Rust (`src-tauri/src/codex/`) drives one private process per session and one process per project for that project's Conductor (spawned lazily, reaped after 15 idle minutes, transparently resumed); the orchestrator's tools are defined once in Rust (`orchestrator/registry.rs`) and execute in the webview against the Zustand stores, scoped to the calling Conductor's project.

## 🤝 Contributing

Issues and PRs welcome. Note the rebuild plan in `docs/plans/rebuild-codex-only-v1.md` before proposing features — the UI and data model are mid-rebuild.
