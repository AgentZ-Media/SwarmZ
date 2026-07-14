import { useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import { useMissions } from "@/lib/missions/store";
import type { MissionEvent } from "@/lib/missions/types";

const EVENT_LABEL: Record<MissionEvent["type"], string> = {
  "mission.created": "Mission created",
  "mission.activated": "Mission started",
  "mission.paused": "Mission paused",
  "mission.resumed": "Mission resumed",
  "mission.cancelled": "Mission cancelled",
  "mission.archived": "Mission archived",
  "task.added": "Task added",
  "task.updated": "Task updated",
  "task.paused": "Task paused",
  "task.resumed": "Task resumed",
  "task.requeued": "Task requeued",
  "task.archived": "Task archived",
  "attempt.started": "Attempt started",
  "attempt.finished": "Attempt finished",
  "artifact.recorded": "Evidence recorded",
  "quality_gate.added": "Quality gate added",
  "quality_gate.resulted": "Quality gate completed",
  "integration_train.created": "Integration train created",
  "integration_train.updated": "Integration train updated",
  "candidate_batch.requested": "Candidate run approved",
  "candidate_batch.selected": "Candidate selected",
  "candidate_batch.overridden": "Candidate selection overridden",
  "schedule.created": "Reminder scheduled",
  "schedule.cancelled": "Reminder cancelled",
  "schedule.claimed": "Reminder claimed",
  "schedule.delivery_failed": "Reminder delivery failed",
  "schedule.fired": "Reminder delivered",
};

export function MissionTimeline({ missionId }: { missionId: string }) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const count = useMissions((state) => state.events.filter((event) => event.missionId === missionId).length);
  const events = useMemo(() => useMissions.getState().events.filter((event) => event.missionId === missionId).slice().reverse(), [missionId, count]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <div className="mx-auto max-w-4xl">
        <div className="mb-4 flex items-center gap-3"><h2 className="text-14 font-semibold text-txt">Audit timeline</h2><span className="font-mono text-10 text-fnt">{events.length} immutable events</span><button onClick={() => void copyMissionReport(missionId).then(() => { setCopyStatus("copied"); window.setTimeout(() => setCopyStatus("idle"), 1500); }).catch(() => { setCopyStatus("error"); window.setTimeout(() => setCopyStatus("idle"), 2500); })} className="focus-ring ml-auto flex h-8 items-center gap-1.5 rounded-md border border-line2 px-2.5 text-10 text-mut hover:bg-card hover:text-txt">{copyStatus === "copied" ? <Check size={11} className="text-ok" /> : <Copy size={11} />}{copyStatus === "copied" ? "Copied" : copyStatus === "error" ? "Copy failed" : "Copy report"}</button></div>
        <ol className="border-l border-line pl-5">
          {events.map((event) => <TimelineRow key={event.eventId} event={event} />)}
        </ol>
      </div>
    </div>
  );
}

async function copyMissionReport(missionId: string): Promise<void> {
  const state = useMissions.getState();
  const mission = state.projection.missions[missionId];
  if (!mission) throw new Error("mission is unknown");
  const taskIds = new Set(mission.taskIds);
  const attemptIds = new Set(mission.taskIds.flatMap((id) => state.projection.tasks[id]?.attemptIds ?? []));
  const report = {
    schema: "swarmz-mission-report-v1",
    exportedAt: new Date().toISOString(),
    mission,
    tasks: mission.taskIds.map((id) => state.projection.tasks[id]).filter(Boolean),
    attempts: [...attemptIds].map((id) => state.projection.attempts[id]).filter(Boolean),
    artifacts: Object.values(state.projection.artifacts).filter((artifact) => artifact.missionId === missionId && (!artifact.taskId || taskIds.has(artifact.taskId))),
    qualityGates: Object.values(state.projection.qualityGates).filter((gate) => gate.missionId === missionId),
    integrationTrains: mission.integrationTrainIds.map((id) => state.projection.integrationTrains[id]).filter(Boolean),
    events: state.events.filter((event) => event.missionId === missionId),
  };
  await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
}

function TimelineRow({ event }: { event: MissionEvent }) {
  const taskId = "taskId" in event.data && typeof event.data.taskId === "string" ? event.data.taskId : null;
  const taskTitle = useMissions((state) => taskId ? state.projection.tasks[taskId]?.title ?? null : null);
  return (
    <li className="relative border-b border-line py-3 first:pt-0">
      <span aria-hidden className="absolute -left-[25px] top-4 h-2 w-2 rounded-full border border-line2 bg-panel" />
      <div className="flex items-center gap-2">
        <span className="text-12 font-medium text-txt">{EVENT_LABEL[event.type]}</span>
        <span className="rounded-sm border border-line px-1.5 py-0.5 font-mono text-10 uppercase text-fnt">{event.actor}</span>
        <time className="ml-auto font-mono text-10 tabular-nums text-fnt">{new Date(event.occurredAt).toLocaleString()}</time>
      </div>
      <p className="mt-1 truncate text-11 text-mut">{taskTitle ?? (event.type.startsWith("mission.") ? "Mission lifecycle" : event.type)}</p>
      <p className="mt-1 break-all font-mono text-10 text-fnt">revision {event.revision} · {event.eventId}</p>
    </li>
  );
}
