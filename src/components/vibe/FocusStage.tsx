import { useMemo, useState } from "react";
import { ChevronDown, Pencil, Square } from "lucide-react";
import { useVibe } from "@/lib/vibe/session-store";
import { useVibeUi } from "@/lib/vibe/ui-store";
import {
  focusSession,
  interrupt,
  setAccess,
  setModelEffort,
} from "@/lib/vibe/controller";
import { hasPendingApproval, totalTokens, VIBE_CTX_WARN } from "@/lib/vibe/ui";
import { recentCodexModels } from "@/lib/orchestrator/models";
import { splitUnifiedDiff } from "@/lib/vibe/diff";
import { ModelEffortPicker } from "@/components/orchestrator/ModelEffortPicker";
import { Tip } from "@/components/ui/tooltip";
import { cn, prettyModel, shortPath } from "@/lib/utils";
import type { VibeAccess, VibePlanStep } from "@/types";
import { ItemFeed } from "./ItemFeed";
import { Composer } from "./Composer";
import { TurnDiffFiles } from "./DiffCard";
import { ConductorStage } from "./ConductorStage";

/**
 * The right-hand stage. Orchestrator-first: the Conductor (the orchestrator
 * chat) owns the stage by default and whenever no session is picked; selecting
 * a session card switches to that session's transcript + composer.
 */
export function FocusStage() {
  const conductor = useVibeUi((s) => s.stageMode === "conductor");
  const activeId = useVibe((s) => s.activeId);
  // a Builder session lives only in its modal — it must never take the stage,
  // even if it briefly became the active session on creation
  const hasActive = useVibe(
    (s) =>
      !!(
        s.activeId &&
        s.sessions[s.activeId] &&
        !s.sessions[s.activeId]?.session.builderForSlug
      ),
  );

  if (conductor || !activeId || !hasActive) return <ConductorStage />;
  // key on the id so per-session composer/feed state resets cleanly on switch
  return <Stage key={activeId} sessionId={activeId} />;
}

function Stage({ sessionId }: { sessionId: string }) {
  const [turnDiffOpen, setTurnDiffOpen] = useState(false);
  return (
    <div className="flex min-w-0 flex-1 flex-col">
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
      if (e && !e.session.builderForSlug && hasPendingApproval(e)) n++;
    }
    return n;
  });
  const firstOther = useVibe((s) => {
    for (const id of s.order) {
      if (id === sessionId) continue;
      const e = s.sessions[id];
      if (e && !e.session.builderForSlug && hasPendingApproval(e)) return id;
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
      className="focus-ring flex items-center gap-2 border-b border-attn/25 bg-attn/10 px-4 py-1.5 text-left font-mono text-[10px] text-attn hover:bg-attn/15"
    >
      <span aria-hidden>⚑</span>
      <span className="min-w-0 truncate">
        {otherCount > 1
          ? `${otherCount} sessions wait for approval`
          : `«${firstName}» waits for approval`}
      </span>
      <span className="ml-auto shrink-0 text-attn/80">View session →</span>
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
    <div className="mx-5 mb-2 overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
        <span className="text-foreground">turn diff</span>
        <span className="tabular-nums">
          {files.length} file{files.length === 1 ? "" : "s"}{" "}
          <span className="text-diff-add">+{add}</span>{" "}
          <span className="text-diff-del">−{del}</span>
        </span>
        <button
          onClick={onClose}
          className="focus-ring ml-auto rounded px-1 text-faint hover:text-muted-foreground"
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

  const [editing, setEditing] = useState(false);

  return (
    <div className="flex items-center gap-2.5 border-b border-border px-4 py-2.5">
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
          className="h-6 w-48 rounded bg-secondary px-1.5 text-[13px] font-semibold text-foreground outline-none select-text"
        />
      ) : (
        <button
          onDoubleClick={() => setEditing(true)}
          className="group/name focus-ring flex items-center gap-1.5 rounded"
          title="Double-click to rename"
        >
          <span className="text-[13px] font-semibold text-foreground">{name}</span>
          <Pencil
            size={11}
            className="text-faint opacity-0 transition-opacity group-hover/name:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
          />
        </button>
      )}

      <span className="min-w-0 truncate font-mono text-[10px] text-faint">
        {shortPath(projectDir)}
      </span>

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
          className="focus-ring ml-auto flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 font-mono text-[10px] text-muted-foreground hover:bg-accent"
          title="Stop the running turn"
        >
          <Square size={10} className="fill-current" /> Stop
        </button>
      )}
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
        className="focus-ring flex shrink-0 items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 font-mono text-[9px] text-muted-foreground transition-colors hover:border-ring/50 hover:text-foreground"
      >
        <span className="max-w-28 truncate">
          {model ? prettyModel(model) : "default model"}
        </span>
        {effort && <span className="text-faint">· {effort}</span>}
        <ChevronDown size={9} className="text-faint" />
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
        onClick={() =>
          void setAccess(sessionId, workspace ? "full" : "workspace")
        }
        className={cn(
          "focus-ring shrink-0 rounded-full border px-2 py-0.5 font-mono text-[9px]",
          workspace
            ? "border-success/35 text-success"
            : "border-input text-muted-foreground",
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
        "focus-ring flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[9px] tabular-nums",
        open
          ? "border-ring/50 text-foreground"
          : "border-border text-muted-foreground hover:bg-accent",
      )}
    >
      <span className="text-faint">Δ</span>
      {summary.files}f <span className="text-diff-add">+{summary.add}</span>{" "}
      <span className="text-diff-del">−{summary.del}</span>
      <ChevronDown
        size={10}
        className={cn("text-faint transition-transform", open && "rotate-180")}
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
        <span className="font-mono text-[11px]">
          Context · {total.toLocaleString()} / {window.toLocaleString()} tokens
        </span>
      }
    >
      <span
        tabIndex={0}
        className={cn(
          "focus-ring shrink-0 rounded-full border border-border bg-secondary px-2 py-0.5 font-mono text-[9px] tabular-nums",
          warn ? "text-warning" : "text-muted-foreground",
        )}
      >
        ctx {Math.round(pct * 100)}%
      </span>
    </Tip>
  );
}

// ---- floating plan card (from the transient turn plan) ----

function PlanCard({ sessionId }: { sessionId: string }) {
  const plan = useVibe((s) => s.sessions[sessionId]?.plan ?? null);
  if (!plan || plan.steps.length === 0) return null;
  return (
    <div className="mx-5 mb-2 overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
        <span className="text-foreground">plan</span>
        <span className="ml-auto text-faint">
          {plan.steps.length} step{plan.steps.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="flex flex-col py-1.5">
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
        "px-3 py-0.5 font-mono text-[10.5px] leading-relaxed",
        done
          ? "text-faint line-through"
          : active
            ? "text-foreground"
            : "text-muted-foreground",
      )}
    >
      <span className={cn("mr-1", done ? "text-success" : active ? "text-foreground" : "text-faint")}>
        {done ? "✓" : active ? "▸" : "·"}
      </span>
      {step.step}
    </li>
  );
}

