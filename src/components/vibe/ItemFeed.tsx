import { memo, useCallback, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { VList, type VListHandle } from "virtua";
import { useVibe } from "@/lib/vibe/session-store";
import { respondApproval } from "@/lib/vibe/controller";
import { approvalCommand, commandExit } from "@/lib/vibe/ui";
import { cn } from "@/lib/utils";
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
        <p className="max-w-xs text-xs leading-relaxed text-faint">
          No messages yet. Say what you want built below — commands, diffs and
          approvals will appear here as the session works.
        </p>
      </div>
    );
  }

  return (
    <VList
      ref={ref}
      onScroll={onScroll}
      className="min-h-0 flex-1 px-5 py-4"
    >
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
    <div className="mx-auto w-full max-w-[46rem] pb-3">
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
    case "assistant":
      return <AssistantRow text={item.text} streaming={!!item.streaming} />;
    case "command":
      return <CommandRow item={item} />;
    case "fileChange":
      return <FileChangeCard changes={item.changes} status={item.status} />;
    case "approval":
      return <ApprovalRow sessionId={sessionId} item={item} />;
    case "warning":
      return <WarningRow text={item.text} />;
    case "plan":
      return item.explanation ? <PlanExplanationRow text={item.explanation} /> : null;
    case "webSearch":
      return <WebSearchRow query={item.query} />;
    default:
      return null;
  }
}

function UserRow({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl border border-border bg-secondary px-3.5 py-2 text-[13.5px] leading-relaxed text-foreground select-text">
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
      <div className="w-full whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-foreground/90 select-text">
        {text}
        <span className="streaming-caret ml-0.5 inline-block h-[14px] w-[6px] translate-y-[2px] bg-foreground/70 align-baseline" />
      </div>
    );
  }
  return (
    <div className="w-full break-words text-[13.5px] leading-relaxed text-foreground/90 select-text">
      <OrchestratorMarkdown text={text} />
    </div>
  );
});

function CardHead({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b border-border px-3 py-1.5 font-mono text-[10px] text-muted-foreground",
        className,
      )}
    >
      {children}
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
    <div className="max-w-[86%] overflow-hidden rounded-lg border border-border bg-card">
      <button
        onClick={() => hasOutput && setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-2 border-b border-border px-3 py-1.5 text-left font-mono text-[10px] text-muted-foreground",
          hasOutput && "hover:bg-accent",
        )}
      >
        {hasOutput && (
          <ChevronRight
            size={11}
            className={cn("shrink-0 text-faint transition-transform", open && "rotate-90")}
          />
        )}
        <span className="shrink-0 text-faint">$</span>
        <span className="min-w-0 flex-1 truncate text-foreground">
          {item.command || "command"}
        </span>
        <span
          className={cn(
            "shrink-0",
            running ? "text-muted-foreground" : failed ? "text-destructive" : "text-success",
          )}
        >
          {text}
        </span>
      </button>
      {open && hasOutput && (
        <pre className="max-h-64 overflow-auto px-3 py-2 font-mono text-[10.5px] leading-relaxed text-muted-foreground select-text">
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
        "max-w-[86%] overflow-hidden rounded-lg border bg-card",
        pending ? "border-attn/55" : "border-border",
      )}
    >
      <CardHead
        className={cn(pending && "border-b-attn/25 text-attn")}
      >
        <span aria-hidden>⚑</span>
        <span className="font-semibold">
          approval — {item.approvalKind === "fileChange" ? "wants to write files" : "wants to run a command"}
        </span>
      </CardHead>
      {command && (
        <pre className="overflow-x-auto px-3 py-2 font-mono text-[10.5px] leading-relaxed text-foreground select-text">
          {command}
        </pre>
      )}
      {files.length > 0 && (
        <div className="flex flex-col px-3 py-2">
          {files.map((f) => (
            <span key={f} className="truncate font-mono text-[10.5px] text-muted-foreground select-text">
              {f}
            </span>
          ))}
        </div>
      )}
      {reason && (
        <p className="px-3 pb-1 text-[11px] leading-relaxed text-muted-foreground">
          {reason}
        </p>
      )}
      {pending ? (
        <div className="flex gap-2 border-t border-border px-3 py-2">
          <button
            onClick={() => respondApproval(sessionId, item.id, "accept")}
            className="focus-ring rounded-md border border-foreground bg-foreground px-3 py-1 font-mono text-[10px] font-semibold text-background"
          >
            Approve
          </button>
          <button
            onClick={() => respondApproval(sessionId, item.id, "decline")}
            className="focus-ring rounded-md border border-border px-3 py-1 font-mono text-[10px] text-muted-foreground hover:bg-accent"
          >
            Decline
          </button>
        </div>
      ) : (
        <div className="border-t border-border px-3 py-1.5 font-mono text-[10px] text-faint">
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
    <div className="max-w-[86%] text-[11px] leading-relaxed text-warning select-text">
      {text}
    </div>
  );
}

function PlanExplanationRow({ text }: { text: string }) {
  return (
    <div className="max-w-[82%] whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground select-text">
      {text}
    </div>
  );
}

function WebSearchRow({ query }: { query: string }) {
  return (
    <div className="max-w-[82%] font-mono text-[10.5px] text-faint select-text">
      🔍 {query}
    </div>
  );
}
