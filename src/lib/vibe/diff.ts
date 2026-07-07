// Pure diff parsing/counting — the single source for Vibe-Mode diff numbers and
// for shaping our fileChange/turn data into @git-diff-view input. No React, no
// store, no worker: callers memoize on the FNV hash. Two data shapes flow in:
//   · a fileChange item's `changes[]` — each `{ path, kind, diff }` where a
//     kind "add" carries the RAW new file content (NOT a unified diff), while
//     update/delete carry a per-file unified diff (session-store live-verified).
//   · a turn's aggregated unified diff (`entry.diff`) — a multi-file unified
//     diff that we split per file for rendering.

import type { VibeFileChange } from "@/types";

// ---- FNV-1a 32-bit — the memo/cache key over a diff string (t3code recipe) ----

export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Stable, cheap cache key: length + FNV (collision-safe enough for a memo). */
export function diffHash(s: string): string {
  return `${s.length.toString(36)}:${fnv1a32(s).toString(36)}`;
}

// ---- language from file extension (git-diff-view / lowlight lang ids) ----

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json", rs: "rust", py: "python", pyi: "python",
  rb: "ruby", go: "go", java: "java", kt: "kotlin", kts: "kotlin",
  swift: "swift", c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp",
  hpp: "cpp", hh: "cpp", cs: "csharp", css: "css", scss: "scss",
  sass: "scss", less: "less", html: "xml", htm: "xml", xml: "xml",
  svg: "xml", vue: "vue", md: "markdown", markdown: "markdown",
  mdx: "markdown", sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", cfg: "ini",
  conf: "ini", sql: "sql", php: "php", lua: "lua", r: "r", pl: "perl",
  pm: "perl", graphql: "graphql", gql: "graphql", dart: "dart",
  scala: "scala", clj: "clojure", ex: "elixir", exs: "elixir",
  erl: "erlang", hs: "haskell", ml: "ocaml", vim: "vim",
};

export function langFromPath(path: string): string {
  const base = (path.split("/").pop() ?? path).toLowerCase();
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === "makefile" || base.endsWith(".mk")) return "makefile";
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot + 1) : "";
  return EXT_LANG[ext] ?? "plaintext";
}

// ---- change kind ----

export type ChangeKind = "add" | "delete" | "update" | "rename" | string;

/** The tagged PatchChangeKind (`{ type: "add" }`) → a plain string. */
export function changeKind(kind: unknown): ChangeKind {
  if (kind && typeof kind === "object" && "type" in kind) {
    const t = (kind as { type: unknown }).type;
    if (typeof t === "string") return t;
  }
  return "update";
}

/** Short badge label for a change kind. */
export function changeKindLabel(kind: ChangeKind): string {
  switch (kind) {
    case "add":
      return "new";
    case "delete":
      return "del";
    case "rename":
      return "ren";
    case "update":
      return "edit";
    default:
      return kind;
  }
}

// ---- +/- counting (one source of truth) ----

export interface DiffStats {
  add: number;
  del: number;
}

/** Count +/- body lines of a unified diff (ignoring +++/--- file headers). */
export function unifiedDiffStats(diff: string | null | undefined): DiffStats {
  if (!diff) return { add: 0, del: 0 };
  let add = 0;
  let del = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) add++;
    else if (line.startsWith("-")) del++;
  }
  return { add, del };
}

/** Count non-empty lines of a raw blob (for a "new file" whose diff is content). */
function rawLineCount(raw: string): number {
  if (!raw) return 0;
  const body = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  return body.length ? body.split("\n").length : 0;
}

/**
 * +/- for one fileChange change. A kind "add" carries raw content, so every
 * line reads as an addition; update/delete carry a unified diff.
 */
export function changeStats(change: VibeFileChange): DiffStats {
  if (changeKind(change.kind) === "add") {
    return { add: rawLineCount(change.diff ?? ""), del: 0 };
  }
  return unifiedDiffStats(change.diff);
}

export interface AggregateStats extends DiffStats {
  files: number;
}

