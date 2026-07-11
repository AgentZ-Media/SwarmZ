// The agent FOCUS view (Vibe v3) — one session expanded out of the fleet
// grid: header (status/name/path/model/access/Δ/ctx/Stop/wide), the
// virtualized transcript, the turn-diff panel, the plan panel and the
// composer (with the approval takeover). The wide toggle fills the whole
// window; "back" collapses to the grid.

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Maximize2, Minimize2, Pencil, Square } from "lucide-react";
import { useVibe } from "@/lib/vibe/session-store";
import { useVibeUi } from "@/lib/vibe/ui-store";
import {
  focusSession,
  interrupt,
  setAccess,
  setModelEffort,
} from "@/lib/vibe/controller";
import {
  decayedSignal,
  hasPendingApproval,
  totalTokens,
  VIBE_CTX_WARN,
} from "@/lib/vibe/ui";
import { recentCodexModels } from "@/lib/orchestrator/models";
import { splitUnifiedDiff } from "@/lib/vibe/diff";
import { ModelEffortPicker } from "@/components/orchestrator/ModelEffortPicker";
import { Tip } from "@/components/ui/tooltip";
import { cn, prettyModel, shortPath } from "@/lib/utils";
import type { VibeAccess, VibePlanStep } from "@/types";
import { ItemFeed } from "./ItemFeed";
import { Composer } from "./Composer";
import { TurnDiffFiles } from "./DiffCard";

export function FocusStage() {
  const activeId = useVibe((s) => s.activeId);
  const hasActive = useVibe((s) => !!(s.activeId && s.sessions[s.activeId]));
  if (!activeId || !hasActive) return null;
  // key on the id so per-session composer/feed state resets cleanly on switch
  return <Stage key={activeId} sessionId={activeId} />;
}

function Stage({ sessionId }: { sessionId: string }) {
  const wide = useVibeUi((s) => s.wide);
  const [turnDiffOpen, setTurnDiffOpen] = useState(false);
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col",
        // wide sits ABOVE the base layout but BELOW all modal chrome: the
        // drawers (z-30/40), dialogs + palette (z-50) and toasts (z-70) must
        // never open invisibly underneath it (the z-order contract — see the
        // drawer/dialog components).
        wide
          ? "animate-zoverlay fixed inset-0 z-20 bg-bg"
          : "animate-zfadeup min-h-0 flex-1",
      )}
    >
      <CrossSessionBanner sessionId={sessionId} />
      <StageHeader
        sessionId={sessionId}
        turnDiffOpen={turnDiffOpen}
        onToggleTurnDiff={() => setTurnDiffOpen((o) => !o)}
      />
      <ItemFeed sessionId={sessionId} />
      {turnDiffOpen && (
        <TurnDiffPanel sessionId={sessionId} onClose={() => setTurnDiffOpen(false)} />
      )}
      <PlanCard sessionId={sessionId} />
      <Composer sessionId={sessionId} />
    </div>
  );
}

// ---- cross-session approval banner ----
// Closes the "I'm deep in session A" gap: a pending approval in ANOTHER session
// shows a thin amber banner here. Primitive selectors only (never a fresh
// array) so this never loops useSyncExternalStore (AGENTS.md).

function CrossSessionBanner({ sessionId }: { sessionId: string }) {
  const otherCount = useVibe((s) => {
    let n = 0;
    for (const id of s.order) {
      if (id === sessionId) continue;
      const e = s.sessions[id];
      if (e && hasPendingApproval(e)) n++;
    }
    return n;
  });
  const firstOther = useVibe((s) => {
    for (const id of s.order) {
      if (id === sessionId) continue;
      const e = s.sessions[id];
      if (e && hasPendingApproval(e)) return id;
    }
    return "";
  });
  const firstName = useVibe((s) =>
    firstOther ? (s.sessions[firstOther]?.session.name ?? "") : "",
  );

  if (otherCount === 0 || !firstOther) return null;
  return (
    <button
      onClick={() => focusSession(firstOther)}
      className="focus-ring flex shrink-0 items-center gap-2 border-b border-attn/25 bg-attn/10 px-4 py-1.5 text-left font-mono text-11 text-attn hover:bg-attn/15"
    >
      <span aria-hidden className="animate-zattn shrink-0">
        ⚑
      </span>
      <span className="min-w-0 truncate">
        {otherCount > 1
          ? `${otherCount} agents wait for approval`
          : `«${firstName}» waits for approval`}
      </span>
      <span className="ml-auto shrink-0 text-attn/80">View agent →</span>
    </button>
  );
}

