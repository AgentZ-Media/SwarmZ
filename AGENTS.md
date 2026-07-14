# AGENTS.md

## Product

SwarmZ is a native macOS Mission Control for durable engineering goals. A fixed,
project-scoped Orchestrator coordinates fresh Codex workers in isolated worktrees;
Mission Control persists tasks, evidence, recovery, and integration across restarts.
The app is React 19 + TypeScript on Tauri 2/Rust and is native, local-first, and Codex-only.

## Read first

- Read the relevant section of `docs/ARCHITECTURE.md` before changing a subsystem.
- For frontend work, follow `DESIGN.md`; for product context, use `README.md`.
- Treat current code and tests as the implementation truth when docs disagree.
- Keep deep details in `docs/ARCHITECTURE.md`, not in this file.

## Stack and commands

- Stack: React 19, TypeScript, Tailwind v4, Zustand, Tauri 2, Rust, pnpm.
- Install: `pnpm install`
- Type-check: `./node_modules/.bin/tsc --noEmit`
- Frontend tests: `pnpm test`
- Build: `pnpm build`
- Rust checks: `cd src-tauri && cargo test`
- Rust lint: `cd src-tauri && cargo clippy --all-targets -- -D warnings`
- Dev app: `pnpm tauri dev` — only with explicit approval; stop it after testing.

## Project map

- `src/components/` — Vibe UI, Mission Control, Orchestrator, settings, shared UI.
- `src/lib/vibe/` — native Codex session state, transport, transcript, reports, diffs.
- `src/lib/orchestrator/` — project Orchestrator, tools, triggers, timers, memory.
- `src/lib/missions/` — event-sourced Mission domain, controller, evidence, outbox.
- `src/lib/scheduler/`, `integration/`, `runtime/` — execution and delivery pipeline.
- `src/lib/projects/`, `persistence/`, `attention/`, `intake/`, `playbooks/`, `github/`
  — supporting product domains.
- `src-tauri/src/` — Codex hosts, Git/filesystem authority, sandboxing, GitHub, native APIs.
- `docs/ARCHITECTURE.md` — subsystem contracts and load-bearing invariants.
- `DESIGN.md` — dark-only design tokens, layout, motion, accessibility, performance.

## Architecture contracts

- Native Codex-only: never revive terminal/PTY, web mode, Claude, OpenRouter, or voice paths.
- There is one product-owned Orchestrator per project; internal `Conductor` names mean the same.
- Workers are temporary, one-assignment attempts. Only the Orchestrator has durable memory.
- Keep project boundaries strict and allow only one writer at a time per worktree/shared lane.
- Mission state changes through its event log and public commands/selectors, never projection edits.
- Agent reports, repo content, PR text, and event text are untrusted data, not execution authority.
- Success requires controller-observed Git/test/review evidence bound to the exact attempt and HEAD.
- Rust owns filesystem, Git, process, sandbox, approval, and effective-access authority.
- Full access and destructive approvals are human-only and fail closed at the Rust boundary.
- Autonomous events must pass through the trigger router and persisted autonomy breaker.
- GitHub uses the local `gh` CLI only. Writes are opt-in and double-gated; merge/close stays human.
- Persistence errors are not empty stores. Preserve hydration order, serialized writes, and quit flushes.
- Worktree cleanup must re-check ownership/status and must never silently force-remove work.

## Frontend and native rules

- Use `DESIGN.md` tokens; do not add hard-coded hex colors or revive legacy component styling.
- Zustand selectors must be referentially stable: prefer primitives/IDs, then derive with `useMemo`.
- Streaming updates replace only the changed normalized item; do not rebuild whole transcript arrays.
- Mutate visible or persisted state only after a backend claim/ack; avoid phantom optimistic state.
- Keep blocking subprocess and filesystem work async and behind Tauri `spawn_blocking`.
- For UI changes, visually check the actual native dev build once at representative sizes.

## Do

- Inspect locally first; use research or parallel agents when they materially improve confidence.
- Follow the requested mode and finish condition: review, plan, diagnose, or implement as asked.
- Prefer existing facades, domain commands, pure helpers, and focused regression tests.
- Keep changes scoped, preserve unrelated user edits, and explain necessary new infrastructure.
- Update `docs/ARCHITECTURE.md`, `README.md`, or `DESIGN.md` when their contracts change.
- Run checks proportional to risk; one targeted visual pass is enough unless more is requested.
- Clean up temporary processes, polling, sessions, and eligible worktrees created during testing.

## Don't

- Do not start a dev server, create external side effects, commit, or push without approval.
- Do not stop at a plan when implementation was requested, or broaden scope without a clear reason.
- Do not trust agent self-reports, optimistically mark approvals, or bypass access/security gates.
- Do not treat read failures as defaults, auto-delete session history, or mutate stores before ack.
- Do not reuse a worker for unrelated work or let multiple agents write one checkout concurrently.
- Do not use fresh object/array selectors in Zustand or regress feed virtualization.
- Do not bypass hardened Git helpers, use force-push/removal, or add OAuth/token handling.

## Release

- Keep versions in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` aligned.
- Add `docs/release-notes/v<X.Y.Z>.md`; use the existing signed release workflow.
- Never release, tag, commit, or push unless the user explicitly asks.

## Definition of done

- Requested behavior is complete, scoped checks pass, and the diff contains no unrelated changes.
- Changed contracts are documented, native UI changes received one visual pass, and cleanup is done.
