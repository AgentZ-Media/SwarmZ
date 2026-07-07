import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Square } from "lucide-react";
import { useVibe } from "@/lib/vibe/session-store";
import {
  interrupt,
  respondApproval,
  sendMessage,
  type VibeApprovalDecision,
} from "@/lib/vibe/controller";
import { approvalCommand } from "@/lib/vibe/ui";
import {
  changeToDiffData,
  parsedFileToDiffData,
  splitUnifiedDiff,
} from "@/lib/vibe/diff";
import { cn } from "@/lib/utils";
import type { VibeFileChange, VibeItem } from "@/types";
import { CompactDiffPreview } from "./DiffCard";

const MAX_ROWS_PX = 168; // ~6 lines

/**
 * The session composer. When the active session has a pending approval the
 * whole input is replaced by a takeover panel (t3code pattern) — the decision
 * IS the thing to do, so it owns the composer surface. Otherwise: auto-growing
 * textarea, Enter to send / ⇧Enter for a newline, send morphs to Stop while a
 * turn runs.
 */
export function Composer({ sessionId }: { sessionId: string }) {
  // primitive signature only (never a fresh array — that loops
  // useSyncExternalStore, see AGENTS.md): the first pending approval id + count.
  const firstPendingId = useVibe((s) => {
    const e = s.sessions[sessionId];
    if (!e) return "";
    for (const id of e.order) {
      const it = e.items[id];
      if (it && it.kind === "approval" && it.status === "pending") return id;
    }
    return "";
  });
  const pendingCount = useVibe((s) => {
    const e = s.sessions[sessionId];
    if (!e) return 0;
    let n = 0;
    for (const id of e.order) {
      const it = e.items[id];
      if (it && it.kind === "approval" && it.status === "pending") n++;
    }
    return n;
  });

  if (firstPendingId) {
    return (
      <ApprovalTakeover
        key={firstPendingId}
        sessionId={sessionId}
        approvalId={firstPendingId}
        count={pendingCount}
      />
    );
  }
  return <MessageComposer sessionId={sessionId} />;
}

