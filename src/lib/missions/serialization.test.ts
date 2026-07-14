import { describe, expect, it } from "vitest";
import { migratePersistedMissions, serializeMissionEvents } from "./serialization";
import type { MissionEvent } from "./types";

const created: MissionEvent = {
  eventId: "event-1",
  missionId: "mission-1",
  revision: 1,
  occurredAt: 10,
  actor: "human",
  type: "mission.created",
  data: {
    projectId: "project-1",
    title: "Mission",
    objective: "Objective",
    policy: {
      maxParallelAttempts: 4,
      stopOnCriticalFailure: true,
      requireQualityGates: true,
      integrationMode: "train",
    },
    budget: {
      maxAttemptsTotal: null,
      maxActiveMinutes: null,
      maxTokens: null,
      maxCostUsd: null,
    },
    createdAt: 10,
  },
};

describe("mission serialization", () => {
  it("round-trips a valid v2 event log", () => {
    const stored = serializeMissionEvents([created]);
    expect(migratePersistedMissions(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });

  it("migrates the v1 envelope, timestamp, actor, revision and event id", () => {
    const legacy = {
      version: 1,
      events: [{
        missionId: "mission-1",
        type: "mission.created",
        at: 42,
        data: created.data,
      }],
    };
    const result = migratePersistedMissions(legacy);
    expect(result.version).toBe(2);
    expect(result.events[0]).toMatchObject({
      eventId: "legacy:mission-1:1",
      revision: 1,
      occurredAt: 42,
      actor: "system",
    });
  });

  it("recovers an event projection after JSON reload without losing attempts", () => {
    const events: MissionEvent[] = [
      created,
      {
        eventId: "event-2",
        missionId: "mission-1",
        revision: 2,
        occurredAt: 20,
        actor: "orchestrator",
        type: "task.added",
        data: {
          id: "task-1",
          missionId: "mission-1",
          title: "Implement",
          description: "Do it",
          priority: 80,
          role: "engineer",
          risk: "high",
          acceptanceCriteria: ["green"],
          root: { projectId: "project-1", path: "/repo" },
          worktreePolicy: { mode: "new" },
          dependencyIds: [],
          declaredFiles: ["src/a.ts"],
          declaredGlobs: [],
          maxAttempts: 2,
          createdAt: 20,
        },
      },
      {
        eventId: "event-3",
        missionId: "mission-1",
        revision: 3,
        occurredAt: 30,
        actor: "scheduler",
        type: "attempt.started",
        data: { id: "attempt-1", taskId: "task-1", sessionId: "session-1", startedAt: 30 },
      },
      {
        eventId: "event-4",
        missionId: "mission-1",
        revision: 4,
        occurredAt: 40,
        actor: "scheduler",
        type: "attempt.finished",
        data: { attemptId: "attempt-1", status: "failed", finishedAt: 40 },
      },
      {
        eventId: "event-5",
        missionId: "mission-1",
        revision: 5,
        occurredAt: 50,
        actor: "scheduler",
        type: "attempt.started",
        data: { id: "attempt-2", taskId: "task-1", sessionId: "session-2", startedAt: 50 },
      },
    ];
    const reloaded = migratePersistedMissions(
      JSON.parse(JSON.stringify(serializeMissionEvents(events))),
    );
    expect(reloaded.events).toHaveLength(5);
    expect(reloaded.events[4]).toMatchObject({
      type: "attempt.started",
      data: { id: "attempt-2", sessionId: "session-2" },
    });
  });

  it("fails closed on malformed, future, stale and partially valid logs", () => {
    expect(() => migratePersistedMissions({ version: 99, events: [] })).toThrow(/unsupported/);
    expect(() => migratePersistedMissions({ version: 2, events: "no" })).toThrow(/array/);
    expect(() => migratePersistedMissions({
      version: 2,
      events: [created, { ...created, eventId: "event-2", revision: 1 }],
    })).toThrow(/stale/);
    expect(() => migratePersistedMissions({
      version: 2,
      events: [created, { garbage: true }],
    })).toThrow(/missing missionId/);
  });
});