// ---- turn-diff panel (the aggregated diff of the running/last turn) ----

function TurnDiffPanel({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}) {
  const diff = useVibe((s) => s.sessions[sessionId]?.diff ?? null);
  const files = useMemo(() => splitUnifiedDiff(diff), [diff]);
  if (files.length === 0) return null;
  const add = files.reduce((n, f) => n + f.add, 0);
  const del = files.reduce((n, f) => n + f.del, 0);
  return (
    <div className="mx-6 mb-2 shrink-0 overflow-hidden rounded-lg border border-line bg-card">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 font-mono text-11 text-mut">
        <span aria-hidden className="text-acc">
          Δ
        </span>
        <span className="text-txt">turn diff</span>
        <span className="tabular-nums">
          {files.length} file{files.length === 1 ? "" : "s"}{" "}
          <span className="text-add">+{add}</span>{" "}
          <span className="text-del">−{del}</span>
        </span>
        <button
          onClick={onClose}
          className="focus-ring ml-auto rounded-xs px-1 text-fnt hover:text-mut"
        >
          close
        </button>
      </div>
      <div className="max-h-[40vh] overflow-auto">
        <TurnDiffFiles files={files} />
      </div>
    </div>
  );
}

// ---- header ----

/** Signal state for the header dot (same triad as the grid cards). The 30 s
 * tick lives in component state (selectors stay pure — no Date.now in a
 * getSnapshot) so the ephemeral "finished" green decays back to idle. */
