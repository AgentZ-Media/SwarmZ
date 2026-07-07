import { useEffect, useRef, useState } from "react";
import {
  BarChart3,
  Bot,
  Download,
  LayoutGrid,
  Plus,
  Settings,
  SlidersHorizontal,
  StickyNote,
  X,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useSwarm } from "@/store";
import { useOrchestrator } from "@/lib/orchestrator/chat-store";
import { useVibeUi } from "@/lib/vibe/ui-store";
import { useUpdates } from "@/lib/updates";
import { WorktreesButton } from "./WorktreePanel";
import { Button } from "./ui/button";
import { Tip } from "./ui/tooltip";
import { cn } from "@/lib/utils";
import { IS_TAURI } from "@/lib/transport";

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
  const orchestratorOpen = useOrchestrator((s) => s.panelOpen);
  const toggleOrchestrator = useOrchestrator((s) => s.togglePanel);
  const uiMode = useSwarm((s) => s.settings.uiMode ?? "grid");
  const stageMode = useVibeUi((s) => s.stageMode);

  return (
    <header
      // "deep" = the whole title-bar subtree is draggable, not just direct hits
      // on the bare <header> (which is all the flex gaps amount to). Tauri's
      // drag.js still auto-excludes real <button>/<input>/role elements, so the
      // action buttons and tabs keep working. WKWebView ignores -webkit-app-region,
      // so this attribute — not the CSS — is what actually drags on macOS.
      data-tauri-drag-region="deep"
      className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background pr-3"
      style={{ paddingLeft: IS_TAURI ? 80 : 16 }}
    >
      <img
        src="/favicon.png"
        alt="SwarmZ"
        draggable={false}
        className="pointer-events-none h-7 w-7 shrink-0"
      />

      <ModeSwitch />

      <WorkspaceTabs />

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {IS_TAURI && <UpdatePill />}

        {/* subscription meters live in the Deck now (components/Deck.tsx) */}

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

        <Tip label={uiMode === "vibe" ? "Conductor (⌘⇧O)" : "Orchestrator (⌘⇧O)"}>
          <Button
            size="icon"
            variant={
              (uiMode === "vibe" ? stageMode === "conductor" : orchestratorOpen)
                ? "secondary"
                : "ghost"
            }
            className="no-drag"
            onClick={
              // in Vibe Mode the Conductor stage IS the orchestrator surface —
              // the sidebar would duplicate it (same routing as ⌘⇧O)
              uiMode === "vibe"
                ? () => useVibeUi.getState().setStageMode("conductor")
                : toggleOrchestrator
            }
          >
            <Bot size={15} />
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

// ---- Mode switch (grid ↔ vibe) ----

/**
 * The app-wide view switch. Real <button>s, so Tauri's drag.js auto-excludes
 * them from the header's "deep" drag region — no extra opt-out needed.
 */
function ModeSwitch() {
  const uiMode = useSwarm((s) => s.settings.uiMode ?? "grid");
  const setUiMode = useSwarm((s) => s.setUiMode);
  return (
    <div className="flex shrink-0 items-center rounded-md border border-border bg-secondary p-0.5 font-mono text-[10px]">
      {(["grid", "vibe"] as const).map((m) => (
        <Tip
          key={m}
          label={
            m === "grid"
              ? "Grid — the tiling terminal wall (⌘⇧V)"
              : "Vibe — native Codex sessions (⌘⇧V)"
          }
        >
          <button
            onClick={() => setUiMode(m)}
            className={cn(
              "focus-ring rounded border px-2.5 py-1 capitalize transition-colors",
              uiMode === m
                ? "border-input bg-card text-foreground"
                : "border-transparent text-faint hover:text-muted-foreground",
            )}
          >
            {m}
          </button>
        </Tip>
      ))}
    </div>
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
      // The strip spans the middle of the title bar (flex-1); its empty area
      // stays draggable for free via the header's data-tauri-drag-region="deep"
      // (Tauri auto-excludes the tab <button>s and the + button).
      className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
    >
      {workspaceOrder.map((id, i) => (
        <WorkspaceTab key={id} id={id} index={i} stripRef={stripRef} />
      ))}
      <Tip label="New workspace (⌘⇧N)">
        <button
          className="no-drag focus-ring flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-faint hover:bg-accent hover:text-foreground"
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
      let attn = 0;
      for (const aid of s.order) {
        const a = s.agents[aid];
        if (!a || a.workspaceId !== id) continue;
        total++;
        if (a.activity === "busy") busy++;
        if (a.attention || a.activity === "waiting") attn++;
      }
      return { total, busy, attn };
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
  const tabRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active)
      tabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  const startReorder = (e: React.MouseEvent) => {
    if (e.button !== 0 || editing) return;
    // dragging starts from the tab body; the close button and the rename
    // input opt out (the main tab button deliberately does NOT)
    if ((e.target as HTMLElement).closest("[data-tab-close], input")) return;
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

  // busy is quiet — a static muted dot; needs-you is the ⚑n badge. Alive but
  // idle is deliberately NEUTRAL (faint), not green: green is reserved for
  // "just finished" / success states (DESIGN.md), and a permanent green tab
  // dot next to a green "✓ finished" word read as the same signal.
  const dotColor =
    stats.busy > 0
      ? "var(--muted-foreground)"
      : stats.total > 0
        ? "var(--faint)"
        : "color-mix(in srgb, var(--faint) 40%, transparent)";

  // The tab is a DIV with two real button siblings (activate + close) — a
  // close X nested inside the tab <button> was unreachable by keyboard and
  // invalid ARIA. `data-tauri-drag-region="false"` keeps the plain div from
  // becoming a window-drag surface under the header's "deep" region.
  return (
    <div
      ref={tabRef}
      data-ws-tab={id}
      data-tauri-drag-region="false"
      onMouseDown={startReorder}
      onAuxClick={(e) => {
        // middle-click closes, like browser tabs
        if (e.button === 1) requestCloseWorkspace(id);
      }}
      className={cn(
        "no-drag group/tab flex h-7 max-w-44 shrink-0 items-center rounded-md border pr-1 transition-colors",
        active
          ? "border-border bg-card text-foreground"
          : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
        isDropTarget && "border-ring bg-ring/10 text-foreground",
      )}
    >
      {editing ? (
        <span className="flex h-full items-center gap-1.5 pl-2">
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: dotColor }}
          />
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
        </span>
      ) : (
        <button
          onClick={() => {
            if (!draggedRef.current) setActiveWorkspace(id);
          }}
          onDoubleClick={() => setEditing(true)}
          title={index <= 8 ? `${name} — ⌘${index + 1}` : name}
          className="focus-ring flex h-full min-w-0 items-center gap-1.5 rounded-md pl-2 pr-0.5"
        >
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: dotColor }}
          />
          <span className="min-w-0 truncate text-xs font-medium">{name}</span>
          {stats.total > 0 && (
            <span className="font-mono text-[10px] tabular-nums text-faint">
              {stats.busy > 0 ? `${stats.busy}/${stats.total}` : stats.total}
            </span>
          )}
          {stats.attn > 0 && (
            <span
              className="font-mono text-[10px] font-semibold tabular-nums text-attn"
              title={`${stats.attn} agent${stats.attn > 1 ? "s" : ""} need${stats.attn > 1 ? "" : "s"} your input`}
            >
              ⚑{stats.attn}
            </span>
          )}
        </button>
      )}

      <button
        data-tab-close
        tabIndex={active ? 0 : -1}
        onClick={(e) => {
          e.stopPropagation();
          requestCloseWorkspace(id);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        title="Close workspace"
        className="focus-ring pointer-events-none flex h-4 w-4 shrink-0 items-center justify-center rounded text-faint opacity-0 hover:bg-destructive/15 hover:text-destructive focus-visible:opacity-100 group-hover/tab:pointer-events-auto group-hover/tab:opacity-100"
      >
        <X size={10} />
      </button>
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
      className="no-drag focus-ring flex h-7 items-center gap-1.5 rounded-md border border-ring/50 bg-ring/10 px-2.5 text-[11px] font-medium text-foreground hover:bg-ring/20 disabled:opacity-70"
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
