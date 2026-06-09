// node-pty ships prebuilt binaries that sometimes lose their execute bit when
// extracted, which makes pty.fork() fail with "posix_spawnp failed".
// Restore +x on every spawn-helper / *.node under node-pty/prebuilds.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

try {
  const require = createRequire(import.meta.url);
  const ptyPkg = require.resolve("node-pty/package.json");
  const prebuilds = path.join(path.dirname(ptyPkg), "prebuilds");
  if (!fs.existsSync(prebuilds)) process.exit(0);
  for (const dir of fs.readdirSync(prebuilds)) {
    const full = path.join(prebuilds, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      if (f === "spawn-helper" || f.endsWith(".node")) {
        try {
          fs.chmodSync(path.join(full, f), 0o755);
        } catch {
          /* ignore */
        }
      }
    }
  }
} catch {
  /* node-pty not installed (e.g. Tauri-only build) — nothing to do */
}
