<div align="center">

# ⚡ SwarmZ

**A native macOS swarm manager for Codex agents — with an autonomous AI Conductor per project.**

Run a swarm of native Codex sessions in project tabs. A Conductor per project decomposes your goals onto named sub-agents in git worktrees, steers and reviews them, sets its own follow-ups, and learns your preferences.

Your app state stays local · model traffic goes to OpenAI through the Codex CLI (your ChatGPT sign-in) · no OAuth, no tokens.

</div>

---

Each agent is a **native Codex session** driven directly through the `codex app-server` — no PTY, no terminal emulation. Work arrives as structured cards: streaming assistant messages (rendered as markdown), collapsible command output, syntax-highlighted **diff cards**, plans, and **approval prompts** you allow or decline right in the composer (`⏎` allow · `⎋` decline).

Sessions live in **project tabs** — one per folder, deduped by canonical path, resumable across restarts. Each project keeps its own swarm, its own Conductor and its own memory.

Built with **React 19 + TypeScript + Tailwind v4** on Tauri 2 (Rust). Dark mode only — by design (`DESIGN.md`).

## ✨ Features

- 🤖 **A Conductor per project** — each tab gets its own AI engineering lead: its own Codex process (spawned lazily, reaped after 15 idle minutes, transparently resumed), its own chats and its own scoped memory. Give it a goal and it **delegates by default** — decomposing the work onto up to 8 named sub-agents, each in its own git worktree, then steering (`prompt_agent`), reviewing (`review_agent`) and reconfiguring them per task. Persona (Maestro / Hive / Orchestrator presets, editable voice) plus a small curated memory it writes via an explicit `remember` tool.
- 🧠 **Genuinely autonomous** — fleet events (an agent finishes, an agent asks for direction, a routine approval lands, a timer fires, a lane sits idle, a watched PR changes) wake the Conductor for a **budget-gated** turn: it judges the result, hands out follow-ups, reports back and learns. Agents deliver schema-forced status reports so it always knows what happened. A per-project circuit breaker (5 consecutive / 20 per hour, only a human message re-arms it) caps runaway cascades; every event payload is treated as untrusted data.
- 🌳 **Git worktrees, managed** — the Conductor creates worktrees per lane, re-homes agents and cleans up under a safe gate that never force-removes work. A worktree panel (title bar) lists every SwarmZ worktree per repo with live dirty/ahead state, reveal-in-Finder, open-in-session and a safe bulk cleanup.
- ✅ **Approvals stay human** — session approvals surface as cards in the composer. The Conductor gets a *fast lane* for genuinely routine approvals, but the classifier is **fail-closed and Rust-anchored**: any shell metasyntax, interpreter, foreign path, delete or rename is destructive and stays human-only, enforced server-side. In doubt, always the human.
- 🐙 **GitHub, opt-in and local-only** — SwarmZ reads and (optionally) manages a project's GitHub context over your locally installed **`gh` CLI**. There is **no OAuth, no login flow, and no token ever touches SwarmZ**. Read-only detection and the PR panel work always; a single Settings toggle (default off) arms the Conductor's PR tools, the write gate, PR-approval routing and a PR watcher. Deliberately **no merge/close** command anywhere — merging stays yours.
- 🗂️ **Fleet grid + focus stage** — a dot-grid of live agent cards for the active project (status, worktree branch, ±diff, mini feed, quick approvals) plus a focus stage to expand one agent full-window. `@agent` in the Conductor composer talks to a session directly.
- 📊 **Deck** — a slim status bar: global needs-you triage queue (`⌘⇧A`), a fleet event ticker, account-level Codex plan meters, a PR indicator and the Conductor status dot.
- 📝 **Quick notes** (`⌘N`), **command palette** (`⌘K`), **usage dashboard** (all-time Codex history), in-app auto-updates.

## 🚀 Quick start

1. Install the [Codex CLI](https://developers.openai.com/codex/cli) (≥ 0.144) and sign in with your ChatGPT account. Optionally install the [GitHub CLI](https://cli.github.com) (`gh`) for the GitHub integration.
2. `pnpm install` · `pnpm tauri dev`
3. `+` (title bar) opens a project folder · `⌘T` starts an agent · `⌘⇧O` (or `⌘B`) talks to the Conductor.

## ⌨️ Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘T` | New agent (Codex session) |
| `⌘B` | Toggle the Conductor sidebar |
| `⌘⇧O` | Show the Conductor (sidebar + fleet) |
| `⌘⇧A` | Jump to the oldest agent waiting for you |
| `⌘1`–`⌘9` | Switch to the n-th project tab |
| `⌘K` | Command palette |
| `⌘N` | Quick notes |
| `⌘,` | Settings |
| `⎋` | Back to fleet |
| `⏎` / `⎋` | Allow / decline a pending approval (in the composer takeover) |

## 🔒 Privacy

Your app state — sessions, chats, notes, settings, memory — stays on your machine (a local `swarmz.json` plus the Codex rollout files under `~/.codex`). Model traffic goes to OpenAI through the Codex CLI (your ChatGPT sign-in); GitHub actions go through your local `gh`. SwarmZ itself holds no account, no token and no server.

## 🏗️ Architecture

See `AGENTS.md` (map + invariants) and `docs/ARCHITECTURE.md` (per-subsystem deep dive). Short version: a generic `codex app-server` host in Rust (`src-tauri/src/codex/`) drives one private process per session and one process per project for that project's Conductor; the Conductor's tools are defined once in Rust (`orchestrator/registry.rs`) and execute in the webview against the Zustand stores, scoped to the calling Conductor's project. Design tokens and UI conventions live in `DESIGN.md`.

## 🛠️ Development

- Type-check: `./node_modules/.bin/tsc --noEmit`
- Build: `pnpm build`
- Dev: `pnpm tauri dev`
- Frontend unit tests: `pnpm test` (vitest) · Rust tests: `cargo test` in `src-tauri/`

## 🤝 Contributing

Issues and PRs welcome. Read `AGENTS.md` first — it carries the load-bearing invariants (selector purity, identity-preserving transcripts, the fail-closed approval classifier, the autonomy budget, the double-gated GitHub integration) that any change must respect.
