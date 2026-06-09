# CLAUDE.md

SwarmZ — run, tile and monitor multiple Claude Code agents in parallel. One React frontend, two backends: native macOS app (Tauri 2 / Rust) and a local web mode (Node engine).

## Stack & commands

- React 19 + TypeScript + Tailwind v4 (dark only — follow `DESIGN.md`), Zustand, xterm.js, pnpm
- Type-check: `./node_modules/.bin/tsc --noEmit` · Build: `pnpm build` · Dev: `pnpm tauri dev` (native) / `pnpm dev:web` (browser)

## Architecture in 10 seconds

- `src/lib/transport.ts` picks the backend at runtime. Every backend capability is declared in `backend-types.ts` and must be implemented in **both** `backend-tauri.ts` and `backend-web.ts`.
- `src/store.ts` holds all app state. Persisted: profiles + usage history (Tauri store `swarmz.json` / localStorage). In-memory only: agents, layout.
- Usage is parsed from `~/.claude/projects/*.jsonl` by `src-tauri/src/usage.rs` (native) and `server/usage.mjs` (web) — keep the two implementations and their pricing tables in sync.

## Releases & updates

- In-app auto-updater (`tauri-plugin-updater`) polls `latest.json` on GitHub Releases; frontend logic in `src/lib/updates.ts`, UI in `TitleBar.tsx`. Builds are ad-hoc signed only (no Apple notarization).
- Release checklist: bump version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` (keep in sync) → create `docs/release-notes/v<X.Y.Z>.md` (CI fails without it) → tag `v<X.Y.Z>` and push the tag → `.github/workflows/release.yml` builds macOS (Apple Silicon) and publishes the release incl. updater manifest.
- Updater signing key: `~/.tauri/swarmz_updater.key` (no password), repo secret `TAURI_SIGNING_PRIVATE_KEY`. Losing it breaks updates for existing installs.

## Ground rules

1. **Never start the dev server** or any long-running app process (`pnpm dev:web`, `pnpm tauri dev`, `pnpm engine`, …) without explicit approval first. Type-checks and builds that don't launch the app are fine.
2. **Never commit or push on your own.** Only when explicitly asked or approved.
3. **Keep docs in sync.** If a change affects anything stated in `CLAUDE.md` or `README.md`, update them in the same change — proactively, without being asked.
