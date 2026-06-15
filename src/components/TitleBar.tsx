import { useEffect, useRef, useState } from "react";
import {
  BarChart3,
  Download,
  Gauge,
  LayoutGrid,
  Plus,
  Settings,
  SlidersHorizontal,
  StickyNote,
  X,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useSwarm } from "@/store";
import { useUpdates } from "@/lib/updates";
import { useLimits } from "@/lib/limits";
import { WorktreesButton } from "./WorktreePanel";
import { Button } from "./ui/button";
import { Tip } from "./ui/tooltip";
import { cn } from "@/lib/utils";
import { IS_TAURI } from "@/lib/transport";
import type { RateLimitWindow } from "@/types";

export function TitleBar({
  onManageProfiles,
  onOpenSettings,
}: {
  onManageProfiles: () => void;
  onOpenSettings: () => void;
}) {
  const setNewAgentOpen = useSwarm((s) => s.setNewAgentOpen);
  const setDashboardOpen = useSwarm((s) => s.setDashboardOpen);
  const dashboardOpen = useSwarm((s) => s.dashboardOpen);
  const fleetOpen = useSwarm((s) => s.fleetOpen);
  const setFleetOpen = useSwarm((s) => s.setFleetOpen);
  const notesOpen = useSwarm((s) => s.notesOpen);
  const setNotesOpen = useSwarm((s) => s.setNotesOpen);

  return (
    <header
      data-tauri-drag-region
      className="drag-region flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background pr-3"
      style={{ paddingLeft: IS_TAURI ? 80 : 16 }}
    >
      <img
        src="/favicon.png"
        alt="SwarmZ"
        draggable={false}
        className="pointer-events-none h-7 w-7 shrink-0"
      />

      <WorkspaceTabs />

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {IS_TAURI && <UpdatePill />}

        <LimitsPill />

        <Tip label="Fleet overview — every workspace live (⌘E)">
          <Button
            size="icon"
            variant={fleetOpen ? "secondary" : "ghost"}
            className="no-drag"
            onClick={() => setFleetOpen(!fleetOpen)}
          >
            <LayoutGrid size={15} />
          </Button>
        </Tip>

        <Tip label="Usage dashboard">
          <Button
            size="icon"
            variant={dashboardOpen ? "secondary" : "ghost"}
            className="no-drag"
            onClick={() => setDashboardOpen(!dashboardOpen)}
          >
            <BarChart3 size={15} />
          </Button>
        </Tip>

        <Tip label="Quick notes (⌘N)">
          <Button
            size="icon"
            variant={notesOpen ? "secondary" : "ghost"}
            className="no-drag"
            onClick={() => setNotesOpen(!notesOpen)}
          >
            <StickyNote size={15} />
          </Button>
        </Tip>

        <Tip label="Profiles">
          <Button
            size="icon"
            variant="ghost"
            className="no-drag"
            onClick={onManageProfiles}
          >
            <SlidersHorizontal size={15} />
          </Button>
        </Tip>

        {/* appears only once at least one git worktree exists */}
        <WorktreesButton />

        <Tip label="Settings">
          <Button
            size="icon"
            variant="ghost"
            className="no-drag"
            onClick={onOpenSettings}
          >
            <Settings size={15} />
          </Button>
        </Tip>

        <Button
          size="sm"
          className="no-drag"
          onClick={() => setNewAgentOpen(true)}
        >
          <Plus size={14} /> New Agent
        </Button>
      </div>
    </header>
  );
}

// ---- Workspace tabs ----

/**
 * The tab strip: one tab per workspace with a live aggregated status dot,
 * agent count and inline rename (double-click). Tabs reorder via drag, accept
 * pane drops (move an agent into another workspace — see TilingGrid) and
 * switch with ⌘1–9.
 */
function WorkspaceTabs() {
  const workspaceOrder = useSwarm((s) => s.workspaceOrder);
  const createWorkspace = useSwarm((s) => s.createWorkspace);
  const stripRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={stripRef}
      // NOT no-drag: the strip spans the middle of the title bar (flex-1), so
      // its empty area must stay draggable — only the tabs and the + button
      // opt out (otherwise the whole title bar middle becomes undraggable).
      className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
    >
      {workspaceOrder.map((id, i) => (
        <WorkspaceTab key={id} id={id} index={i} stripRef={stripRef} />
      ))}
      <Tip label="New workspace (⌘⇧N)">
        <button
          className="no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-faint hover:bg-accent hover:text-foreground"
          onClick={() => createWorkspace()}
        >
          <Plus size={14} />
        </button>
      </Tip>
    </div>
  );
}