function useStageState(sessionId: string): "working" | "needs" | "finished" | "idle" {
  const busy = useVibe((s) => !!s.busy[sessionId]);
  const needs = useVibe((s) => {
    const e = s.sessions[sessionId];
    return e ? hasPendingApproval(e) : false;
  });
  const lastBusyEndAt = useVibe((s) => s.sessions[sessionId]?.lastBusyEndAt ?? null);
  const [, setTick] = useState(0);
  useEffect(() => {
    // only the time-decayed state needs re-evaluation without store events
    if (busy || needs || lastBusyEndAt === null) return;
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [busy, needs, lastBusyEndAt]);
  const signal = decayedSignal(busy, needs, lastBusyEndAt, Date.now());
  return signal === "needsYou" ? "needs" : signal;
}

const STAGE_DOT: Record<string, string> = {
  working: "bg-acc animate-zpulse",
  needs: "bg-attn animate-zattn",
  finished: "bg-ok",
  idle: "bg-fnt",
};

function StageHeader({
  sessionId,
  turnDiffOpen,
  onToggleTurnDiff,
}: {
  sessionId: string;
  turnDiffOpen: boolean;
  onToggleTurnDiff: () => void;
}) {
  const name = useVibe((s) => s.sessions[sessionId]?.session.name ?? "");
  const projectDir = useVibe((s) => s.sessions[sessionId]?.session.projectDir ?? "");
  const model = useVibe((s) => s.sessions[sessionId]?.session.model);
  const effort = useVibe((s) => s.sessions[sessionId]?.session.effort);
  const access = useVibe((s) => s.sessions[sessionId]?.session.access ?? "workspace");
  const busy = useVibe((s) => !!s.busy[sessionId]);
  const renameSession = useVibe((s) => s.renameSession);
  const state = useStageState(sessionId);
  const wide = useVibeUi((s) => s.wide);
  const setWide = useVibeUi((s) => s.setWide);
  const backToFleet = useVibeUi((s) => s.backToFleet);

  const [editing, setEditing] = useState(false);

  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
      <button
        onClick={backToFleet}
        title="Collapse back to fleet (⎋)"
        className="focus-ring flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md text-mut hover:bg-card hover:text-txt"
      >
        <Minimize2 size={14} />
      </button>
      <span
        aria-hidden
        className={cn("h-[9px] w-[9px] shrink-0 rounded-full", STAGE_DOT[state])}
      />
      {editing ? (
        <input
          autoFocus
          defaultValue={name}
          onFocus={(e) => e.target.select()}
          onBlur={(e) => {
            renameSession(sessionId, e.target.value);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setEditing(false);
          }}
          className="h-6 w-48 select-text rounded-sm bg-pop px-1.5 text-14 font-semibold text-txt outline-none"
        />
      ) : (
        <button
          onDoubleClick={() => setEditing(true)}
          className="group/name focus-ring flex shrink-0 items-center gap-1.5 rounded-xs"
          title="Double-click to rename"
        >
          <span className="text-14 font-semibold tracking-[-0.01em] text-txt">
            {name}
          </span>
          <Pencil
            size={11}
            className="text-fnt opacity-0 transition-opacity group-hover/name:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
          />
        </button>
      )}

      <span className="min-w-0 truncate font-mono text-11 text-fnt">
        {shortPath(projectDir)}
      </span>

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <SessionModelChip sessionId={sessionId} model={model} effort={effort} />
        <AccessChip sessionId={sessionId} access={access} />
        <TurnDiffChip
          sessionId={sessionId}
          open={turnDiffOpen}
          onToggle={onToggleTurnDiff}
        />
        <ContextGauge sessionId={sessionId} />

        {busy && (
          <button
            onClick={() => interrupt(sessionId)}
            className="focus-ring flex shrink-0 items-center gap-1.5 rounded-sm border border-line2 px-2.5 py-1 font-mono text-11 text-mut hover:text-txt"
            title="Stop the running turn"
          >
            <Square size={9} className="fill-current" /> Stop
          </button>
        )}
        <button
          onClick={() => setWide(!wide)}
          title={wide ? "Restore split view" : "Expand to full window"}
          className="focus-ring flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md text-mut hover:bg-card hover:text-txt"
        >
          {wide ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
      </div>
    </div>
  );
}

/** Clickable model + reasoning-effort chip → the shared picker (applies next turn). */
function SessionModelChip({
  sessionId,
  model,
  effort,
}: {
  sessionId: string;
  model?: string;
  effort?: string;
}) {
  const models = useMemo(() => recentCodexModels(), []);
  return (
    <ModelEffortPicker
      model={model}
      effort={effort}
      models={models}
      onApply={(next) => void setModelEffort(sessionId, next.model, next.effort)}
    >
      <button
        title="Model & reasoning effort — click to change (applies from the next turn)"
        className="focus-ring flex shrink-0 items-center gap-1 rounded-sm px-2 py-0.5 font-mono text-11 text-fnt transition-colors hover:bg-card hover:text-mut"
      >
        <span className="max-w-28 truncate">
          {model ? prettyModel(model) : "default model"}
        </span>
        {effort && <span>· {effort}</span>}
        <ChevronDown size={9} />
      </button>
    </ModelEffortPicker>
  );
}

function AccessChip({
  sessionId,
  access,
}: {
  sessionId: string;
  access: VibeAccess;
}) {
  const workspace = access === "workspace";
  return (
    <Tip label="Session access — click to toggle. Applies from the next turn.">
      <button
        onClick={() => void setAccess(sessionId, workspace ? "full" : "workspace")}
        className={cn(
          "focus-ring shrink-0 rounded-sm px-2 py-0.5 font-mono text-11",
          workspace ? "text-ok" : "text-warn",
        )}
      >
        {workspace ? "workspace-write" : "full access"}
      </button>
    </Tip>
  );
}

/** Compact access to the turn's aggregated diff — toggles the TurnDiffPanel. */
function TurnDiffChip({
  sessionId,
  open,
  onToggle,
}: {
  sessionId: string;
  open: boolean;
  onToggle: () => void;
}) {
  const diff = useVibe((s) => s.sessions[sessionId]?.diff ?? null);
  const summary = useMemo(() => {
    const files = splitUnifiedDiff(diff);
    if (files.length === 0) return null;
    return {
      files: files.length,
      add: files.reduce((n, f) => n + f.add, 0),
      del: files.reduce((n, f) => n + f.del, 0),
    };
  }, [diff]);
  if (!summary) return null;
  return (
    <button
      onClick={onToggle}
      title="Show the diff of this turn"
      className={cn(
        "focus-ring flex shrink-0 items-center gap-1 rounded-sm px-2 py-0.5 font-mono text-11 tabular-nums",
        open ? "bg-card text-txt" : "text-fnt hover:bg-card hover:text-mut",
      )}
    >
      <span aria-hidden>Δ</span>
      {summary.files}f <span className="text-add">+{summary.add}</span>{" "}
      <span className="text-del">−{summary.del}</span>
      <ChevronDown
        size={10}
        className={cn("transition-transform", open && "rotate-180")}
      />
    </button>
  );
}

function ContextGauge({ sessionId }: { sessionId: string }) {
  const usage = useVibe((s) => s.sessions[sessionId]?.tokenUsage ?? null);
  // `last` = the latest turn's accounting = the CURRENT context footprint.
  // `total` is cumulative across turns (every turn re-counts the whole
  // context as input) and overshoots the window after a few turns.
  const total = totalTokens(usage?.last);
  const window = usage?.modelContextWindow ?? 0;
  if (!window || total <= 0) return null;
  const pct = Math.min(total / window, 1);
  const warn = pct >= VIBE_CTX_WARN;
  return (
    <Tip
      label={
        <span className="font-mono text-11">
          Context · {total.toLocaleString()} / {window.toLocaleString()} tokens
        </span>
      }
    >
      <span
        tabIndex={0}
        className={cn(
          "focus-ring shrink-0 rounded-sm px-2 py-0.5 font-mono text-11 tabular-nums",
          warn ? "text-warn" : "text-fnt",
        )}
      >
        ctx {Math.round(pct * 100)}%
      </span>
    </Tip>
  );
}

// ---- plan panel (from the transient turn plan) ----

function PlanCard({ sessionId }: { sessionId: string }) {
  const plan = useVibe((s) => s.sessions[sessionId]?.plan ?? null);
  if (!plan || plan.steps.length === 0) return null;
  const done = plan.steps.filter((s) => s.status === "completed").length;
  const pct = Math.round((done / plan.steps.length) * 100);
  return (
    <div className="mx-auto mb-2 w-full max-w-[46rem] shrink-0 overflow-hidden rounded-lg border border-line bg-card px-0">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 font-mono text-11 text-mut">
        <span className="text-txt">plan</span>
        <span className="h-[3px] flex-1 overflow-hidden rounded-full bg-line">
          <span
            className="block h-full bg-acc transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
        </span>
        <span className="tabular-nums text-fnt">
          {done}/{plan.steps.length}
        </span>
      </div>
      <ul className="flex max-h-28 flex-col overflow-y-auto py-1.5">
        {plan.steps.map((step, i) => (
          <PlanStepRow key={i} step={step} />
        ))}
      </ul>
    </div>
  );
}

function PlanStepRow({ step }: { step: VibePlanStep }) {
  const done = step.status === "completed";
  const active = step.status === "in_progress";
  return (
    <li
      className={cn(
        "flex gap-2 px-3 py-px font-mono text-11 leading-[1.7]",
        done ? "text-fnt line-through" : active ? "text-txt" : "text-mut",
      )}
    >
      <span
        aria-hidden
        className={cn(done ? "text-ok" : active ? "text-acc" : "text-fnt")}
      >
        {done ? "✓" : active ? "▸" : "·"}
      </span>
      <span>{step.step}</span>
    </li>
  );
}
