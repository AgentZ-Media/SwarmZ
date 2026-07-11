import { useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3,
  Download,
  FolderOpen,
  GitPullRequest,
  PanelLeft,
  Plus,
  Search,
  Settings,
  StickyNote,
  X,
} from "lucide-react";
import { useSwarm } from "@/store";
import { useProjects, openProjectIds } from "@/lib/projects/store";
import { useVibe } from "@/lib/vibe/session-store";
import { hasPendingApproval } from "@/lib/vibe/ui";
import { useVibeUi } from "@/lib/vibe/ui-store";
import {
  activateProject,
  focusSession,
  requestCloseProject,
} from "@/lib/vibe/controller";
import { vibeTriageEntries } from "@/lib/vibe/triage";
import { discoverProjects } from "@/lib/orchestrator/native";
import { useUpdates } from "@/lib/updates";
import { WorktreesButton } from "./WorktreePanel";
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

/** Shared 32px icon-button treatment for the title-bar actions. */
const BAR_BTN =
  "no-drag focus-ring flex h-8 w-8 items-center justify-center rounded-md text-mut hover:bg-card hover:text-txt";

export function TitleBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const setDashboardOpen = useSwarm((s) => s.setDashboardOpen);
  const dashboardOpen = useSwarm((s) => s.dashboardOpen);
  const notesOpen = useSwarm((s) => s.notesOpen);
  const setNotesOpen = useSwarm((s) => s.setNotesOpen);
  const setPaletteOpen = useSwarm((s) => s.setPaletteOpen);
  const conductorOpen = useVibeUi((s) => s.conductorOpen);
  const toggleConductor = useVibeUi((s) => s.toggleConductor);

  return (
    <header
      // "deep" = the whole title-bar subtree is draggable, not just direct hits
      // on the bare <header> (which is all the flex gaps amount to). Tauri's
      // drag.js still auto-excludes real <button>/<input>/role elements, so the
      // action buttons keep working; the project tabs are plain <div>s and opt
      // out explicitly via data-tauri-drag-region="false". WKWebView ignores
      // -webkit-app-region, so this attribute — not the CSS — drags on macOS.
      data-tauri-drag-region="deep"
      className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel pr-4"
      style={{ paddingLeft: IS_TAURI ? 80 : 16 }}
    >
      {/* Conductor sidebar toggle (⌘B) */}
      <Tip label={conductorOpen ? "Collapse the Conductor (⌘B)" : "Open the Conductor (⌘B)"}>
        <button onClick={toggleConductor} className={BAR_BTN}>
          <PanelLeft
            size={16}
            className={cn(!conductorOpen && "opacity-40")}
          />
        </button>
      </Tip>

      {/* brand mark + wordmark */}
      <div className="flex shrink-0 items-center gap-2">
        <span aria-hidden className="hex-mark hex-mark-flat flex h-6 w-6 items-center justify-center">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="#fff">
            <polygon points="13 2 4 14 11 14 9.5 22 20 10 13 10" />
          </svg>
        </span>
        <span className="text-14 font-bold tracking-[-0.01em] text-txt">
          SwarmZ
        </span>
        <span aria-hidden className="font-mono text-12 text-fnt">
          /
        </span>
      </div>

      <ProjectTabs />

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <NeedsYouPill />

        {IS_TAURI && <UpdatePill />}

        <Tip label="Search or jump (⌘K)">
          <button
            onClick={() => setPaletteOpen(true)}
            className="no-drag focus-ring flex h-8 items-center gap-1.5 rounded-md px-2.5 text-mut hover:bg-card hover:text-txt"
          >
            <Search size={15} />
            <span className="font-mono text-11">⌘K</span>
          </button>
        </Tip>

        <Tip label="Usage dashboard">
          <button
            onClick={() => setDashboardOpen(!dashboardOpen)}
            className={cn(BAR_BTN, dashboardOpen && "bg-card text-txt")}
          >
            <BarChart3 size={15} />
          </button>
        </Tip>

        <Tip label="Quick notes (⌘N)">
          <button
            onClick={() => setNotesOpen(!notesOpen)}
            className={cn(BAR_BTN, notesOpen && "bg-card text-txt")}
          >
            <StickyNote size={15} />
          </button>
        </Tip>

        {/* appears only once at least one git worktree exists */}
        <WorktreesButton />

        <GitHubButton />

        <Tip label="Settings (⌘,)">
          <button onClick={onOpenSettings} className={BAR_BTN}>
            <Settings size={15} />
          </button>
        </Tip>

        <Tip label="New agent (⌘T)">
          <button
            onClick={() => useVibeUi.getState().setNewSessionOpen(true)}
            className="no-drag focus-ring ml-1 flex h-8 items-center gap-1.5 rounded-md bg-acc px-3 text-12 font-semibold text-white hover:brightness-110"
          >
            <Plus size={13} strokeWidth={2.8} /> New agent
          </button>
        </Tip>
      </div>
    </header>
  );
}