/** Aggregated live state of one workspace, for its tab dot. */
function useWorkspaceStats(id: string) {
  return useSwarm(
    useShallow((s) => {
      let total = 0;
      let busy = 0;
      let attention = false;
      for (const aid of s.order) {
        const a = s.agents[aid];
        if (!a || a.workspaceId !== id) continue;
        total++;
        if (a.activity === "busy") busy++;
        if (a.attention || a.activity === "waiting") attention = true;
      }
      return { total, busy, attention };
    }),
  );
}

function WorkspaceTab({
  id,
  index,
  stripRef,
}: {
  id: string;
  index: number;
  stripRef: React.RefObject<HTMLDivElement | null>;
}) {
  const name = useSwarm((s) => s.workspaces[id]?.name ?? "");
  const active = useSwarm((s) => s.activeWorkspaceId === id);
  const isDropTarget = useSwarm((s) => s.tabDropTarget === id);
  const setActiveWorkspace = useSwarm((s) => s.setActiveWorkspace);
  const requestCloseWorkspace = useSwarm((s) => s.requestCloseWorkspace);
  const renameWorkspace = useSwarm((s) => s.renameWorkspace);
  const moveWorkspace = useSwarm((s) => s.moveWorkspace);
  const stats = useWorkspaceStats(id);
  const [editing, setEditing] = useState(false);
  // a drag that actually moved suppresses the click-to-activate on mouseup
  const draggedRef = useRef(false);

  // keep the active tab in view when switching via keyboard
  const tabRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active)
      tabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  const startReorder = (e: React.MouseEvent) => {
    if (e.button !== 0 || editing) return;
    if ((e.target as HTMLElement).closest("button:not([data-ws-tab]), input"))
      return;
    const strip = stripRef.current;
    if (!strip) return;
    const startX = e.clientX;
    draggedRef.current = false;

    const onMove = (ev: MouseEvent) => {
      if (!draggedRef.current && Math.abs(ev.clientX - startX) < 6) return;
      draggedRef.current = true;
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
      // live reorder: drop the tab where the cursor crosses a sibling's midpoint
      const tabs = Array.from(
        strip.querySelectorAll<HTMLElement>("[data-ws-tab]"),
      );
      let to = tabs.length - 1;
      for (let i = 0; i < tabs.length; i++) {
        const r = tabs[i].getBoundingClientRect();
        if (ev.clientX < r.left + r.width / 2) {
          to = i;
          break;
        }
      }
      moveWorkspace(id, to);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      // let the click handler read the flag before clearing it
      setTimeout(() => (draggedRef.current = false), 0);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <button
      ref={tabRef}
      data-ws-tab={id}
      onMouseDown={startReorder}
      onClick={() => {
        if (!draggedRef.current) setActiveWorkspace(id);
      }}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest("input")) return;
        setEditing(true);
      }}
      onAuxClick={(e) => {
        // middle-click closes, like browser tabs
        if (e.button === 1) requestCloseWorkspace(id);
      }}
      title={index <= 8 ? `${name} — ⌘${index + 1}` : name}
      className={cn(
        "no-drag group/tab flex h-7 max-w-44 shrink-0 items-center gap-1.5 rounded-md border px-2 transition-colors",
        active
          ? "border-border bg-card text-foreground"
          : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
        isDropTarget && "border-ring bg-ring/10 text-foreground",
        stats.attention && !active && "attn-pulse",
      )}
    >
      <span className="relative flex h-1.5 w-1.5 shrink-0">
        {stats.busy > 0 && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warning opacity-60" />
        )}
        <span
          className="relative inline-flex h-1.5 w-1.5 rounded-full"
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
      </span>

      {editing ? (
        <input
          autoFocus
          defaultValue={name}
          onFocus={(e) => e.target.select()}
          onBlur={(e) => {
            renameWorkspace(id, e.target.value);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setEditing(false);
          }}
          onMouseDown={(e) => e.stopPropagation()}
          className="h-5 w-24 rounded bg-secondary px-1 text-xs text-foreground outline-none select-text"
        />
      ) : (
        <span className="min-w-0 truncate text-xs font-medium">{name}</span>
      )}

      {stats.total > 0 && (
        <span className="font-mono text-[10px] tabular-nums text-faint">
          {stats.busy > 0 ? `${stats.busy}/${stats.total}` : stats.total}
        </span>
      )}

      <span
        role="button"
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          requestCloseWorkspace(id);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        className="-mr-0.5 hidden h-4 w-4 shrink-0 items-center justify-center rounded text-faint hover:bg-destructive/15 hover:text-destructive group-hover/tab:flex"
      >
        <X size={10} />
      </span>
    </button>
  );
}

