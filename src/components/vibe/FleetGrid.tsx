// The Fleet GRID (Vibe v3) — the right-hand home view: one mini-window card
// per agent of the ACTIVE project, with filter chips and the dot-grid canvas.
// Every card is a self-contained mini surface: status header, live mini-feed
// (the last transcript lines), a quick-approval row while the agent waits,
// and a mini composer. Clicking a card focuses the session (FocusStage).
//
// Performance contract (AGENTS.md): no selector returns a fresh array/object.
// The grid selects one primitive status signature and rebuilds rows in
// useMemo; each card selects only ITS session's primitives by id; each
// mini-feed line selects only ITS item by id (identity-preserved store).

import { memo, useEffect, useMemo, useState } from "react";
import { Maximize2, Plus, X } from "lucide-react";
import { useVibe } from "@/lib/vibe/session-store";
import { useVibeUi, type FleetFilter } from "@/lib/vibe/ui-store";
import {
  closeSession,
  focusSession,
  respondApproval,
  sendMessage,
} from "@/lib/vibe/controller";
import { useProjects } from "@/lib/projects/store";
import {
  approvalCommand,
  commandExit,
  decayedSignal,
  diffStats,
  hasPendingApproval,
  shortAge,
} from "@/lib/vibe/ui";
import { changeStats } from "@/lib/vibe/diff";
import { reportForItem } from "@/lib/vibe/report-item";
import { cn, folderName } from "@/lib/utils";
import type { VibeItem } from "@/types";

type FleetState = "working" | "needs" | "finished" | "idle";

// ---------------------------------------------------------------------------
// status signature — ONE primitive string for the whole grid: id + busy +
// needs-you + lastBusyEndAt per session of the active project. Pure store
// data (no Date.now in the selector — getSnapshot must be idempotent); the
// time-dependent "finished" decay is derived in useMemo below, refreshed by
// a 30 s tick.
// ---------------------------------------------------------------------------

function useFleetRows(): {
  rows: { id: string; state: FleetState }[];
  counts: Record<FleetState, number> & { all: number };
} {
  const activeProjectId = useProjects((s) => s.activeProjectId);
  const sig = useVibe((s) => {
    const parts: string[] = [];
    for (const id of s.order) {
      const e = s.sessions[id];
      if (!e) continue;
      if (activeProjectId && e.session.projectId !== activeProjectId) continue;
      parts.push(
        `${id}:${s.busy[id] ? 1 : 0}:${hasPendingApproval(e) ? 1 : 0}:${e.lastBusyEndAt ?? ""}`,
      );
    }
    return parts.join("|");
  });

  // 30 s tick so the ephemeral "finished" state decays without store events —
  // the tick VALUE is a memo dep (a force-render alone would leave the memo
  // cached on `sig` and `now` would never re-evaluate)
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  return useMemo(() => {
    const now = Date.now();
    const rows: { id: string; state: FleetState }[] = [];
    const counts = { all: 0, working: 0, needs: 0, finished: 0, idle: 0 };
    if (sig) {
      for (const part of sig.split("|")) {
        const [id, busy, needs, endAt] = part.split(":");
        const signal = decayedSignal(
          busy === "1",
          needs === "1",
          endAt ? Number(endAt) : null,
          now,
        );
        const state: FleetState = signal === "needsYou" ? "needs" : signal;
        rows.push({ id, state });
        counts[state]++;
        counts.all++;
      }
    }
    return { rows, counts };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, tick]);
}