/** The GitHub panel button (Phase 7) — the drawer itself is read-only and
 * works without the integration toggle; automation lives behind Settings. */
function GitHubButton() {
  const githubOpen = useSwarm((s) => s.githubOpen);
  const setGithubOpen = useSwarm((s) => s.setGithubOpen);
  return (
    <Tip label="GitHub — repo & pull requests">
      <button
        onClick={() => setGithubOpen(!githubOpen)}
        className={cn(BAR_BTN, githubOpen && "bg-card text-txt")}
      >
        <GitPullRequest size={15} />
      </button>
    </Tip>
  );
}

/**
 * The needs-you pill — amber, only while at least one agent waits on the
 * human. Click = jump to the oldest waiting session (same routing as ⌘⇧A).
 */
function NeedsYouPill() {
  // primitive count — vibeTriageEntries builds fresh arrays, so only its
  // length may leave the selector (AGENTS.md)
  const count = useVibe((s) => vibeTriageEntries(s).length);
  if (count === 0) return null;
  const jump = () => {
    const entries = vibeTriageEntries(useVibe.getState());
    if (entries.length) focusSession(entries[0].id);
  };
  return (
    <button
      onClick={jump}
      title="Jump to the next agent that needs you (⌘⇧A)"
      className="no-drag focus-ring mr-1 flex h-8 items-center gap-1.5 rounded-md border border-attn/30 bg-attn/10 px-3 font-mono text-12 font-semibold text-attn hover:bg-attn/15"
    >
      <span aria-hidden className="animate-zattn">
        ⚑
      </span>
      {count} need{count === 1 ? "s" : ""} you
    </button>
  );
}

// ---- Project tabs ----

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

  // busy is quiet — the accent live-dot marks a project with running agents;
  // alive but idle stays NEUTRAL (fnt); an empty project fades further.
  // Needs-you is the ⚑n badge, never the dot.
  const dotCls =
    stats.busy > 0
      ? "bg-acc animate-zpulse"
      : stats.total > 0
        ? "bg-fnt"
        : "bg-fnt/40";

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
        "no-drag group/tab flex h-8 max-w-44 shrink-0 items-center rounded-md border pr-1 transition-colors",
        active
          ? "border-line bg-card text-txt"
          : "border-transparent text-mut hover:bg-card/60 hover:text-txt",
      )}
    >
      {editing ? (
        <span className="flex h-full items-center gap-1.5 pl-2.5">
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotCls)} />
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
            className="h-5 w-24 select-text rounded-xs bg-pop px-1 text-12 text-txt outline-none"
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
          className="focus-ring flex h-full min-w-0 items-center gap-1.5 rounded-md pl-2.5 pr-0.5"
        >
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotCls)} />
          <span className="min-w-0 truncate text-12 font-medium">{name}</span>
          {stats.total > 0 && (
            <span className="font-mono text-10 tabular-nums text-fnt">
              {stats.busy > 0 ? `${stats.busy}/${stats.total}` : stats.total}
            </span>
          )}
          {stats.attn > 0 && (
            <span
              className="font-mono text-10 font-semibold tabular-nums text-attn"
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
          requestCloseProject(id);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        title="Close project tab (sessions are kept)"
        className="focus-ring pointer-events-none flex h-4 w-4 shrink-0 items-center justify-center rounded-xs text-fnt opacity-0 hover:bg-err/15 hover:text-err focus-visible:opacity-100 group-hover/tab:pointer-events-auto group-hover/tab:opacity-100"
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
          <button className="no-drag focus-ring flex h-8 shrink-0 items-center gap-1 rounded-md px-1.5 text-fnt hover:bg-card hover:text-txt">
            <Plus size={14} />
            {openCount === 0 && <span className="text-12">Open project</span>}
          </button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuItem onSelect={() => void pick()}>
          <FolderOpen size={13} className="shrink-0 text-mut" />
          Open folder…
        </DropdownMenuItem>
        {recents.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Recent</DropdownMenuLabel>
            {recents.map((p) => (
              <DropdownMenuItem key={p.path} onSelect={() => void openDir(p.path)}>
                <span className="min-w-0 flex-1 truncate text-12">{p.name}</span>
                <span className="max-w-[55%] shrink-0 truncate font-mono text-10 text-fnt">
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
      className="no-drag focus-ring flex h-8 items-center gap-1.5 rounded-md border border-acc/50 bg-acc/10 px-2.5 text-11 font-medium text-txt hover:bg-acc/20 disabled:opacity-70"
      disabled={stage === "downloading"}
      onClick={() => (stage === "ready" ? restart() : downloadAndInstall())}
      title={
        stage === "ready"
          ? "Restart SwarmZ to apply the update"
          : "Download and install the update"
      }
    >
      <Download size={12} className="text-acc" />
      <span className="font-mono tabular-nums">{label}</span>
    </button>
  );
}
