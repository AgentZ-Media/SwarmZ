<div align="center">

# ⚡ SwarmZ

**Native macOS Mission Control for large Codex engineering goals.**

Turn a backlog into a durable Mission: dependencies, fresh temporary workers,
isolated worktrees, evidence-based quality gates, recovery and one integrated
result. A single fixed Orchestrator per project coordinates and learns; workers
never become reusable personalities.

Your app state stays local · model traffic goes to OpenAI through the Codex CLI (your ChatGPT sign-in) · no OAuth, no tokens.

</div>

---

Each worker is a **native Codex session** driven directly through the
`codex app-server` — no PTY and no terminal emulation. Work arrives as
structured cards: streaming assistant messages, collapsible command output,
syntax-highlighted diffs, evidence reports and approval prompts you allow or
decline in the composer (`⏎` allow · `⎋` decline).

Sessions and Missions live in **project tabs** — one per canonical folder,
resumable across restarts. Each project keeps its own Mission state, fleet,
fixed Orchestrator and scoped memory.

Built with **React 19 + TypeScript + Tailwind v4** on Tauri 2 (Rust). Dark mode only — by design (`DESIGN.md`).

## ✨ Features

- 🎯 **Durable Mission Control** — tasks, dependencies, attempts, artifacts,
  policies, schedules and decisions live in an event-sourced model rather than
  disappearing into chat. Board, Graph, Fleet, Integration and Timeline views
  expose progress, critical dependencies and the next human decision.
- 🤖 **One Orchestrator per project** — every tab gets the same product-owned
  engineering-lead identity, its own Codex process, chats and scoped memory.
  Persona presets and reusable worker profiles are gone. Only Orchestrator can
  learn through the explicit `remember` tool.
- ⚡ **Fresh bounded workers** — the scheduler admits up to 8 parallel,
  one-assignment attempts against live process capacity and a human-approved
  Mission Envelope. Every attempt receives its own deterministic worktree and
  is closed after its evidence becomes durable.
- ✅ **Evidence before success** — worker reports are untrusted. Native Git
  snapshots, exact scoped diffs, direct-argv command exits, review and usage
  artifacts must pass before a task becomes verified.
- 🚂 **Integration Train and recovery** — successful branches integrate in
  dependency order behind reproducible gates and durable checkpoints. Failed
  entries expose explicit Retry, Skip and typed-confirm Rollback actions.
- 🧪 **Runtime Environments** — configure direct-argv setup/cleanup, local
  services, ports and database namespaces. Acceptance commands run in a
  no-network macOS sandbox with a confined HOME and narrowly granted toolchains.
- 🧩 **Large-task intake and reuse** — import text, Markdown, CSV, JSON or
  GitHub Issues; apply playbooks and temporary task roles; coordinate multiple
  project roots; compare evidence-bound candidate attempts.
- 🧠 **Genuinely autonomous, visibly bounded** — worker completions, routine
  approvals, timers, idle lanes and watched PR changes wake budget-gated
  Orchestrator turns. A persisted circuit breaker caps runaway cascades.
- 🌳 **Git worktrees, managed** — worktrees carry live dirty/ahead state,
  reveal/open actions and safe cleanup that never silently force-removes work.
- ✅ **Approvals stay yours** — session approvals surface as cards in the composer. “Always allow” stores a bounded Codex-proposed command rule that you can edit or delete in Settings; Orchestrator worktrees additionally receive a Rust-verified commit/push lane for their own `swarm/*` branch. Everything else remains fail-closed and human-controlled.
- 🔎 **Reviews are opt-in and bounded** — the automated review/fix loop is off by default. Settings can enable it with a hard per-worktree iteration limit; review lanes are visible in Fleet, independent worktrees review in parallel, and findings stay in the original feature worktree.
- 🐙 **GitHub, opt-in and local-only** — SwarmZ reads and (optionally) manages a project's GitHub context over your locally installed **`gh` CLI**. There is **no OAuth, no login flow, and no token ever touches SwarmZ**. Read-only detection and the PR panel work always; a single Settings toggle (default off) arms the Conductor's PR tools, the write gate, PR-approval routing and a PR watcher. Deliberately **no merge/close** command anywhere — merging stays yours.
- 🗂️ **Fleet grid + focus stage** — live worker cards show status, branch,
  diff, feed and approvals; focus expands one lane. `@lane` in the Orchestrator
  composer continues that lane's one assignment.
- 📊 **Attention and insights** — one global Attention Inbox combines worker,
  task, integration and actionable PR/CI failures. Mission Insights summarizes
  throughput, risk, retries, ETA and cost from durable evidence.
- 📝 **Quick notes** (`⌘N`), **command palette** (`⌘K`), **usage dashboard** (all-time Codex history), in-app auto-updates.

## 🚀 Quick start

1. Install the [Codex CLI](https://developers.openai.com/codex/cli) (≥ 0.144) and sign in with your ChatGPT account. Optionally install the [GitHub CLI](https://cli.github.com) (`gh`) for the GitHub integration.
2. `pnpm install` · `pnpm tauri dev`
3. `+` opens a project · create a Mission for a large backlog · `⌘⇧O` (or
   `⌘B`) talks to Orchestrator · `⌘T` starts a manual temporary lane.

## ⌨️ Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘T` | New temporary worker lane |
| `⌘B` | Toggle the Orchestrator sidebar |
| `⌘⇧O` | Show Orchestrator and Mission Control |
| `⌘⇧A` | Open the global Attention Inbox |
| `⌘1`–`⌘9` | Switch to the n-th project tab |
| `⌘K` | Command palette |
| `⌘N` | Quick notes |
| `⌘,` | Settings |
| `⎋` | Back to fleet |
| `⏎` / `⎋` | Allow / decline a pending approval (in the composer takeover) |

## 🔒 Privacy

Your app state — projects, Missions, event logs, outbox records, runtime specs,
schedules, sessions, chats, notes, settings, budgets and Orchestrator memory —
stays on your machine (a local `swarmz.json` plus Codex rollout files under
`~/.codex`). Model traffic goes to OpenAI through the Codex CLI (your ChatGPT
sign-in); optional GitHub actions go through your local `gh`. SwarmZ itself
has no account, hosted service or OAuth flow.

## 🏗️ Architecture

See `AGENTS.md` (map + invariants) and `docs/ARCHITECTURE.md`
(subsystem deep dive). A generic Rust `codex app-server` host drives private
worker processes and one project Orchestrator. The frontend persists Mission
events, schedules and a fenced outbox; Rust owns filesystem, Git, process,
sandbox, evidence and GitHub authority. Design tokens and UI conventions live
in `DESIGN.md`.

## 🛠️ Development

- Type-check: `./node_modules/.bin/tsc --noEmit`
- Build: `pnpm build`
- Dev: `pnpm tauri dev`
- Frontend unit tests: `pnpm test` (vitest) · Rust tests: `cargo test` in `src-tauri/`

## 🤝 Contributing

Issues and PRs welcome. Read `AGENTS.md` first — it carries the load-bearing invariants (selector purity, identity-preserving transcripts, the fail-closed approval classifier, the autonomy budget, the double-gated GitHub integration) that any change must respect.
