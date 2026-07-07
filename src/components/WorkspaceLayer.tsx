import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Zap } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useSwarm, type SwarmState } from "@/store";
import { TilingGrid } from "./TilingGrid";
import { PresetThumbnail } from "./PresetThumbnail";
import { paneSignal } from "./AgentPane";
import { Button } from "./ui/button";
import { cn, folderName } from "@/lib/utils";
import { paneRects, type Rect } from "@/lib/layout";
import { blurActiveTerm, focusTerm } from "@/lib/term-host";
import { lastEventForPane, useFleetEvents, type FleetEvent } from "@/lib/events";
import { triageEntries } from "@/lib/triage";
import { fleetCounts } from "@/lib/orchestrator/snapshot";
import type { Agent } from "@/types";

/**
 * Hosts one always-mounted grid wrapper per workspace. Inactive workspaces
 * are only hidden via CSS (`invisible`) — their terminals, PTYs and layouts
 * keep running untouched, so switching tabs is instant and lossless.
 *
 * Fleet overview (⌘E): the same wrappers are scaled into a card grid with
 * CSS transforms. No remounting, no snapshots — every card is the live
 * terminal wall of that workspace, just smaller. Cards are letterboxed to the
 * app's aspect ratio, so what you see is exactly what you get after zooming.
 *
 * Ops board (Stage 3): each card carries unscaled per-pane chrome (status,
 * project · branch, last fleet event, context bar), a quiet fleet header
 * summarizes the whole board, and the keyboard drives it — arrows move a
 * blue selection ring geometrically across all panes, Enter jumps in,
 * Tab/⇧Tab cycles the needs-you panes (oldest first). Cards deliberately
 * keep their TRUE spatial workspace layout — spatial truth over sorted
 * grids, so a card is always exactly what zooming into it reveals.
 */

const FLEET_ANIM_MS = 220;
// breathing room around each fleet card, as a fraction of the cell
const CARD_INSET = 0.94;

interface FleetCell {
  /** content origin in percent of the layer */
  x: number;
  y: number;
  /** uniform scale — content size is scale*100% in both axes */
  scale: number;
}

function fleetCells(count: number): FleetCell[] {
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const cellW = 100 / cols;
  const cellH = 100 / rows;
  const scale = (Math.min(cellW, cellH) / 100) * CARD_INSET;
  const cells: FleetCell[] = [];
  for (let i = 0; i < count; i++) {
    const col = i % cols;
    // center the last (possibly short) row
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? count - row * cols : cols;
    const rowOffset = ((cols - inRow) * cellW) / 2;
    cells.push({
      x: rowOffset + col * cellW + (cellW - scale * 100) / 2,
      y: row * cellH + (cellH - scale * 100) / 2,
      scale,
    });
  }
  return cells;
}

// ---- Keyboard operation (the ops board) ----

interface FleetTarget {
  agentId: string;
  /** pane center in layer pixels (percent coords corrected by aspect ratio) */
  x: number;
  y: number;
}

/** Every visible pane's center, across all workspaces, in layer pixels. */
function fleetTargets(s: SwarmState, layer: HTMLElement | null): FleetTarget[] {
  const cells = fleetCells(s.workspaceOrder.length);
  // fall back to a 16:10-ish box — only the aspect ratio matters here
  const w = layer?.clientWidth || 1600;
  const h = layer?.clientHeight || 1000;
  const targets: FleetTarget[] = [];
  s.workspaceOrder.forEach((wid, i) => {
    const cell = cells[i];
    for (const p of paneRects(s.layouts[wid] ?? null)) {
      targets.push({
        agentId: p.agentId,
        x: ((cell.x + (p.rect.x + p.rect.w / 2) * cell.scale) / 100) * w,
        y: ((cell.y + (p.rect.y + p.rect.h / 2) * cell.scale) / 100) * h,
      });
    }
  });
  return targets;
}

const ARROW_DIRS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/**
 * Nearest pane in the pressed direction: candidates must lie ahead along the
 * arrow's axis; among them the lowest `ahead + 2·drift` wins (drift = offset
 * on the orthogonal axis — doubled so navigation prefers staying in the same
 * row/column over a marginally closer diagonal pane). No wrap-around.
 */