export function FleetGrid() {
  const filter = useVibeUi((s) => s.fleetFilter);
  const setNewSessionOpen = useVibeUi((s) => s.setNewSessionOpen);
  const hasProject = useProjects((s) => !!s.activeProjectId);
  const { rows, counts } = useFleetRows();
  const shown = filter === "all" ? rows : rows.filter((r) => r.state === filter);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
        <span aria-hidden className="font-mono text-12 text-acc">
          //
        </span>
        <span className="-ml-1 text-14 font-semibold tracking-[-0.01em] text-txt">
          Fleet
        </span>
        <FilterChips counts={counts} />
        <button
          onClick={() => setNewSessionOpen(true)}
          className="focus-ring ml-auto flex h-7 items-center gap-1.5 rounded-md border border-dashed border-line2 px-3 text-12 text-fnt hover:border-fnt hover:text-mut"
        >
          <Plus size={11} /> agent
        </button>
      </div>

      <div className="dot-grid grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(272px,1fr))] auto-rows-max content-start gap-3 overflow-y-auto p-4">
        {shown.map((r) => (
          <AgentCard key={r.id} id={r.id} state={r.state} />
        ))}
        {shown.length === 0 && (
          <EmptyState
            filtered={rows.length > 0}
            hasProject={hasProject}
            onNew={() => setNewSessionOpen(true)}
          />
        )}
      </div>
    </div>
  );
}

function EmptyState({
  filtered,
  hasProject,
  onNew,
}: {
  filtered: boolean;
  hasProject: boolean;
  onNew: () => void;
}) {
  return (
    <div className="col-span-full flex flex-col items-center gap-3 py-20 text-center">
      <p className="max-w-xs text-12 leading-normal text-fnt">
        {filtered
          ? "No agents match this filter."
          : hasProject
            ? "No agents in this project yet — spin one up, or ask the Conductor to split the work."
            : "Open a project to run agents on it."}
      </p>
      {!filtered && hasProject && (
        <button
          onClick={onNew}
          className="focus-ring flex h-8 items-center gap-1.5 rounded-md bg-acc px-4 text-12 font-semibold text-white hover:brightness-110"
        >
          <Plus size={12} /> New agent
        </button>
      )}
    </div>
  );
}

// ---- filter chips ----

const FILTERS: { key: FleetFilter; glyph: string; cls: string }[] = [
  { key: "all", glyph: "", cls: "text-txt" },
  { key: "working", glyph: "▸", cls: "text-acc" },
  { key: "needs", glyph: "⚑", cls: "text-attn" },
  { key: "finished", glyph: "✓", cls: "text-ok" },
  { key: "idle", glyph: "·", cls: "text-fnt" },
];

function FilterChips({
  counts,
}: {
  counts: Record<FleetState, number> & { all: number };
}) {
  const filter = useVibeUi((s) => s.fleetFilter);
  const setFilter = useVibeUi((s) => s.setFleetFilter);
  return (
    <div className="flex items-center rounded-md border border-line bg-card p-0.5">
      {FILTERS.map((f) => {
        const on = filter === f.key;
        const n = f.key === "all" ? counts.all : counts[f.key];
        return (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            title={f.key === "all" ? "All agents" : f.key}
            className={cn(
              "focus-ring flex h-[26px] items-center gap-1.5 rounded-sm px-3 font-mono text-12 tabular-nums",
              on ? "bg-pop font-semibold text-txt" : "text-fnt hover:text-mut",
            )}
          >
            {f.glyph && (
              <span aria-hidden className={f.cls}>
                {f.glyph}
              </span>
            )}
            {f.key === "all" ? `All ${n}` : n}
          </button>
        );
      })}
    </div>
  );
}

// ---- one agent card ----

const STATE_DOT: Record<FleetState, string> = {
  working: "bg-acc animate-zpulse",
  needs: "bg-attn animate-zattn",
  finished: "bg-ok",
  idle: "bg-fnt",
};

