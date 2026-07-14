import { useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, Bell, ChevronDown, GitBranch, LayoutDashboard, Network, Pause, Play, Plus, Radio, ScrollText, ShieldAlert, Workflow, X } from "lucide-react";
import { useMissions } from "@/lib/missions/store";
import type { Mission, MissionTask } from "@/lib/missions/types";
import { useProjects } from "@/lib/projects/store";
import { useVibeUi, type WorkspaceView } from "@/lib/vibe/ui-store";
import { cn } from "@/lib/utils";
import { FleetGrid } from "@/components/vibe/FleetGrid";
import { MissionBoard } from "./MissionBoard";
import { MissionGraph } from "./MissionGraph";
import { MissionIntegrationView } from "./MissionIntegrationView";
import { MissionTimeline } from "./MissionTimeline";
import { AttentionInbox } from "./AttentionInbox";
import { MissionTaskInspector } from "./MissionTaskInspector";
import { MissionRecoveryPanel } from "./MissionRecoveryPanel";
import { MissionInsightsPanel } from "./MissionInsightsPanel";
import { useMissionOutbox } from "@/lib/missions/outbox-store";
import { MissionHeaderActions } from "./MissionHeaderActions";
import { Dialog, DialogDescription, DialogTitle, DrawerContent } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

const TABS: Array<{ id: WorkspaceView; label: string; icon: typeof LayoutDashboard }> = [
  { id: "board", label: "Board", icon: LayoutDashboard },
  { id: "graph", label: "Graph", icon: Network },
  { id: "fleet", label: "Fleet", icon: Radio },
  { id: "integration", label: "Integration", icon: GitBranch },
  { id: "timeline", label: "Timeline", icon: ScrollText },
];

export function MissionWorkspace() {
  const [insightsOpen, setInsightsOpen] = useState(false);
  const projectId = useProjects((state) => state.activeProjectId);
  const selectedId = useVibeUi((state) => state.selectedMissionId);
  const view = useVibeUi((state) => state.workspaceView);
  const attentionOpen = useVibeUi((state) => state.attentionOpen);
  const selectedTaskId = useVibeUi((state) => state.selectedMissionTaskId);
  const recoveryOpen = useVibeUi((state) => state.recoveryOpen);
  const missionSignature = useMissions((state) => Object.values(state.projection.missions)
    .filter((mission) => mission.projectId === projectId && mission.status !== "archived")
    .map((mission) => `${mission.id}:${mission.status}:${mission.updatedAt}:${mission.taskIds.length}`)
    .sort()
    .join("|"));
  const missions = useMemo(() => Object.values(useMissions.getState().projection.missions)
    .filter((mission) => mission.projectId === projectId && mission.status !== "archived")
    .sort((a, b) => b.updatedAt - a.updatedAt), [projectId, missionSignature]);
  const mission = missions.find((item) => item.id === selectedId) ?? missions[0] ?? null;

  useEffect(() => {
    if ((mission?.id ?? null) !== selectedId) useVibeUi.getState().setSelectedMissionId(mission?.id ?? null);
  }, [mission?.id, selectedId]);
  if (!projectId) return <NoProject />;
  if (!mission && view === "fleet") return <FleetGrid />;
  if (!mission) return <NoMission />;

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <main className="flex min-w-0 flex-1 flex-col">
        <MissionHeader mission={mission} missions={missions} onOpenInsights={() => setInsightsOpen(true)} />
        <div className="flex h-10 shrink-0 items-center overflow-x-auto border-b border-line px-2 sm:px-3">
          <nav aria-label="Mission views" className="flex h-full min-w-max items-center gap-0.5">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const active = view === tab.id;
              return <button key={tab.id} onClick={() => useVibeUi.getState().setWorkspaceView(tab.id)} aria-current={active ? "page" : undefined} className={cn("focus-ring flex h-8 items-center gap-1.5 rounded-md px-3 text-11", active ? "bg-card font-medium text-txt" : "text-fnt hover:text-mut")}><Icon size={12} />{tab.label}</button>;
            })}
          </nav>
          <button onClick={() => useVibeUi.getState().setAttentionOpen(true)} className="focus-ring ml-auto flex h-8 items-center gap-1.5 rounded-md px-2.5 text-11 text-mut hover:bg-card hover:text-txt 2xl:hidden"><Bell size={12} /> Attention</button>
        </div>
        {view === "board" && <MissionBoard missionId={mission.id} />}
        {view === "graph" && <MissionGraph missionId={mission.id} />}
        {view === "fleet" && <FleetGrid />}
        {view === "integration" && <MissionIntegrationView missionId={mission.id} />}
        {view === "timeline" && <MissionTimeline missionId={mission.id} />}
      </main>
      <aside className="hidden w-[304px] shrink-0 border-l border-line bg-panel/55 2xl:flex"><AttentionInbox className="h-full w-full rounded-none border-0" /></aside>
      <Dialog open={attentionOpen} onOpenChange={(open) => { if (!open) useVibeUi.getState().setAttentionOpen(false); }}>
        <DrawerContent className="w-[min(360px,94vw)]">
          <DialogTitle className="sr-only">Attention inbox</DialogTitle>
          <DialogDescription className="sr-only">Approvals, failed gates, blocked tasks and other mission decisions that need you.</DialogDescription>
          <button onClick={() => useVibeUi.getState().setAttentionOpen(false)} aria-label="Close attention inbox" className="focus-ring absolute right-2 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-md text-fnt hover:bg-card hover:text-txt"><X size={14} aria-hidden /></button>
          <AttentionInbox className="h-full w-full rounded-none border-0" />
        </DrawerContent>
      </Dialog>
      <Dialog open={!!selectedTaskId} onOpenChange={(open) => { if (!open) useVibeUi.getState().setSelectedMissionTaskId(null); }}>
        <DrawerContent className="w-[min(760px,94vw)]">
          <DialogTitle className="sr-only">Mission task details</DialogTitle>
          <DialogDescription className="sr-only">Inspect task scope, attempts, evidence and quality gates.</DialogDescription>
          {selectedTaskId && <MissionTaskInspector className="h-full w-full rounded-none border-0" />}
        </DrawerContent>
      </Dialog>
      <MissionRecoveryPanel missionId={mission.id} open={recoveryOpen} />
      <Dialog open={insightsOpen} onOpenChange={setInsightsOpen}>
        <DrawerContent className="w-[min(760px,94vw)] p-3">
          <DialogTitle className="sr-only">Mission insights</DialogTitle>
          <DialogDescription className="sr-only">Evidence-based mission health, throughput, risk and recommended decisions.</DialogDescription>
          <button onClick={() => setInsightsOpen(false)} aria-label="Close mission insights" className="focus-ring absolute right-5 top-5 z-10 flex h-8 w-8 items-center justify-center rounded-md text-fnt hover:bg-card hover:text-txt"><X size={14} aria-hidden /></button>
          <MissionInsightsPanel missionId={mission.id} className="h-full rounded-lg" />
        </DrawerContent>
      </Dialog>
    </div>
  );
}