function nearestInDirection(
  targets: FleetTarget[],
  from: FleetTarget,
  key: string,
): string | null {
  const dir = ARROW_DIRS[key];
  let best: string | null = null;
  let bestScore = Infinity;
  for (const t of targets) {
    if (t.agentId === from.agentId) continue;
    const dx = t.x - from.x;
    const dy = t.y - from.y;
    const ahead = dx * dir[0] + dy * dir[1];
    if (ahead <= 1) continue;
    const drift = Math.abs(dx * dir[1]) + Math.abs(dy * dir[0]);
    const score = ahead + 2 * drift;
    if (score < bestScore) {
      bestScore = score;
      best = t.agentId;
    }
  }
  return best;
}

/** Jump into a pane — the exact click path: workspace switch (closes the
 * fleet) + pane focus + terminal focus. */
function jumpIntoPane(agentId: string) {
  const s = useSwarm.getState();
  const agent = s.agents[agentId];
  if (!agent) return;
  s.setActiveWorkspace(agent.workspaceId);
  s.focusAgent(agentId);
  focusTerm(agentId);
}

export function WorkspaceLayer() {
  const workspaceOrder = useSwarm((s) => s.workspaceOrder);
  const activeId = useSwarm((s) => s.activeWorkspaceId);
  const fleetOpen = useSwarm((s) => s.fleetOpen);

  // Exit animation: when the fleet closes, hold the card transforms one more
  // frame-batch so the chosen workspace zooms back up instead of snapping.
  // Set during render (same pattern as the focus-mode exit in TilingGrid).
  const [fleetClosing, setFleetClosing] = useState(false);
  const prevFleetRef = useRef(fleetOpen);
  if (prevFleetRef.current !== fleetOpen) {
    if (!fleetOpen && prevFleetRef.current) setFleetClosing(true);
    prevFleetRef.current = fleetOpen;
  }
  useEffect(() => {
    if (!fleetClosing) return;
    const t = setTimeout(() => setFleetClosing(false), FLEET_ANIM_MS + 60);
    return () => clearTimeout(t);
  }, [fleetClosing]);

  // entering the fleet drops keyboard focus — terminals must not eat ⌘E/Escape
  useEffect(() => {
    if (fleetOpen) blurActiveTerm();
  }, [fleetOpen]);

  // ---- Ops-board selection: purely visual chrome (a blue ring), never a
  // real focus — the blurred terminals must not resize or steal keys.
  const layerRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  // initial selection on open: the oldest needs-you pane, else the active pane
  useEffect(() => {
    if (!fleetOpen) return;
    const s = useSwarm.getState();
    setSelectedId(triageEntries(s)[0]?.id ?? s.activeAgentId());
  }, [fleetOpen]);

  // shared 30s ticker for the ages in the card chrome ("finished · 2m", event
  // ages) — one interval for the whole board, only while it shows
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!fleetOpen) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [fleetOpen]);

  // Fleet keyboard (terminals are not focused here, so keys arrive):
  //   Escape       → exit (an open palette swallows its own Escape first)
  //   arrows       → move the selection ring geometrically across all panes
  //   Enter        → jump into the selected pane (same path as a click)
  //   Tab / ⇧Tab   → cycle needs-you panes only, oldest first (triage)
  //   Home / End   → first / last triage target
  useEffect(() => {
    if (!fleetOpen) return;
    const onKey = (e: KeyboardEvent) => {
      const s = useSwarm.getState();
      if (e.key === "Escape") {
        if (!s.paletteOpen) s.setFleetOpen(false);
        return;
      }
      // an open dialog (palette, settings, …) owns the keyboard — same guard
      // idea as the global shortcuts in App.tsx; and typing in a real text
      // field (e.g. the orchestrator panel next to the board) stays typing
      if (document.querySelector('[role="dialog"]')) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
      )
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "Enter") {
        const id = selectedRef.current;
        if (id && s.agents[id]) {
          e.preventDefault();
          jumpIntoPane(id);
        }
      } else if (e.key === "Tab") {
        e.preventDefault();
        const triage = triageEntries(s);
        if (triage.length === 0) return;
        const idx = triage.findIndex((x) => x.id === selectedRef.current);
        const next = e.shiftKey
          ? triage[((idx <= 0 ? triage.length : idx) - 1) % triage.length]
          : triage[(idx + 1) % triage.length];
        setSelectedId(next.id);
      } else if (e.key === "Home" || e.key === "End") {
        // first/last triage target — the oldest/newest waiting pane
        const triage = triageEntries(s);
        if (triage.length === 0) return;
        e.preventDefault();
        setSelectedId(
          e.key === "Home" ? triage[0].id : triage[triage.length - 1].id,
        );
      } else if (ARROW_DIRS[e.key]) {
        e.preventDefault();
        const targets = fleetTargets(s, layerRef.current);
        if (targets.length === 0) return;
        const cur = targets.find((x) => x.agentId === selectedRef.current);
        if (!cur) {
          // stale/empty selection — land somewhere sensible, don't dead-end
          setSelectedId(targets[0].agentId);
          return;
        }
        const next = nearestInDirection(targets, cur, e.key);
        if (next) setSelectedId(next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fleetOpen]);

  const showFleet = fleetOpen || fleetClosing;
  const cells = fleetCells(workspaceOrder.length);

  return (
    <div ref={layerRef} className="absolute inset-0">
      {workspaceOrder.map((wid, i) => {
        const cell = cells[i];
        const isActive = wid === activeId;
        let style: React.CSSProperties | undefined;
        let cls: string;
        if (fleetOpen) {
          style = {
            transform: `translate(${cell.x}%, ${cell.y}%) scale(${cell.scale})`,
            transformOrigin: "0 0",
          };
          cls = "visible";
        } else if (fleetClosing) {
          // the picked workspace animates to full size, the rest fade out in place
          style = isActive
            ? undefined
            : {
                transform: `translate(${cell.x}%, ${cell.y}%) scale(${cell.scale})`,
                transformOrigin: "0 0",
                opacity: 0,
              };
          cls = "visible";
        } else {
          cls = isActive ? "visible" : "invisible";
        }
        return (
          <div
            key={wid}
            className={cn(
              "absolute inset-0 p-2",
              cls,
              showFleet &&
                "pointer-events-none transition-[transform,opacity] duration-200 ease-out",
              !fleetOpen && !fleetClosing && !isActive && "pointer-events-none",
            )}
            style={style}
          >
            <WorkspaceView workspaceId={wid} />
          </div>
        );
      })}

      {fleetOpen &&
        workspaceOrder.map((wid, i) => (
          <FleetCard
            key={wid}
            workspaceId={wid}
            cell={cells[i]}
            selectedAgentId={selectedId}
            now={now}
          />
        ))}

      {fleetOpen && <FleetHeader />}
    </div>
  );
}

