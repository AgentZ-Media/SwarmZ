import { useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3,
  Bot,
  Download,
  FolderOpen,
  Plus,
  Settings,
  StickyNote,
  X,
} from "lucide-react";
import { useSwarm } from "@/store";
import { useProjects, openProjectIds } from "@/lib/projects/store";
import { useVibe } from "@/lib/vibe/session-store";
import { hasPendingApproval } from "@/lib/vibe/ui";
import { useVibeUi } from "@/lib/vibe/ui-store";
import { activateProject, requestCloseProject } from "@/lib/vibe/controller";
import { discoverProjects } from "@/lib/orchestrator/native";
import { useUpdates } from "@/lib/updates";
import { WorktreesButton } from "./WorktreePanel";
import { Button } from "./ui/button";
import { Tip } from "./ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { cn, shortPath } from "@/lib/utils";
import { IS_TAURI, pickDirectory } from "@/lib/transport";
import type { ProjectEntry } from "@/lib/orchestrator/types";

export function TitleBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const setDashboardOpen = useSwarm((s) => s.setDashboardOpen);
  const dashboardOpen = useSwarm((s) => s.dashboardOpen);
  const notesOpen = useSwarm((s) => s.notesOpen);
  const setNotesOpen = useSwarm((s) => s.setNotesOpen);
  const stageMode = useVibeUi((s) => s.stageMode);

  return (
    <header
      // "deep" = the whole title-bar subtree is draggable, not just direct hits
      // on the bare <header> (which is all the flex gaps amount to). Tauri's
      // drag.js still auto-excludes real <button>/<input>/role elements, so the
      // action buttons keep working; the project tabs are plain <div>s and opt
      // out explicitly via data-tauri-drag-region="false". WKWebView ignores
      // -webkit-app-region, so this attribute — not the CSS — drags on macOS.
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

      <ProjectTabs />

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {IS_TAURI && <UpdatePill />}

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

        <Tip label="Conductor (⌘⇧O)">
          <Button
            size="icon"
            variant={stageMode === "conductor" ? "secondary" : "ghost"}
            className="no-drag"
            onClick={() => useVibeUi.getState().setStageMode("conductor")}
          >
            <Bot size={15} />
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
          onClick={() => useVibeUi.getState().setNewSessionOpen(true)}
        >
          <Plus size={14} /> New Session
        </Button>
      </div>
    </header>
  );
}

// ---- Project tabs (interim look — the Phase-6 design restyles them) ----

/**
 * One tab per OPEN project. Click = activate (⌘1–9), double-click = rename,
 * middle-click / X = close the tab (sessions stay — reopening the folder
 * brings them back), drag = reorder, + = folder picker / recents dropdown.
 */
function ProjectTabs() {
  // primitive signature — never a fresh array from the selector
  const idsSig = useProjects((s) => openProjectIds(s).join("|"));
  const ids = useMemo(() => (idsSig ? idsSig.split("|") : []), [idsSig]);
  const stripRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={stripRef}
      // The strip spans the middle of the title bar (flex-1); its empty area
      // stays draggable for free via the header's data-tauri-drag-region="deep"
      // (Tauri auto-excludes the buttons; the tab divs opt out explicitly).
      className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
    >
      {ids.map((id, i) => (
        <ProjectTab key={id} id={id} index={i} stripRef={stripRef} />
      ))}
      <AddProjectButton openCount={ids.length} />
    </div>
  );
}

/** Aggregated live session state of one project, for its tab. */
function useProjectStats(id: string) {
  const total = useVibe((s) =>
    s.order.reduce(
      (n, sid) => (s.sessions[sid]?.session.projectId === id ? n + 1 : n),
      0,
    ),
  );
  const busy = useVibe((s) =>
    s.order.reduce(
      (n, sid) =>
        s.sessions[sid]?.session.projectId === id && s.busy[sid] ? n + 1 : n,
      0,
    ),
  );
  const attn = useVibe((s) => {
    let n = 0;
    for (const sid of s.order) {
      const e = s.sessions[sid];
      if (e && e.session.projectId === id && hasPendingApproval(e)) n++;
    }
    return n;
  });
  return { total, busy, attn };
}

