import { describe, expect, it } from "vitest";
import { emptyMissionProjection } from "@/lib/missions/core";
import type {
  Mission,
  MissionTask,
  QualityGate,
  TaskAttempt,
} from "@/lib/missions/types";
import type { UsageHistoryEntry } from "@/types";
import { buildMissionInsightsSnapshot } from "./MissionInsightsPanel";

function mission(): Mission {
  return {
    id: "mission-1",
    projectId: "project-1",
    title: "Ship insights",
    objective: "Verify telemetry",
    status: "active",
    taskIds: ["task-1"],
    integrationTrainIds: [],
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
    createdAt: 1,
    updatedAt: 2,
    archivedAt: null,
    cancelledAt: null,
    pausedAt: null,
    activatedAt: 1,
    revision: 1,
  };
}

function task(status: MissionTask["status"] = "succeeded"): MissionTask {
  return {
    id: "task-1",
    missionId: "mission-1",
    title: "Build telemetry",
    description: "",
    status,
    priority: 50,
    role: "implementer",
    risk: "medium",
    acceptanceCriteria: ["Telemetry is real."],
    root: { projectId: "project-1", path: "/repo" },
    worktreePolicy: { mode: "none" },
    dependencyIds: [],
    declaredFiles: [],
    declaredGlobs: [],
    maxAttempts: 3,
    attemptIds: ["attempt-1", "attempt-2"],
    qualityGateIds: [],
    artifactIds: [],
    createdAt: 1,
    updatedAt: 2,
    archivedAt: null,
    pausedAt: null,
    resumeInstruction: null,
    requeuedAfterAttemptId: null,
  };
}

function attempt(id: string, sessionId: string, start: number): TaskAttempt {
  return {
    id,
    missionId: "mission-1",
    taskId: "task-1",
    ordinal: id === "attempt-1" ? 1 : 2,
    status: "succeeded",
    sessionId,
    workerLabel: null,
    startedAt: start,
    finishedAt: start + 60_000,
    summary: null,
    error: null,
    report: null,
    artifactIds: [],
  };
}

function usage(sessionId: string): UsageHistoryEntry {
  return {
    runtime: "codex",
    session_id: sessionId,
    agent_name: "worker",
    cwd: "/repo",
    started_at: 1,
    last_updated: 2,
    message_count: 1,
    input_tokens: 1_000,
    output_tokens: 200,
    cache_creation_tokens: 0,
    cache_read_tokens: 300,
    cost_usd: 0.25,
    by_model: [],
  };
}

describe("MissionInsightsPanel projection adapter", () => {
  it("uses real attempt durations and uniquely attributable session usage", () => {
    const projection = emptyMissionProjection();
    projection.missions["mission-1"] = mission();
    projection.tasks["task-1"] = task();
    projection.attempts["attempt-1"] = attempt("attempt-1", "session-1", 10);
    projection.attempts["attempt-2"] = attempt("attempt-2", "session-2", 100);
    const snapshot = buildMissionInsightsSnapshot("mission-1", projection, {
      one: usage("session-1"),
      two: usage("session-2"),
    });
    expect(snapshot?.insights.actual).toMatchObject({
      attempts: 2,
      retries: 1,
      tokensUsed: 3_000,
      costUsd: 0.5,
    });
    expect(snapshot?.trackedUsageSessions).toBe(2);
  });

  it("clusters failed gates by explicit stable kind, not error prose", () => {
    const projection = emptyMissionProjection();
    projection.missions["mission-1"] = mission();
    projection.tasks["task-1"] = {
      ...task("failed"),
      attemptIds: [],
      qualityGateIds: ["gate-1"],
    };
    projection.qualityGates["gate-1"] = {
      id: "gate-1",
      missionId: "mission-1",
      taskId: "task-1",
      kind: "unit_tests",
      label: "Unit tests",
      command: "pnpm test",
      required: true,
      status: "failed",
      details: "A long free-form error",
      artifactIds: [],
      createdAt: 1,
      updatedAt: 2,
    } satisfies QualityGate;
    const snapshot = buildMissionInsightsSnapshot("mission-1", projection, {});
    expect(snapshot?.insights.failureClusters[0]).toMatchObject({
      fingerprint: "gate:unit_tests",
      count: 1,
    });
  });

  it("returns null for a mission absent from the durable projection", () => {
    expect(
      buildMissionInsightsSnapshot("missing", emptyMissionProjection(), {}),
    ).toBeNull();
  });
});