/**
 * One quiet summary row floating above the board:
 * `Fleet · 6 agents · 3 working · 1 needs you · 2 workspaces`.
 * Counting rules are shared with the orchestrator's `fleetSummaryLine`
 * (`fleetCounts` in orchestrator/snapshot.ts) — never a second census.
 */
function FleetHeader() {
  const counts = useSwarm(useShallow((s) => fleetCounts(s)));
  const n = (count: number, word: string) =>
    `${count} ${word}${count === 1 ? "" : "s"}`;
  const dot = <span className="text-faint">·</span>;
  return (
    <div className="pointer-events-none absolute left-1/2 top-2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-md border border-border bg-popover/95 px-2.5 py-1 font-mono text-[10px] tabular-nums text-muted-foreground shadow-sm animate-in">
      <span className="font-medium text-foreground">Fleet</span>
      {dot}
      <span>{n(counts.panes, "agent")}</span>
      {dot}
      <span>{counts.busy} working</span>
      {counts.waiting > 0 && (
        <>
          {dot}
          <span className="font-semibold text-attn">
            <span aria-hidden>⚑ </span>
            {counts.waiting} need{counts.waiting === 1 ? "s" : ""} you
          </span>
        </>
      )}
      {dot}
      <span>{n(counts.workspaces, "workspace")}</span>
    </div>
  );
}