const AgentCard = memo(function AgentCard({
  id,
  state,
}: {
  id: string;
  state: FleetState;
}) {
  const name = useVibe((s) => s.sessions[id]?.session.name ?? "");
  const projectDir = useVibe((s) => s.sessions[id]?.session.projectDir ?? "");
  const fromConductor = useVibe(
    (s) => s.sessions[id]?.session.spawnedBy === "conductor",
  );
  const branch = useVibe(
    (s) => s.sessions[id]?.session.worktree?.branch ?? "",
  );
  const busy = useVibe((s) => !!s.busy[id]);
  const diff = useVibe((s) => s.sessions[id]?.diff ?? null);
  const lastBusyEndAt = useVibe((s) => s.sessions[id]?.lastBusyEndAt ?? null);
  const setCloseConfirmId = useVibeUi((s) => s.setCloseConfirmId);
  // memoized — diffStats scans the full diff string, never per card render
  const { add, del } = useMemo(() => diffStats(diff), [diff]);

  // the "✓ Xm" age label ticks while the card shows "finished" (the memo'd
  // card otherwise never re-renders between state changes)
  const [, setAgeTick] = useState(0);
  useEffect(() => {
    if (state !== "finished") return;
    const t = setInterval(() => setAgeTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [state]);

  const where = branch ? `⎇ ${branch.split("/").pop()}` : folderName(projectDir);

  const onClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) setCloseConfirmId(id);
    else void closeSession(id);
  };
  const open = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    focusSession(id);
  };

  return (
    <div
      className={cn(
        "animate-zfadeup relative flex h-[272px] flex-col overflow-clip rounded-xl border bg-card transition-[border-color,box-shadow] hover:shadow-card",
        state === "needs"
          ? "border-attn/45 hover:border-attn/60"
          : "border-line hover:border-line2",
      )}
    >
      {busy && <span className="activity-line activity-line-top" />}

      {/* mini window header */}
      <div
        onClick={() => open()}
        title="Expand agent"
        className="flex shrink-0 cursor-default items-center gap-2 border-b border-line py-2 pl-3 pr-2 hover:bg-pop"
      >
        <span
          aria-hidden
          className={cn("h-[9px] w-[9px] shrink-0 rounded-full", STATE_DOT[state])}
        />
        <span className="min-w-0 truncate text-13 font-semibold text-txt">
          {name}
        </span>
        {fromConductor && (
          // dezent — marks a lane the Conductor staffed vs. a self-spawned one.
          // `//` is the Conductor's mark throughout the app (sidebar header),
          // so it reads as attribution without stealing the name's width.
          <span
            aria-label="Spawned by the Conductor"
            title="Spawned by the Conductor"
            className="shrink-0 rounded-sm border border-acc/35 bg-acc/10 px-1 font-mono text-10 font-semibold leading-none text-acc/90"
          >
            //
          </span>
        )}
        <span className="min-w-0 truncate font-mono text-10 text-fnt">
          {where}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {state === "finished" && lastBusyEndAt !== null && (
            <span className="mr-1 font-mono text-10 text-ok">
              ✓ {shortAge(Date.now() - lastBusyEndAt)}
            </span>
          )}
          {(add > 0 || del > 0) && (
            <span className="mr-1 font-mono text-10 tabular-nums">
              <span className="text-add">+{add}</span>{" "}
              <span className="text-del">−{del}</span>
            </span>
          )}
          <button
            onClick={open}
            title="Expand agent"
            className="focus-ring flex h-[26px] w-[26px] items-center justify-center rounded-sm text-fnt hover:bg-line hover:text-txt"
          >
            <Maximize2 size={12} />
          </button>
          <button
            onClick={onClose}
            title="Close agent"
            className="focus-ring flex h-[26px] w-[26px] items-center justify-center rounded-sm text-fnt hover:bg-err/15 hover:text-err"
          >
            <X size={12} />
          </button>
        </span>
      </div>

      {/* mini feed */}
      <MiniFeed id={id} busy={busy} onOpen={() => open()} />

      {/* quick approval */}
      <QuickApproval id={id} />

      {/* mini composer */}
      <MiniComposer id={id} name={name} />
    </div>
  );
});

// ---- mini feed: tail signature → per-item rows (identity-preserved) ----

function MiniFeed({
  id,
  busy,
  onOpen,
}: {
  id: string;
  busy: boolean;
  onOpen: () => void;
}) {
  const tailSig = useVibe((s) =>
    (s.sessions[id]?.order ?? []).slice(-4).join("|"),
  );
  const itemIds = useMemo(() => (tailSig ? tailSig.split("|") : []), [tailSig]);
  return (
    <div
      onClick={onOpen}
      className="flex min-h-0 flex-1 cursor-default flex-col justify-end gap-1.5 overflow-hidden px-3 py-2.5"
    >
      {itemIds.length === 0 && (
        <p className="text-11 leading-normal text-fnt">
          Fresh agent — send a prompt below or route one via the Conductor.
        </p>
      )}
      {itemIds.map((iid) => (
        <MiniLine key={iid} sessionId={id} itemId={iid} />
      ))}
      {busy && (
        <div className="font-mono text-11 text-fnt">
          <span className="animate-zcaret">…</span>
        </div>
      )}
    </div>
  );
}

