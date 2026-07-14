import type { MissionSchedule } from "./types";

export const MAX_MISSION_SCHEDULES = 20;
export const MAX_MISSION_SCHEDULE_DELAY_MS = 365 * 24 * 60 * 60_000;

export function validateScheduleTime(now: number, at: number): string | null {
  if (!Number.isFinite(at)) return "Choose a valid date and time.";
  if (at < now - 60_000) return "The reminder time is in the past.";
  if (at > now + MAX_MISSION_SCHEDULE_DELAY_MS) return "Reminders can be scheduled at most one year ahead.";
  return null;
}

export function pendingSchedules(
  schedules: readonly MissionSchedule[],
): MissionSchedule[] {
  return schedules
    .filter((item) => item.cancelledAt === null && item.claimedAt === null)
    .sort((left, right) =>
      Math.max(left.at, left.nextAttemptAt ?? 0) - Math.max(right.at, right.nextAttemptAt ?? 0) ||
      left.id.localeCompare(right.id));
}

export function splitScheduleDue(schedules: readonly MissionSchedule[], now: number): {
  due: MissionSchedule[];
  future: MissionSchedule[];
} {
  const pending = pendingSchedules(schedules);
  return {
    due: pending.filter((item) => Math.max(item.at, item.nextAttemptAt ?? 0) <= now),
    future: pending.filter((item) => Math.max(item.at, item.nextAttemptAt ?? 0) > now),
  };
}