/** One workspace's content: its tiling grid, or the empty state. */
function WorkspaceView({ workspaceId }: { workspaceId: string }) {
  const hasLayout = useSwarm((s) => !!s.layouts[workspaceId]);
  const setNewAgentOpen = useSwarm((s) => s.setNewAgentOpen);
  if (!hasLayout) return <EmptyState onNew={() => setNewAgentOpen(true)} />;
  return <TilingGrid workspaceId={workspaceId} />;
}

/**
 * Fleet-mode chrome above one scaled workspace: border, name pill with live
 * status, per-pane ops chrome, and the click handling — clicking a pane jumps
 * straight to that agent, clicking anywhere else activates the workspace.
 *
 * All chrome lives on this UNSCALED overlay sibling (the CSS transform only
 * touches the live workspace wrapper underneath), so pills, text and the
 * selection ring render at normal size no matter how small the card gets.
 */
function FleetCard({
  workspaceId,
  cell,
  selectedAgentId,
  now,
}: {
  workspaceId: string;
  cell: FleetCell;
  selectedAgentId: string | null;
  now: number;
}) {
  const name = useSwarm((s) => s.workspaces[workspaceId]?.name ?? "");
  const layout = useSwarm((s) => s.layouts[workspaceId] ?? null);
  const rects = useMemo(() => paneRects(layout), [layout]);
  const stats = useSwarm(
    useShallow((s) => {
      let total = 0;
      let busy = 0;
      let attention = false;
      for (const id of s.order) {
        const a = s.agents[id];
        if (!a || a.workspaceId !== workspaceId) continue;
        total++;
        if (a.activity === "busy") busy++;
        if (a.attention || a.activity === "waiting") attention = true;
      }
      return { total, busy, attention };
    }),
  );

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const store = useSwarm.getState();
    // the wrapper underneath is the full container scaled by cell.scale and
    // padded by p-2 (8px) — map the click into the grid's percent space
    const bounds = e.currentTarget.getBoundingClientRect();
    const pad = 8 * cell.scale;
    const rx =
      ((e.clientX - bounds.left - pad) / (bounds.width - 2 * pad)) * 100;
    const ry =
      ((e.clientY - bounds.top - pad) / (bounds.height - 2 * pad)) * 100;
    const hit = paneRects(store.layouts[workspaceId] ?? null).find(
      (p) =>
        rx >= p.rect.x &&
        rx < p.rect.x + p.rect.w &&
        ry >= p.rect.y &&
        ry < p.rect.y + p.rect.h,
    );
    // switches (or stays) and closes the fleet either way
    store.setActiveWorkspace(workspaceId);
    if (hit) {
      store.focusAgent(hit.agentId);
      focusTerm(hit.agentId);
    }
  };

  return (
    <div
      className="absolute animate-in"
      onClick={onClick}
      style={{
        left: `${cell.x}%`,
        top: `${cell.y}%`,
        width: `${cell.scale * 100}%`,
        height: `${cell.scale * 100}%`,
      }}
    >
      <button
        className={cn(
          "group/card absolute -inset-1 rounded-lg border transition-colors",
          // amber = a pane in here needs the human (static, no pulse);
          // blue stays a hover/selection affordance
          stats.attention
            ? "border-attn/70"
            : "border-border hover:border-ring/60",
        )}
      >
        <span className="absolute left-2 top-2 z-10 flex max-w-[80%] items-center gap-1.5 rounded-md border border-border bg-popover/95 px-2 py-1 shadow-sm">
          {/* alive-but-idle is neutral, not green — green stays "just
              finished"/success (same rule as the workspace tabs) */}
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{
              backgroundColor: stats.attention
                ? "var(--attn)"
                : stats.busy > 0
                  ? "var(--muted-foreground)"
                  : stats.total > 0
                    ? "var(--faint)"
                    : "color-mix(in srgb, var(--faint) 40%, transparent)",
            }}
          />
          {stats.attention && (
            <span className="shrink-0 font-mono text-[10px] font-semibold leading-none text-attn">
              ⚑
            </span>
          )}
          <span className="truncate text-[11px] font-medium text-foreground">
            {name}
          </span>
          <span className="font-mono text-[10px] tabular-nums text-faint">
            {stats.busy > 0 ? `${stats.busy}/${stats.total}` : stats.total}
          </span>
        </span>
      </button>

      {/* per-pane ops chrome — aligned with the scaled grid content: the
          wrapper underneath has p-2 (8px), which the transform shrinks to
          8·scale px (the same correction the click mapping above applies) */}
      <div
        className="pointer-events-none absolute z-10"
        style={{ inset: 8 * cell.scale }}
      >
        {rects.map((p) => (
          <FleetPaneChrome
            key={p.paneId}
            agentId={p.agentId}
            rect={p.rect}
            selected={p.agentId === selectedAgentId}
            now={now}
          />
        ))}
      </div>
    </div>
  );
}

