// Off-main-thread diff parse + syntax highlight (t3code recipe, adapted to the
// @git-diff-view fallback). Vite bundles this via `new Worker(new URL(...))`
// (see diff-highlight.ts) so it works fully offline. The worker runs the whole
// git-diff-view pipeline — parse → raw → syntax (lowlight, class-based) → build
// lines — and posts back the serialisable "full bundle"; the main thread merges
// it into a fresh DiffFile and hands that to <DiffView>. Highlighting stays on
// this thread so a 3000-line diff never janks the scroll of the virtualized
// feed. Results are LRU-cached here keyed by (diff hash, mode); the highlighter
// ignores lines over ~1000 chars (minified/one-liners) like t3code's cap.

import { DiffFile } from "@git-diff-view/core";
import { highlighter } from "@git-diff-view/lowlight";
import type { DiffData } from "./diff";

// minified-line guard: never tokenize lines longer than this (t3code: 1000)
highlighter.setMaxLineToIgnoreSyntax(1000);

type Bundle = ReturnType<DiffFile["_getFullBundle"]>;

interface Req {
  id: number;
  key: string;
  data: DiffData;
  mode: "unified" | "split";
  highlight: boolean;
}

// small LRU of built bundles (AST work is the expensive part) — t3code sizes
// its AST cache at 240; our diffs are smaller and per-card, 60 is plenty.
const LRU_MAX = 60;
const cache = new Map<string, Bundle>();

function build(data: DiffData, mode: "unified" | "split", highlight: boolean): Bundle {
  const file = DiffFile.createInstance({
    oldFile: data.oldFile,
    newFile: data.newFile,
    hunks: data.hunks,
  });
  file.initTheme("dark");
  file.initRaw();
  if (highlight) file.initSyntax({ registerHighlighter: highlighter });
  if (mode === "split") file.buildSplitDiffLines();
  else file.buildUnifiedDiffLines();
  return file._getFullBundle();
}

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, key, data, mode, highlight } = e.data;
  const ck = `${key}:${mode}:${highlight ? 1 : 0}`;
  let bundle = cache.get(ck);
  if (bundle) {
    // touch for LRU recency
    cache.delete(ck);
    cache.set(ck, bundle);
  } else {
    try {
      bundle = build(data, mode, highlight);
    } catch (err) {
      (self as unknown as Worker).postMessage({ id, error: String(err) });
      return;
    }
    cache.set(ck, bundle);
    if (cache.size > LRU_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }
  (self as unknown as Worker).postMessage({ id, bundle });
};
