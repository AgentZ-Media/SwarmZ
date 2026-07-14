import { describe, expect, it } from "vitest";
import { pendingSchedules, splitScheduleDue, validateScheduleTime } from "./schedule-core";
import type { MissionSchedule } from "./types";

const schedule = (id: string, at: number, patch: Partial<MissionSchedule> = {}): MissionSchedule => ({
  id, missionId: "mission-1", projectId: "project-1", note: id, at,
  createdAt: 1, cancelledAt: null, claimedAt: null, firedAt: null, ...patch,
});

describe("mission schedules", () => {
  it("rejects past and more-than-one-year dates", () => {
    expect(validateScheduleTime(100_000, 1)).toMatch(/past/);
    expect(validateScheduleTime(100_000, 100_000 + 366 * 24 * 60 * 60_000)).toMatch(/year/);
    expect(validateScheduleTime(100_000, 101_000)).toBeNull();
  });

  it("returns only cancellable unclaimed schedules in due order", () => {
    expect(pendingSchedules([
      schedule("late", 30), schedule("early", 10),
      schedule("claimed", 5, { claimedAt: 6 }),
      schedule("cancelled", 4, { cancelledAt: 5 }),
    ]).map((item) => item.id)).toEqual(["early", "late"]);
  });

  it("classifies overdue persisted reminders as missed-on-restart work", () => {
    const result = splitScheduleDue([schedule("missed", 10), schedule("future", 30)], 20);
    expect(result.due.map((item) => item.id)).toEqual(["missed"]);
    expect(result.future.map((item) => item.id)).toEqual(["future"]);
  });

  it("keeps failed deliveries pending until their durable retry deadline", () => {
    const retry = schedule("retry", 10, { lastDeliveryError: "denied", nextAttemptAt: 40 });
    expect(splitScheduleDue([retry], 30).future.map((item) => item.id)).toEqual(["retry"]);
    expect(splitScheduleDue([retry], 40).due.map((item) => item.id)).toEqual(["retry"]);
  });
});