// ---- Per-pane ops chrome ----

/** Compact age for the ops chrome: "now" / "4m" / "2h". */
function shortAge(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins <= 0) return "now";
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h`;
}

/** Event line wording — compact (the pane is obvious from placement), the
 * glyphs match the Deck's ticker. History, not status → rendered faint. */
const EVENT_LINE: Record<FleetEvent["kind"], string> = {
  finished: "✓ finished",
  waiting: "⚑ waiting",
  orch_prompt: "▸ orch → prompted",
  created: "+ created",
  exited: "× exited",
};

/**
 * The signal triad chip for a fleet card — same `paneSignal` rule as the
 * pane header (AgentPane.tsx), compact glyph + word rendering.
 */
function FleetSignalChip({ agent, now }: { agent: Agent; now: number }) {
  const signal = paneSignal(agent, now);
  const base = "shrink-0 font-mono text-[10px] leading-none";
  switch (signal) {
    case "working":
      return (
        <span className={cn(base, "text-muted-foreground")}>▸ working</span>
      );
    case "needsYou":
      return (
        <span className={cn(base, "font-semibold text-attn")}>⚑ needs you</span>
      );
    case "finished":
      return (
        <span className={cn(base, "text-success")}>
          ✓ finished{" "}
          <span className="text-success/60">
            · {shortAge(now - (agent.lastBusyEndAt ?? now))}
          </span>
        </span>
      );
    case "starting":
      return <span className={cn(base, "text-muted-foreground")}>· starting</span>;
    case "idle":
      return <span className={cn(base, "text-faint")}>· idle</span>;
    case "exited":
      return <span className={cn(base, "text-faint")}>× exited</span>;
    case "running":
      return <span className={cn(base, "text-faint")}>· running</span>;
  }
}

/**
 * One pane's chrome on the ops board: a small pill anchored to the pane's
 * bottom-left (the workspace pill owns the top-left) with status chip + name,
 * project · branch, the pane's last fleet event, and a 3px context bar.
 *
 * Degradation mirrors the pane-header philosophy: this div spans the pane's
 * on-screen rect and is a container-query root — small panes drop the event
 * line first (@max-2xs), then the project line (@max-3xs). `overflow-hidden`
 * keeps the pill from bleeding into neighbour panes on extreme layouts.
 */
function FleetPaneChrome({
  agentId,
  rect,
  selected,
  now,
}: {
  agentId: string;
  rect: Rect;
  selected: boolean;
  now: number;
}) {
  const agent = useSwarm((s) => s.agents[agentId]);
  const lastEvent = useFleetEvents((s) => lastEventForPane(s.events, agentId));
  if (!agent) return null;

  const project = agent.worktree
    ? folderName(agent.worktree.root)
    : agent.cwd
      ? folderName(agent.cwd)
      : null;
  const branch =
    agent.worktree?.branch ?? agent.git?.branch ?? agent.usage?.git_branch ?? null;
  const projectLine = project
    ? branch
      ? `${project} · ${branch}`
      : project
    : null;

  const u = agent.usage;
  const ctxPct =
    u && u.context_tokens > 0 && u.context_limit > 0
      ? Math.min(u.context_tokens / u.context_limit, 1)
      : null;

  return (
    <div
      className="@container absolute overflow-hidden"
      style={{
        left: `${rect.x}%`,
        top: `${rect.y}%`,
        width: `${rect.w}%`,
        height: `${rect.h}%`,
      }}
    >
      {/* selection ring — blue = "where I am" (keyboard cursor), pure chrome */}
      {selected && (
        <div className="absolute inset-0.5 rounded-md border-2 border-ring" />
      )}
      <div className="absolute bottom-1.5 left-1.5 flex min-w-0 max-w-[calc(100%-0.75rem)] flex-col gap-1 rounded-md border border-border bg-popover/95 px-2 py-1.5 shadow-sm">
        <div className="flex min-w-0 items-center gap-1.5">
          <FleetSignalChip agent={agent} now={now} />
          <span className="min-w-0 truncate text-[10px] font-medium leading-none text-foreground">
            {agent.name}
          </span>
        </div>
        {projectLine && (
          <div className="truncate font-mono text-[10px] leading-none text-faint @max-3xs:hidden">
            {projectLine}
          </div>
        )}
        {lastEvent && (
          <div className="truncate font-mono text-[10px] leading-none text-faint @max-2xs:hidden">
            {EVENT_LINE[lastEvent.kind]} · {shortAge(now - lastEvent.at)}
          </div>
        )}
        {ctxPct !== null && (
          <div className="flex items-center gap-1.5">
            <span className="relative h-[3px] min-w-6 flex-1 overflow-hidden rounded-full bg-border">
              <span
                className="absolute inset-y-0 left-0 rounded-full"
                style={{
                  width: `${ctxPct * 100}%`,
                  // --warning = context pressure (DESIGN.md: never --attn)
                  background:
                    ctxPct >= 0.75 ? "var(--warning)" : "var(--ring)",
                }}
              />
            </span>
            <span className="shrink-0 font-mono text-[10px] leading-none tabular-nums text-faint">
              {Math.round(ctxPct * 100)}%
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  const presets = useSwarm((s) => s.workspacePresets);
  const requestLoadPreset = useSwarm((s) => s.requestLoadPreset);
  return (
    <div className="flex h-full w-full overflow-y-auto rounded-lg border border-dashed border-border">
      {/* m-auto centers but stays scrollable when presets outgrow the pane */}
      <div className="m-auto flex max-w-lg flex-col items-center gap-5 p-6 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-border bg-card">
          <Zap size={22} className="text-foreground" fill="currentColor" />
        </div>
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            Empty workspace
          </h1>
          <p className="mt-1.5 max-w-xs text-sm leading-relaxed text-muted-foreground">
            Pick a preset below or launch a single agent — split and tile from
            there. ⌘K reaches every agent and action.
          </p>
        </div>
        {presets.length > 0 && (
          <div className="flex flex-wrap items-stretch justify-center gap-2.5">
            {presets.map((p) => (
              <button
                key={p.id}
                onClick={() => requestLoadPreset(p.id)}
                className="group focus-ring flex w-28 flex-col gap-2 rounded-lg border border-border bg-card p-2.5 transition-colors hover:border-ring/60 hover:bg-accent"
                title={`Load preset "${p.name}"`}
              >
                <PresetThumbnail
                  layout={p.layout}
                  className="h-14 w-full transition-opacity group-hover:opacity-90"
                />
                <span className="truncate text-[11px] font-medium text-muted-foreground transition-colors group-hover:text-foreground">
                  {p.name}
                </span>
              </button>
            ))}
          </div>
        )}
        <Button onClick={onNew}>
          <Plus size={15} /> Launch an agent
        </Button>
        <p className="text-[11px] text-faint">
          or press{" "}
          <kbd className="rounded-md border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            ⌘T
          </kbd>
        </p>
      </div>
    </div>
  );
}
