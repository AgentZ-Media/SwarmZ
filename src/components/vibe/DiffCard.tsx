import { lazy, memo, Suspense, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import {
  capDiff,
  changeKind,
  changeKindLabel,
  changeStats,
  type ChangeKind,
  type ParsedFile,
} from "@/lib/vibe/diff";
import { changeToPatchText } from "@/lib/vibe/diff-patch";
import { cn } from "@/lib/utils";
import type { VibeFileChange } from "@/types";

/** Per-file diff string byte cap — bigger diffs render a [truncated] banner. */
const BYTE_CAP = 512 * 1024;
/** A file collapses by default past this many changed lines. */
const LINE_COLLAPSE = 80;
/** A fileChange card with more files than this collapses every file by default. */
const FILE_COLLAPSE = 3;
/** Tall expanded diffs scroll inside the row (keeps virtua row heights sane). */
const BODY_MAX = "max-h-[460px]";

// ---------------------------------------------------------------------------
// DiffBody — the @pierre/diffs wrapper. `<FileDiff>` renders plain text
// immediately and swaps in worker-highlighted tokens per line (same line
// count, fixed line-height), so the async token swap never changes the row's
// height — the virtua feed stays reflow-free (identity-preservation
// invariant). Inner virtualization is off (DIFF_OPTIONS): the transcript's
// VList owns row heights; tall diffs scroll inside BODY_MAX instead.
// An unparseable patch falls back to a plain <pre> of the raw text.
// ---------------------------------------------------------------------------

const HighlightedDiffBody = lazy(() =>
  import("./HighlightedDiffBody").then((module) => ({
    default: module.HighlightedDiffBody,
  })),
);

const DiffBody = memo(function DiffBody({ patchText }: { patchText: string }) {
  const plain = (
    <pre
      className={cn(
        "select-text overflow-auto px-3 py-2 font-mono text-11 leading-[1.7] text-mut",
        BODY_MAX,
      )}
    >
      {patchText}
    </pre>
  );
  return (
    <Suspense fallback={plain}>
      <HighlightedDiffBody patchText={patchText} bodyClassName={BODY_MAX} />
    </Suspense>
  );
});

function TruncatedBanner() {
  return (
    <div className="border-t border-line px-3 py-1 font-mono text-10 text-warn">
      [truncated] — file too large to render in full
    </div>
  );
}

// ---------------------------------------------------------------------------
// FileRow — one collapsible file inside a fileChange card or the turn panel.
// The diff mounts lazily: only an OPEN row parses + asks the worker pool.
// ---------------------------------------------------------------------------

const FileRow = memo(function FileRow({
  path,
  kind,
  add,
  del,
  patchText,
  truncated,
  defaultOpen,
}: {
  path: string;
  kind: ChangeKind;
  add: number;
  del: number;
  patchText: string;
  truncated: boolean;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-t border-line first:border-t-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="focus-ring flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-11 hover:bg-pop"
      >
        <ChevronRight
          size={11}
          className={cn(
            "shrink-0 text-fnt transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="shrink-0 rounded-xs border border-line px-1 text-10 uppercase tracking-wide text-fnt">
          {changeKindLabel(kind)}
        </span>
        <span className="min-w-0 flex-1 select-text truncate text-mut">
          {path}
        </span>
        {(add > 0 || del > 0) && (
          <span className="shrink-0 tabular-nums">
            <span className="text-add">+{add}</span>{" "}
            <span className="text-del">−{del}</span>
          </span>
        )}
      </button>
      {open && (
        <>
          <DiffBody patchText={patchText} />
          {truncated && <TruncatedBanner />}
        </>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// FileChangeCard — header aggregate + one collapsible FileRow per file.
// Large sets (many files or big diffs) mount collapsed; small single edits
// auto-open.
// ---------------------------------------------------------------------------

interface PreparedFile {
  path: string;
  kind: ChangeKind;
  add: number;
  del: number;
  patchText: string;
  truncated: boolean;
  size: number;
}

function prepareChanges(changes: VibeFileChange[]): PreparedFile[] {
  return changes.map((c) => {
    const kind = changeKind(c.kind);
    const { add, del } = changeStats(c);
    const capped = capDiff(c.diff ?? "", BYTE_CAP);
    const source: VibeFileChange = capped.truncated
      ? { ...c, diff: capped.text }
      : c;
    return {
      path: c.path,
      kind,
      add,
      del,
      patchText: changeToPatchText(source),
      truncated: capped.truncated,
      size: add + del,
    };
  });
}

export const FileChangeCard = memo(function FileChangeCard({
  changes,
  status,
}: {
  changes: VibeFileChange[];
  status: string;
}) {
  const files = useMemo(() => prepareChanges(changes), [changes]);
  const totals = useMemo(
    () =>
      files.reduce(
        (acc, f) => ({ add: acc.add + f.add, del: acc.del + f.del }),
        { add: 0, del: 0 },
      ),
    [files],
  );
  const cardLarge =
    files.length > FILE_COLLAPSE || totals.add + totals.del > LINE_COLLAPSE * 2;

  return (
    <div className="max-w-[92%] overflow-hidden rounded-lg border border-line bg-card">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 font-mono text-11">
        <span aria-hidden className="text-acc">
          Δ
        </span>
        <span className="text-txt">
          {files.length} file{files.length === 1 ? "" : "s"} changed
        </span>
        {(totals.add > 0 || totals.del > 0) && (
          <span className="tabular-nums text-fnt">
            <span className="text-add">+{totals.add}</span>{" "}
            <span className="text-del">−{totals.del}</span>
          </span>
        )}
        {status && <span className="ml-auto text-fnt">{status}</span>}
      </div>
      <div className="flex flex-col">
        {files.map((f) => (
          <FileRow
            key={f.path}
            path={f.path}
            kind={f.kind}
            add={f.add}
            del={f.del}
            patchText={f.patchText}
            truncated={f.truncated}
            defaultOpen={!cardLarge && f.size <= LINE_COLLAPSE}
          />
        ))}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// TurnDiffFiles — the same collapsible file list, fed by a split turn diff.
// Used by the stage's turn-diff panel. Files auto-open when the set is small.
// ---------------------------------------------------------------------------

export const TurnDiffFiles = memo(function TurnDiffFiles({
  files,
}: {
  files: ParsedFile[];
}) {
  const cardLarge =
    files.length > FILE_COLLAPSE ||
    files.reduce((n, f) => n + f.add + f.del, 0) > LINE_COLLAPSE * 2;
  return (
    <div className="flex flex-col">
      {files.map((f) => {
        const capped = capDiff(f.diff, BYTE_CAP);
        return (
          <FileRow
            key={f.path}
            path={f.path}
            kind={f.kind}
            add={f.add}
            del={f.del}
            patchText={capped.text}
            truncated={capped.truncated}
            defaultOpen={!cardLarge && f.add + f.del <= LINE_COLLAPSE}
          />
        );
      })}
    </div>
  );
});

// ---------------------------------------------------------------------------
// CompactDiffPreview — a height-capped preview for the approval takeover:
// the first file's diff, straight through the same engine (the pool has
// usually highlighted it already — LRU by content hash).
// ---------------------------------------------------------------------------

export function CompactDiffPreview({ patchText }: { patchText: string }) {
  return (
    <div className="overflow-hidden rounded-md border border-line">
      <DiffBody patchText={patchText} />
    </div>
  );
}
