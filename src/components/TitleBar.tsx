import {
  BarChart3,
  Bot,
  Download,
  Plus,
  Settings,
  StickyNote,
} from "lucide-react";
import { useSwarm } from "@/store";
import { useVibeUi } from "@/lib/vibe/ui-store";
import { useUpdates } from "@/lib/updates";
import { WorktreesButton } from "./WorktreePanel";
import { Button } from "./ui/button";
import { Tip } from "./ui/tooltip";
import { IS_TAURI } from "@/lib/transport";

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
      // action buttons keep working. WKWebView ignores -webkit-app-region,
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

      {/* the middle stays empty (draggable) until the Phase-2 project tabs land */}
      <div className="min-w-0 flex-1" />

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
