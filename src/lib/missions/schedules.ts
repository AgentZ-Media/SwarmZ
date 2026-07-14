import { notify } from "@/lib/transport";
import { persistenceIssues } from "@/lib/persistence/coordinator";
import { flushMissionsPersist, useMissions } from "./store";
import { MAX_MISSION_SCHEDULES, pendingSchedules, validateScheduleTime } from "./schedule-core";
import type { MissionSchedule, MissionStatus } from "./types";

const MAX_SLEEP_MS = 2 ** 31 - 1;
const handles = new Map<string, ReturnType<typeof setTimeout>>();
const firing = new Set<string>();
let stopActive: (() => void) | null = null;

function clearHandle(id: string): void {
  const handle = handles.get(id);
  if (handle) clearTimeout(handle);
  handles.delete(id);
}

function arm(schedule: MissionSchedule): void {
  clearHandle(schedule.id);
  const dueAt = Math.max(schedule.at, schedule.nextAttemptAt ?? 0);
  const delay = Math.max(0, dueAt - Date.now());
  handles.set(schedule.id, setTimeout(() => {
    handles.delete(schedule.id);
    const current = useMissions.getState().projection.schedules[schedule.id];
    if (!current || current.cancelledAt !== null || current.claimedAt !== null) return;
    const currentDueAt = Math.max(current.at, current.nextAttemptAt ?? 0);
    if (currentDueAt > Date.now()) arm(current);
    else void fire(current, current.at < Date.now() - 1_000);
  }, Math.min(delay, MAX_SLEEP_MS)));
}

async function durable(): Promise<void> {
  await flushMissionsPersist();
  if (persistenceIssues().some((issue) => issue.name === "missions")) {
    throw new Error("Mission reminder could not be saved durably");
  }
}

async function fire(schedule: MissionSchedule, missed: boolean): Promise<void> {
  if (firing.has(schedule.id)) return;
  firing.add(schedule.id);
  try {
    const current = useMissions.getState().projection.schedules[schedule.id];
    if (!current || current.cancelledAt !== null || current.claimedAt !== null) return;
    // Claim and flush before the external notification. A crash after this
    // point is retained as visible uncertain delivery and is never mislabeled
    // fired or retried automatically.
    const deliveryAttempt = (current.deliveryAttempts ?? 0) + 1;
    useMissions.getState().claimSchedule(schedule.missionId, schedule.id, {
      actor: "system",
      idempotencyKey: `schedule-claim:${schedule.id}:${deliveryAttempt}`,
    });
    await durable();
    const mission = useMissions.getState().projection.missions[schedule.missionId];
    if (mission) {
      await notify(`⏰ ${mission.title}`, `${missed ? "Missed reminder: " : ""}${schedule.note}`);
    }
    useMissions.getState().fireSchedule(schedule.missionId, schedule.id, {
      actor: "system",
      idempotencyKey: `schedule-fired:${schedule.id}`,
    });
    await durable();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const claimed = useMissions.getState().projection.schedules[schedule.id];
    if (claimed && claimed.claimedAt !== null && claimed.firedAt === null) {
      try {
        const attempt = claimed.deliveryAttempts ?? 1;
        const delay = Math.min(60 * 60_000, 30_000 * 2 ** Math.min(6, Math.max(0, attempt - 1)));
        useMissions.getState().failScheduleDelivery(
          schedule.missionId,
          schedule.id,
          message.slice(0, 1_000) || "Native notification delivery failed",
          Date.now() + delay,
          {
            actor: "system",
            idempotencyKey: `schedule-delivery-failed:${schedule.id}:${attempt}`,
          },
        );
        await durable();
        const retryable = useMissions.getState().projection.schedules[schedule.id];
        if (retryable) arm(retryable);
      } catch (persistError) {
        // The durable claim remains an explicit uncertain state. Never mark
        // it fired and never auto-retry when the failure receipt is not safe.
        console.error("[missions] reminder delivery became uncertain:", persistError);
      }
    }
    console.error("[missions] reminder delivery failed:", message);
  } finally {
    firing.delete(schedule.id);
  }
}

function reconcile(): void {
  const state = useMissions.getState();
  if (state.hydrateStatus !== "ready") return;
  const pending = pendingSchedules(Object.values(state.projection.schedules));
  const ids = new Set(pending.map((item) => item.id));
  for (const id of handles.keys()) if (!ids.has(id)) clearHandle(id);
  for (const schedule of pending) {
    if (Math.max(schedule.at, schedule.nextAttemptAt ?? 0) <= Date.now()) void fire(schedule, true);
    else if (!handles.has(schedule.id)) arm(schedule);
  }
}

export async function createMissionSchedule(missionId: string, note: string, at: number): Promise<string> {
  const issue = validateScheduleTime(Date.now(), at);
  if (issue) throw new Error(issue);
  const state = useMissions.getState();
  const count = pendingSchedules(Object.values(state.projection.schedules)
    .filter((item) => item.missionId === missionId)).length;
  if (count >= MAX_MISSION_SCHEDULES) throw new Error(`This mission already has ${MAX_MISSION_SCHEDULES} pending reminders.`);
  const id = state.createSchedule(missionId, note, at);
  await durable();
  reconcile();
  return id;
}

export async function cancelMissionSchedule(missionId: string, scheduleId: string): Promise<void> {
  useMissions.getState().cancelSchedule(missionId, scheduleId);
  await durable();
  clearHandle(scheduleId);
}

const NOTIFY_STATUSES = new Set<MissionStatus>(["needs_human", "blocked", "failed", "succeeded", "cancelled"]);

/** Start deadline wakeups and native status-change notifications. */
export function startMissionSchedules(): () => void {
  if (stopActive) return stopActive;
  let seeded = false;
  let statuses = new Map<string, MissionStatus>();
  const wake = () => {
    const state = useMissions.getState();
    if (state.hydrateStatus !== "ready") return;
    const next = new Map(Object.values(state.projection.missions).map((mission) => [mission.id, mission.status]));
    if (!seeded) {
      statuses = next;
      seeded = true;
    } else {
      for (const mission of Object.values(state.projection.missions)) {
        const previous = statuses.get(mission.id);
        if (previous && previous !== mission.status && NOTIFY_STATUSES.has(mission.status)) {
          void notify(`Mission · ${mission.title}`, `Status changed: ${previous} → ${mission.status}`)
            .catch((error) => console.warn("[missions] status notification skipped:", error));
        }
      }
      statuses = next;
    }
    reconcile();
  };
  const unsubscribe = useMissions.subscribe(wake);
  wake();
  const stop = () => {
    unsubscribe();
    for (const id of [...handles.keys()]) clearHandle(id);
    stopActive = null;
  };
  stopActive = stop;
  return stop;
}
