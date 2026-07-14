import { useMemo } from "react";
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
  "task.archived": "Task archived",
  "attempt.started": "Attempt started",
  "attempt.finished": "Attempt finished",
  "artifact.recorded": "Evidence recorded",
  "quality_gate.added": "Quality gate added",
  "quality_gate.resulted": "Quality gate completed",
  "integration_train.created": "Integration train created",
  "integration_train.updated": "Integration train updated",
};

export function MissionTimeline({ missionId }: { missionId: string }) {
  const count = useMissions((state) => state.events.filter((event) => event.missionId === missionId).length);
  const events = useMemo(() => useMissions.getState().events.filter((event) => event.missionId === missionId).slice().reverse(), [missionId, count]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <div className="mx-auto max-w-4xl">
        <div className="mb-4 flex items-baseline gap-3"><h2 className="text-14 font-semibold text-txt">Audit timeline</h2><span className="font-mono text-10 text-fnt">{events.length} immutable events</span></div>
        <ol className="border-l border-line pl-5">
          {events.map((event) => <TimelineRow key={event.eventId} event={event} />)}
        </ol>
      </div>
    </div>
  );
}

function TimelineRow({ event }: { event: MissionEvent }) {
  const taskId = "taskId" in event.data && typeof event.data.taskId === "string" ? event.data.taskId : null;
  const taskTitle = useMissions((state) => taskId ? state.projection.tasks[taskId]?.title ?? null : null);
  return (
    <li className="relative border-b border-line py-3 first:pt-0">
      <span aria-hidden className="absolute -left-[25px] top-4 h-2 w-2 rounded-full border border-line2 bg-panel" />
      <div className="flex items-center gap-2">
        <span className="text-12 font-medium text-txt">{EVENT_LABEL[event.type]}</span>
        <span className="rounded-sm border border-line px-1.5 py-0.5 font-mono text-9 uppercase text-fnt">{event.actor}</span>
        <time className="ml-auto font-mono text-10 tabular-nums text-fnt">{new Date(event.occurredAt).toLocaleString()}</time>
      </div>
      <p className="mt-1 truncate text-11 text-mut">{taskTitle ?? (event.type.startsWith("mission.") ? "Mission lifecycle" : event.type)}</p>
      <p className="mt-1 font-mono text-9 text-fnt">revision {event.revision} · {event.eventId}</p>
    </li>
  );
}
