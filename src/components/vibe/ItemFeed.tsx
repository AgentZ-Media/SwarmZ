import { memo, useCallback, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { VList, type VListHandle } from "virtua";
import { useVibe } from "@/lib/vibe/session-store";
import { respondApproval } from "@/lib/vibe/controller";
import { reportForItem } from "@/lib/vibe/report-item";
import { approvalCommand, commandExit } from "@/lib/vibe/ui";
import { cn } from "@/lib/utils";
import type { AgentReport } from "@/lib/orchestrator/report";
import type { VibeFileChange, VibeItem } from "@/types";
import { FileChangeCard } from "./DiffCard";
import { OrchestratorMarkdown } from "@/components/OrchestratorMarkdown";

/** Only the last slice of a command's output is painted — the store keeps
 * more, but a giant <pre> would blow up row measurement. */
const OUTPUT_RENDER_CAP = 6_000;

/**
 * The focus-stage transcript: a virtualized, bottom-pinned feed. Rows are
 * memoized and each selects ONLY its own item by id (the normalized store
 * hands a stable reference until that item changes), so a streaming delta
 * re-renders exactly one row. The feed itself subscribes to a cheap tail
 * signature purely to drive bottom-pinning — never a render debounce.
 */
export function ItemFeed({ sessionId }: { sessionId: string }) {
  const order = useVibe((s) => s.sessions[sessionId]?.order);
  // tail signature: length + last item id + its growing text/output length.
  // Changes on every append AND on every streaming delta → the pin effect
  // fires, but the O(1) compute keeps it free.
  const tailRev = useVibe((s) => {
    const e = s.sessions[sessionId];
    if (!e || e.order.length === 0) return "";
    const last = e.items[e.order[e.order.length - 1]];
    const len =
      last?.kind === "assistant"
        ? last.text.length
        : last?.kind === "command"
          ? last.output.length
          : 0;
    return `${e.order.length}:${last?.id}:${len}`;
  });

  const ref = useRef<VListHandle>(null);
  // "stick to bottom while at bottom" — the user scrolling up releases the pin
  const atBottomRef = useRef(true);

  const onScroll = useCallback(() => {
    const h = ref.current;
    if (!h) return;
    // within 24px of the end counts as "at bottom"
    atBottomRef.current =
      h.scrollOffset >= h.scrollSize - h.viewportSize - 24;
  }, []);

  const count = order?.length ?? 0;
  useLayoutEffect(() => {
    if (count === 0) return;
    if (atBottomRef.current) ref.current?.scrollToIndex(count - 1, { align: "end" });
    // tailRev in deps so streaming growth keeps us pinned
  }, [count, tailRev]);

  if (!order || order.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center">
        <p className="max-w-xs text-12 leading-normal text-fnt">
          No messages yet. Say what you want built below — commands, diffs and
          approvals will appear here as the agent works.
        </p>
      </div>
    );
  }

  return (
    <VList ref={ref} onScroll={onScroll} className="min-h-0 flex-1 px-6 py-6">
      {order.map((iid) => (
        <ItemRow key={iid} sessionId={sessionId} itemId={iid} />
      ))}
    </VList>
  );
}

// ---- one row: selects only its own item ----

const ItemRow = memo(function ItemRow({
  sessionId,
  itemId,
}: {
  sessionId: string;
  itemId: string;
}) {
  const item = useVibe((s) => s.sessions[sessionId]?.items[itemId]);
  if (!item) return null;
  return (
    <div className="mx-auto w-full max-w-[46rem] pb-4">
      <RenderItem sessionId={sessionId} item={item} />
    </div>
  );
});

function RenderItem({
  sessionId,
  item,
}: {
  sessionId: string;
  item: VibeItem;
}) {
  switch (item.kind) {
    case "user":
      return <UserRow text={item.text} />;
    case "assistant": {
      // an expect_report turn's final message renders as a report card, not
      // as raw JSON (the gate is strict: stamped `report: true` AND parses)
      const report = reportForItem(item);
      if (report) return <ReportCard report={report} />;
      return <AssistantRow text={item.text} streaming={!!item.streaming} />;
    }
    case "command":
      return <CommandRow item={item} />;
    case "fileChange":
      return <FileChangeCard changes={item.changes} status={item.status} />;
    case "approval":
      return <ApprovalRow sessionId={sessionId} item={item} />;
    case "warning":
      return <WarningRow text={item.text} />;
    case "notice":
      return <NoticeRow text={item.text} />;
    case "plan":
      return item.explanation ? <PlanExplanationRow text={item.explanation} /> : null;
    case "webSearch":
      return <WebSearchRow query={item.query} />;
    default:
      return null;
  }
}

