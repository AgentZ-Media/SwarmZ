import { describe, expect, it } from "vitest";
import { emptyMissionProjection, reduceMissionEvent } from "./core";
import {
  deriveApprovedMissionScope,
  deterministicMissionBranch,
  envelopeFromApprovedScope,
  missionAttemptPrompt,
  predictedWorktreePath,
  taskIsInsideApprovedScope,
  verifiedGateResults,
  workerOutcomeDisposition,
  exactPromptTurnId,
  missionTurnEvidence,
  missionHardStopReason,
  taskHasSafeMissionPlacement,
  unexpectedChangedFiles,
} from "./controller-core";
import type { MissionEvent, MissionEventPayload, MissionProjection } from "./types";

function history() {
  let projection = emptyMissionProjection();
  const events: MissionEvent[] = [];
  let revision = 0;
  const apply = (payload: MissionEventPayload, actor: MissionEvent["actor"] = "human") => {
    const event = {
      ...payload,
      eventId: `event-${revision + 1}`,
      missionId: "mission-1",
      revision: ++revision,
      occurredAt: revision * 10,
      actor,
    } as MissionEvent;
    projection = reduceMissionEvent(projection, event);
    events.push(event);
    return event;
  };
  apply({
    type: "mission.created",
    data: {
      projectId: "project-1",
      title: "Mission",
      objective: "Ship",
      policy: {
        maxParallelAttempts: 12,
        stopOnCriticalFailure: true,
        requireQualityGates: true,
        integrationMode: "train",
        archiveCompletedWorkers: true,
        networkAuthority: "deny",
        githubAuthority: "deny",
        allowedTools: ["workspace_sandbox"],
        qualityCommands: ["pnpm test"],
        stopOnRegression: "needs_human",
        stopOnConflict: "pause_mission",
      },
      budget: { maxAttemptsTotal: 10, maxActiveMinutes: 30, maxTokens: 100_000, maxCostUsd: null },
      createdAt: 1,
    },
  });
  apply({
    type: "task.added",
    data: {
      id: "task-1",
      missionId: "mission-1",
      title: "Implement",
      description: "Do it",
      priority: 80,
      role: "engineer",
      risk: "medium",
      acceptanceCriteria: ["green"],
      root: { projectId: "project-1", path: "/repo" },
      worktreePolicy: { mode: "new" },
      dependencyIds: [],
      declaredFiles: ["src/a.ts"],
      declaredGlobs: [],
      maxAttempts: 3,
      createdAt: 2,
    },
  });
  return {
    events,
    apply,
    projection: () => projection as MissionProjection,
  };
}

