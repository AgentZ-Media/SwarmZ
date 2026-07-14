import { describe, expect, it } from "vitest";
import {
  MissionInvariantError,
  emptyMissionProjection,
  missionCommandFingerprint,
  reduceMissionEvent,
  replayMissionEvents,
} from "./core";
import type {
  MissionEvent,
  MissionEventPayload,
  MissionTaskInput,
} from "./types";

const policy = {
  maxParallelAttempts: 8,
  stopOnCriticalFailure: true,
  requireQualityGates: true,
  integrationMode: "manual" as const,
  archiveCompletedWorkers: true,
};
const budget = {
  maxAttemptsTotal: null,
  maxActiveMinutes: null,
  maxTokens: null,
  maxCostUsd: null,
};

function eventBuilder(missionId = "mission-1") {
  let revision = 0;
  let id = 0;
  return (payload: MissionEventPayload, overrides: Partial<MissionEvent> = {}) => ({
    ...payload,
    eventId: `event-${++id}`,
    missionId,
    revision: ++revision,
    occurredAt: revision * 10,
    actor: "system" as const,
    ...overrides,
  }) as MissionEvent;
}

function created(build: ReturnType<typeof eventBuilder>): MissionEvent {
  return build({
    type: "mission.created",
    data: {
      projectId: "project-1",
      title: "Ship Mission Control",
      objective: "Complete all durable mission work",
      policy,
      budget,
      createdAt: 1,
    },
  });
}

function task(id: string, dependencyIds: string[] = [], maxAttempts = 2): MissionTaskInput {
  return {
    id,
    missionId: "mission-1",
    title: `Task ${id}`,
    description: `Implement ${id}`,
    priority: 50,
    role: "engineer",
    risk: "medium",
    acceptanceCriteria: ["tests pass"],
    root: { projectId: "project-1", path: "/repo" },
    worktreePolicy: { mode: "new" },
    dependencyIds,
    declaredFiles: [`src/${id}.ts`],
    declaredGlobs: [],
    maxAttempts,
    createdAt: 2,
  };
}

