---

## Install (macOS, Apple Silicon)

1. Download the `.dmg` below, open it and drag **SwarmZ** into `Applications`.
2. SwarmZ is **not notarized by Apple** (indie release). On first launch macOS
   will block it — clear the quarantine flag once:

   ```bash
   xattr -cr /Applications/SwarmZ.app
   ```

   (or right-click the app → **Open** → **Open**.)
3. Requires a working [Claude Code](https://claude.com/claude-code) install —
   `claude` must resolve on your `PATH`.

Updates after this are delivered **in-app** via the built-in updater.
