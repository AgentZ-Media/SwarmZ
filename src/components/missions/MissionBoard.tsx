import { useMemo } from "react";
import { Check, CircleAlert, Clock3, GitBranch, Pause, Play, ShieldCheck } from "lucide-react";
import { useMissions } from "@/lib/missions/store";
import type { MissionTask, TaskStatus } from "@/lib/missions/types";
import { useVibeUi } from "@/lib/vibe/ui-store";
import { cn } from "@/lib/utils";

const GROUPS: Array<{ key: string; label: string; statuses: TaskStatus[]; glyph: string }> = [
  { key: "queue", label: "Queue", statuses: ["draft", "blocked_by_dependency", "paused"], glyph: "○" },
  { key: "ready", label: "Ready", statuses: ["ready"], glyph: "◇" },
  { key: "running", label: "Running", statuses: ["running"], glyph: "▶" },
  { key: "attention", label: "Needs attention", statuses: ["needs_human", "blocked", "failed"], glyph: "⚑" },
  { key: "done", label: "Verified", statuses: ["succeeded"], glyph: "✓" },
];

const STATUS_STYLE: Record<TaskStatus, { label: string; color: string; shape: string }> = {
  draft: { label: "Draft", color: "text-fnt", shape: "○" },
  paused: { label: "Paused", color: "text-warn", shape: "Ⅱ" },
  blocked_by_dependency: { label: "Waiting", color: "text-fnt", shape: "◇" },
  ready: { label: "Ready", color: "text-acc", shape: "◆" },
  running: { label: "Running", color: "text-acc", shape: "▶" },
  needs_human: { label: "Needs you", color: "text-attn", shape: "⚑" },
  blocked: { label: "Blocked", color: "text-attn", shape: "■" },
  failed: { label: "Failed", color: "text-err", shape: "×" },
  succeeded: { label: "Passed", color: "text-ok", shape: "✓" },
  cancelled: { label: "Cancelled", color: "text-fnt", shape: "×" },
  archived: { label: "Archived", color: "text-fnt", shape: "□" },
};

export function MissionBoard({ missionId }: { missionId: string }) {
  const signature = useMissions((state) => {
    const mission = state.projection.missions[missionId];
    return mission?.taskIds.map((id) => {
      const task = state.projection.tasks[id];
      return task ? `${id}:${task.status}:${task.priority}:${task.updatedAt}:${task.attemptIds.length}` : id;
    }).join("|") ?? "";
  });
  const tasks = useMemo(() => {
    const state = useMissions.getState();
    const mission = state.projection.missions[missionId];
    return (mission?.taskIds ?? [])
      .map((id) => state.projection.tasks[id])
      .filter((task): task is MissionTask => !!task && task.status !== "archived" && task.status !== "cancelled")
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
  }, [missionId, signature]);

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="grid min-w-[860px] grid-cols-5 border-y border-line bg-panel/35">
        {GROUPS.map((group, index) => {
          const rows = tasks.filter((task) => group.statuses.includes(task.status));
          return (
            <section key={group.key} aria-labelledby={`mission-group-${group.key}`} className={cn("min-h-[420px] p-3", index > 0 && "border-l border-line")}>
              <header className="mb-2 flex h-7 items-center gap-2">
                <span aria-hidden className={cn("font-mono text-11", group.key === "attention" ? "text-attn" : group.key === "done" ? "text-ok" : "text-fnt")}>{group.glyph}</span>
                <h3 id={`mission-group-${group.key}`} className="text-11 font-semibold uppercase tracking-[0.08em] text-mut">{group.label}</h3>
                <span className="ml-auto font-mono text-10 tabular-nums text-fnt">{rows.length}</span>
              </header>
              <div className="space-y-1.5">
                {rows.map((task) => <TaskRow key={task.id} task={task} />)}
                {rows.length === 0 && <p className="border-t border-dashed border-line px-1 py-3 text-10 leading-relaxed text-fnt">Nothing in this lane.</p>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function TaskRow({ task }: { task: MissionTask }) {
  const selected = useVibeUi((state) => state.selectedMissionTaskId === task.id);
  const status = STATUS_STYLE[task.status];
  const latestAttemptId = task.attemptIds[task.attemptIds.length - 1];
  const attemptStatus = useMissions((state) => latestAttemptId ? state.projection.attempts[latestAttemptId]?.status ?? null : null);
  const gateSig = useMissions((state) => task.qualityGateIds.map((id) => state.projection.qualityGates[id]?.status ?? "missing").join("|"));
  const gatePassed = gateSig && gateSig.split("|").every((value) => value === "passed" || value === "waived");

  return (
    <button
      onClick={() => useVibeUi.getState().setSelectedMissionTaskId(task.id)}
      aria-pressed={selected}
      className={cn(
        "focus-ring group w-full border border-line bg-card px-2.5 py-2 text-left hover:border-line2 hover:bg-pop",
        selected && "border-acc/45 bg-acc/5",
      )}
    >
      <div className="flex items-start gap-2">
        <span aria-hidden className={cn("mt-0.5 w-3 shrink-0 font-mono text-10", status.color)}>{status.shape}</span>
        <span className="line-clamp-2 text-11 font-medium leading-[1.35] text-txt">{task.title}</span>
        <span className={cn("ml-auto shrink-0 font-mono text-10", task.priority >= 80 ? "text-attn" : "text-fnt")}>P{Math.max(0, Math.min(3, 3 - Math.floor(task.priority / 26)))}</span>
      </div>
      <div className="mt-2 flex items-center gap-2 pl-5 font-mono text-10 text-fnt">
        <span className={status.color}>{status.label}</span>
        {task.dependencyIds.length > 0 && <span title={`${task.dependencyIds.length} dependencies`} className="flex items-center gap-0.5"><GitBranch size={9} />{task.dependencyIds.length}</span>}
        {task.qualityGateIds.length > 0 && <span title="Quality gates" className={cn("flex items-center gap-0.5", gatePassed ? "text-ok" : "text-fnt")}><ShieldCheck size={9} />{task.qualityGateIds.length}</span>}
        {attemptStatus === "running" && <Play size={9} className="text-acc" />}
        {attemptStatus === "blocked" && <CircleAlert size={9} className="text-attn" />}
        {task.status === "paused" && <Pause size={9} className="text-warn" />}
        {task.status === "succeeded" && <Check size={9} className="text-ok" />}
        {!latestAttemptId && task.status !== "succeeded" && <Clock3 size={9} />}
        <span className="ml-auto truncate">{task.role}</span>
      </div>
    </button>
  );
}
