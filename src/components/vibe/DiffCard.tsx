import { memo, useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { DiffView, DiffModeEnum, DiffFile } from "@git-diff-view/react";
import {
  capDiff,
  changeKind,
  changeKindLabel,
  changeStats,
  changeToDiffData,
  diffHash,
  parsedFileToDiffData,
  type ChangeKind,
  type DiffData,
  type ParsedFile,
} from "@/lib/vibe/diff";
import { requestDiffBundle } from "@/lib/vibe/diff-highlight";
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
// DiffBody — the @git-diff-view wrapper. Plain first (no highlight, parsed on
// this thread but cheap), then swaps to an off-thread-highlighted DiffFile once
// the worker resolves. Height stays stable across the swap (same line count),
// so the async replace never reflows the feed. `highlight={false}` is the fully
// functional path — the worker is a pure enhancement.
// ---------------------------------------------------------------------------

const DiffBody = memo(function DiffBody({
  diffKey,
  data,
  highlight,
}: {
  diffKey: string;
  data: DiffData;
  highlight: boolean;
}) {
  const [file, setFile] = useState<DiffFile | null>(null);

  useEffect(() => {
    if (!highlight) {
      setFile(null);
      return;
    }
    let cancelled = false;
    requestDiffBundle(diffKey, data, "unified")
      .then((bundle) => {
        if (cancelled) return;
        const f = DiffFile.createInstance({
          oldFile: data.oldFile,
          newFile: data.newFile,
          hunks: data.hunks,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        f._mergeFullBundle(bundle as any);
        setFile(f);
      })
      .catch(() => {
        /* stay on the plain path */
      });
    return () => {
      cancelled = true;
    };
  }, [diffKey, highlight, data]);

  const common = {
    diffViewMode: DiffModeEnum.Unified,
    diffViewTheme: "dark" as const,
    diffViewFontSize: 11,
    diffViewWrap: false,
  };

  return (
    <div className={cn("vibe-diff overflow-auto", BODY_MAX)}>
      {file ? (
        <DiffView diffFile={file} diffViewHighlight {...common} />
      ) : (
        <DiffView data={data} diffViewHighlight={false} {...common} />
      )}
    </div>
  );
});

function TruncatedBanner() {
  return (
    <div className="border-t border-border px-3 py-1 font-mono text-[9.5px] text-warning">
      [truncated] — file too large to render in full
    </div>
  );
}

// ---------------------------------------------------------------------------
// FileRow — one collapsible file inside a fileChange card or the turn panel.
// Highlighting is lazy: only an OPEN row asks the worker (plain until then).
// ---------------------------------------------------------------------------

const FileRow = memo(function FileRow({
  path,
  kind,
  add,
  del,
  data,
  truncated,
  defaultOpen,
}: {
  path: string;
  kind: ChangeKind;
  add: number;
  del: number;
  data: DiffData;
  truncated: boolean;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // the diff string identity drives the highlight cache key
  const diffKey = useMemo(() => diffHash(data.hunks.join("\n")), [data]);

  return (
    <div className="border-t border-border first:border-t-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[10.5px] hover:bg-accent"
      >
        <ChevronRight
          size={11}
          className={cn("shrink-0 text-faint transition-transform", open && "rotate-90")}
        />
        <span className="shrink-0 rounded border border-border px-1 text-[9px] uppercase tracking-wide text-faint">
          {changeKindLabel(kind)}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground select-text">
          {path}
        </span>
        {(add > 0 || del > 0) && (
          <span className="shrink-0 tabular-nums">
            <span className="text-diff-add">+{add}</span>{" "}
            <span className="text-diff-del">−{del}</span>
          </span>
        )}
      </button>
      {open && (
        <>
          <DiffBody diffKey={diffKey} data={data} highlight />
          {truncated && <TruncatedBanner />}
        </>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// FileChangeCard — replaces the old flat fileChange row. Header aggregate +
// one collapsible FileRow per file. Large sets (many files or big diffs) mount
// collapsed; small single edits auto-open.
// ---------------------------------------------------------------------------

interface PreparedFile {
  path: string;
  kind: ChangeKind;
  add: number;
  del: number;
  data: DiffData;
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
      data: changeToDiffData(source),
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
    <div className="max-w-[86%] overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
        <span className="text-foreground">
          {files.length} file{files.length === 1 ? "" : "s"} changed
        </span>
        {(totals.add > 0 || totals.del > 0) && (
          <span className="tabular-nums">
            <span className="text-diff-add">+{totals.add}</span>{" "}
            <span className="text-diff-del">−{totals.del}</span>
          </span>
        )}
        {status && <span className="ml-auto text-faint">{status}</span>}
      </div>
      <div className="flex flex-col">
        {files.map((f) => (
          <FileRow
            key={f.path}
            path={f.path}
            kind={f.kind}
            add={f.add}
            del={f.del}
            data={f.data}
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
        const data = parsedFileToDiffData(
          capped.truncated ? { ...f, diff: capped.text } : f,
        );
        return (
          <FileRow
            key={f.path}
            path={f.path}
            kind={f.kind}
            add={f.add}
            del={f.del}
            data={data}
            truncated={capped.truncated}
            defaultOpen={!cardLarge && f.add + f.del <= LINE_COLLAPSE}
          />
        );
      })}
    </div>
  );
});

// ---------------------------------------------------------------------------
// CompactDiffPreview — a plain (no highlight), height-capped preview for the
// approval takeover: shows the first file's diff without spinning the worker.
// ---------------------------------------------------------------------------

export function CompactDiffPreview({ data }: { data: DiffData }) {
  const diffKey = useMemo(() => diffHash(data.hunks.join("\n")), [data]);
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <DiffBody diffKey={diffKey} data={data} highlight={false} />
    </div>
  );
}
