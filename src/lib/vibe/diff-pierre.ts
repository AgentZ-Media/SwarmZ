// @pierre/diffs adapter (Phase 6, plan 5a) — everything engine-specific for
// the diff rendering lives here so the numbers layer (`diff.ts`) stays pure
// and engine-independent, and a renderer swap stays confined to this file +
// HighlightedDiffBody.tsx.
//
// Engine decisions (WKWebView de-risking, deliberate):
//   · `preferredHighlighter: "shiki-js"` — Shiki's JavaScript RegExp engine,
//     NO Oniguruma WASM. WKWebView has bitten us with WASM/worker edge cases
//     before; the JS engine trades a little grammar fidelity for a pure-JS
//     path that works everywhere the webview runs.
//   · Highlighting is lazy-loaded with the first expanded diff. The providers
//     beside each renderer resolve to pierre's shared 2-worker singleton, so
//     the virtualized feed never janks and rows never spawn their own pool.
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
import { diffHash } from "./diff";
export { changeToPatchText, hasFileHeader } from "./diff-patch";

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