/** One mini-feed line — selects ONLY its own item (stable reference until
 * that item changes), so a streaming delta re-renders exactly this line. */
const MiniLine = memo(function MiniLine({
  sessionId,
  itemId,
}: {
  sessionId: string;
  itemId: string;
}) {
  const item = useVibe((s) => s.sessions[sessionId]?.items[itemId]);
  if (!item) return null;
  const l = miniLine(item);
  if (!l) return null;
  return (
    <div
      className={cn(
        "flex min-w-0 items-baseline gap-1.5 leading-normal",
        l.mono ? "font-mono text-11" : "text-12",
        l.textCls,
      )}
    >
      <span aria-hidden className={cn("shrink-0", l.glyphCls)}>
        {l.glyph}
      </span>
      <span
        className={cn(
          "min-w-0 overflow-hidden",
          l.clamp2 ? "line-clamp-2" : "truncate",
        )}
      >
        {l.text}
      </span>
      {l.meta && (
        <span
          className={cn(
            "ml-auto shrink-0 font-mono text-10 tabular-nums",
            l.metaCls,
          )}
        >
          {l.meta}
        </span>
      )}
    </div>
  );
});

interface MiniLineSpec {
  glyph: string;
  glyphCls: string;
  text: string;
  textCls: string;
  mono?: boolean;
  clamp2?: boolean;
  meta?: string;
  metaCls?: string;
}

function miniLine(item: VibeItem): MiniLineSpec | null {
  switch (item.kind) {
    case "user":
      // a Conductor-injected prompt is marked with the Conductor's `//` glyph
      return item.via === "conductor"
        ? {
            glyph: "//",
            glyphCls: "text-acc/80",
            text: item.text,
            textCls: "text-mut",
            mono: true,
          }
        : {
            glyph: "›",
            glyphCls: "text-fnt",
            text: item.text,
            textCls: "text-mut",
          };
    case "assistant": {
      // an expect_report turn's final message: a readable status line
      // instead of clamped raw JSON (same gate as the ItemFeed report card)
      const report = reportForItem(item);
      if (report) {
        return {
          glyph: report.needsHuman ? "⚑" : report.done ? "✓" : "▸",
          glyphCls: report.needsHuman
            ? "text-attn"
            : report.done
              ? "text-ok"
              : "text-fnt",
          text: (report.needsHuman && report.question) || report.summary || "report",
          textCls: report.needsHuman ? "text-attn" : "text-mut",
          clamp2: true,
        };
      }
      return {
        glyph: "·",
        glyphCls: "text-acc",
        text: item.text,
        textCls: "text-mut",
        clamp2: true,
      };
    }
    case "command": {
      const { text, failed } = commandExit(item);
      return {
        glyph: "$",
        glyphCls: "text-fnt",
        text: item.command || "command",
        textCls: "text-txt",
        mono: true,
        meta: text,
        metaCls:
          text === "running" ? "text-fnt" : failed ? "text-err" : "text-ok",
      };
    }
    case "fileChange": {
      let add = 0;
      let del = 0;
      for (const c of item.changes) {
        const s = changeStats(c);
        add += s.add;
        del += s.del;
      }
      return {
        glyph: "Δ",
        glyphCls: "text-acc",
        text:
          item.changes.length === 1
            ? item.changes[0].path
            : `${item.changes.length} files changed`,
        textCls: "text-txt",
        mono: true,
        meta: `+${add} −${del}`,
        metaCls: "text-fnt",
      };
    }
    case "approval": {
      const pending = item.status === "pending";
      const cmd = approvalCommand(item.payload);
      return {
        glyph: "⚑",
        glyphCls: "text-attn",
        text:
          cmd ||
          (item.approvalKind === "fileChange" ? "wants to write files" : "approval"),
        textCls: pending ? "text-attn" : "text-fnt",
        mono: true,
        meta: pending ? "pending" : item.status,
        metaCls: pending ? "text-attn" : "text-fnt",
      };
    }
    case "warning":
      return {
        glyph: "⚠",
        glyphCls: "text-warn",
        text: item.text,
        textCls: "text-warn",
      };
    case "plan":
      return {
        glyph: "≡",
        glyphCls: "text-fnt",
        text: item.explanation || "plan updated",
        textCls: "text-fnt",
      };
    case "webSearch":
      return {
        glyph: "⌕",
        glyphCls: "text-fnt",
        text: item.query,
        textCls: "text-fnt",
        mono: true,
      };
    default:
      return null;
  }
}