function MissionHeader({ mission, missions, onOpenInsights }: { mission: Mission; missions: Mission[]; onOpenInsights: () => void }) {
  const taskSignature = useMissions((state) => mission.taskIds.map((id) => state.projection.tasks[id]?.status ?? "missing").join("|"));
  const stats = useMemo(() => {
    const projection = useMissions.getState().projection;
    const tasks = mission.taskIds.map((id) => projection.tasks[id]).filter((task): task is MissionTask => !!task && !["archived", "cancelled"].includes(task.status));
    const done = tasks.filter((task) => task.status === "succeeded").length;
    const running = tasks.filter((task) => task.status === "running").length;
    const attention = tasks.filter((task) => ["needs_human", "blocked", "failed"].includes(task.status)).length;
    return { total: tasks.length, done, running, attention, roots: new Set(tasks.map((task) => task.root.path)).size, percent: tasks.length ? Math.round(done / tasks.length * 100) : 0 };
  }, [mission.id, mission.taskIds, taskSignature]);
  const paused = mission.status === "paused";
  const terminal = ["cancelled", "failed", "succeeded"].includes(mission.status);
  const recoveryCount = useMissionOutbox((state) => Object.values(state.snapshot.records)
    .filter((record) => record.missionId === mission.id && record.status !== "delivered").length);

  return (
    <header className="shrink-0 border-b border-line bg-panel/35 px-3 py-2.5 lg:px-4 lg:py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2 lg:gap-3">
        <div className="min-w-[220px] flex-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="focus-ring flex max-w-full items-center gap-2 rounded-md text-left hover:text-txt">
                <span className="truncate text-16 font-semibold tracking-[-0.01em] text-txt">{mission.title}</span><ChevronDown size={13} className="shrink-0 text-fnt" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-[min(420px,70dvh)] w-[min(420px,calc(100vw-2rem))] overflow-y-auto">
              {missions.map((item) => (
                <DropdownMenuItem key={item.id} onSelect={() => useVibeUi.getState().setSelectedMissionId(item.id)} className={cn("text-12", item.id === mission.id ? "bg-line text-txt" : "text-mut")}>
                  <span className="min-w-0 flex-1 truncate">{item.title}</span><span className="ml-auto shrink-0 font-mono text-10 uppercase text-fnt">{item.status}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <p className="mt-0.5 max-w-2xl truncate text-11 text-fnt">{mission.objective}</p>
        </div>
        <span className={cn("shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-10 uppercase", paused ? "border-warn/30 text-warn" : terminal ? "border-line text-fnt" : "border-acc/30 text-acc")}>{mission.status}</span>
        <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
        <button onClick={onOpenInsights} title="Open evidence-based mission insights" className="focus-ring flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line2 px-2.5 text-11 text-mut hover:bg-card hover:text-txt"><Activity size={12} />Insights</button>
        <button onClick={() => useVibeUi.getState().setRecoveryOpen(true)} title="Open durable delivery ledger" className={cn("focus-ring flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-11 hover:bg-card", recoveryCount ? "border-attn/35 text-attn" : "border-line2 text-mut hover:text-txt")}><ShieldAlert size={12} />{recoveryCount ? `${recoveryCount} recovery` : "Ledger"}</button>
        <MissionHeaderActions mission={mission} />
        <button onClick={() => paused ? useMissions.getState().activateMission(mission.id) : useMissions.getState().pauseMission(mission.id)} disabled={terminal} className="focus-ring flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line2 px-2.5 text-11 text-mut hover:bg-card hover:text-txt disabled:opacity-40">{paused ? <Play size={12} /> : <Pause size={12} />}{paused ? "Resume" : "Pause"}</button>
        <button onClick={() => useVibeUi.getState().setMissionCreateOpen(true)} className="focus-ring flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-acc px-3 text-11 font-semibold text-white hover:brightness-110"><Plus size={12} /> Mission</button>
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <div className="h-1.5 min-w-[120px] max-w-md flex-1 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-ok transition-[width]" style={{ width: `${stats.percent}%` }} /></div>
        <span className="font-mono text-10 tabular-nums text-mut">{stats.done}/{stats.total} verified · {stats.percent}%</span>
        <span className="hidden font-mono text-10 tabular-nums text-acc sm:inline">▶ {stats.running} running</span>
        {stats.attention > 0 && <span className="flex items-center gap-1 font-mono text-10 tabular-nums text-attn"><AlertTriangle size={10} /> {stats.attention} attention</span>}
        <span className="hidden font-mono text-10 text-fnt lg:inline">{stats.roots} root{stats.roots === 1 ? "" : "s"} · limit {mission.policy.maxParallelAttempts} · train {mission.policy.integrationMode}</span>
      </div>
    </header>
  );
}

function NoProject() {
  return <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-center"><div><Workflow size={26} className="mx-auto text-fnt" /><h1 className="mt-4 text-16 font-semibold text-txt">Open a project to begin</h1><p className="mx-auto mt-2 max-w-md text-12 leading-relaxed text-fnt">A mission is scoped to real project roots so worktrees, approvals, evidence and GitHub operations stay confined.</p></div></div>;
}

function NoMission() {
  return <div className="dot-grid flex min-h-0 flex-1 items-center justify-center p-4 text-center sm:p-8"><div className="max-w-lg border-y border-line bg-panel/40 px-4 py-8 sm:px-8 sm:py-10"><Workflow size={28} className="mx-auto text-acc" /><h1 className="mt-4 text-16 font-semibold tracking-[-0.01em] text-txt">Turn a large goal into a controlled mission</h1><p className="mt-3 text-12 leading-relaxed text-fnt">Import a bug list or roadmap. SwarmZ builds the dependency graph, schedules temporary workers, prevents conflicting writes and verifies the combined result.</p><div className="mt-6 flex flex-wrap justify-center gap-2"><button onClick={() => useVibeUi.getState().setMissionCreateOpen(true)} className="focus-ring h-9 rounded-md bg-acc px-5 text-12 font-semibold text-white hover:brightness-110"><Plus size={13} className="mr-1.5 inline" />Create first mission</button><button onClick={() => useVibeUi.getState().setWorkspaceView("fleet")} className="focus-ring h-9 rounded-md px-4 text-12 text-mut hover:bg-card hover:text-txt">Open fleet</button></div></div></div>;
}
