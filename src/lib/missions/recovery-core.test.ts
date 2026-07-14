import { describe, expect, it } from "vitest";
import { emptyMissionProjection } from "./core";
import type { MissionOutboxRecord, OutboxStatus } from "./outbox";
import {
  orphanMissionSessionIds,
  runningAttemptRecoveryIssue,
  sessionMatchesSpawn,
  spawnProjectionIssue,
  type MissionRecoverySession,
} from "./recovery-core";
import type { Mission, MissionTask, TaskAttempt } from "./types";

function attempt(status: TaskAttempt["status"] = "running"): TaskAttempt {
  return {
    id: "attempt-1",
    missionId: "mission-1",
    taskId: "task-1",
    ordinal: 1,
    status,
    sessionId: "session-1",
    workerLabel: "temporary worker",
    startedAt: 1,
    finishedAt: status === "running" ? null : 2,
    summary: null,
    error: null,
    report: null,
    artifactIds: [],
  };
}

function projection(status: TaskAttempt["status"] = "running") {
  const value = emptyMissionProjection();
  value.missions["mission-1"] = {
    id: "mission-1",
    projectId: "project-1",
    title: "Mission",
    objective: "Ship safely",
    status: "active",
    taskIds: ["task-1"],
    integrationTrainIds: [],
    policy: {
      maxParallelAttempts: 1,
      stopOnCriticalFailure: true,
      requireQualityGates: true,
      integrationMode: "manual",
    },
    budget: {
      maxAttemptsTotal: null,
      maxActiveMinutes: null,
      maxTokens: null,
      maxCostUsd: null,
    },
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    cancelledAt: null,
    pausedAt: null,
    activatedAt: 1,
    revision: 1,
  } satisfies Mission;
  value.tasks["task-1"] = {
    id: "task-1",
    missionId: "mission-1",
    title: "Task",
    description: "Do it",
    status: status === "running" ? "running" : "succeeded",
    priority: 50,
    role: "implementation",
    risk: "medium",
    acceptanceCriteria: ["Done"],
    root: { projectId: "project-1", path: "/repo" },
    worktreePolicy: { mode: "new" },
    dependencyIds: [],
    declaredFiles: [],
    declaredGlobs: [],
    maxAttempts: 1,
    attemptIds: ["attempt-1"],
    qualityGateIds: [],
    artifactIds: [],
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    pausedAt: null,
  } satisfies MissionTask;
  value.attempts["attempt-1"] = attempt(status);
  return value;
}

function spawn(status: OutboxStatus = "delivered"): MissionOutboxRecord {
  return {
    id: "record-1",
    missionId: "mission-1",
    idempotencyKey: "spawn:attempt-1",
    command: {
      kind: "spawn",
      payload: {
        taskId: "task-1",
        attemptId: "attempt-1",
        sessionId: "session-1",
        projectId: "project-1",
        cwd: "/repo/.worktrees/task-1",
        root: "/repo",
        branch: "mission/task-1",
        prompt: "Implement",
      },
    },
    status,
    createdAt: 1,
    updatedAt: 1,
    attempts: 1,
    maxAttempts: 5,
    nextAttemptAt: 1,
    lease: null,
    delivery: status === "delivered"
      ? { deliveredAt: 1, receipt: { sessionId: "session-1" } }
      : null,
    lastError: null,
  };
}

function session(
  patch: Partial<MissionRecoverySession> = {},
): MissionRecoverySession {
  return {
    id: "session-1",
    projectId: "project-1",
    projectDir: "/repo/.worktrees/task-1",
    spawnedBy: "mission",
    access: "workspace",
    worktree: { root: "/repo", branch: "mission/task-1", shared: false },
    ...patch,
  };
}

describe("Mission production recovery core", () => {
  it("requires every durable spawn capability to match before session reuse", () => {
    expect(sessionMatchesSpawn(session(), spawn())).toBe(true);
    expect(sessionMatchesSpawn(session({ access: "full" }), spawn())).toBe(false);
    expect(sessionMatchesSpawn(session({ projectDir: "/repo" }), spawn())).toBe(false);
    expect(sessionMatchesSpawn(session({ spawnedBy: "user" }), spawn())).toBe(false);
  });

  it("refuses spawn replay after Mission authority or attempt ownership changed", () => {
    const valid = projection();
    expect(spawnProjectionIssue(valid, spawn("failed"))).toBeNull();
    valid.missions["mission-1"].status = "paused";
    expect(spawnProjectionIssue(valid, spawn("failed"))).toMatch(/no longer active/);

    const mismatched = projection();
    mismatched.attempts["attempt-1"].sessionId = "another-session";
    expect(spawnProjectionIssue(mismatched, spawn("failed"))).toMatch(/session id/);
  });

  it("keeps a replayable pre-ack lane but fails a delivered spawn without its exact session", () => {
    const running = attempt();
    expect(runningAttemptRecoveryIssue(running, [spawn("claimed")], {})).toBeNull();
    expect(runningAttemptRecoveryIssue(running, [spawn()], {})).toMatch(/no persisted/);
    expect(runningAttemptRecoveryIssue(running, [spawn()], {
      "session-1": session({ projectDir: "/wrong" }),
    })).toMatch(/disagrees/);
    expect(runningAttemptRecoveryIssue(running, [spawn()], {
      "session-1": session(),
    })).toBeNull();
  });

  it("closes only orphaned Mission-owned lanes in deterministic order", () => {
    const records = [spawn("claimed")];
    const sessions = [
      session(),
      session({ id: "orphan-z", projectDir: "/z" }),
      session({ id: "orphan-a", projectDir: "/a" }),
      session({ id: "human", spawnedBy: "user", projectDir: "/human" }),
    ];
    expect(orphanMissionSessionIds(projection(), records, sessions))
      .toEqual(["orphan-a", "orphan-z"]);
  });

  it("treats a terminal attempt's persisted worker as orphaned", () => {
    expect(orphanMissionSessionIds(projection("succeeded"), [spawn()], [session()]))
      .toEqual(["session-1"]);
  });
});