// ---- quick approval row ----

function QuickApproval({ id }: { id: string }) {
  const firstPendingId = useVibe((s) => {
    const e = s.sessions[id];
    if (!e) return "";
    for (const iid of e.order) {
      const it = e.items[iid];
      if (it && it.kind === "approval" && it.status === "pending") return iid;
    }
    return "";
  });
  if (!firstPendingId) return null;
  return <QuickApprovalRow key={firstPendingId} id={id} itemId={firstPendingId} />;
}

function QuickApprovalRow({ id, itemId }: { id: string; itemId: string }) {
  const item = useVibe((s) => s.sessions[id]?.items[itemId]);
  const [responding, setResponding] = useState(false);
  if (!item || item.kind !== "approval") return null;
  const hint =
    approvalCommand(item.payload) ||
    (item.approvalKind === "fileChange"
      ? "wants to write files"
      : "wants to run a command");
  const respond = (decision: "accept" | "decline") => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (responding) return;
    setResponding(true);
    void respondApproval(id, itemId, decision);
  };
  return (
    <div className="flex shrink-0 items-center gap-1.5 border-t border-attn/25 bg-attn/10 px-3 py-1.5">
      <span className="flex min-w-0 items-center gap-1.5 font-mono text-10 text-attn">
        <span aria-hidden className="animate-zattn shrink-0">
          ⚑
        </span>
        <span className="min-w-0 truncate">{hint}</span>
      </span>
      <button
        onClick={respond("decline")}
        disabled={responding}
        className="focus-ring ml-auto shrink-0 rounded-sm border border-line2 px-2 py-0.5 font-mono text-10 text-mut hover:border-err/45 hover:text-err disabled:opacity-40"
      >
        Decline
      </button>
      <button
        onClick={respond("accept")}
        disabled={responding}
        className="focus-ring shrink-0 rounded-sm bg-txt px-2.5 py-0.5 font-mono text-10 font-bold text-bg hover:brightness-90 disabled:opacity-40"
      >
        Allow
      </button>
    </div>
  );
}

// ---- mini composer ----

function MiniComposer({ id, name }: { id: string; name: string }) {
  // the human composer waits while a turn runs (one turn at a time, AGENTS.md)
  const busy = useVibe((s) => !!s.busy[id]);
  const [text, setText] = useState("");
  const send = () => {
    const t = text.trim();
    if (!t || busy) return;
    void sendMessage(id, t);
    setText("");
  };
  return (
    <div className="flex shrink-0 items-center gap-1.5 border-t border-line px-2 py-1.5">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            send();
          }
        }}
        placeholder={busy ? `${name} is working…` : `Message ${name}…`}
        className="min-w-0 flex-1 select-text bg-transparent text-12 text-txt placeholder:text-fnt focus:outline-none"
      />
      <button
        onClick={send}
        title="Send"
        className={cn(
          "focus-ring flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-white",
          text.trim() && !busy ? "bg-acc hover:brightness-110" : "bg-line2",
        )}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="12" y1="20" x2="12" y2="5" />
          <polyline points="6 11 12 5 18 11" />
        </svg>
      </button>
    </div>
  );
}
