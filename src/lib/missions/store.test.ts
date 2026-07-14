import { beforeEach, describe, expect, it } from "vitest";
import { emptyMissionProjection } from "./core";
import { deriveApprovedMissionScope } from "./controller-core";
import { useMissions } from "./store";
import { useMissionOutbox } from "./outbox-store";
import {
  claimMissionCommandById,
  deliverMissionCommand,
  emptyMissionOutbox,
  enqueueMissionCommand,
} from "./outbox";
import type { AddMissionTaskInput } from "./store";

function task(id: string, dependencyIds: string[] = []): AddMissionTaskInput {
  return {
    id,
    title: id,
    description: `Implement ${id}`,
    priority: 50,
    role: "engineer",
    risk: "low",
    acceptanceCriteria: ["done"],
    root: { projectId: "project-1", path: "/repo" },
    worktreePolicy: { mode: "new" },
    dependencyIds,
    declaredFiles: [],
    declaredGlobs: [],
    maxAttempts: 2,
  };
}

describe("mission command store", () => {
  beforeEach(() => {
    useMissions.setState({
      projection: emptyMissionProjection(),
      events: [],
      hydrated: true,
      hydrateStatus: "ready",
      hydrateError: null,
    });
    useMissionOutbox.setState({
      snapshot: emptyMissionOutbox(),
      hydrateStatus: "ready",
      hydrateError: null,
    });
  });

  it("creates and explicitly activates a draft mission", () => {
    const store = useMissions.getState();
    const id = store.createMission({
      id: "mission-1",
      projectId: "project-1",
      title: "Mission",
      objective: "Ship it",
    }, { occurredAt: 10 });
    expect(useMissions.getState().projection.missions[id].status).toBe("draft");
    useMissions.getState().activateMission(id, { occurredAt: 20 });
    expect(useMissions.getState().projection.missions[id]).toMatchObject({
      status: "active",
      activatedAt: 20,
    });
  });

  it("creates, validates and activates a mission task batch atomically", () => {
    const result = useMissions.getState().createMissionWithTasks({
      id: "mission-atomic",
      projectId: "project-1",
      title: "Atomic mission",
      objective: "Never leave an empty draft",
    }, [task("leaf", ["root"]), task("root")], { occurredAt: 10 });
    expect(result).toEqual({ missionId: "mission-atomic", taskIds: ["leaf", "root"] });
    expect(useMissions.getState().projection.missions["mission-atomic"]).toMatchObject({
      status: "active",
      taskIds: ["root", "leaf"],
    });
    const before = useMissions.getState().events.length;
    expect(() => useMissions.getState().createMissionWithTasks({
      id: "mission-invalid",
      projectId: "project-1",
      title: "Invalid",
      objective: "Must roll back",
    }, [task("cycle-a", ["cycle-b"]), task("cycle-b", ["cycle-a"])]))
      .toThrow(/cyclic/);
    expect(useMissions.getState().events).toHaveLength(before);
    expect(useMissions.getState().projection.missions["mission-invalid"]).toBeUndefined();
  });

  it("validates mission title and objective before mutating the log", () => {
    expect(() => useMissions.getState().createMission({
      id: "mission-1",
      projectId: "project-1",
      title: "",
      objective: "Ship it",
    })).toThrow(/title/);
    expect(useMissions.getState().events).toEqual([]);
  });

  it("adds an arbitrarily ordered DAG batch atomically", () => {
    useMissions.getState().createMission({
      id: "mission-1",
      projectId: "project-1",
      title: "Mission",
      objective: "Ship it",
    });
    const ids = useMissions.getState().addTasks("mission-1", [
      task("leaf", ["middle"]),
      task("root"),
      task("middle", ["root"]),
    ]);
    expect(ids).toEqual(["leaf", "root", "middle"]);
    expect(useMissions.getState().projection.missions["mission-1"].taskIds)
      .toEqual(["root", "middle", "leaf"]);
    expect(useMissions.getState().projection.tasks.root.status).toBe("ready");
    expect(useMissions.getState().projection.tasks.leaf.status).toBe("blocked_by_dependency");
  });

  it("rejects a cyclic or unknown bulk DAG without appending a partial prefix", () => {
    useMissions.getState().createMission({
      id: "mission-1",
      projectId: "project-1",
      title: "Mission",
      objective: "Ship it",
    });
    const before = useMissions.getState().events.length;
    expect(() => useMissions.getState().addTasks("mission-1", [
      task("a", ["b"]),
      task("b", ["a"]),
    ])).toThrow(/cyclic/);
    expect(useMissions.getState().events).toHaveLength(before);
    expect(Object.keys(useMissions.getState().projection.tasks)).toEqual([]);
  });

  it("creates immutable attempt history through retry actions", () => {
    const state = useMissions.getState();
    state.createMission({ id: "mission-1", projectId: "project-1", title: "M", objective: "O" });
    useMissions.getState().addTask("mission-1", task("task-1"));
    const first = useMissions.getState().createAttempt("mission-1", "task-1", { id: "attempt-1" });
    useMissions.getState().settleAttempt("mission-1", first, { status: "failed", error: "red" });
    const second = useMissions.getState().createAttempt("mission-1", "task-1", { id: "attempt-2" });
    useMissions.getState().settleAttempt("mission-1", second, { status: "succeeded", summary: "green" });
    const projection = useMissions.getState().projection;
    expect(projection.tasks["task-1"].attemptIds).toEqual(["attempt-1", "attempt-2"]);
    expect(projection.attempts["attempt-1"]).toMatchObject({ status: "failed", error: "red" });
    expect(projection.attempts["attempt-2"]).toMatchObject({ status: "succeeded", summary: "green" });
  });

  it("durably pauses a running task and refuses archive until its attempt settles", () => {
    const state = useMissions.getState();
    state.createMission({ id: "mission-1", projectId: "project-1", title: "M", objective: "O" });
    state.addTask("mission-1", task("task-1"));
    state.createAttempt("mission-1", "task-1", { id: "attempt-1", sessionId: "session-1" }, { occurredAt: 10 });
    expect(useMissions.getState().projection.tasks["task-1"].status).toBe("running");
    state.pauseTask("mission-1", "task-1", { occurredAt: 20 });
    expect(useMissions.getState().projection.tasks["task-1"]).toMatchObject({
      status: "paused",
      pausedAt: 20,
    });
    expect(() => state.archiveTask("mission-1", "task-1", { occurredAt: 21 }))
      .toThrow(/running attempt/);
    state.settleAttempt("mission-1", "attempt-1", { status: "cancelled" }, { occurredAt: 22 });
    state.archiveTask("mission-1", "task-1", { occurredAt: 23 });
    expect(useMissions.getState().projection.tasks["task-1"].status).toBe("archived");
  });

  it("requeues a terminal intervention with an instruction for one fresh attempt", () => {
    const state = useMissions.getState();
    state.createMission({ id: "mission-1", projectId: "project-1", title: "M", objective: "O" });
    useMissions.getState().addTask("mission-1", task("task-1"));
    useMissions.getState().createAttempt("mission-1", "task-1", { id: "attempt-1" });
    useMissions.getState().settleAttempt("mission-1", "attempt-1", {
      status: "needs_human",
      summary: "Need a decision",
    });
    useMissions.getState().requeueTask(
      "mission-1",
      "task-1",
      "attempt-1",
      "Use the safe migration",
      undefined,
    );
    expect(useMissions.getState().projection.tasks["task-1"].status).toBe("ready");
    const events = useMissions.getState().events;
    expect(events.slice(-2).map((event) => [event.type, event.actor])).toEqual([
      ["task.requeued", "human"],
      ["mission.activated", "human"],
    ]);
    expect(deriveApprovedMissionScope(events, "mission-1")?.tasks["task-1"])
      .toMatchObject({ resumeInstruction: "Use the safe migration" });
    useMissions.getState().createAttempt("mission-1", "task-1", { id: "attempt-2" });
    expect(useMissions.getState().projection.attempts["attempt-2"].resumeInstruction)
      .toBe("Use the safe migration");
    expect(useMissions.getState().projection.tasks["task-1"].resumeInstruction).toBeNull();
  });

  it("requires an explicit atomic attempt-limit extension for an exhausted requeue", () => {
    const state = useMissions.getState();
    state.createMission({ id: "mission-1", projectId: "project-1", title: "M", objective: "O" });
    useMissions.getState().addTask("mission-1", { ...task("task-1"), maxAttempts: 1 });
    useMissions.getState().createAttempt("mission-1", "task-1", { id: "attempt-1" });
    useMissions.getState().settleAttempt("mission-1", "attempt-1", { status: "needs_human" });
    expect(() => useMissions.getState().requeueTask(
      "mission-1", "task-1", "attempt-1", "Retry",
    )).toThrow(/explicit attempt-limit extension/);
    useMissions.getState().requeueTask(
      "mission-1", "task-1", "attempt-1", "Retry", { extendAttemptLimit: true },
    );
    expect(useMissions.getState().projection.tasks["task-1"])
      .toMatchObject({ maxAttempts: 2, status: "ready" });
    expect(useMissions.getState().events.slice(-3).map((event) => event.type))
      .toEqual(["task.updated", "task.requeued", "mission.activated"]);
  });

  it("checkpoints delivered receipts into the immutable archive event batch", () => {
    const state = useMissions.getState();
    state.createMission({ id: "mission-1", projectId: "project-1", title: "M", objective: "O" });
    state.addTask("mission-1", task("task-1"));
    state.createAttempt("mission-1", "task-1", { id: "attempt-1" });
    state.settleAttempt("mission-1", "attempt-1", { status: "succeeded" });

    const queued = enqueueMissionCommand(
      emptyMissionOutbox(),
      {
        missionId: "mission-1",
        idempotencyKey: "settle:attempt-1",
        kind: "settle",
        payload: {
          taskId: "task-1",
          attemptId: "attempt-1",
          status: "succeeded",
          completionId: "completion-1",
        },
      },
      "outbox-1",
      10,
    ).snapshot;
    const claimed = claimMissionCommandById(
      queued,
      "outbox-1",
      "worker",
      "claim-1",
      11,
      5_000,
    ).snapshot;
    const delivered = deliverMissionCommand(
      claimed,
      "outbox-1",
      "claim-1",
      { completionId: "completion-1" },
      12,
    ).snapshot;
    useMissionOutbox.setState({ snapshot: delivered });

    state.archiveMission("mission-1", { occurredAt: 20 });
    const tail = useMissions.getState().events.slice(-2);
    expect(tail.map((event) => event.type)).toEqual([
      "artifact.recorded",
      "mission.archived",
    ]);
    const artifact = Object.values(useMissions.getState().projection.artifacts)
      .find((value) => value.label === "mission-outbox-audit");
    expect(artifact?.metadata).toMatchObject({
      archivedAt: 20,
      recordCount: 1,
      records: [{
        recordId: "outbox-1",
        completionId: "completion-1",
        status: "succeeded",
      }],
    });
    expect(useMissions.getState().projection.missions["mission-1"].status)
      .toBe("archived");
  });

  it("refuses to archive while durable outbox work is unsettled", () => {
    const state = useMissions.getState();
    state.createMission({ id: "mission-1", projectId: "project-1", title: "M", objective: "O" });
    const pending = enqueueMissionCommand(emptyMissionOutbox(), {
      missionId: "mission-1",
      idempotencyKey: "pending:1",
      kind: "settle",
      payload: {
        taskId: "task-1",
        attemptId: "attempt-1",
        status: "failed",
        completionId: "completion-1",
      },
    }, "pending-1", 10).snapshot;
    useMissionOutbox.setState({ snapshot: pending });
    expect(() => state.archiveMission("mission-1", { occurredAt: 20 }))
      .toThrow(/unsettled outbox operation/);
    expect(useMissions.getState().projection.missions["mission-1"].status).toBe("draft");
  });

  it("settles multiple quality gates in one event-log batch", () => {
    const state = useMissions.getState();
    state.createMission({ id: "mission-1", projectId: "project-1", title: "M", objective: "O" });
    useMissions.getState().addTask("mission-1", task("task-1"));
    for (const id of ["gate-1", "gate-2"]) {
      useMissions.getState().addQualityGate("mission-1", {
        id,
        taskId: "task-1",
        kind: "unit_tests",
        label: id,
        command: id,
        required: true,
      });
    }
    const before = useMissions.getState().events.length;
    useMissions.getState().settleQualityGates("mission-1", [
      { gateId: "gate-1", status: "passed" },
      { gateId: "gate-2", status: "passed" },
    ]);
    expect(useMissions.getState().events.slice(before).map((event) => event.type))
      .toEqual(["quality_gate.resulted", "quality_gate.resulted"]);
    expect(useMissions.getState().projection.qualityGates["gate-1"].status).toBe("passed");
    expect(useMissions.getState().projection.qualityGates["gate-2"].status).toBe("passed");
  });

  it("runs an artifact-backed candidate batch and requires an explicit ambiguous override", () => {
    const state = useMissions.getState();
    state.createMission({ id: "mission-1", projectId: "project-1", title: "M", objective: "O" });
    state.addTask("mission-1", { ...task("task-1"), maxAttempts: 4 });
    const batchId = state.requestCandidateBatch("mission-1", "task-1", {
      count: 2,
      instruction: "Compare two independent implementations",
      minimumScoreMargin: 10,
    });
    state.createAttempt("mission-1", "task-1", { id: "candidate-1", candidateBatchId: batchId });
    state.recordArtifact("mission-1", {
      id: "commit-1", taskId: "task-1", attemptId: "candidate-1", kind: "commit",
      label: "Verified commit", uri: `git:${"a".repeat(40)}`, metadata: { commit: "a".repeat(40) },
    });
    state.settleAttempt("mission-1", "candidate-1", { status: "succeeded" });
    state.createAttempt("mission-1", "task-1", { id: "candidate-2", candidateBatchId: batchId });
    state.recordArtifact("mission-1", {
      id: "commit-2", taskId: "task-1", attemptId: "candidate-2", kind: "commit",
      label: "Verified commit", uri: `git:${"b".repeat(40)}`, metadata: { commit: "b".repeat(40) },
    });
    state.settleAttempt("mission-1", "candidate-2", { status: "succeeded" });
    expect(useMissions.getState().projection.tasks["task-1"].status).toBe("needs_human");
    expect(() => state.selectCandidate("mission-1", batchId, "candidate-1")).toThrow(/unambiguous/);
    state.overrideCandidate("mission-1", batchId, "candidate-1", "Candidate one is safer because it preserves the public API.");
    expect(useMissions.getState().projection.tasks["task-1"]).toMatchObject({
      status: "succeeded",
      selectedCandidateAttemptId: "candidate-1",
    });
  });

  it("accepts only the selector's clear evidence winner", () => {
    const state = useMissions.getState();
    state.createMission({ id: "mission-1", projectId: "project-1", title: "M", objective: "O" });
    state.addTask("mission-1", { ...task("task-1"), maxAttempts: 4 });
    const batchId = state.requestCandidateBatch("mission-1", "task-1", { count: 2, instruction: "Compare" });
    for (const id of ["candidate-1", "candidate-2"]) {
      state.createAttempt("mission-1", "task-1", { id, candidateBatchId: batchId });
      state.recordArtifact("mission-1", {
        id: `commit-${id}`, taskId: "task-1", attemptId: id, kind: "commit",
        label: "Verified commit", uri: null, metadata: {
          authority: "swarmz_native", evidenceKind: "commit", commit: "a".repeat(40),
        },
      });
      if (id === "candidate-2") state.recordArtifact("mission-1", {
        id: "tests-2", taskId: "task-1", attemptId: id, kind: "test_result",
        label: "Independent tests", uri: null, metadata: {
          authority: "swarmz_native", evidenceKind: "test", exitCode: 0,
        },
      });
      state.settleAttempt("mission-1", id, { status: "succeeded" });
    }
    expect(() => state.selectCandidate("mission-1", batchId, "candidate-1")).toThrow(/evidence decision/);
    state.selectCandidate("mission-1", batchId, "candidate-2");
    expect(useMissions.getState().projection.candidateBatches[batchId].selectedAttemptId).toBe("candidate-2");
  });

  it("projects quality gates from the selected candidate, not the last finisher", () => {
    const state = useMissions.getState();
    state.createMission({ id: "mission-1", projectId: "project-1", title: "M", objective: "O" });
    state.addTask("mission-1", { ...task("task-1"), maxAttempts: 4 });
    state.addQualityGate("mission-1", {
      id: "gate-test", taskId: "task-1", kind: "unit_tests", label: "Unit tests",
      command: "pnpm test", required: true,
    });
    const batchId = state.requestCandidateBatch("mission-1", "task-1", { count: 2, instruction: "Compare" });
    for (const [id, score, status] of [
      ["candidate-a", 2, "passed"],
      ["candidate-b", 1, "failed"],
    ] as const) {
      state.createAttempt("mission-1", "task-1", { id, candidateBatchId: batchId });
      state.recordArtifact("mission-1", {
        id: `commit-${id}`, taskId: "task-1", attemptId: id, kind: "commit",
        label: "Verified commit", uri: null,
        metadata: { authority: "swarmz_native", evidenceKind: "commit", commit: id.padEnd(40, "a") },
      });
      state.recordArtifact("mission-1", {
        id: `test-${id}`, taskId: "task-1", attemptId: id, kind: "test_result",
        label: "Native acceptance", uri: null,
        metadata: { authority: "swarmz_native", evidenceKind: "test", command: "pnpm test", status, exitCode: status === "passed" ? 0 : 1 },
      });
      for (let index = 0; index < score; index++) state.recordArtifact("mission-1", {
        id: `extra-${id}-${index}`, taskId: "task-1", attemptId: id, kind: "diff",
        label: `Evidence ${index}`, uri: null,
        metadata: { authority: "swarmz_native", evidenceKind: "diff" },
      });
      state.settleAttempt("mission-1", id, { status: "succeeded" });
    }
    state.selectCandidate("mission-1", batchId, "candidate-a");
    expect(useMissions.getState().projection.qualityGates["gate-test"]).toMatchObject({
      status: "passed",
      artifactIds: ["test-candidate-a"],
    });
  });

  it("locks candidate experiments after a task entered the integration train", () => {
    const state = useMissions.getState();
    state.createMission({ id: "mission-1", projectId: "project-1", title: "M", objective: "O" });
    state.addTask("mission-1", { ...task("task-1"), maxAttempts: 4 });
    state.createIntegrationTrain("mission-1", {
      id: "train-1", baseBranch: "main", integrationBranch: "swarmz/mission-1",
      status: "running", entries: [{ taskId: "task-1", position: 0, status: "integrated", commit: "a".repeat(40), detail: null }],
    });
    expect(() => state.requestCandidateBatch("mission-1", "task-1", { count: 2, instruction: "Too late" }))
      .toThrow(/locked after.*integrated/);
  });

  it("persists schedule create, cancellation and at-most-once claim lifecycle", () => {
    const state = useMissions.getState();
    state.createMission({ id: "mission-1", projectId: "project-1", title: "M", objective: "O" }, { occurredAt: 1_000 });
    const cancelled = state.createSchedule("mission-1", "Review", 2_000, { occurredAt: 1_000 });
    state.cancelSchedule("mission-1", cancelled, { occurredAt: 1_100 });
    expect(() => state.claimSchedule("mission-1", cancelled, { occurredAt: 2_000 })).toThrow(/cannot be claimed/);
    const fired = state.createSchedule("mission-1", "Ship", 3_000, { occurredAt: 1_200 });
    state.claimSchedule("mission-1", fired, { occurredAt: 3_000 });
    expect(() => state.claimSchedule("mission-1", fired, { occurredAt: 3_001 })).toThrow(/cannot be claimed/);
    state.fireSchedule("mission-1", fired, { occurredAt: 3_002 });
    expect(useMissions.getState().projection.schedules[fired]).toMatchObject({ claimedAt: 3_000, firedAt: 3_002 });
  });

  it("releases a denied reminder delivery for a visible bounded retry", () => {
    const state = useMissions.getState();
    state.createMission({ id: "mission-1", projectId: "project-1", title: "M", objective: "O" }, { occurredAt: 1_000 });
    const id = state.createSchedule("mission-1", "Review", 2_000, { occurredAt: 1_000 });
    state.claimSchedule("mission-1", id, { occurredAt: 2_000 });
    state.failScheduleDelivery("mission-1", id, "permission denied", 32_000, { occurredAt: 2_001 });
    expect(useMissions.getState().projection.schedules[id]).toMatchObject({
      claimedAt: null,
      firedAt: null,
      deliveryAttempts: 1,
      lastDeliveryError: "permission denied",
      nextAttemptAt: 32_000,
    });
    state.claimSchedule("mission-1", id, { occurredAt: 32_000 });
    state.fireSchedule("mission-1", id, { occurredAt: 32_001 });
    expect(useMissions.getState().projection.schedules[id]).toMatchObject({ firedAt: 32_001, deliveryAttempts: 2 });
  });

  it("refuses writes before safe hydration", () => {
    useMissions.setState({ hydrated: false, hydrateStatus: "failed" });
    expect(() => useMissions.getState().createMission({
      id: "mission-1",
      projectId: "project-1",
      title: "Mission",
      objective: "Ship it",
    })).toThrow(/not safely hydrated/);
  });
});