function limitColor(pct: number) {
  return pct >= 85
    ? "var(--destructive)"
    : pct >= 65
      ? "var(--warning)"
      : "var(--success)";
}

function formatReset(iso: string | null) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const withinDay = d.getTime() - Date.now() < 24 * 60 * 60 * 1000;
  if (withinDay) return time;
  const day = d.toLocaleDateString(undefined, { weekday: "short" });
  return `${day} ${time}`;
}

function LimitMeter({
  label,
  tip,
  win,
}: {
  label: string;
  tip: string;
  win: RateLimitWindow;
}) {
  const pct = Math.min(Math.max(win.utilization ?? 0, 0), 100);
  const reset = formatReset(win.resets_at);
  return (
    <Tip
      label={
        <span className="font-mono text-[11px]">
          {tip}: {Math.round(pct)}% used
          {reset ? ` · resets ${reset}` : ""}
        </span>
      }
    >
      <span className="flex items-center gap-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-faint">
          {label}
        </span>
        <span className="h-1 w-10 overflow-hidden rounded-full bg-secondary">
          <span
            className="block h-full rounded-full"
            style={{ width: `${pct}%`, backgroundColor: limitColor(pct) }}
          />
        </span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {Math.round(pct)}%
        </span>
      </span>
    </Tip>
  );
}

/**
 * Usage limits of the Claude subscription logged in on this machine
 * (5-hour session window + weekly windows). Hidden when no login is found.
 */
function LimitsPill() {
  const limits = useLimits((s) => s.limits);
  if (!limits) return null;

  const meters: { label: string; tip: string; win: RateLimitWindow }[] = [];
  if (limits.five_hour)
    meters.push({ label: "5h", tip: "5-hour session limit", win: limits.five_hour });
  if (limits.seven_day)
    meters.push({ label: "wk", tip: "Weekly limit (all models)", win: limits.seven_day });
  if (limits.seven_day_sonnet?.utilization)
    meters.push({
      label: "son",
      tip: "Weekly Sonnet limit",
      win: limits.seven_day_sonnet,
    });
  if (limits.seven_day_opus?.utilization)
    meters.push({
      label: "opus",
      tip: "Weekly Opus limit",
      win: limits.seven_day_opus,
    });
  if (meters.length === 0) return null;

  return (
    <div className="flex h-7 items-center gap-3 rounded-md border border-border bg-card px-3">
      <Gauge size={12} className="shrink-0 text-faint" />
      {meters.map((m, i) => (
        <span key={m.label} className="flex items-center gap-3">
          {i > 0 && <span className="h-3.5 w-px bg-border" />}
          <LimitMeter label={m.label} tip={m.tip} win={m.win} />
        </span>
      ))}
    </div>
  );
}

/** Shows only when an update is live: available → downloading → ready. */
function UpdatePill() {
  const stage = useUpdates((s) => s.stage);
  const version = useUpdates((s) => s.version);
  const progress = useUpdates((s) => s.progress);
  const downloadAndInstall = useUpdates((s) => s.downloadAndInstall);
  const restart = useUpdates((s) => s.restart);

  if (stage === "idle") return null;

  const label =
    stage === "downloading"
      ? `Downloading… ${progress}%`
      : stage === "ready"
        ? "Restart to update"
        : stage === "error"
          ? "Update failed — retry"
          : version
            ? `Update ${version}`
            : "Update available";

  return (
    <button
      className="no-drag flex h-7 items-center gap-1.5 rounded-md border border-ring/50 bg-ring/10 px-2.5 text-[11px] font-medium text-foreground hover:bg-ring/20 disabled:opacity-70"
      disabled={stage === "downloading"}
      onClick={() => (stage === "ready" ? restart() : downloadAndInstall())}
      title={
        stage === "ready"
          ? "Restart SwarmZ to apply the update"
          : "Download and install the update"
      }
    >
      <Download size={12} className="text-ring" />
      <span className="font-mono tabular-nums">{label}</span>
    </button>
  );
}
