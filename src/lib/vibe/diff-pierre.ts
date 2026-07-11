// @pierre/diffs adapter (Phase 6, plan 5a) — everything engine-specific for
// the diff rendering lives here so the numbers layer (`diff.ts`) stays pure
// and engine-independent, and a rollback to @git-diff-view would touch only
// this file + DiffCard.tsx.
//
// Engine decisions (WKWebView de-risking, deliberate):
//   · `preferredHighlighter: "shiki-js"` — Shiki's JavaScript RegExp engine,
//     NO Oniguruma WASM. WKWebView has bitten us with WASM/worker edge cases
//     before; the JS engine trades a little grammar fidelity for a pure-JS
//     path that works everywhere the webview runs.
//   · Highlighting runs in pierre's own worker pool (2 workers, mounted once
//     in VibeLayer via WorkerPoolContextProvider) — the virtualized feed
//     never janks on a big diff, same contract as the old diff-worker.
//   · The theme is a Shiki css-variables theme ("swarmz") — every token
//     color resolves from `--diffs-*` custom properties defined in
//     styles.css against the SwarmZ palette (accent/txt/ok/warn/fnt), so a
//     future accent change re-themes diffs for free. Custom properties
//     inherit into pierre's shadow root; the add/del washes are pinned to
//     `--add`/`--del` via the `--diffs-bg-*-override` variables (styles.css).

import {
  parsePatchFiles,
  registerCustomCSSVariableTheme,
  type FileDiffMetadata,
} from "@pierre/diffs";
import type { FileDiffProps } from "@pierre/diffs/react";
import type { VibeFileChange } from "@/types";
import { changeKind, diffHash } from "./diff";

/** The registered Shiki css-variables theme name (see styles.css tokens). */
export const SWARMZ_DIFF_THEME = "swarmz";

// Fallback values baked into the generated theme — the real values come from
// the `--diffs-*` custom properties in styles.css; these only guard a missing
// stylesheet. Registered ONCE at module load, BEFORE the worker pool spins up
// (VibeLayer imports this module for the pool options), so the resolved theme
// ships to the workers with their initialize request.
registerCustomCSSVariableTheme(SWARMZ_DIFF_THEME, {
  foreground: "#e9eaee",
  background: "transparent",
  "token-comment": "#62646f",
  "token-keyword": "#f7a6ba",
  "token-string": "#8fcfa5",
  "token-string-expression": "#8fcfa5",
  "token-constant": "#fac4d1",
  "token-function": "#e3c58a",
  "token-parameter": "#9da0ab",
  "token-punctuation": "#9da0ab",
  "token-link": "#f0567c",
});

/** Languages preloaded into the highlight workers (common in our repos —
 * anything else resolves lazily on first use). */
export const DIFF_PRELOAD_LANGS = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "rust",
  "python",
  "css",
  "html",
  "markdown",
  "shellscript",
  "yaml",
  "toml",
] as const;

/** Shared render options for every `<FileDiff>` (DiffCard). Unified view,
 * no inner virtualization — the transcript's virtua VList owns row heights,
 * a nested virtualizer's buffer resizing would fight it (plan 5a). */
export const DIFF_OPTIONS: NonNullable<FileDiffProps<undefined>["options"]> = {
  theme: SWARMZ_DIFF_THEME,
  themeType: "dark",
  diffStyle: "unified",
  preferredHighlighter: "shiki-js",
  disableVirtualizationBuffers: true,
  disableFileHeader: true,
  overflow: "scroll",
  // minified/one-liner guard (t3code's cap) — longer lines render plain
  tokenizeMaxLineLength: 1000,
};

/** Worker pool sizing — 2 is plenty: one visible transcript at a time, and
 * highlight requests are per-file and LRU-cached inside the pool. */
export const DIFF_POOL_SIZE = 2;

// ---------------------------------------------------------------------------
// Patch-text → FileDiffMetadata. pierre parses standard unified diffs/patches;
// our two shapes become patch text first (pure string work), then parse.
// Parsed metadata is LRU-cached by content hash: virtua unmounts/remounts
// rows on scroll, and re-parsing a large diff on every remount would jank.
// ---------------------------------------------------------------------------

const PARSE_LRU_MAX = 80;
const parseCache = new Map<string, FileDiffMetadata | null>();

/** Parse one file's patch text into pierre metadata (null = unparseable —
 * the caller falls back to a plain <pre>). Cached by content hash. */
export function toFileDiff(patchText: string): FileDiffMetadata | null {
  const key = diffHash(patchText);
  const hit = parseCache.get(key);
  if (hit !== undefined) {
    parseCache.delete(key);
    parseCache.set(key, hit); // LRU touch
    return hit;
  }
  let meta: FileDiffMetadata | null = null;
  try {
    const parsed = parsePatchFiles(patchText, key);
    meta = parsed[0]?.files[0] ?? null;
  } catch {
    meta = null;
  }
  parseCache.set(key, meta);
  if (parseCache.size > PARSE_LRU_MAX) {
    const oldest = parseCache.keys().next().value;
    if (oldest !== undefined) parseCache.delete(oldest);
  }
  return meta;
}

/**
 * True when a per-file unified diff chunk already carries file headers.
 * Only the PREAMBLE (everything before the first `@@` hunk header) counts:
 * a hunk-body line like `--- separator` (a deleted `-- separator` content
 * line) must never be mistaken for a file header, or the headers would not
 * be synthesized and pierre would fall back to raw `<pre>` text. A header is
 * a `diff --git ` line OR an adjacent `--- ` / `+++ ` pair in the preamble.
 * Exported for the unit test.
 */
export function hasFileHeader(diff: string): boolean {
  const lines = diff.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("@@")) return false; // hunk body reached — no headers
    if (line.startsWith("diff --git ")) return true;
    if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) return true;
  }
  return false;
}

/**
 * Patch text for one fileChange change. A kind "add" carries the RAW new file
 * content (session-store live-verified), so it becomes a synthesized all-add
 * patch (an EMPTY new file becomes the git-canonical header-only patch — git
 * writes no hunk for it, and `@@ -0,0 +1,0 @@` is no valid hunk);
 * update/delete pass their unified diff through (headers added when the
 * chunk starts at `@@`).
 */
export function changeToPatchText(change: VibeFileChange): string {
  const raw = change.diff ?? "";
  if (changeKind(change.kind) === "add") {
    const body = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    const lines = body.length ? body.split("\n") : [];
    if (lines.length === 0) return `--- /dev/null\n+++ b/${change.path}\n`;
    return (
      `--- /dev/null\n+++ b/${change.path}\n@@ -0,0 +1,${lines.length} @@\n` +
      lines.map((l) => `+${l}`).join("\n") +
      "\n"
    );
  }
  if (!hasFileHeader(raw)) {
    return `--- a/${change.path}\n+++ b/${change.path}\n${raw}`;
  }
  return raw;
}
