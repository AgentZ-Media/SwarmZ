import { useEffect, useId, useState } from "react";
import { AlertTriangle, Bot, CheckCheck, ChevronRight } from "lucide-react";
import { useMissions } from "@/lib/missions/store";
import {
  type AttentionRow,
  type AttentionTone,
} from "@/lib/attention/core";
import { useAttentionRows } from "@/lib/attention/use-attention";
import { activateProject, focusSession } from "@/lib/vibe/controller";
import { useVibeUi } from "@/lib/vibe/ui-store";
import { useSwarm } from "@/store";
import { acknowledgeGithubAttention } from "@/lib/attention/acknowledgement";
import { cn } from "@/lib/utils";

export interface AttentionInboxProps {
  className?: string;
  /** Useful when the inbox is embedded in a compact overview column. */
  maxItems?: number;
  /** Reserve the drawer header's top-right close-button footprint. */
  reserveCloseButtonSpace?: boolean;
}

/**
 * Global decision queue across durable mission state and live worker state.
 * Store selectors emit only primitive signatures; fresh row objects are built
 * outside Zustand so transcript and event-log updates cannot cause a render
 * loop through unstable object identity.
 */
export function AttentionInbox({
  className,
  maxItems,
  reserveCloseButtonSpace = false,
}: AttentionInboxProps) {
  const titleId = useId();
  const hydrateStatus = useMissions((state) => state.hydrateStatus);
  const hydrateError = useMissions((state) => state.hydrateError);
  const rows = useAttentionRows();
  const visibleRows =
    maxItems === undefined ? rows : rows.slice(0, Math.max(1, maxItems));
  const hiddenCount = rows.length - visibleRows.length;

  // Relative ages remain honest while the panel stays open without placing
  // Date.now() inside a Zustand selector.
  const [, setClock] = useState(0);
  useEffect(() => {
    if (rows.length === 0) return;
    const timer = window.setInterval(() => setClock((value) => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [rows.length]);

  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-card",
        className,
      )}
    >
      <header
        className={cn(
          "flex min-h-12 flex-wrap items-center gap-2 border-b border-line px-4 py-2",
          reserveCloseButtonSpace && "pr-12",
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span aria-hidden className="font-mono text-13 text-attn">
              ⚑
            </span>
            <h2
              id={titleId}
              className="text-14 font-semibold tracking-[-0.01em] text-txt"
            >
              Attention inbox
            </h2>
          </div>
          <p className="mt-0.5 text-11 text-mut">
            Decisions and failures across missions and workers.
          </p>
        </div>
        <span className="rounded-sm border border-line2 bg-panel px-2 py-1 font-mono text-11 tabular-nums text-mut">
          {rows.length} open
        </span>
      </header>

      {hydrateStatus === "failed" ? (
        <div
          role="alert"
          className="m-3 rounded-lg border border-err/40 bg-err/10 px-3 py-2.5"
        >
          <div className="flex items-center gap-2 text-12 font-medium text-err">
            <AlertTriangle size={14} aria-hidden /> Mission storage unavailable
          </div>
          <p className="mt-1 break-words text-11 leading-normal text-mut">
            {hydrateError || "Mission attention could not be loaded safely."}
          </p>
        </div>
      ) : hydrateStatus === "pending" && visibleRows.length === 0 ? (
        <div
          role="status"
          aria-live="polite"
          className="flex min-h-40 flex-1 items-center justify-center px-6 py-8"
        >
          <span aria-hidden className="mr-2 h-2 w-2 animate-pulse rounded-full bg-acc" />
          <span className="font-mono text-11 text-mut">
            Loading mission attention…
          </span>
        </div>
      ) : visibleRows.length === 0 ? (
        <div className="flex min-h-40 flex-1 flex-col items-center justify-center px-6 py-8 text-center">
          <CheckCheck size={20} className="text-ok" aria-hidden />
          <p className="mt-2 text-13 font-medium text-txt">Nothing needs you</p>
          <p className="mt-1 max-w-[42ch] text-11 leading-normal text-mut">
            Failed gates, blocked tasks, worker approvals and structured
            questions will collect here.
          </p>
        </div>
      ) : (
        <div
          role="list"
          aria-label="Items needing attention"
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {visibleRows.map((row) => (
            <AttentionItem key={row.key} row={row} />
          ))}
          {hiddenCount > 0 && (
            <p className="border-t border-line px-4 py-2 text-center font-mono text-10 text-fnt">
              {hiddenCount} more in the full inbox
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function AttentionItem({ row }: { row: AttentionRow }) {
  const navigate = () => {
    if (row.source === "github") {
      const swarm = useSwarm.getState();
      swarm.updateSettings({
        githubAttentionAcknowledged: acknowledgeGithubAttention(
          swarm.settings.githubAttentionAcknowledged,
          [row],
        ),
      });
    }
    const ui = useVibeUi.getState();
    ui.setAttentionOpen(false);
    // Attention is global. Re-open/activate the owning project before any
    // mission, integration or GitHub navigation mutates its local selection.
    activateProject(row.projectId);
    if (row.source === "worker") {
      focusSession(row.sourceId);
      return;
    }
    if (row.source === "github") {
      useSwarm.getState().setGithubOpen(true);
      return;
    }
    ui.setSelectedMissionId(row.missionId);
    if (row.source === "train") {
      ui.setSelectedMissionTaskId(null);
      ui.setWorkspaceView("integration");
    } else {
      ui.setSelectedMissionTaskId(row.sourceId);
      ui.setWorkspaceView("board");
    }
  };

  return (
    <div
      role="listitem"
      className={cn(
        "border-b border-line last:border-b-0",
        row.tone === "attention" && "bg-attn/[0.04]",
      )}
    >
      <button
        type="button"
        onClick={navigate}
        aria-label={`${row.statusLabel}: ${row.title}, ${row.place}`}
        className="focus-ring group flex w-full min-w-0 items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-pop"
      >
        <span
          aria-hidden
          className={cn(
            "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border font-mono text-11",
            row.tone === "attention" &&
              "border-attn/35 bg-attn/10 text-attn",
            row.tone === "blocked" && "border-warn/35 bg-warn/10 text-warn",
            row.tone === "failed" && "border-err/35 bg-err/10 text-err",
          )}
        >
          {row.source === "worker" ? <Bot size={13} /> : statusGlyph(row.tone)}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 flex-1 truncate text-12 font-medium text-txt">
              {row.title}
            </span>
            <span
              className={cn(
                "shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-10",
                row.tone === "attention" && "bg-attn/10 text-attn",
                row.tone === "blocked" && "bg-warn/10 text-warn",
                row.tone === "failed" && "bg-err/10 text-err",
              )}
            >
              {row.statusLabel}
            </span>
          </span>
          <span className="mt-1 line-clamp-2 break-words text-11 leading-normal text-mut">
            {row.detail}
          </span>
          <span className="mt-1.5 flex min-w-0 items-center gap-2 font-mono text-10 text-fnt">
            <span className="truncate">{row.place}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0 tabular-nums">{formatAge(row.since)}</span>
          </span>
        </span>

        <ChevronRight
          size={14}
          aria-hidden
          className="mt-1 shrink-0 text-fnt transition-transform group-hover:translate-x-0.5 group-hover:text-mut"
        />
      </button>
    </div>
  );
}

function statusGlyph(tone: AttentionTone): string {
  return tone === "attention" ? "⚑" : tone === "failed" ? "×" : "!";
}

function formatAge(since: number): string {
  const elapsed = Math.max(0, Date.now() - since);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}
