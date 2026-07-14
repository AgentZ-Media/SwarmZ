import { beforeEach, describe, expect, it } from "vitest";
import { emptyMissionProjection } from "./core";
import { deriveApprovedMissionScope } from "./controller-core";
import { useMissions } from "./store";
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
