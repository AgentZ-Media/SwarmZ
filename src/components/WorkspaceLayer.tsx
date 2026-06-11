import { useEffect, useRef, useState } from "react";
import { Plus, Zap } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useSwarm } from "@/store";
import { TilingGrid } from "./TilingGrid";
import { PresetThumbnail } from "./PresetThumbnail";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";
import { paneRects } from "@/lib/layout";
import { blurActiveTerm, focusTerm } from "@/lib/term-host";

/**
 * Hosts one always-mounted grid wrapper per workspace. Inactive workspaces
 * are only hidden via CSS (`invisible`) — their terminals, PTYs and layouts
 * keep running untouched, so switching tabs is instant and lossless.
 *
 * Fleet overview (⌘E): the same wrappers are scaled into a card grid with
 * CSS transforms. No remounting, no snapshots — every card is the live
 * terminal wall of that workspace, just smaller. Cards are letterboxed to the
 * app's aspect ratio, so what you see is exactly what you get after zooming.
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

  // Escape leaves the fleet (terminals are not focused here, so it arrives);
  // an open palette swallows its own Escape — don't close both at once
  useEffect(() => {
    if (!fleetOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !useSwarm.getState().paletteOpen)
        useSwarm.getState().setFleetOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fleetOpen]);

  const showFleet = fleetOpen || fleetClosing;
  const cells = fleetCells(workspaceOrder.length);

  return (
    <div className="absolute inset-0">
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
          <FleetCard key={wid} workspaceId={wid} cell={cells[i]} />
        ))}
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
 * status, and the click handling — clicking a pane jumps straight to that
 * agent, clicking anywhere else activates the workspace.
 */
function FleetCard({
  workspaceId,
  cell,
}: {
  workspaceId: string;
  cell: FleetCell;
}) {
  const name = useSwarm((s) => s.workspaces[workspaceId]?.name ?? "");
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
          stats.attention
            ? "attn-pulse border-ring/60"
            : "border-border hover:border-ring/60",
        )}
      >
        <span className="absolute left-2 top-2 z-10 flex max-w-[80%] items-center gap-1.5 rounded-md border border-border bg-popover/95 px-2 py-1 shadow-sm">
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{
              backgroundColor: stats.attention
                ? "var(--ring)"
                : stats.busy > 0
                  ? "var(--warning)"
                  : stats.total > 0
                    ? "var(--success)"
                    : "var(--faint)",
            }}
          />
          <span className="truncate text-[11px] font-medium text-foreground">
            {name}
          </span>
          <span className="font-mono text-[10px] tabular-nums text-faint">
            {stats.busy > 0 ? `${stats.busy}/${stats.total}` : stats.total}
          </span>
        </span>
      </button>
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
            Spawn parallel Claude agents, tile them into a grid, and watch
            tokens &amp; cost in real time.
          </p>
        </div>
        {presets.length > 0 && (
          <div className="flex flex-wrap items-stretch justify-center gap-2.5">
            {presets.map((p) => (
              <button
                key={p.id}
                onClick={() => requestLoadPreset(p.id)}
                className="group flex w-28 flex-col gap-2 rounded-lg border border-border bg-card p-2.5 transition-colors hover:border-ring/60 hover:bg-accent"
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
