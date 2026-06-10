import { useEffect, useRef, useState } from "react";
import { Plus, Zap } from "lucide-react";
import { TooltipProvider } from "./components/ui/tooltip";
import { TitleBar } from "./components/TitleBar";
import { TilingGrid } from "./components/TilingGrid";
import { NewAgentDialog } from "./components/NewAgentDialog";
import { ProfilesDialog } from "./components/ProfilesDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { UsageDashboard } from "./components/UsageDashboard";
import { WebDirectoryPicker } from "./components/WebDirectoryPicker";
import { Button } from "./components/ui/button";
import { useSwarm } from "./store";
import { useUpdates } from "./lib/updates";
import { useLimits } from "./lib/limits";
import { startGitPolling } from "./lib/git";
import { encodeProjectDir } from "./lib/utils";
import {
  ensureNotifyPermission,
  fetchUsageForSession,
  getHome,
  notify,
  onUsageChanged,
} from "./lib/transport";

export default function App() {
  const hydrate = useSwarm((s) => s.hydrate);
  const setUsage = useSwarm((s) => s.setUsage);
  const setNewAgentOpen = useSwarm((s) => s.setNewAgentOpen);
  const splitActive = useSwarm((s) => s.splitActive);
  const removeAgent = useSwarm((s) => s.removeAgent);
  const adjustFontSize = useSwarm((s) => s.adjustFontSize);
  const order = useSwarm((s) => s.order);

  const [profilesOpen, setProfilesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const homeRef = useRef<string>("");
  const notifyGranted = useRef(false);
  const prevAttention = useRef<Set<string>>(new Set());

  // init
  useEffect(() => {
    void hydrate();
    void getHome().then((h) => (homeRef.current = h));
    void ensureNotifyPermission().then((g) => (notifyGranted.current = g));
    const updates = useUpdates.getState();
    updates.startBackgroundPolling();
    const stopLimits = useLimits.getState().start();
    const stopGit = startGitPolling();
    return () => {
      updates.stopBackgroundPolling();
      stopLimits();
      stopGit();
    };
  }, [hydrate]);

  // usage refresh — each agent shows ONLY its own session's usage.
  // Watcher events are filtered to the project dirs of open agents, all
  // triggers are coalesced (min 2s apart), and nothing runs while the
  // window is hidden (one refresh fires on becoming visible again).
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastRun = 0;
    let pendingWhileHidden = false;
    const MIN_GAP_MS = 2000;

    const refresh = async () => {
      const { agents, order } = useSwarm.getState();
      await Promise.all(
        order.map(async (id) => {
          const a = agents[id];
          if (!a) return;
          const dir = a.cwd || homeRef.current;
          if (!dir) return;
          // sessions other agents have latched onto — with several agents in
          // the same folder, an unlatched pane must never match a sibling's file
          const exclude = order
            .filter((oid) => oid !== id)
            .map((oid) => agents[oid]?.sessionId)
            .filter((s): s is string => !!s);
          try {
            const u = await fetchUsageForSession(dir, a.createdAt, a.sessionId, exclude);
            if (alive && u) setUsage(id, u);
          } catch {
            /* ignore */
          }
        }),
      );
    };

    const schedule = () => {
      if (!alive) return;
      if (document.hidden) {
        pendingWhileHidden = true;
        return;
      }
      if (timer) return; // a run is already scheduled — coalesce
      const wait = Math.max(0, lastRun + MIN_GAP_MS - Date.now());
      timer = setTimeout(() => {
        timer = null;
        lastRun = Date.now();
        void refresh();
      }, wait);
    };

    lastRun = Date.now();
    void refresh();
    const interval = setInterval(schedule, 4000);
    const unlistenP = onUsageChanged((changedDirs) => {
      // ignore changes from sessions we're not displaying (other Claude
      // instances writing to ~/.claude/projects); empty = unknown → refresh
      if (changedDirs && changedDirs.length > 0) {
        const { agents, order } = useSwarm.getState();
        const watched = new Set(
          order
            .map((id) => agents[id]?.cwd || homeRef.current)
            .filter(Boolean)
            .map(encodeProjectDir),
        );
        if (!changedDirs.some((d) => watched.has(d))) return;
      }
      schedule();
    });
    const onVisibility = () => {
      if (!document.hidden && pendingWhileHidden) {
        pendingWhileHidden = false;
        schedule();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      void unlistenP.then((u) => u());
    };
  }, [setUsage]);

  // native notification when an agent rings the bell / needs attention
  useEffect(() => {
    const unsub = useSwarm.subscribe((state) => {
      const nowAttention = new Set<string>();
      for (const id of state.order) {
        const a = state.agents[id];
        if (a?.attention) {
          nowAttention.add(id);
          if (!prevAttention.current.has(id) && notifyGranted.current) {
            void notify(`🔔 ${a.name}`, "Agent needs your attention");
          }
        }
      }
      prevAttention.current = nowAttention;
    });
    return unsub;
  }, []);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === "t") {
        e.preventDefault();
        setNewAgentOpen(true);
      } else if (k === ",") {
        // macOS convention: ⌘, opens settings
        e.preventDefault();
        setSettingsOpen(true);
      } else if (k === "d") {
        e.preventDefault();
        splitActive(e.shiftKey ? "column" : "row");
      } else if (k === "w") {
        const id = useSwarm.getState().activeAgentId();
        if (id) {
          e.preventDefault();
          removeAgent(id);
        }
      } else if (k === "+" || k === "=" || k === "-" || k === "0") {
        // per-pane zoom — "=" covers ⌘+ on layouts where + needs shift (US)
        const id = useSwarm.getState().activeAgentId();
        if (id) {
          e.preventDefault();
          adjustFontSize(id, k === "0" ? "reset" : k === "-" ? -1 : 1);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setNewAgentOpen, splitActive, removeAgent, adjustFontSize]);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-background">
        <TitleBar
          onManageProfiles={() => setProfilesOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <main className="relative min-h-0 min-w-0 flex-1 p-2">
          {order.length === 0 ? (
            <EmptyState onNew={() => setNewAgentOpen(true)} />
          ) : (
            <TilingGrid />
          )}
        </main>
      </div>

      <NewAgentDialog />
      <ProfilesDialog open={profilesOpen} onOpenChange={setProfilesOpen} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <UsageDashboard />
      <WebDirectoryPicker />
    </TooltipProvider>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex h-full w-full items-center justify-center rounded-lg border border-dashed border-border">
      <div className="flex flex-col items-center gap-5 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-border bg-card">
          <Zap size={22} className="text-foreground" fill="currentColor" />
        </div>
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            Welcome to SwarmZ
          </h1>
          <p className="mt-1.5 max-w-xs text-sm leading-relaxed text-muted-foreground">
            Spawn parallel Claude agents, tile them into a grid, and watch
            tokens &amp; cost in real time.
          </p>
        </div>
        <Button onClick={onNew}>
          <Plus size={15} /> Launch your first agent
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