describe("mission event reducer", () => {
  it("keeps train-mode work active until every root integration train completes", () => {
    const build = eventBuilder();
    let state = reduceMissionEvent(emptyMissionProjection(), build({
      type: "mission.created",
      data: {
        projectId: "project-1", title: "Train", objective: "Integrate",
        policy: { ...policy, integrationMode: "train" }, budget, createdAt: 1,
      },
    }));
    state = reduceMissionEvent(state, build({ type: "task.added", data: task("task-1") }));
    state = reduceMissionEvent(state, build({ type: "mission.activated", data: { activatedAt: 20 } }));
    state = reduceMissionEvent(state, build({ type: "attempt.started", data: { id: "attempt-1", taskId: "task-1", startedAt: 30 } }));
    state = reduceMissionEvent(state, build({ type: "attempt.finished", data: { attemptId: "attempt-1", status: "succeeded", finishedAt: 40 } }));
    expect(state.missions["mission-1"].status).toBe("active");
    state = reduceMissionEvent(state, build({
      type: "integration_train.created",
      data: {
        id: "train-1", missionId: "mission-1", baseBranch: "main",
        integrationBranch: "swarmz/integration/one", status: "open",
        entries: [{ taskId: "task-1", position: 0, status: "queued", commit: null, detail: null }],
        createdAt: 50, updatedAt: 50,
      },
    }));
    expect(state.missions["mission-1"].status).toBe("active");
    state = reduceMissionEvent(state, build({
      type: "integration_train.updated",
      data: {
        trainId: "train-1", status: "completed",
        entries: [{ taskId: "task-1", position: 0, status: "integrated", commit: "a".repeat(40), detail: "verified" }],
        updatedAt: 60,
      },
    }));
    expect(state.missions["mission-1"].status).toBe("succeeded");
  });
  it("derives draft, active and explicit activated status", () => {
    const build = eventBuilder();
    let state = reduceMissionEvent(emptyMissionProjection(), created(build));
    expect(state.missions["mission-1"].status).toBe("draft");
    state = reduceMissionEvent(state, build({
      type: "mission.activated",
      data: { activatedAt: 20 },
    }));
    expect(state.missions["mission-1"].status).toBe("active");
  });

  it("replays a 60-task dependency chain and unlocks it in order", () => {
    const build = eventBuilder();
    const events: MissionEvent[] = [created(build)];
    for (let index = 0; index < 60; index += 1) {
      events.push(build({
        type: "task.added",
        data: task(`task-${index}`, index ? [`task-${index - 1}`] : []),
      }));
    }
    let state = replayMissionEvents(events);
    expect(Object.keys(state.tasks)).toHaveLength(60);
    expect(Object.keys(state.dependencies)).toHaveLength(59);
    expect(state.tasks["task-0"].status).toBe("ready");
    expect(state.tasks["task-59"].status).toBe("blocked_by_dependency");

    for (let index = 0; index < 60; index += 1) {
      const attemptId = `attempt-${index}`;
      state = reduceMissionEvent(state, build({
        type: "attempt.started",
        data: { id: attemptId, taskId: `task-${index}`, startedAt: 1_000 + index },
      }));
      state = reduceMissionEvent(state, build({
        type: "attempt.finished",
        data: { attemptId, status: "succeeded", finishedAt: 2_000 + index },
      }));
      expect(state.tasks[`task-${index}`].status).toBe("succeeded");
      if (index < 59) expect(state.tasks[`task-${index + 1}`].status).toBe("ready");
    }
    expect(state.missions["mission-1"].status).toBe("succeeded");
  });

  it("rejects dependency cycles atomically", () => {
    const build = eventBuilder();
    let state = replayMissionEvents([
      created(build),
      build({ type: "task.added", data: task("a") }),
      build({ type: "task.added", data: task("b", ["a"]) }),
    ]);
    const before = state;
    expect(() => {
      state = reduceMissionEvent(state, build({
        type: "task.updated",
        data: { taskId: "a", updatedAt: 99, patch: { dependencyIds: ["b"] } },
      }));
    }).toThrow(/cycle/);
    expect(state).toBe(before);
    expect(state.tasks.a.dependencyIds).toEqual([]);
  });

  it("rejects missing dependencies and duplicate dependency edges", () => {
    const build = eventBuilder();
    const state = replayMissionEvents([created(build)]);
    expect(() => reduceMissionEvent(state, build({
      type: "task.added",
      data: task("a", ["missing"]),
    }))).toThrow(/unknown task dependency/);
  });

  it("rejects stale and skipped revisions", () => {
    const build = eventBuilder();
    const first = created(build);
    const state = replayMissionEvents([first]);
    expect(() => reduceMissionEvent(state, {
      ...build({ type: "mission.paused", data: { pausedAt: 30 } }),
      revision: 1,
    })).toThrow(/stale mission revision/);
    expect(() => reduceMissionEvent(state, {
      ...build({ type: "mission.paused", data: { pausedAt: 30 } }),
      revision: 5,
    })).toThrow(/expected 2/);
  });

  it("deduplicates exact event and command retries but rejects conflicts", () => {
    const build = eventBuilder();
    const first = created(build);
    const state = replayMissionEvents([first]);
    expect(reduceMissionEvent(state, first)).toBe(state);

    const pause = build(
      { type: "mission.paused", data: { pausedAt: 20 } },
      { idempotencyKey: "pause-command" },
    );
    const paused = reduceMissionEvent(state, pause);
    expect(reduceMissionEvent(paused, {
      ...pause,
      eventId: "retry-event",
      revision: pause.revision + 99,
      occurredAt: pause.occurredAt + 9_999,
    })).toBe(paused);
    expect(() => reduceMissionEvent(paused, {
      ...pause,
      eventId: "conflict-event",
      data: { pausedAt: 99 },
    } as MissionEvent)).toThrow(/idempotency key conflict/);
  });

  it("canonicalizes command payload keys while excluding retry transport metadata", () => {
    const build = eventBuilder();
    const original = build({ type: "mission.paused", data: { pausedAt: 20 } });
    const retry = {
      ...original,
      eventId: "retry-transport",
      revision: 99,
      occurredAt: 123_456,
      data: Object.fromEntries(Object.entries(original.data).reverse()),
    } as MissionEvent;
    expect(missionCommandFingerprint(retry)).toBe(missionCommandFingerprint(original));
    const changed = {
      ...retry,
      type: "mission.paused",
      data: { pausedAt: 21 },
    } as MissionEvent;
    expect(missionCommandFingerprint(changed)).not.toBe(missionCommandFingerprint(original));
  });

  it("keeps terminal attempts immutable and retries as a new attempt", () => {
    const build = eventBuilder();
    let state = replayMissionEvents([
      created(build),
      build({ type: "task.added", data: task("task-1", [], 2) }),
      build({ type: "attempt.started", data: { id: "try-1", taskId: "task-1", startedAt: 30 } }),
      build({ type: "attempt.finished", data: { attemptId: "try-1", status: "failed", finishedAt: 40 } }),
    ]);
    expect(state.tasks["task-1"].status).toBe("ready");
    expect(() => reduceMissionEvent(state, build({
      type: "attempt.finished",
      data: { attemptId: "try-1", status: "succeeded", finishedAt: 50 },
    }))).toThrow(/immutable/);
    state = reduceMissionEvent(state, build({
      type: "attempt.started",
      data: { id: "try-2", taskId: "task-1", startedAt: 50 },
    }, { revision: 5 }));
    state = reduceMissionEvent(state, build({
      type: "attempt.finished",
      data: { attemptId: "try-2", status: "failed", finishedAt: 60 },
    }, { revision: 6 }));
    expect(state.tasks["task-1"].attemptIds).toEqual(["try-1", "try-2"]);
    expect(state.tasks["task-1"].status).toBe("failed");
    expect(state.attempts["try-1"].status).toBe("failed");
  });

  it("requires a human-bound requeue before retrying a needs-human task", () => {
    const build = eventBuilder();
    let state = replayMissionEvents([
      created(build),
      build({ type: "task.added", data: task("task-1", [], 3) }),
      build({ type: "attempt.started", data: { id: "try-1", taskId: "task-1", startedAt: 30 } }),
      build({
        type: "attempt.finished",
        data: { attemptId: "try-1", status: "needs_human", finishedAt: 40, summary: "Choose an API" },
      }),
    ]);
    expect(state.tasks["task-1"].status).toBe("needs_human");
    const requeue = build({
      type: "task.requeued",
      data: { taskId: "task-1", afterAttemptId: "try-1", instruction: "Use API B", requeuedAt: 50 },
    });
    expect(() => reduceMissionEvent(state, requeue)).toThrow(/only a human/);
    state = reduceMissionEvent(state, { ...requeue, actor: "human" });
    expect(state.tasks["task-1"]).toMatchObject({
      status: "ready",
      resumeInstruction: "Use API B",
      requeuedAfterAttemptId: "try-1",
    });
    state = reduceMissionEvent(state, build({
      type: "attempt.started",
      data: { id: "try-2", taskId: "task-1", startedAt: 60 },
    }));
    expect(state.attempts["try-2"].resumeInstruction).toBe("Use API B");
    expect(state.tasks["task-1"]).toMatchObject({
      status: "running",
      resumeInstruction: null,
      requeuedAfterAttemptId: null,
    });
  });

  it("blocks successful attempts on required quality gates", () => {
    const build = eventBuilder();
    let state = replayMissionEvents([
      created(build),
      build({ type: "task.added", data: task("task-1") }),
      build({
        type: "quality_gate.added",
        data: {
          id: "gate-1",
          missionId: "mission-1",
          taskId: "task-1",
          kind: "unit_tests",
          label: "Unit tests",
          command: "pnpm test",
          required: true,
          createdAt: 30,
        },
      }),
      build({ type: "attempt.started", data: { id: "try-1", taskId: "task-1", startedAt: 40 } }),
      build({ type: "attempt.finished", data: { attemptId: "try-1", status: "succeeded", finishedAt: 50 } }),
    ]);
    expect(state.tasks["task-1"].status).toBe("blocked");
    state = reduceMissionEvent(state, build({
      type: "quality_gate.resulted",
      data: { gateId: "gate-1", status: "passed", updatedAt: 60 },
    }));
    expect(state.tasks["task-1"].status).toBe("succeeded");
  });

  it("retains archived missions, tasks, attempts and artifacts", () => {
    const build = eventBuilder();
    let state = replayMissionEvents([
      created(build),
      build({ type: "task.added", data: task("task-1") }),
      build({ type: "attempt.started", data: { id: "try-1", taskId: "task-1", startedAt: 30 } }),
      build({
        type: "artifact.recorded",
        data: {
          id: "artifact-1",
          missionId: "mission-1",
          taskId: "task-1",
          attemptId: "try-1",
          kind: "commit",
          label: "implementation",
          uri: "git:abc123",
          metadata: {},
          createdAt: 45,
        },
      }),
      build({ type: "attempt.finished", data: { attemptId: "try-1", status: "succeeded", finishedAt: 50 } }),
    ]);
    state = reduceMissionEvent(state, build({ type: "mission.archived", data: { archivedAt: 60 } }));
    expect(state.missions["mission-1"].status).toBe("archived");
    expect(state.tasks["task-1"]).toBeTruthy();
    expect(state.attempts["try-1"]).toBeTruthy();
    expect(state.artifacts["artifact-1"]).toBeTruthy();
    expect(() => reduceMissionEvent(state, build({ type: "mission.resumed", data: { resumedAt: 60 } })))
      .toThrow(/archived missions are immutable/);
  });

  it("pauses and resumes missions and tasks durably", () => {
    const build = eventBuilder();
    let state = replayMissionEvents([
      created(build),
      build({ type: "task.added", data: task("task-1") }),
      build({ type: "task.paused", data: { taskId: "task-1", pausedAt: 30 } }),
    ]);
    expect(state.tasks["task-1"].status).toBe("paused");
    state = reduceMissionEvent(state, build({ type: "task.resumed", data: { taskId: "task-1", resumedAt: 40 } }));
    expect(state.tasks["task-1"].status).toBe("ready");
    state = reduceMissionEvent(state, build({ type: "mission.paused", data: { pausedAt: 50 } }));
    expect(state.missions["mission-1"].status).toBe("paused");
    state = reduceMissionEvent(state, build({ type: "mission.resumed", data: { resumedAt: 60 } }));
    expect(state.missions["mission-1"].status).toBe("active");
  });

  it("never mutates a prior projection", () => {
    const build = eventBuilder();
    const before = replayMissionEvents([created(build)]);
    const after = reduceMissionEvent(before, build({ type: "task.added", data: task("task-1") }));
    expect(before.missions["mission-1"].taskIds).toEqual([]);
    expect(before.tasks["task-1"]).toBeUndefined();
    expect(after.missions["mission-1"].taskIds).toEqual(["task-1"]);
  });

  it("rejects invalid priorities, retry budgets and empty mission copy", () => {
    const build = eventBuilder();
    expect(() => replayMissionEvents([build({
      type: "mission.created",
      data: { projectId: "project-1", title: "", objective: "x", policy, budget, createdAt: 1 },
    })])).toThrow(MissionInvariantError);
    const state = replayMissionEvents([created(eventBuilder())]);
    const invalid = task("bad");
    invalid.priority = 101;
    const badBuild = eventBuilder();
    badBuild({ type: "mission.created", data: { projectId: "p", title: "x", objective: "x", policy, budget, createdAt: 1 } });
    expect(() => reduceMissionEvent(state, badBuild({ type: "task.added", data: invalid }))).toThrow(/priority/);
    const runtimeBuild = eventBuilder("runtime-mission");
    expect(() => replayMissionEvents([runtimeBuild({
      type: "mission.created",
      data: {
        projectId: "project-1", title: "Runtime", objective: "x", budget, createdAt: 1,
        policy: {
          ...policy,
          runtimeEnvironment: { environmentId: "local", specFingerprint: "not-a-digest" },
        },
      },
    })])).toThrow(/mission execution policy/);
  });
});
