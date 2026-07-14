import { memo, useMemo } from "react";
import { FileDiff, WorkerPoolContextProvider } from "@pierre/diffs/react";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import {
  DIFF_OPTIONS,
  DIFF_POOL_SIZE,
  DIFF_PRELOAD_LANGS,
  SWARMZ_DIFF_THEME,
  toFileDiff,
} from "@/lib/vibe/diff-pierre";
import { cn } from "@/lib/utils";

const POOL_OPTIONS = {
  workerFactory: () => new DiffsWorker(),
  poolSize: DIFF_POOL_SIZE,
};

const HIGHLIGHTER_OPTIONS = {
  theme: SWARMZ_DIFF_THEME,
  preferredHighlighter: "shiki-js" as const,
  langs: [...DIFF_PRELOAD_LANGS],
};

/**
 * Heavy diff renderer, deliberately isolated behind a dynamic import.
 * Pierre's providers all resolve to its shared singleton, so several visible
 * file rows still share one two-worker pool rather than spawning per row.
 */
export const HighlightedDiffBody = memo(function HighlightedDiffBody({
  patchText,
  bodyClassName,
}: {
  patchText: string;
  bodyClassName: string;
}) {
  const meta = useMemo(() => toFileDiff(patchText), [patchText]);
  if (!meta) {
    return (
      <pre className="max-h-64 select-text overflow-auto px-3 py-2 font-mono text-11 leading-[1.7] text-mut">
        {patchText}
      </pre>
    );
  }

  return (
    <WorkerPoolContextProvider
      poolOptions={POOL_OPTIONS}
      highlighterOptions={HIGHLIGHTER_OPTIONS}
    >
      <div className={cn("vibe-diff overflow-auto", bodyClassName)}>
        <FileDiff fileDiff={meta} options={DIFF_OPTIONS} />
      </div>
    </WorkerPoolContextProvider>
  );
});
