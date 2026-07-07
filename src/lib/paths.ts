// Pure filesystem-path detection for chat text — the presentation layer turns
// the detected paths into compact pills that show ONLY the filename (plus an
// optional `:line`), with the full path in the tooltip. Runs over plain-text
// nodes AFTER markdown parsing (see OrchestratorMarkdown), never inside code
// spans or fenced blocks.

/** One slice of a text run: either prose or a detected filesystem path. */
export type TextSegment =
  | { path: false; text: string }
  | { path: true; text: string };

// A path is `~/…` (home-relative), an absolute path with at least two segments
// (`/a/b`), or a BARE RELATIVE path like `src-tauri/src/sessions.rs:407`. The
// two-segment floor keeps prose like "read/write" from matching (a single `/x`
// never does). Relative paths are the false-positive-prone case, so they are
// held to a stricter shape: every directory segment is dot-free (which rejects
// domains — `example.com/x.ts`), and the last segment must carry a file
// extension. The lookbehind rejects URLs (`://…`), mid-word slashes (`a/b`
// inside a token) and scoped npm packages (`@scope/pkg`). A trailing `:line`
// (or `:line:col`) editor location is absorbed into the match.
const PATH_RE =
  /(?<![\w:/~@.])(?:~\/[A-Za-z0-9._+@\-/]*|\/(?:[A-Za-z0-9._+@-]+\/)+[A-Za-z0-9._+@-]*|(?:\.?[A-Za-z0-9_+-]+\/)+\.?[A-Za-z0-9_+-]+\.[A-Za-z0-9]{1,8})(?::\d+){0,2}/g;

// Trailing punctuation that is almost always sentence syntax, not part of the
// path — trimmed off the match and handed back to the prose segment.
const TRAILING = /[.,;:!?)\]}'"]+$/;

/**
 * Split a text run into prose + path segments. A path must be non-trivial
 * (`~/…` or `/a/b`), so a lone `/` or `~` is left as prose. Adjacent segments
 * never both have `path:false` — callers can key on that.
 */
export function splitTextWithPaths(text: string): TextSegment[] {
  if (!text || (!text.includes("/") && !text.includes("~"))) {
    return text ? [{ path: false, text }] : [];
  }
  const out: TextSegment[] = [];
  let last = 0;
  const pushProse = (s: string) => {
    if (!s) return;
    const prev = out[out.length - 1];
    if (prev && prev.path === false) prev.text += s;
    else out.push({ path: false, text: s });
  };
  for (const m of text.matchAll(PATH_RE)) {
    const idx = m.index ?? 0;
    let match = m[0];
    // give trailing sentence punctuation back to the prose
    const trail = TRAILING.exec(match);
    let suffix = "";
    if (trail) {
      suffix = trail[0];
      match = match.slice(0, match.length - suffix.length);
    }
    // a match that collapsed to just "~" or "/" isn't a real path
    if (match === "~" || match === "/" || match === "~/") {
      pushProse(text.slice(last, idx + m[0].length));
      last = idx + m[0].length;
      continue;
    }
    pushProse(text.slice(last, idx));
    out.push({ path: true, text: match });
    if (suffix) pushProse(suffix);
    last = idx + m[0].length;
  }
  pushProse(text.slice(last));
  return out;
}

/**
 * Split a trailing `:line` (or `:line:col`) editor location off a path. The
 * line is the FIRST number only — a pill shows at most `:line`, so the column
 * is parsed (to keep it out of the basename) but dropped from `line`.
 */
export function splitLineSuffix(path: string): {
  path: string;
  line: string | null;
} {
  const m = /^(.*?):(\d+)(?::\d+)?$/.exec(path);
  return m ? { path: m[1], line: m[2] } : { path, line: null };
}

/**
 * Is this markdown-link href a filesystem path, not a URL? Absolute and `~/`
 * hrefs always count; a bare relative href counts under the same strict shape
 * as prose detection (dot-free directory segments + a file extension on the
 * last segment — rejects domains like `example.com/x`). Used to render such
 * links as path pills instead of clickable links.
 */
export function isPathHref(href: string): boolean {
  if (href.includes("://")) return false;
  if (/^~?\//.test(href)) return true;
  return /^(?:\.?[A-Za-z0-9_+-]+\/)+\.?[A-Za-z0-9_+-]+\.[A-Za-z0-9]{1,8}(?::\d+){0,2}$/.test(
    href,
  );
}

/** The last non-empty segment of a path (the filename or folder name). */
export function basename(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

/**
 * Compact pill display for a path: the basename plus any `:line`. The full path
 * (incl. its line/col suffix) is what belongs in the pill's tooltip.
 */
export function pathPillLabel(path: string): {
  base: string;
  line: string | null;
} {
  const { path: bare, line } = splitLineSuffix(path);
  return { base: basename(bare), line };
}

/** Everything before the basename, incl. the trailing slash (may be empty). */
export function dirname(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i >= 0 ? trimmed.slice(0, i + 1) : "";
}

/** Middle-elide an over-long string, keeping both ends legible. */
export function elideMiddle(s: string, max = 32): string {
  if (s.length <= max) return s;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}
