import { describe, expect, it } from "vitest";
import { schedule } from "@/lib/scheduler/core";
import type { SchedulableTask } from "@/lib/scheduler/types";
import { emptyMissionProjection, reduceMissionEvent } from "./core";
import { approveMissionEnvelope, type MissionExecutionEnvelope } from "./envelope";
import type { MissionReportV2 } from "./report-v2";
import { planMissionStarts, planReportSettlement } from "./runner-core";
import type { MissionEvent, MissionEventPayload, MissionProjection } from "./types";

function buildProjection(count: number): MissionProjection {
  let state = emptyMissionProjection();
  let revision = 0;
  let eventId = 0;
  const apply = (payload: MissionEventPayload) => {
    const event = {
      ...payload,
      eventId: `event-${++eventId}`,
      missionId: "mission-1",
      revision: ++revision,
      occurredAt: revision,
      actor: "system",
    } as MissionEvent;
    state = reduceMissionEvent(state, event);
  };
  apply({
    type: "mission.created",
    data: {
      projectId: "project-1",
      title: "Mission",
      objective: "Ship a large app",
      policy: {
        maxParallelAttempts: 48,
        stopOnCriticalFailure: true,
        requireQualityGates: true,
        integrationMode: "train",
        archiveCompletedWorkers: true,
      },
      budget: {
        maxAttemptsTotal: null,
        maxActiveMinutes: null,
        maxTokens: null,
        maxCostUsd: null,
      },
      createdAt: 1,
    },
  });
  for (let index = 0; index < count; index += 1) {
    apply({
      type: "task.added",
      data: {
        id: `task-${index}`,
        missionId: "mission-1",
        title: `Task ${index}`,
        description: "Implement",
        priority: 100 - (index % 100),
        role: "engineer",
        risk: "medium",
        acceptanceCriteria: ["verified"],
        root: { projectId: "project-1", path: "/repo" },
        worktreePolicy: { mode: "new" },
        dependencyIds: [],
        declaredFiles: [`src/${index}.ts`],
        declaredGlobs: [],
        maxAttempts: 3,
        createdAt: index + 2,
      },
    });
  }
  return state;
}

function envelope(patch: Partial<MissionExecutionEnvelope> = {}): MissionExecutionEnvelope {
  const draft: MissionExecutionEnvelope = {
    id: "envelope-1",
    missionId: "mission-1",
    revision: 1,
    issuedAt: 1,
    expiresAt: null,
    limits: {
      maxTasks: 50,
      maxAttempts: 100,
      maxTokens: 1_000_000,
      maxActiveMs: 1_000_000,
      maxCostUsd: 100,
      maxParallel: 5,
    },
    capabilities: {
      allowedTools: ["edit_file", "test"],
      allowedRoots: ["/repo"],
      network: "deny",
      github: "deny",
    },
    stopPolicy: {
      regression: "needs_human",
      conflict: "pause_mission",
      criticalFailure: "cancel_mission",
    },
    approval: null,
    ...patch,
  };
  if (patch.approval === null) return draft;
  return approveMissionEnvelope(draft, {
    approvalId: "approval-1",
    envelopeRevision: draft.revision,
    approvedAt: 2,
    approvedBy: "human",
  });
}

const zeroUsage = {
  tasksStarted: 0,
  attemptsStarted: 0,
  tokensUsed: 0,
  activeMs: 0,
  costUsd: 0,
  activeAttempts: 0,
};

function schedulerFor(projection: MissionProjection) {
  const tasks: SchedulableTask[] = Object.values(projection.tasks).map((task) => ({
    task,
    enqueuedAt: task.createdAt,
    worktreePath: `/repo/.worktrees/${task.id}`,
  }));
  return schedule({
    tasks,
    activeLeases: [],
    backendActiveCount: 0,
    now: 1_000,
    limits: {
      globalConcurrency: 64,
      perProjectConcurrency: 64,
      perMissionConcurrency: 64,
      hardBackendCap: 64,
      agingIntervalMs: 1_000,
    },
  });
}