describe("mission controller pure authority helpers", () => {
  it("enforces declared file and glob scope only when a scope exists", () => {
    expect(unexpectedChangedFiles(
      { declaredFiles: ["src/main.ts"], declaredGlobs: ["tests/**/*.test.ts"] },
      ["src/main.ts", "tests/unit/a.test.ts", "README.md"],
    )).toEqual(["README.md"]);
    expect(unexpectedChangedFiles(
      { declaredFiles: [], declaredGlobs: [] },
      ["anything/is/advisory.ts"],
    )).toEqual([]);
  });
  it("authorizes exactly the latest human activate/resume snapshot", () => {
    const state = history();
    state.apply({ type: "mission.activated", data: { activatedAt: 30 } });
    const scope = deriveApprovedMissionScope(state.events, "mission-1")!;
    expect(scope.approvalRevision).toBe(3);
    expect(taskIsInsideApprovedScope(scope, state.projection().tasks["task-1"])).toBe(true);

    state.apply({
      type: "task.updated",
      data: { taskId: "task-1", updatedAt: 40, patch: { description: "Expanded secretly" } },
    }, "orchestrator");
    expect(taskIsInsideApprovedScope(scope, state.projection().tasks["task-1"])).toBe(false);
  });

  it("does not authorize tasks added after activation until a new human activation", () => {
    const state = history();
    state.apply({ type: "mission.activated", data: { activatedAt: 30 } });
    state.apply({
      type: "task.added",
      data: {
        id: "task-2",
        missionId: "mission-1",
        title: "Later",
        description: "Not approved yet",
        priority: 50,
        role: "engineer",
        risk: "low",
        acceptanceCriteria: ["done"],
        root: { projectId: "project-1", path: "/repo" },
        worktreePolicy: { mode: "new" },
        dependencyIds: [],
        declaredFiles: [],
        declaredGlobs: [],
        maxAttempts: 2,
        createdAt: 40,
      },
    }, "orchestrator");
    const oldScope = deriveApprovedMissionScope(state.events, "mission-1")!;
    expect(oldScope.tasks["task-2"]).toBeUndefined();
    state.apply({ type: "mission.activated", data: { activatedAt: 50 } });
    expect(deriveApprovedMissionScope(state.events, "mission-1")?.tasks["task-2"]).toBeTruthy();
  });

  it("derives fail-closed policy and clamps adaptive concurrency to eight", () => {
    const state = history();
    state.apply({ type: "mission.activated", data: { activatedAt: 30 } });
    const envelope = envelopeFromApprovedScope(
      deriveApprovedMissionScope(state.events, "mission-1")!,
    )!;
    expect(envelope).toMatchObject({
      revision: 3,
      limits: { maxParallel: 8, maxTokens: 100_000, maxActiveMs: 1_800_000 },
      capabilities: { network: "deny", github: "deny" },
      stopPolicy: { regression: "needs_human", conflict: "pause_mission" },
      approval: { approvalId: "event-3", approvedBy: "human" },
    });
  });

  it("refuses runtime authorities the workspace-only harness cannot grant", () => {
    const state = history();
    state.apply({ type: "mission.activated", data: { activatedAt: 30 } });
    const scope = deriveApprovedMissionScope(state.events, "mission-1")!;
    expect(envelopeFromApprovedScope({
      ...scope,
      mission: {
        ...scope.mission,
        policy: { ...scope.mission.policy, networkAuthority: "allow" },
      },
    })).toBeNull();
  });

  it("uses stable deterministic branches and predicted worktree paths", () => {
    const branch = deterministicMissionBranch("mission-1", "task/unsafe", 2);
    expect(branch).toMatch(/^swarmz\/mission-[a-z0-9]+-task-unsafe-a2$/);
    expect(predictedWorktreePath("/repo/", branch)).toBe(`/repo/.worktrees/${branch.split("/")[1]}`);
    expect(deterministicMissionBranch("mission-1", "task/unsafe", 2)).toBe(branch);
  });

  it("carries a human retry instruction into the fresh worker prompt", () => {
    const state = history();
    state.apply({ type: "mission.activated", data: { activatedAt: 30 } });
    state.apply({ type: "attempt.started", data: { id: "attempt-1", taskId: "task-1", startedAt: 40 } }, "scheduler");
    state.apply({ type: "attempt.finished", data: { attemptId: "attempt-1", status: "needs_human", finishedAt: 50 } }, "system");
    state.apply({
      type: "task.requeued",
      data: {
        taskId: "task-1",
        afterAttemptId: "attempt-1",
        instruction: "Use API version two",
        requeuedAt: 60,
      },
    });
    state.apply({ type: "mission.activated", data: { activatedAt: 70 } });
    const task = state.projection().tasks["task-1"];
    expect(task.status).toBe("ready");
    expect(missionAttemptPrompt(task, "attempt-2")).toContain("Use API version two");
    const scope = deriveApprovedMissionScope(state.events, "mission-1")!;
    state.apply({ type: "attempt.started", data: { id: "attempt-2", taskId: "task-1", startedAt: 80 } }, "scheduler");
    expect(state.projection().attempts["attempt-2"].resumeInstruction).toBe("Use API version two");
    expect(state.projection().tasks["task-1"].resumeInstruction).toBeNull();
    expect(taskIsInsideApprovedScope(scope, state.projection().tasks["task-1"])).toBe(true);
  });

  it("validates every required gate before returning any passed result", () => {
    const gate = (id: string, command: string) => ({
      id,
      missionId: "mission-1",
      taskId: "task-1",
      kind: "unit_tests" as const,
      label: id,
      command,
      required: true,
      status: "pending" as const,
      details: null,
      artifactIds: [],
      createdAt: 1,
      updatedAt: 1,
    });
    const gates = [gate("gate-1", "first"), gate("gate-2", "second")];
    expect(() => verifiedGateResults(gates, { first: 0, second: 1 }))
      .toThrow(/second/);
    expect(gates.map((gate) => gate.status)).toEqual(["pending", "pending"]);
    expect(verifiedGateResults(gates, { first: 0, second: 0 }))
      .toEqual([
        expect.objectContaining({ gateId: "gate-1", status: "passed" }),
        expect.objectContaining({ gateId: "gate-2", status: "passed" }),
      ]);
  });

  it("never inspects a success report after a failed, exited or interrupted turn", () => {
    expect(workerOutcomeDisposition("failed")).toBe("failed");
    expect(workerOutcomeDisposition("exited")).toBe("failed");
    expect(workerOutcomeDisposition("interrupted")).toBe("cancelled");
    expect(workerOutcomeDisposition("completed")).toBe("inspect_report");
  });

  it("binds prompt, report and command evidence to exactly one durable turn", () => {
    const items = {
      prompt: { id: "prompt", at: 1, kind: "user" as const, text: "Do it", turnId: "turn-1" },
      command1: { id: "command1", at: 2, kind: "command" as const, command: "test", status: "completed", exitCode: 0, output: "", turnId: "turn-1" },
      report1: { id: "report1", at: 3, kind: "assistant" as const, text: "bound", report: true, turnId: "turn-1" },
      command2: { id: "command2", at: 4, kind: "command" as const, command: "test", status: "completed", exitCode: 1, output: "", turnId: "turn-2" },
      report2: { id: "report2", at: 5, kind: "assistant" as const, text: "foreign", report: true, turnId: "turn-2" },
    };
    const order = Object.keys(items);
    expect(exactPromptTurnId(order, items, "Do it")).toBe("turn-1");
    expect(missionTurnEvidence(order, items, "turn-1")).toEqual({
      assistantText: "bound",
      reportStamped: true,
      commands: { test: 0 },
    });
  });

  it("stops active work when a hard budget or breaker trips", () => {
    const state = history();
    state.apply({ type: "mission.activated", data: { activatedAt: 30 } });
    const envelope = envelopeFromApprovedScope(deriveApprovedMissionScope(state.events, "mission-1")!)!;
    const usage = { tasksStarted: 1, attemptsStarted: 1, tokensUsed: 100_000, activeMs: 1, costUsd: 0, activeAttempts: 1 };
    expect(missionHardStopReason(envelope, usage, false)).toMatch(/token/);
    expect(missionHardStopReason(envelope, { ...usage, tokensUsed: 0 }, true)).toMatch(/breaker/);
  });

  it("refuses main-checkout and integration-branch worker placement", () => {
    const task = history().projection().tasks["task-1"];
    expect(taskHasSafeMissionPlacement({ ...task, worktreePolicy: { mode: "none" } })).toBe(false);
    expect(taskHasSafeMissionPlacement({ ...task, worktreePolicy: { mode: "integration" } })).toBe(false);
    expect(taskHasSafeMissionPlacement({ ...task, worktreePolicy: { mode: "new" } })).toBe(true);
  });
});
