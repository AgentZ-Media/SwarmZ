import { useEffect, useRef, useState } from "react";
import { Plus, Zap } from "lucide-react";
import { TooltipProvider } from "./components/ui/tooltip";
import { TitleBar } from "./components/TitleBar";
import { TilingGrid } from "./components/TilingGrid";
import { NewAgentDialog } from "./components/NewAgentDialog";
import { ProfilesDialog } from "./components/ProfilesDialog";
import { UsageDashboard } from "./components/UsageDashboard";
import { WebDirectoryPicker } from "./components/WebDirectoryPicker";
import { Button } from "./components/ui/button";
import { useSwarm } from "./store";
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
  const order = useSwarm((s) => s.order);

  const [profilesOpen, setProfilesOpen] = useState(false);
  const homeRef = useRef<string>("");
  const notifyGranted = useRef(false);
  const prevAttention = useRef<Set<string>>(new Set());

  // init
  useEffect(() => {
    void hydrate();
    void getHome().then((h) => (homeRef.current = h));
    void ensureNotifyPermission().then((g) => (notifyGranted.current = g));
  }, [hydrate]);

  // usage refresh — each agent shows ONLY its own session's usage
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      const { agents, order } = useSwarm.getState();
      await Promise.all(
        order.map(async (id) => {
          const a = agents[id];
          if (!a) return;
          const dir = a.cwd || homeRef.current;
          if (!dir) return;
          try {
            const u = await fetchUsageForSession(dir, a.createdAt, a.sessionId);
            if (alive && u) setUsage(id, u);
          } catch {
            /* ignore */
          }
        }),
      );
    };

    void refresh();
    const interval = setInterval(refresh, 4000);
    const unlistenP = onUsageChanged(refresh);

    return () => {
      alive = false;
      clearInterval(interval);
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
      } else if (k === "d") {
        e.preventDefault();
        splitActive(e.shiftKey ? "column" : "row");
      } else if (k === "w") {
        const id = useSwarm.getState().activeAgentId();
        if (id) {
          e.preventDefault();
          removeAgent(id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setNewAgentOpen, splitActive, removeAgent]);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-background">
        <TitleBar onManageProfiles={() => setProfilesOpen(true)} />
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