describe("mission runner core", () => {
  it("bounds a real 50-task scheduler wave by the approved parallel envelope", () => {
    const projection = buildProjection(50);
    const scheduler = schedulerFor(projection);
    expect(scheduler.starts).toHaveLength(50);
    const plan = planMissionStarts({
      projection,
      scheduler,
      envelope: envelope(),
      usage: zeroUsage,
      now: 1_000,
      breakerOpen: false,
      completedOperationIds: new Set(),
    });
    expect(plan.commands).toHaveLength(5);
    expect(plan.rejected).toHaveLength(45);
    expect(plan.rejected.every((item) => item.code === "parallel_limit")).toBe(true);
    expect(plan.projectedUsage).toMatchObject({
      tasksStarted: 5,
      attemptsStarted: 5,
      activeAttempts: 5,
    });
  });

  it("always declares a fresh temporary one-assignment worker with no persona or memory", () => {
    const projection = buildProjection(1);
    const plan = planMissionStarts({
      projection,
      scheduler: schedulerFor(projection),
      envelope: envelope(),
      usage: zeroUsage,
      now: 100,
      breakerOpen: false,
      completedOperationIds: new Set(),
    });
    expect(plan.commands[0].worker).toEqual({
      lifecycle: "temporary_one_assignment",
      assignmentTaskId: "task-0",
      resumeExistingSession: false,
      durableMemory: false,
      persona: false,
      workspaceOnly: true,
      closeAfterTerminalReport: true,
      label: "Task task-0 · attempt 1",
    });
  });

  it("is replay-idempotent through deterministic operation and attempt ids", () => {
    const projection = buildProjection(1);
    const base = {
      projection,
      scheduler: schedulerFor(projection),
      envelope: envelope(),
      usage: zeroUsage,
      now: 100,
      breakerOpen: false,
    };
    const first = planMissionStarts({ ...base, completedOperationIds: new Set() });
    const replay = planMissionStarts({
      ...base,
      completedOperationIds: new Set([first.commands[0].operationId]),
    });
    expect(replay.commands).toEqual([]);
    expect(replay.rejected[0].code).toBe("already_dispatched");
  });

  it("deduplicates a malformed scheduler decision inside the same plan", () => {
    const projection = buildProjection(1);
    const selected = schedulerFor(projection).starts[0];
    const plan = planMissionStarts({
      projection,
      scheduler: { starts: [selected, selected] },
      envelope: envelope(),
      usage: zeroUsage,
      now: 100,
      breakerOpen: false,
      completedOperationIds: new Set(),
    });
    expect(plan.commands).toHaveLength(1);
    expect(plan.rejected).toEqual([expect.objectContaining({ code: "already_dispatched" })]);
  });

  it("fails closed when approval, breaker or capability authority is missing", () => {
    const projection = buildProjection(1);
    const scheduler = schedulerFor(projection);
    const base = {
      projection,
      scheduler,
      usage: zeroUsage,
      now: 100,
      completedOperationIds: new Set<string>(),
    };
    expect(planMissionStarts({
      ...base,
      envelope: envelope({ approval: null }),
      breakerOpen: false,
    }).rejected[0].code).toBe("approval_required");
    expect(planMissionStarts({
      ...base,
      envelope: envelope(),
      breakerOpen: true,
    }).rejected[0].code).toBe("breaker_open");
    expect(planMissionStarts({
      ...base,
      envelope: envelope(),
      breakerOpen: false,
      capabilitiesForTask: () => ({ tools: ["shell"] }),
    }).rejected[0].code).toBe("tool_denied");
  });

  it("settles success only when report identity and external evidence are verified", () => {
    let projection = buildProjection(1);
    const start = planMissionStarts({
      projection,
      scheduler: schedulerFor(projection),
      envelope: envelope(),
      usage: zeroUsage,
      now: 100,
      breakerOpen: false,
      completedOperationIds: new Set(),
    }).commands[0];
    projection = reduceMissionEvent(projection, {
      eventId: "attempt-start-event",
      missionId: "mission-1",
      revision: projection.missions["mission-1"].revision + 1,
      occurredAt: 100,
      actor: "scheduler",
      type: "attempt.started",
      data: { id: start.attemptId, taskId: start.taskId, startedAt: 100 },
    });
    const report: MissionReportV2 = {
      version: 2,
      missionId: "mission-1",
      taskId: "task-0",
      attemptId: start.attemptId,
      status: "succeeded",
      summary: "done",
      evidence: { baseSha: "a".repeat(40), headSha: "b".repeat(40), diffSha256: null },
      filesChanged: [],
      commands: [],
      artifacts: [],
      question: null,
    };
    expect(planReportSettlement({
      projection,
      report,
      observation: null,
      finishedAt: 200,
      operationId: "settle-1",
      completedOperationIds: new Set(),
    })).toMatchObject({ ok: false, code: "success_unverified" });

    expect(planReportSettlement({
      projection,
      report,
      observation: {
        headSha: "b".repeat(40),
        baseSha: "a".repeat(40),
        commands: {},
      },
      finishedAt: 200,
      operationId: "settle-1",
      completedOperationIds: new Set(),
    })).toMatchObject({
      ok: true,
      event: { type: "attempt.finished", data: { status: "succeeded" } },
    });
  });
});
