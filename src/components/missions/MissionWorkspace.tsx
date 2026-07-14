import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Bell, ChevronDown, GitBranch, LayoutDashboard, Network, Pause, Play, Plus, Radio, ScrollText, ShieldAlert, Workflow, X } from "lucide-react";
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
import { useMissionOutbox } from "@/lib/missions/outbox-store";

const TABS: Array<{ id: WorkspaceView; label: string; icon: typeof LayoutDashboard }> = [
  { id: "board", label: "Board", icon: LayoutDashboard },
  { id: "graph", label: "Graph", icon: Network },
  { id: "fleet", label: "Fleet", icon: Radio },
  { id: "integration", label: "Integration", icon: GitBranch },
  { id: "timeline", label: "Timeline", icon: ScrollText },
];

export function MissionWorkspace() {
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
  useEffect(() => {
    if (!attentionOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") useVibeUi.getState().setAttentionOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [attentionOpen]);

  if (!projectId) return <NoProject />;
  if (!mission && view === "fleet") return <FleetGrid />;
  if (!mission) return <NoMission />;

  return (
    <div className="relative flex min-h-0 flex-1">
      <main className="flex min-w-0 flex-1 flex-col">
        <MissionHeader mission={mission} missions={missions} />
        <div className="flex h-10 shrink-0 items-center border-b border-line px-3">
          <nav aria-label="Mission views" className="flex h-full items-center gap-0.5">
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
      {attentionOpen && <div className="absolute inset-0 z-30 flex justify-end bg-black/45 2xl:hidden" onMouseDown={(event) => { if (event.target === event.currentTarget) useVibeUi.getState().setAttentionOpen(false); }}><aside role="dialog" aria-modal="true" aria-label="Attention inbox" className="relative h-full w-[min(360px,92vw)] border-l border-line2 bg-panel shadow-2xl"><button onClick={() => useVibeUi.getState().setAttentionOpen(false)} aria-label="Close attention inbox" className="focus-ring absolute right-2 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-md text-fnt hover:bg-card hover:text-txt"><X size={14} /></button><AttentionInbox className="h-full w-full rounded-none border-0" /></aside></div>}
      {selectedTaskId && <div role="dialog" aria-modal="true" aria-label="Mission task details" className="absolute inset-0 z-40 flex justify-end bg-black/45" onMouseDown={(event) => { if (event.target === event.currentTarget) useVibeUi.getState().setSelectedMissionTaskId(null); }}><MissionTaskInspector className="h-full w-[min(760px,94vw)] rounded-none border-y-0 border-r-0 shadow-2xl" /></div>}
      {recoveryOpen && <MissionRecoveryPanel missionId={mission.id} />}
    </div>
  );
}

function MissionHeader({ mission, missions }: { mission: Mission; missions: Mission[] }) {
  const [chooser, setChooser] = useState(false);
  const taskSignature = useMissions((state) => mission.taskIds.map((id) => state.projection.tasks[id]?.status ?? "missing").join("|"));
  const stats = useMemo(() => {
    const projection = useMissions.getState().projection;
    const tasks = mission.taskIds.map((id) => projection.tasks[id]).filter((task): task is MissionTask => !!task && !["archived", "cancelled"].includes(task.status));
    const done = tasks.filter((task) => task.status === "succeeded").length;
    const running = tasks.filter((task) => task.status === "running").length;
    const attention = tasks.filter((task) => ["needs_human", "blocked", "failed"].includes(task.status)).length;
    return { total: tasks.length, done, running, attention, percent: tasks.length ? Math.round(done / tasks.length * 100) : 0 };
  }, [mission.id, mission.taskIds, taskSignature]);
  const paused = mission.status === "paused";
  const terminal = ["cancelled", "failed", "succeeded"].includes(mission.status);
  const recoveryCount = useMissionOutbox((state) => Object.values(state.snapshot.records)
    .filter((record) => record.missionId === mission.id && record.status !== "delivered").length);

  return (
    <header className="shrink-0 border-b border-line bg-panel/35 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <div className="relative min-w-0">
          <button onClick={() => setChooser((value) => !value)} aria-expanded={chooser} className="focus-ring flex max-w-full items-center gap-2 rounded-md text-left hover:text-txt">
            <span className="truncate text-15 font-semibold tracking-[-0.01em] text-txt">{mission.title}</span><ChevronDown size={13} className="shrink-0 text-fnt" />
          </button>
          <p className="mt-0.5 max-w-2xl truncate text-11 text-fnt">{mission.objective}</p>
          {chooser && <div className="absolute left-0 top-10 z-40 w-[min(420px,80vw)] border border-line2 bg-pop p-1 shadow-2xl">{missions.map((item) => <button key={item.id} onClick={() => { useVibeUi.getState().setSelectedMissionId(item.id); setChooser(false); }} className={cn("focus-ring flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-12 hover:bg-card", item.id === mission.id ? "text-txt" : "text-mut")}><span className="truncate">{item.title}</span><span className="ml-auto font-mono text-10 uppercase text-fnt">{item.status}</span></button>)}</div>}
        </div>
        <span className={cn("shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-10 uppercase", paused ? "border-warn/30 text-warn" : terminal ? "border-line text-fnt" : "border-acc/30 text-acc")}>{mission.status}</span>
        <button onClick={() => useVibeUi.getState().setRecoveryOpen(true)} title="Open durable delivery ledger" className={cn("focus-ring ml-auto flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-11 hover:bg-card", recoveryCount ? "border-attn/35 text-attn" : "border-line2 text-mut hover:text-txt")}><ShieldAlert size={12} />{recoveryCount ? `${recoveryCount} recovery` : "Ledger"}</button>
        <button onClick={() => paused ? useMissions.getState().activateMission(mission.id) : useMissions.getState().pauseMission(mission.id)} disabled={terminal} className="focus-ring flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line2 px-2.5 text-11 text-mut hover:bg-card hover:text-txt disabled:opacity-40">{paused ? <Play size={12} /> : <Pause size={12} />}{paused ? "Resume" : "Pause"}</button>
        <button onClick={() => useVibeUi.getState().setMissionCreateOpen(true)} className="focus-ring flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-acc px-3 text-11 font-semibold text-white hover:brightness-110"><Plus size={12} /> Mission</button>
      </div>
      <div className="mt-3 flex items-center gap-4">
        <div className="h-1.5 min-w-[120px] max-w-md flex-1 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-ok transition-[width]" style={{ width: `${stats.percent}%` }} /></div>
        <span className="font-mono text-10 tabular-nums text-mut">{stats.done}/{stats.total} verified · {stats.percent}%</span>
        <span className="hidden font-mono text-10 tabular-nums text-acc sm:inline">▶ {stats.running} running</span>
        {stats.attention > 0 && <span className="flex items-center gap-1 font-mono text-10 tabular-nums text-attn"><AlertTriangle size={10} /> {stats.attention} attention</span>}
        <span className="hidden font-mono text-10 text-fnt lg:inline">limit {mission.policy.maxParallelAttempts} · train {mission.policy.integrationMode}</span>
      </div>
    </header>
  );
}

function NoProject() {
  return <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-center"><div><Workflow size={26} className="mx-auto text-fnt" /><h1 className="mt-4 text-16 font-semibold text-txt">Open a project to begin</h1><p className="mx-auto mt-2 max-w-md text-12 leading-relaxed text-fnt">A mission is scoped to real project roots so worktrees, approvals, evidence and GitHub operations stay confined.</p></div></div>;
}

function NoMission() {
  return <div className="dot-grid flex min-h-0 flex-1 items-center justify-center p-8 text-center"><div className="max-w-lg border-y border-line bg-panel/40 px-8 py-10"><Workflow size={28} className="mx-auto text-acc" /><h1 className="mt-4 text-18 font-semibold tracking-[-0.01em] text-txt">Turn a large goal into a controlled mission</h1><p className="mt-3 text-12 leading-relaxed text-fnt">Import a bug list or roadmap. SwarmZ builds the dependency graph, schedules temporary workers, prevents conflicting writes and verifies the combined result.</p><button onClick={() => useVibeUi.getState().setMissionCreateOpen(true)} className="focus-ring mt-6 h-9 rounded-md bg-acc px-5 text-12 font-semibold text-white hover:brightness-110"><Plus size={13} className="mr-1.5 inline" />Create first mission</button><button onClick={() => useVibeUi.getState().setWorkspaceView("fleet")} className="focus-ring ml-2 h-9 rounded-md px-4 text-12 text-mut hover:bg-card hover:text-txt">Open fleet</button></div></div>;
}
