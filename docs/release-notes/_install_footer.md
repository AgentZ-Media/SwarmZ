---

## Install (macOS, Apple Silicon)

1. Download the `.dmg` below, open it and drag **SwarmZ** into `Applications`.
2. SwarmZ is **not notarized by Apple** (indie release). On first launch macOS
   will block it — clear the quarantine flag once:

   ```bash
   xattr -cr /Applications/SwarmZ.app
   ```

   (or right-click the app → **Open** → **Open**.)
3. Requires a working [Codex CLI](https://developers.openai.com/codex/cli)
   (≥ 0.144) signed in with your ChatGPT account — `codex` must resolve on your
   `PATH`. The [GitHub CLI](https://cli.github.com) (`gh`) is optional and
   powers the opt-in GitHub integration.

Updates after this are delivered **in-app** via the built-in updater.