export function aggregateChangeStats(changes: VibeFileChange[]): AggregateStats {
  let add = 0;
  let del = 0;
  for (const c of changes) {
    const s = changeStats(c);
    add += s.add;
    del += s.del;
  }
  return { add, del, files: changes.length };
}

// ---- @git-diff-view input shaping ----

export interface DiffData {
  oldFile?: { fileName?: string; fileLang?: string; content?: string };
  newFile?: { fileName?: string; fileLang?: string; content?: string };
  hunks: string[];
}

/** Cap a diff string before parsing; returns the (possibly clipped) text + flag. */
export function capDiff(diff: string, byteCap: number): { text: string; truncated: boolean } {
  if (diff.length <= byteCap) return { text: diff, truncated: false };
  // clip on a line boundary so the parser still sees well-formed hunks
  const clipped = diff.slice(0, byteCap);
  const lastNl = clipped.lastIndexOf("\n");
  return { text: lastNl > 0 ? clipped.slice(0, lastNl) : clipped, truncated: true };
}

/**
 * Shape one fileChange change into @git-diff-view data. A "new file" (raw
 * content) is synthesized into a unified add-diff so its lines render as
 * additions and count correctly; update/delete pass their unified diff through.
 */
export function changeToDiffData(change: VibeFileChange): DiffData {
  const lang = langFromPath(change.path);
  const file = { fileName: change.path, fileLang: lang };
  if (changeKind(change.kind) === "add") {
    const raw = change.diff ?? "";
    const body = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    const lines = body.length ? body.split("\n") : [];
    const hunk =
      `--- /dev/null\n+++ b/${change.path}\n@@ -0,0 +1,${lines.length} @@\n` +
      lines.map((l) => `+${l}`).join("\n") +
      (lines.length ? "\n" : "");
    return { oldFile: file, newFile: file, hunks: [hunk] };
  }
  return { oldFile: file, newFile: file, hunks: [change.diff ?? ""] };
}

// ---- multi-file unified diff → per-file chunks (turn diff) ----

export interface ParsedFile {
  path: string;
  kind: ChangeKind;
  /** the per-file unified diff chunk */
  diff: string;
  add: number;
  del: number;
}

function extractPath(chunk: string): string | null {
  // prefer +++ b/<path> (skip /dev/null deletes), then --- a/<path>, then diff --git
  const plus = /^\+\+\+ (?:b\/)?(.+)$/m.exec(chunk);
  if (plus && plus[1] !== "/dev/null") return plus[1].trim();
  const minus = /^--- (?:a\/)?(.+)$/m.exec(chunk);
  if (minus && minus[1] !== "/dev/null") return minus[1].trim();
  const git = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
  if (git) return git[2].trim();
  return null;
}

function fileKind(chunk: string): ChangeKind {
  if (/^new file mode/m.test(chunk)) return "add";
  if (/^deleted file mode/m.test(chunk)) return "delete";
  if (/^rename (from|to) /m.test(chunk)) return "rename";
  return "update";
}

/**
 * Split an aggregated multi-file unified diff (a turn's `entry.diff`) into one
 * chunk per file. Splits on `diff --git` headers when present, else on `--- `.
 */
export function splitUnifiedDiff(diff: string | null | undefined): ParsedFile[] {
  if (!diff || !diff.trim()) return [];
  const text = diff.replace(/\r\n/g, "\n");
  const hasGit = /^diff --git /m.test(text);
  const chunks = hasGit
    ? text.split(/(?=^diff --git )/m)
    : text.split(/(?=^--- )/m);
  const files: ParsedFile[] = [];
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const path = extractPath(chunk);
    if (!path) continue;
    const { add, del } = unifiedDiffStats(chunk);
    files.push({ path, kind: fileKind(chunk), diff: chunk, add, del });
  }
  return files;
}

/** Shape a split turn-diff file into @git-diff-view data. */
export function parsedFileToDiffData(file: ParsedFile): DiffData {
  const lang = langFromPath(file.path);
  const meta = { fileName: file.path, fileLang: lang };
  return { oldFile: meta, newFile: meta, hunks: [file.diff] };
}