function ProjectTab({
  id,
  index,
  stripRef,
}: {
  id: string;
  index: number;
  stripRef: React.RefObject<HTMLDivElement | null>;
}) {
  const name = useProjects((s) => s.projects[id]?.name ?? "");
  const dir = useProjects((s) => s.projects[id]?.dir ?? "");
  const active = useProjects((s) => s.activeProjectId === id);
  const renameProject = useProjects((s) => s.renameProject);
  const moveProject = useProjects((s) => s.moveProject);
  const stats = useProjectStats(id);
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
        strip.querySelectorAll<HTMLElement>("[data-project-tab]"),
      );
      let to = tabs.length - 1;
      for (let i = 0; i < tabs.length; i++) {
        const r = tabs[i].getBoundingClientRect();
        if (ev.clientX < r.left + r.width / 2) {
          to = i;
          break;
        }
      }
      moveProject(id, to);
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
  // idle is deliberately NEUTRAL (faint), not green: green stays reserved for
  // "just finished" / success states (DESIGN.md).
  const dotColor =
    stats.busy > 0
      ? "var(--muted-foreground)"
      : stats.total > 0
        ? "var(--faint)"
        : "color-mix(in srgb, var(--faint) 40%, transparent)";

  // The tab is a DIV with two real button siblings (activate + close) — a
  // close X nested inside the tab <button> would be unreachable by keyboard
  // and invalid ARIA. `data-tauri-drag-region="false"` keeps the plain div
  // from becoming a window-drag surface under the header's "deep" region.
  return (
    <div
      ref={tabRef}
      data-project-tab={id}
      data-tauri-drag-region="false"
      onMouseDown={startReorder}
      onAuxClick={(e) => {
        // middle-click closes, like browser tabs (busy → confirm line)
        if (e.button === 1) requestCloseProject(id);
      }}
      className={cn(
        "no-drag group/tab flex h-7 max-w-44 shrink-0 items-center rounded-md border pr-1 transition-colors",
        active
          ? "border-border bg-card text-foreground"
          : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
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
              renameProject(id, e.target.value);
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
            if (!draggedRef.current) activateProject(id);
          }}
          onDoubleClick={() => setEditing(true)}
          title={
            (index <= 8 ? `${name} — ⌘${index + 1}` : name) +
            `\n${shortPath(dir)}`
          }
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
              title={`${stats.attn} session${stats.attn > 1 ? "s" : ""} need${stats.attn > 1 ? "" : "s"} your input`}
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
          requestCloseProject(id);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        title="Close project tab (sessions are kept)"
        className="focus-ring pointer-events-none flex h-4 w-4 shrink-0 items-center justify-center rounded text-faint opacity-0 hover:bg-destructive/15 hover:text-destructive focus-visible:opacity-100 group-hover/tab:pointer-events-auto group-hover/tab:opacity-100"
      >
        <X size={10} />
      </button>
    </div>
  );
}

/** The + button: folder picker on top, discovery recents underneath. */
function AddProjectButton({ openCount }: { openCount: number }) {
  const [open, setOpen] = useState(false);
  const [recents, setRecents] = useState<ProjectEntry[]>([]);

  // load recents on the opening edge only
  useEffect(() => {
    if (!open) return;
    let stale = false;
    void discoverProjects()
      .then((ps) => {
        if (stale) return;
        const openDirs = new Set(
          Object.values(useProjects.getState().projects)
            .filter((p) => !p.closedAt)
            .map((p) => p.dir),
        );
        setRecents(
          ps.filter((p) => p.exists && !openDirs.has(p.path)).slice(0, 8),
        );
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [open]);

  const openDir = async (dir: string) => {
    const id = await useProjects.getState().openProject(dir);
    activateProject(id);
  };

  const pick = async () => {
    const dir = await pickDirectory();
    if (dir) await openDir(dir);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tip label="Open project">
        <DropdownMenuTrigger asChild>
          <button className="no-drag focus-ring flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-faint hover:bg-accent hover:text-foreground">
            <Plus size={14} />
            {openCount === 0 && <span className="text-xs">Open project</span>}
          </button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuItem onSelect={() => void pick()}>
          <FolderOpen size={13} className="shrink-0 text-muted-foreground" />
          Open folder…
        </DropdownMenuItem>
        {recents.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Recent</DropdownMenuLabel>
            {recents.map((p) => (
              <DropdownMenuItem key={p.path} onSelect={() => void openDir(p.path)}>
                <span className="min-w-0 flex-1 truncate text-xs">{p.name}</span>
                <span className="max-w-[55%] shrink-0 truncate font-mono text-[10px] text-faint">
                  {shortPath(p.path)}
                </span>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
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