function MessageComposer({ sessionId }: { sessionId: string }) {
  const busy = useVibe((s) => !!s.busy[sessionId]);
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  // auto-grow up to ~6 lines, then scroll inside
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = `${Math.min(ta.scrollHeight, MAX_ROWS_PX)}px`;
  }, [text]);

  const send = () => {
    const t = text.trim();
    if (!t || busy) return;
    void sendMessage(sessionId, t);
    setText("");
  };

  return (
    <div className="mx-auto mb-4 flex w-full max-w-[46rem] items-end gap-2 rounded-[10px] border border-input bg-card px-3 py-2.5 focus-within:border-ring/60">
      <textarea
        ref={taRef}
        value={text}
        rows={1}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        placeholder="Message this session…"
        className="min-h-[20px] flex-1 resize-none bg-transparent text-xs leading-relaxed text-foreground placeholder:text-faint focus:outline-none select-text"
      />
      {busy ? (
        <button
          onClick={() => interrupt(sessionId)}
          title="Stop the running turn"
          className="focus-ring flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 font-mono text-[10px] text-muted-foreground hover:bg-accent"
        >
          <Square size={11} className="fill-current" /> Stop
        </button>
      ) : (
        <button
          onClick={send}
          disabled={!text.trim()}
          title="Send (↵)"
          className={cn(
            "focus-ring flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground disabled:opacity-40",
          )}
        >
          <ArrowUp size={14} />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Approval takeover — replaces the input while the session waits on the human.
// All four decisions; keyboard ⏎ = Allow, ⎋ = Decline (local handler only, no
// global shortcuts, dialog guards untouched). Optimistic disable after a click;
// the next pending approval rises when this one resolves (status leaves
// "pending" immediately, so the panel re-keys to it via the parent).
// ---------------------------------------------------------------------------

function ApprovalTakeover({
  sessionId,
  approvalId,
  count,
}: {
  sessionId: string;
  approvalId: string;
  count: number;
}) {
  const item = useVibe((s) => s.sessions[sessionId]?.items[approvalId]);
  const [responding, setResponding] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // focus the panel on mount so ⏎/⎋ land here without a new global shortcut
  useLayoutEffect(() => {
    rootRef.current?.focus();
  }, []);

  const isFileChange = item?.kind === "approval" && item.approvalKind === "fileChange";

  const respond = (decision: VibeApprovalDecision) => {
    if (responding) return;
    setResponding(true);
    void respondApproval(sessionId, approvalId, decision);
  };

  if (!item || item.kind !== "approval") return null;

  const summary = isFileChange
    ? "wants to write files"
    : "wants to run a command";

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onKeyDown={(e) => {
        if (responding) return;
        if (e.key === "Enter") {
          e.preventDefault();
          respond("accept");
        } else if (e.key === "Escape") {
          e.preventDefault();
          respond("decline");
        }
      }}
      className="mx-auto mb-4 w-full max-w-[46rem] overflow-hidden rounded-[10px] border border-attn/55 bg-card outline-none focus-visible:border-attn"
    >
      <div className="flex items-center gap-2 border-b border-attn/25 bg-attn/10 px-3 py-1.5 font-mono text-[10px] text-attn">
        <span aria-hidden>⚑</span>
        <span className="font-semibold uppercase tracking-wider">
          Pending approval
        </span>
        <span className="font-normal text-attn/80">— {summary}</span>
        {count > 1 && (
          <span className="ml-auto rounded-full border border-attn/40 px-1.5 tabular-nums text-attn/90">
            1 of {count}
          </span>
        )}
      </div>

      <div className="max-h-[280px] overflow-auto px-3 py-2.5">
        <ApprovalPreview
          sessionId={sessionId}
          isFileChange={isFileChange}
          payload={item.payload}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2.5">
        <button
          onClick={() => respond("decline")}
          disabled={responding}
          className="focus-ring rounded-md border border-destructive/50 px-3 py-1 font-mono text-[10px] text-destructive hover:bg-destructive/10 disabled:opacity-40"
        >
          Decline <span className="text-destructive/60">⎋</span>
        </button>
        <button
          onClick={() => respond("cancel")}
          disabled={responding}
          className="focus-ring rounded-md px-3 py-1 font-mono text-[10px] text-muted-foreground hover:bg-accent disabled:opacity-40"
        >
          Cancel turn
        </button>
        <button
          onClick={() => respond("acceptForSession")}
          disabled={responding}
          className="focus-ring ml-auto rounded-md border border-border px-3 py-1 font-mono text-[10px] text-muted-foreground hover:bg-accent disabled:opacity-40"
        >
          Allow for session
        </button>
        <button
          onClick={() => respond("accept")}
          disabled={responding}
          className="focus-ring rounded-md border border-foreground bg-foreground px-3 py-1 font-mono text-[10px] font-semibold text-background hover:bg-foreground/90 disabled:opacity-40"
        >
          Allow <span className="text-background/60">↵</span>
        </button>
      </div>
    </div>
  );
}

/** The request preview: command details, or a file-change diff preview. */
function ApprovalPreview({
  sessionId,
  isFileChange,
  payload,
}: {
  sessionId: string;
  isFileChange: boolean;
  payload: Record<string, unknown>;
}) {
  // the fileChange item this approval points at (payload.itemId), if any
  const linkedItemId = typeof payload.itemId === "string" ? payload.itemId : "";
  const linked = useVibe((s) =>
    linkedItemId ? s.sessions[sessionId]?.items[linkedItemId] : undefined,
  );
  const turnDiff = useVibe((s) => s.sessions[sessionId]?.diff ?? null);

  // resolve the best-available preview diff data for a file-change approval
  const previewData = useMemo(() => {
    if (!isFileChange) return null;
    // 1. the linked fileChange item's first change
    if (linked && linked.kind === "fileChange" && linked.changes.length > 0) {
      return changeToDiffData(linked.changes[0]);
    }
    // 2. changes carried on the payload itself
    const raw = Array.isArray(payload.changes)
      ? (payload.changes as VibeFileChange[])
      : [];
    if (raw.length > 0 && typeof raw[0]?.path === "string") {
      return changeToDiffData(raw[0]);
    }
    // 3. the turn's aggregated diff, first file
    const files = splitUnifiedDiff(turnDiff);
    if (files.length > 0) return parsedFileToDiffData(files[0]);
    return null;
  }, [isFileChange, linked, payload, turnDiff]);

  if (isFileChange) {
    const files = approvalFilePaths(linked, payload);
    return (
      <div className="flex flex-col gap-2">
        {files.length > 0 && (
          <div className="flex flex-col gap-0.5">
            {files.map((f) => (
              <span
                key={f}
                className="truncate font-mono text-[10.5px] text-muted-foreground select-text"
              >
                {f}
              </span>
            ))}
          </div>
        )}
        {previewData ? (
          <CompactDiffPreview data={previewData} />
        ) : (
          <p className="font-mono text-[10.5px] text-faint">no preview available</p>
        )}
      </div>
    );
  }

  // command approval
  const command = approvalCommand(payload);
  const cwd = typeof payload.cwd === "string" ? payload.cwd : "";
  const reason = typeof payload.reason === "string" ? payload.reason : "";
  return (
    <div className="flex flex-col gap-1.5">
      {command ? (
        <pre className="overflow-x-auto rounded-md border border-border bg-background/40 px-2.5 py-1.5 font-mono text-[10.5px] leading-relaxed text-foreground select-text">
          {command}
        </pre>
      ) : (
        <p className="font-mono text-[10.5px] text-faint">no command</p>
      )}
      {cwd && (
        <span className="font-mono text-[10px] text-faint select-text">
          in {cwd}
        </span>
      )}
      {reason && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">{reason}</p>
      )}
    </div>
  );
}

/** File paths named by a file-change approval (linked item, then payload). */
function approvalFilePaths(
  linked: VibeItem | undefined,
  payload: Record<string, unknown>,
): string[] {
  if (linked && linked.kind === "fileChange") {
    return linked.changes.map((c) => c.path);
  }
  if (Array.isArray(payload.changes)) {
    return (payload.changes as VibeFileChange[])
      .map((c) => c?.path)
      .filter((p): p is string => typeof p === "string");
  }
  return [];
}
