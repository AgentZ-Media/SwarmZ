import { memo, useEffect, useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { useVibe } from "@/lib/vibe/session-store";
import { useVibeUi } from "@/lib/vibe/ui-store";
import { closeSession } from "@/lib/vibe/controller";
import { useOrchestrator } from "@/lib/orchestrator/chat-store";
import { useSwarm } from "@/store";
import { effectivePersona } from "@/lib/orchestrator/persona";
import {
  diffStats,
  hasPendingApproval,
  shortAge,
  totalTokens,
  VIBE_CTX_WARN,
  VIBE_FINISHED_WINDOW_MS,
} from "@/lib/vibe/ui";
import { cn, folderName, prettyModel } from "@/lib/utils";
import { AgentIdentityMark, useAgentSummary } from "../agents/AgentIdentity";

const RAIL_LABEL = "font-mono text-[9px] uppercase tracking-[0.12em] text-faint px-1 py-0.5";

/** The left rail: the pinned orchestrator "Conductor", the session cards
 * (signal-triad status), and the New-Session button. */
export function SessionRail() {
  // Builder sessions are excluded — they run in their own modal, not the rail.
  // Select a stable primitive signature (a joined id string) and rebuild the
  // array in useMemo, never a fresh array in the selector (AGENTS.md).
  const visibleSig = useVibe((s) =>
    s.order.filter((id) => !s.sessions[id]?.session.builderForSlug).join(","),
  );
  const order = useMemo(
    () => (visibleSig ? visibleSig.split(",") : []),
    [visibleSig],
  );
  const setNewSessionOpen = useVibeUi((s) => s.setNewSessionOpen);

  return (
    <div className="flex w-[264px] shrink-0 flex-col gap-2 overflow-hidden border-r border-border p-2.5">
      <span className={RAIL_LABEL}>Conductor</span>
      <ConductorCard />

      <span className={cn(RAIL_LABEL, "mt-1")}>Sessions</span>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {order.map((id) => (
          <SessionCard key={id} id={id} />
        ))}
        {order.length === 0 && (
          <p className="px-1 text-[11px] leading-relaxed text-faint">
            No sessions yet.
          </p>
        )}
      </div>

      <button
        onClick={() => setNewSessionOpen(true)}
        className="focus-ring mt-auto flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-input py-2 font-mono text-[10px] text-faint hover:border-ring/50 hover:text-muted-foreground"
      >
        <Plus size={12} /> New session
      </button>
    </div>
  );
}

function ConductorCard() {
  const active = useVibeUi((s) => s.stageMode === "conductor");
  const setStageMode = useVibeUi((s) => s.setStageMode);
  const running = useOrchestrator((s) => Object.values(s.busy).some(Boolean));
  const pings = useOrchestrator((s) =>
    s.chats.reduce(
      (n, c) => n + c.pendingPings.filter((p) => !p.delivered).length,
      0,
    ),
  );
  // active-chat model/effort/ctx (display-only — the picker lives in the stage
  // header). Primitive selectors, so a streaming delta never re-renders the rail.
  const provider = useOrchestrator(
    (s) => s.chats.find((c) => c.id === s.activeChatId)?.provider ?? "codex",
  );
  const model = useOrchestrator(
    (s) => s.chats.find((c) => c.id === s.activeChatId)?.model,
  );
  const effort = useOrchestrator(
    (s) => s.chats.find((c) => c.id === s.activeChatId)?.effort,
  );
  const ctxPct = useOrchestrator((s) => {
    const u = s.activeChatId ? s.tokenUsage[s.activeChatId] : null;
    const total = totalTokens(u?.last);
    const win = u?.modelContextWindow ?? 0;
    return win && total > 0 ? Math.round(Math.min(total / win, 1) * 100) : null;
  });
  const modelLabel = model
    ? prettyModel(model)
    : provider === "codex"
      ? "default model"
      : "";
  const persona = useSwarm((s) => effectivePersona(s.settings.orchestratorPersona));
  return (
    <button
      onClick={() => setStageMode("conductor")}
      className={cn(
        "focus-ring relative overflow-hidden rounded-lg border bg-card px-2.5 py-2 text-left",
        active
          ? "border-ring/60 ring-1 ring-ring/35"
          : "border-ring/30 hover:border-ring/50",
      )}
    >
      <div className="flex items-center gap-2">
        {persona.emoji ? (
          <span className="shrink-0 text-[11px] leading-none">{persona.emoji}</span>
        ) : (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ring" />
        )}
        <span className="min-w-0 truncate text-xs font-semibold text-foreground">
          {persona.name}
        </span>
        {pings > 0 && (
          <span className="ml-auto rounded-full border border-ring/45 px-1.5 font-mono text-[9px] text-ring">
            {pings} ping{pings === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <div className="mt-1 font-mono text-[10px] text-muted-foreground">
        {running ? "▸ working" : "the fleet conductor"}
      </div>

      {(modelLabel || (provider === "codex" && effort) || ctxPct !== null) && (
        <div className="mt-1 flex items-center gap-1.5 font-mono text-[9px] tabular-nums text-faint">
          {modelLabel && (
            <span className="min-w-0 truncate">{modelLabel}</span>
          )}
          {provider === "codex" && effort && (
            <span className="shrink-0">· {effort}</span>
          )}
          {ctxPct !== null && (
            <span
              className={cn(
                "ml-auto shrink-0",
                ctxPct >= VIBE_CTX_WARN * 100 && "text-warning",
              )}
            >
              ctx {ctxPct}%
            </span>
          )}
        </div>
      )}
    </button>
  );
}

// ---- session card ----
// Selects primitives only, so a streaming delta on session A never re-renders
// session B's card (zustand's Object.is check keeps it scoped). hasPendingApproval
// runs in a selector but short-circuits and returns a stable boolean.

const SessionCard = memo(function SessionCard({ id }: { id: string }) {
  const name = useVibe((s) => s.sessions[id]?.session.name ?? "");
  const projectDir = useVibe((s) => s.sessions[id]?.session.projectDir ?? "");
  const model = useVibe((s) => s.sessions[id]?.session.model);
  const effort = useVibe((s) => s.sessions[id]?.session.effort);
  // ctx % from the latest turn accounting (like the stage gauge) — a primitive
  // number so a streaming delta on this session never re-renders the whole rail
  const ctxPct = useVibe((s) => {
    const u = s.sessions[id]?.tokenUsage;
    const total = totalTokens(u?.last);
    const win = u?.modelContextWindow ?? 0;
    return win && total > 0 ? Math.round(Math.min(total / win, 1) * 100) : null;
  });
  const diff = useVibe((s) => s.sessions[id]?.diff ?? null);
  const busy = useVibe((s) => !!s.busy[id]);
  const isActiveId = useVibe((s) => s.activeId === id);
  const sessionStage = useVibeUi((s) => s.stageMode === "session");
  const active = isActiveId && sessionStage;
  const needsYou = useVibe((s) => {
    const e = s.sessions[id];
    return e ? hasPendingApproval(e) : false;
  });
  const lastBusyEndAt = useVibe((s) => s.sessions[id]?.lastBusyEndAt ?? null);
  const agentSlug = useVibe((s) => s.sessions[id]?.session.agentSlug);
  const agentSummary = useAgentSummary(agentSlug);

  const setActive = useVibe((s) => s.setActive);
  const setStageMode = useVibeUi((s) => s.setStageMode);
  const setCloseConfirmId = useVibeUi((s) => s.setCloseConfirmId);

  // ephemeral "finished" moment ticks down without an event → local 30s tick
  const [, force] = useState(0);
  useEffect(() => {
    if (busy || needsYou || lastBusyEndAt === null) return;
    if (Date.now() - lastBusyEndAt >= VIBE_FINISHED_WINDOW_MS) return;
    const t = setInterval(() => force((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [busy, needsYou, lastBusyEndAt]);

  // derive the signal-triad state from the primitives above (kept cheap so a
  // streaming delta on one session never re-renders the whole rail)
  const finished =
    lastBusyEndAt !== null &&
    Date.now() - lastBusyEndAt < VIBE_FINISHED_WINDOW_MS;
  const state: "working" | "needsYou" | "finished" | "idle" = needsYou
    ? "needsYou"
    : busy
      ? "working"
      : finished
        ? "finished"
        : "idle";

  const { add, del } = diffStats(diff);

  const onClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) setCloseConfirmId(id);
    else void closeSession(id);
  };

  return (
    <div
      onClick={() => {
        setActive(id);
        setStageMode("session");
      }}
      className={cn(
        "group/card relative cursor-default overflow-hidden rounded-lg border bg-card px-2.5 py-2",
        active
          ? "border-ring/60 ring-1 ring-ring/35"
          : state === "needsYou"
            ? "border-attn/55"
            : "border-border hover:border-input",
      )}
    >
      {busy && (
        <span className="activity-line activity-line-top">
          <span className="sr-only">working</span>
        </span>
      )}

      <div className="flex items-center gap-2">
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{
            backgroundColor:
              state === "needsYou"
                ? "var(--attn)"
                : state === "working"
                  ? "var(--muted-foreground)"
                  : "var(--faint)",
          }}
        />
        <AgentIdentityMark summary={agentSummary} size={12} />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
          {name}
        </span>
        <button
          onClick={onClose}
          title="Close session"
          className="focus-ring flex h-4 w-4 shrink-0 items-center justify-center rounded text-faint opacity-0 hover:bg-destructive/15 hover:text-destructive focus-visible:opacity-100 group-hover/card:opacity-100"
        >
          <X size={10} />
        </button>
      </div>

      <div className="mt-1 flex items-center gap-2 font-mono text-[10px] tabular-nums text-faint">
        <span className="min-w-0 truncate">{folderName(projectDir)}</span>
        {(add > 0 || del > 0) && (
          <span className="ml-auto shrink-0">
            <span className="text-diff-add">+{add}</span>{" "}
            <span className="text-diff-del">−{del}</span>
          </span>
        )}
      </div>

      <StatusLine state={state} lastBusyEndAt={lastBusyEndAt} />

      {(model || effort || ctxPct !== null) && (
        <div className="mt-1 flex items-center gap-1.5 font-mono text-[9px] tabular-nums text-faint">
          {model && (
            <span className="min-w-0 truncate">{prettyModel(model)}</span>
          )}
          {effort && <span className="shrink-0">· {effort}</span>}
          {ctxPct !== null && (
            <span
              className={cn(
                "ml-auto shrink-0",
                ctxPct >= VIBE_CTX_WARN * 100 && "text-warning",
              )}
            >
              ctx {ctxPct}%
            </span>
          )}
        </div>
      )}
    </div>
  );
});

function StatusLine({
  state,
  lastBusyEndAt,
}: {
  state: "working" | "needsYou" | "finished" | "idle";
  lastBusyEndAt: number | null;
}) {
  const base = "mt-1.5 font-mono text-[10px]";
  switch (state) {
    case "working":
      return <div className={cn(base, "text-muted-foreground")}>▸ working</div>;
    case "needsYou":
      return (
        <div className={cn(base, "font-semibold text-attn")}>
          ⚑ needs you — approval pending
        </div>
      );
    case "finished": {
      const age = Date.now() - (lastBusyEndAt ?? Date.now());
      return (
        <div className={cn(base, "text-success")}>
          ✓ finished · {age < 60_000 ? "just now" : `${shortAge(age)} ago`}
        </div>
      );
    }
    case "idle":
      return <div className={cn(base, "text-faint")}>· idle</div>;
  }
}