/** User bubble — pop surface, 12/12/4/12 radius (reference). */
function UserRow({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[82%] select-text whitespace-pre-wrap rounded-xl rounded-br-[4px] border border-line2 bg-pop px-3.5 py-2.5 text-13 leading-relaxed text-txt">
        {text}
      </div>
    </div>
  );
}

// A finished assistant message renders as lightweight markdown (the shared
// OrchestratorMarkdown subset — bold/italic/inline+fenced code/lists/links, no
// innerHTML). A STILL-STREAMING message stays plaintext + caret: re-parsing
// markdown on every ~80 ms delta batch would be wasteful and unclosed markers
// would flicker. Rows are memoized per item id (ItemRow), so a completed
// message parses exactly once when `streaming` clears.
const AssistantRow = memo(function AssistantRow({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  if (streaming) {
    return (
      <div className="w-full select-text whitespace-pre-wrap text-13 leading-relaxed text-txt/90">
        {text}
        <span className="animate-zcaret ml-0.5 inline-block h-[13px] w-[6px] translate-y-[2px] rounded-[1px] bg-txt/70 align-baseline" />
      </div>
    );
  }
  return (
    <div className="w-full select-text text-13 leading-relaxed text-txt/90">
      <OrchestratorMarkdown text={text} />
    </div>
  );
});

// ---- agent status report (Phase 5 expect_report turns) ----

/** How many files_changed rows the card paints before collapsing to "+N". */
const REPORT_FILES_SHOWN = 6;

/**
 * A completed `expect_report` turn's schema-forced final message, rendered
 * as a compact report card instead of raw JSON (the Conductor still parses
 * the JSON machine-side — this is presentation only). Signal logic follows
 * DESIGN.md: needs-you = attn (like the approval card), done = a green
 * checkmark on a quiet card, in-progress = neutral.
 */
function ReportCard({ report }: { report: AgentReport }) {
  const needsYou = report.needsHuman;
  const status = needsYou ? "needs you" : report.done ? "done" : "in progress";
  const glyph = needsYou ? "⚑" : report.done ? "✓" : "▸";
  const glyphCls = needsYou ? "text-attn" : report.done ? "text-ok" : "text-fnt";
  const tests =
    report.testsPass === null ? null : report.testsPass ? "tests pass" : "tests FAIL";
  const shownFiles = report.filesChanged.slice(0, REPORT_FILES_SHOWN);
  const moreFiles = report.filesChanged.length - shownFiles.length;

  return (
    <div
      className={cn(
        "max-w-[88%] overflow-hidden rounded-lg border bg-card",
        needsYou ? "border-attn/55" : "border-line",
      )}
    >
      <div
        className={cn(
          "flex items-center gap-1.5 border-b px-3 py-1.5 font-mono text-11",
          needsYou
            ? "border-attn/25 bg-attn/10 text-attn"
            : "border-line text-fnt",
        )}
      >
        <span aria-hidden className={glyphCls}>
          {glyph}
        </span>
        <span className="font-semibold">report</span>
        <span className="opacity-75">— {status}</span>
        {tests && (
          <span
            className={cn(
              "ml-auto shrink-0",
              report.testsPass ? "text-ok" : "text-err",
            )}
          >
            {tests}
          </span>
        )}
      </div>
      {report.summary && (
        <p className="select-text px-3 py-2.5 text-13 leading-relaxed text-txt">
          {report.summary}
        </p>
      )}
      {needsYou && report.question && (
        <p className="select-text border-t border-attn/25 bg-attn/10 px-3 py-2 text-13 leading-relaxed text-attn">
          {report.question}
        </p>
      )}
      {shownFiles.length > 0 && (
        <div className="flex flex-col gap-0.5 border-t border-line px-3 py-2">
          {shownFiles.map((f, i) => (
            <span
              key={`${i}:${f}`}
              className="select-text truncate font-mono text-11 text-mut"
            >
              {f}
            </span>
          ))}
          {moreFiles > 0 && (
            <span className="font-mono text-11 text-fnt">+{moreFiles} more</span>
          )}
        </div>
      )}
      {report.followups.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-line px-3 py-2">
          {report.followups.map((f, i) => (
            <span key={i} className="select-text text-12 leading-normal text-mut">
              <span aria-hidden className="mr-1.5 text-fnt">
                →
              </span>
              {f}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function CommandRow({ item }: { item: Extract<VibeItem, { kind: "command" }> }) {
  const { text, failed } = commandExit(item);
  const running = text === "running";
  const [open, setOpen] = useState(running);
  const hasOutput = item.output.trim().length > 0;
  const shown =
    item.output.length > OUTPUT_RENDER_CAP
      ? item.output.slice(item.output.length - OUTPUT_RENDER_CAP)
      : item.output;

  return (
    <div className="max-w-[88%] overflow-hidden rounded-lg border border-line bg-card">
      <button
        onClick={() => hasOutput && setOpen((o) => !o)}
        className={cn(
          "focus-ring flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-11 text-mut",
          hasOutput && "hover:bg-pop",
        )}
      >
        {hasOutput && (
          <ChevronRight
            size={10}
            className={cn(
              "shrink-0 text-fnt transition-transform",
              open && "rotate-90",
            )}
          />
        )}
        <span aria-hidden className="shrink-0 text-fnt">
          $
        </span>
        <span className="min-w-0 flex-1 truncate text-txt">
          {item.command || "command"}
        </span>
        <span
          className={cn(
            "shrink-0",
            running ? "animate-zcaret text-fnt" : failed ? "text-err" : "text-ok",
          )}
        >
          {text}
        </span>
      </button>
      {open && hasOutput && (
        <pre className="max-h-[190px] select-text overflow-auto border-t border-line px-3 py-2.5 font-mono text-11 leading-[1.6] text-mut">
          {shown}
        </pre>
      )}
    </div>
  );
}

function ApprovalRow({
  sessionId,
  item,
}: {
  sessionId: string;
  item: Extract<VibeItem, { kind: "approval" }>;
}) {
  const pending = item.status === "pending";
  const command = approvalCommand(item.payload);
  const reason = typeof item.payload.reason === "string" ? item.payload.reason : "";
  const files = Array.isArray(item.payload.changes)
    ? (item.payload.changes as VibeFileChange[]).map((c) => c.path)
    : [];

  return (
    <div
      className={cn(
        "max-w-[88%] overflow-hidden rounded-lg border bg-card",
        pending ? "border-attn/55" : "border-line",
      )}
    >
      <div
        className={cn(
          "flex items-center gap-1.5 border-b px-3 py-1.5 font-mono text-11",
          pending ? "border-attn/25 bg-attn/10 text-attn" : "border-line text-fnt",
        )}
      >
        <span aria-hidden>⚑</span>
        <span className="font-semibold">approval</span>
        <span className="opacity-75">
          —{" "}
          {item.approvalKind === "fileChange"
            ? "wants to write files"
            : "wants to run a command"}
        </span>
      </div>
      {command && (
        <pre className="select-text overflow-x-auto px-3 py-2 font-mono text-11 leading-relaxed text-txt">
          {command}
        </pre>
      )}
      {files.length > 0 && (
        <div className="flex flex-col gap-0.5 px-3 py-2">
          {files.map((f) => (
            <span key={f} className="select-text truncate font-mono text-11 text-mut">
              {f}
            </span>
          ))}
        </div>
      )}
      {reason && (
        <p className="px-3 pb-1.5 text-12 leading-normal text-mut">{reason}</p>
      )}
      {pending ? (
        <div className="flex gap-2 border-t border-line px-3 py-2">
          <button
            onClick={() => respondApproval(sessionId, item.id, "accept")}
            className="focus-ring rounded-md bg-txt px-3 py-1 font-mono text-11 font-bold text-bg hover:brightness-90"
          >
            Allow
          </button>
          <button
            onClick={() => respondApproval(sessionId, item.id, "decline")}
            className="focus-ring rounded-md border border-line2 px-3 py-1 font-mono text-11 text-mut hover:border-err/45 hover:text-err"
          >
            Decline
          </button>
        </div>
      ) : (
        <div
          className={cn(
            "border-t border-line px-3 py-1.5 font-mono text-11",
            item.status === "accepted" || item.status === "acceptedForSession"
              ? "text-ok"
              : "text-fnt",
          )}
        >
          {resolvedLabel(item.status)}
        </div>
      )}
    </div>
  );
}

function resolvedLabel(status: string): string {
  switch (status) {
    case "accepted":
      return "✓ approved";
    case "acceptedForSession":
      return "✓ approved for the session";
    case "declined":
      return "× declined";
    case "cancelled":
      return "× cancelled";
    default:
      return status;
  }
}

function WarningRow({ text }: { text: string }) {
  return (
    <div className="max-w-[88%] select-text text-12 leading-normal text-warn">
      {text}
    </div>
  );
}

/** A neutral centered divider (context compaction) — reads as info, not error. */
function NoticeRow({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5 text-11 text-fnt">
      <span className="h-px flex-1 bg-line" />
      <span className="select-text">{text}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

function PlanExplanationRow({ text }: { text: string }) {
  return (
    <div className="max-w-[82%] select-text whitespace-pre-wrap text-12 leading-normal text-fnt">
      {text}
    </div>
  );
}

function WebSearchRow({ query }: { query: string }) {
  return (
    <div className="max-w-[82%] select-text font-mono text-11 text-fnt">
      ⌕ {query}
    </div>
  );
}
