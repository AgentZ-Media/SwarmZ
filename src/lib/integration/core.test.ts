import { describe, expect, it } from "vitest";
import type {
  IntegrationTrain,
  MissionArtifact,
  MissionTask,
  QualityGate,
  TaskAttempt,
} from "@/lib/missions/types";
import {
  assessEntryReadiness,
  latestCheckpoint,
  operationIdFor,
  planCombinedRegression,
  planIntegration,
} from "./core";
import type { IntegrationInput } from "./types";

const NOW = 1_000_000;
const HEAD = "bbbbbbb";

function commitFor(index: number): string {
  return `a${index.toString(16).padStart(6, "0")}`;
}

function task(id: string, patch: Partial<MissionTask> = {}): MissionTask {
  return {
    id,
    missionId: "mission",
    title: id,
    description: "",
    status: "succeeded",
    priority: 50,
    role: "implementation",
    risk: "low",
    acceptanceCriteria: [],
    root: { projectId: "project", path: "/repo" },
    worktreePolicy: { mode: "new" },
    dependencyIds: [],
    declaredFiles: [`src/${id}.ts`],
    declaredGlobs: [],
    maxAttempts: 3,
    attemptIds: [`attempt:${id}`],
    qualityGateIds: [],
    artifactIds: [`artifact:${id}`],
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    pausedAt: null,
    ...patch,
  };
}

function attempt(id: string, patch: Partial<TaskAttempt> = {}): TaskAttempt {
  return {
    id: `attempt:${id}`,
    missionId: "mission",
    taskId: id,
    ordinal: 1,
    status: "succeeded",
    sessionId: `session:${id}`,
    workerLabel: null,
    startedAt: 1,
    finishedAt: 2,
    summary: null,
    error: null,
    report: null,
    artifactIds: [`artifact:${id}`],
    ...patch,
  };
}

function artifact(id: string, commit = commitFor(Number(id.replace(/\D/g, "")) || 1)): MissionArtifact {
  return {
    id: `artifact:${id}`,
    missionId: "mission",
    taskId: id,
    attemptId: `attempt:${id}`,
    kind: "commit",
    label: "Commit",
    uri: commit,
    metadata: {},
    createdAt: 2,
  };
}

function gate(id: string, taskId: string | null, patch: Partial<QualityGate> = {}): QualityGate {
  return {
    id,
    missionId: "mission",
    taskId,
    kind: "unit_tests",
    label: id,
    command: "pnpm test",
    required: true,
    status: "passed",
    details: null,
    artifactIds: [],
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

function train(ids: readonly string[], patch: Partial<IntegrationTrain> = {}): IntegrationTrain {
  return {
    id: "train",
    missionId: "mission",
    baseBranch: "main",
    integrationBranch: "integration/mission",
    status: "running",
    entries: ids.map((taskId, position) => ({
      taskId,
      position,
      status: "queued",
      commit: null,
      detail: null,
    })),
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

function input(ids: readonly string[], patch: Partial<IntegrationInput> = {}): IntegrationInput {
  const tasks = Object.fromEntries(ids.map((id) => [id, task(id)]));
  const attempts = Object.fromEntries(ids.map((id) => [`attempt:${id}`, attempt(id)]));
  const artifacts = Object.fromEntries(ids.map((id, index) => [`artifact:${id}`, artifact(id, commitFor(index + 1))]));
  return {
    train: train(ids),
    tasks,
    attempts,
    artifacts,
    qualityGates: {},
    strategy: "merge",
    currentHead: HEAD,
    checkpoints: [
      {
        id: "baseline",
        trainId: "train",
        headCommit: HEAD,
        integratedTaskIds: [],
        completedOperationIds: [],
        passedGateIds: [],
        createdAt: 0,
      },
    ],
    stopPolicy: {
      onOperationFailure: "rollback",
      onConflict: "needs_human",
      onGateFailure: "rollback",
      stopOnCriticalRisk: false,
      checkpointEvery: 10,
    },
    now: NOW,
    ...patch,
  };
}

describe("integration readiness", () => {
  it("requires a succeeded task, succeeded attempt and matching commit evidence", () => {
    const state = input(["t1"]);
    expect(assessEntryReadiness(state.train.entries[0], state)).toMatchObject({ ready: true, code: "ready", attemptId: "attempt:t1", commit: commitFor(1) });

    expect(assessEntryReadiness(state.train.entries[0], { ...state, tasks: { t1: task("t1", { status: "failed" }) } }).code).toBe("task_not_succeeded");
    expect(assessEntryReadiness(state.train.entries[0], { ...state, attempts: { "attempt:t1": attempt("t1", { status: "failed" }) } }).code).toBe("attempt_not_succeeded");
    expect(assessEntryReadiness(state.train.entries[0], { ...state, artifacts: {} }).code).toBe("commit_missing");
  });

  it("refuses mismatched entry and artifact commits", () => {
    const state = input(["t1"]);
    const entry = { ...state.train.entries[0], commit: "ccccccc" };
    expect(assessEntryReadiness(entry, state).code).toBe("commit_missing");
  });

  it("requires dependencies to succeed and enter the train first", () => {
    const state = input(["root", "child"]);
    state.tasks = { ...state.tasks, child: task("child", { dependencyIds: ["root"] }) };
    expect(assessEntryReadiness(state.train.entries[1], state).code).toBe("dependency_not_integrated");
    state.train = { ...state.train, entries: state.train.entries.map((entry) => entry.taskId === "root" ? { ...entry, status: "integrated" } : entry) };
    expect(assessEntryReadiness(state.train.entries[1], state).code).toBe("ready");
  });

  it("distinguishes missing, pending, failed and waived required gates", () => {
    const state = input(["t1"]);
    state.tasks = { t1: task("t1", { qualityGateIds: ["gate"] }) };
    expect(assessEntryReadiness(state.train.entries[0], state).code).toBe("required_gate_pending");
    state.qualityGates = { gate: gate("gate", "t1", { status: "pending" }) };
    expect(assessEntryReadiness(state.train.entries[0], state).code).toBe("required_gate_pending");
    state.qualityGates = { gate: gate("gate", "t1", { status: "failed" }) };
    expect(assessEntryReadiness(state.train.entries[0], state).code).toBe("required_gate_failed");
    state.qualityGates = { gate: gate("gate", "t1", { status: "waived" }) };
    expect(assessEntryReadiness(state.train.entries[0], state).ready).toBe(true);
  });
});

describe("integration queue and operations", () => {
  it("queues a 50-task DAG one dependency-safe entry at a time", () => {
    const ids = Array.from({ length: 50 }, (_, index) => `t${index}`);
    const state = input(ids);
    state.tasks = Object.fromEntries(ids.map((id, index) => [id, task(id, { dependencyIds: index === 0 ? [] : [`t${index - 1}`] })]));
    expect(planIntegration(state).readyQueue.map((entry) => entry.taskId)).toEqual(["t0"]);

    state.train = { ...state.train, entries: state.train.entries.map((entry, index) => ({ ...entry, status: index < 25 ? "integrated" : "queued" })) };
    state.stopPolicy = { ...state.stopPolicy, checkpointEvery: 50 };
    expect(planIntegration(state).readyQueue.map((entry) => entry.taskId)).toEqual(["t25"]);
  });

  it("uses train position and task id for deterministic queue order", () => {
    const state = input(["b", "a", "c"]);
    state.train = { ...state.train, entries: [state.train.entries[2], state.train.entries[0], state.train.entries[1]] };
    expect(planIntegration(state).readyQueue.map((entry) => entry.taskId)).toEqual(["b", "a", "c"]);
    expect(planIntegration(state).operation?.taskId).toBe("b");
  });

  it("produces declarative merge, rebase and cherry-pick plans", () => {
    for (const strategy of ["merge", "rebase", "cherry_pick"] as const) {
      const plan = planIntegration(input(["t1"], { strategy }));
      expect(plan.action).toBe("execute");
      expect(plan.operation?.operation).toMatchObject({ kind: strategy, expectedHead: HEAD, targetBranch: "integration/mission" });
    }
  });

  it("creates stable, input-sensitive operation ids", () => {
    const args = ["train", "task", "attempt", "aaaaaaa", "merge", "bbbbbbb"] as const;
    expect(operationIdFor(...args)).toBe(operationIdFor(...args));
    expect(operationIdFor(...args)).not.toBe(operationIdFor("train", "task", "attempt", "aaaaaaa", "merge", "ccccccc"));
  });

  it("reconciles completed or ancestor operations instead of executing twice", () => {
    const state = input(["t1"]);
    const first = planIntegration(state);
    expect(first.operation).not.toBeNull();
    expect(planIntegration({ ...state, completedOperationIds: new Set([first.operation!.operationId]) }).action).toBe("reconcile");
    expect(planIntegration({ ...state, integratedCommits: new Set([first.operation!.commit]) }).action).toBe("reconcile");
  });

  it("waits while the same idempotent operation is owned by an executor", () => {
    const state = input(["t1"]);
    const first = planIntegration(state);
    expect(planIntegration({ ...state, activeOperationIds: new Set([first.operation!.operationId]) }).action).toBe("wait");
  });

  it("waits with explainable evaluations when no entry is ready", () => {
    const state = input(["t1"]);
    state.tasks = { t1: task("t1", { status: "running" }) };
    const plan = planIntegration(state);
    expect(plan.action).toBe("wait");
    expect(plan.evaluations[0]?.code).toBe("task_not_succeeded");
  });
});

describe("conflicts, checkpoints and stop policies", () => {
  it("blocks high conflicts and asks for a human according to policy", () => {
    const state = input(["t1"], { observedChanges: [{ id: "base", files: ["src/t1.ts"] }] });
    const plan = planIntegration(state);
    expect(plan.action).toBe("needs_human");
    expect(plan.conflicts[0]?.severity).toBe("high");
  });

  it("allows medium conflict radar warnings to accompany an operation", () => {
    const state = input(["t1"]);
    state.tasks = { t1: task("t1", { declaredFiles: [], declaredGlobs: ["src/features/**"] }) };
    state.observedChanges = [{ id: "base", files: [], globs: ["src/features/*.ts"] }];
    const plan = planIntegration(state);
    expect(plan.action).toBe("execute");
    expect(plan.conflicts[0]?.severity).toBe("medium");
  });

  it("creates periodic deterministic checkpoints", () => {
    const state = input(["a", "b", "c"]);
    state.train = { ...state.train, entries: state.train.entries.map((entry, index) => ({ ...entry, status: index < 2 ? "integrated" : "queued" })) };
    state.stopPolicy = { ...state.stopPolicy, checkpointEvery: 2 };
    const plan = planIntegration(state);
    expect(plan.action).toBe("checkpoint");
    expect(plan.checkpoint).toMatchObject({ headCommit: HEAD, integratedTaskIds: ["a", "b"] });
    expect(planIntegration(state).checkpoint?.checkpointId).toBe(plan.checkpoint?.checkpointId);
  });

  it("creates a baseline checkpoint before any git operation", () => {
    const state = input(["t1"], { checkpoints: [] });
    const plan = planIntegration(state);
    expect(plan).toMatchObject({ action: "checkpoint", checkpoint: { headCommit: HEAD, integratedTaskIds: [] } });
  });

  it("rolls back to the latest deterministic checkpoint", () => {
    const state = input(["t1"], {
      failure: { kind: "operation_failed", detail: "boom" },
      checkpoints: [
        { id: "older", trainId: "train", headCommit: "1111111", integratedTaskIds: [], completedOperationIds: [], passedGateIds: [], createdAt: 1 },
        { id: "newer-a", trainId: "train", headCommit: "2222222", integratedTaskIds: [], completedOperationIds: [], passedGateIds: [], createdAt: 2 },
        { id: "newer-z", trainId: "train", headCommit: "3333333", integratedTaskIds: [], completedOperationIds: [], passedGateIds: [], createdAt: 2 },
      ],
    });
    expect(latestCheckpoint("train", state.checkpoints ?? [])?.id).toBe("newer-z");
    expect(planIntegration(state)).toMatchObject({ action: "rollback", rollback: { checkpointId: "newer-z", targetHead: "3333333", expectedHead: HEAD } });
  });

  it("fails closed when rollback is requested without a checkpoint", () => {
    expect(planIntegration(input(["t1"], { failure: { kind: "gate_failed", detail: "tests" }, checkpoints: [] }))).toMatchObject({ action: "blocked", rollback: null });
  });

  it("honours stop, continue and human conflict policies", () => {
    expect(planIntegration(input(["t1"], { failure: { kind: "operation_failed", detail: "x" }, stopPolicy: { onOperationFailure: "stop", onConflict: "stop", onGateFailure: "stop", stopOnCriticalRisk: false, checkpointEvery: 10 } })).action).toBe("blocked");
    expect(planIntegration(input(["t1"], { failure: { kind: "operation_failed", detail: "x" }, stopPolicy: { onOperationFailure: "continue", onConflict: "stop", onGateFailure: "stop", stopOnCriticalRisk: false, checkpointEvery: 10 } })).action).toBe("reconcile");
    expect(planIntegration(input(["t1"], { failure: { kind: "merge_conflict", detail: "x" }, stopPolicy: { onOperationFailure: "stop", onConflict: "needs_human", onGateFailure: "stop", stopOnCriticalRisk: false, checkpointEvery: 10 } })).action).toBe("needs_human");
  });

  it("applies stop policies to durable failed entries and gate results", () => {
    const failedEntry = input(["t1"]);
    failedEntry.train = { ...failedEntry.train, entries: [{ ...failedEntry.train.entries[0], status: "failed" }] };
    expect(planIntegration(failedEntry).action).toBe("rollback");
    failedEntry.stopPolicy = { ...failedEntry.stopPolicy, onOperationFailure: "continue" };
    expect(planIntegration(failedEntry).action).toBe("reconcile");

    const failedGate = input(["t1"]);
    failedGate.tasks = { t1: task("t1", { qualityGateIds: ["gate"] }) };
    failedGate.qualityGates = { gate: gate("gate", "t1", { status: "failed" }) };
    expect(planIntegration(failedGate).action).toBe("rollback");
  });

  it("requires human confirmation for critical-risk tasks when configured", () => {
    const state = input(["t1"]);
    state.tasks = { t1: task("t1", { risk: "critical" }) };
    state.stopPolicy = { ...state.stopPolicy, stopOnCriticalRisk: true };
    expect(planIntegration(state).action).toBe("needs_human");
  });
});

describe("combined regression planning", () => {
  it("deduplicates commands while retaining all gate ids", () => {
    const state = input([], {
      qualityGates: {
        unit: gate("unit", null, { command: "pnpm test" }),
        integration: gate("integration", null, { command: "pnpm test" }),
        build: gate("build", null, { command: "pnpm build" }),
      },
    });
    const regression = planCombinedRegression(state);
    expect(regression.steps).toHaveLength(2);
    expect(regression.steps.find((step) => step.command === "pnpm test")?.gateIds).toEqual(["integration", "unit"]);
    expect(planIntegration(state).action).toBe("run_regression");
  });

  it("completes only after the head-specific regression plan is recorded", () => {
    const state = input([], { qualityGates: { unit: gate("unit", null) } });
    const first = planIntegration(state);
    expect(first.action).toBe("run_regression");
    expect(planIntegration({ ...state, completedRegressionPlanIds: new Set([first.regression!.planId]) }).action).toBe("complete");
  });

  it("waits for persisted gate results after a regression executor completes", () => {
    const state = input([], { qualityGates: { unit: gate("unit", null, { status: "running" }) } });
    const first = planIntegration(state);
    expect(planIntegration({ ...state, completedRegressionPlanIds: new Set([first.regression!.planId]) }).action).toBe("wait");
  });

  it("rejects an inconsistent completed train snapshot", () => {
    const state = input(["t1"]);
    state.train = { ...state.train, status: "completed" };
    expect(planIntegration(state).action).toBe("blocked");
  });

  it("blocks failed or commandless required regression gates", () => {
    const failed = input([], { qualityGates: { gate: gate("gate", null, { status: "failed" }) } });
    expect(planIntegration(failed).action).toBe("blocked");
    const commandless = input([], { qualityGates: { gate: gate("gate", null, { command: null }) } });
    expect(planIntegration(commandless).action).toBe("blocked");
  });

  it("excludes explicitly waived gates from combined regression", () => {
    const state = input([], { qualityGates: { waived: gate("waived", null, { status: "waived", command: null }) } });
    expect(planCombinedRegression(state).steps).toEqual([]);
    expect(planIntegration(state).action).toBe("complete");
  });

  it("completes immediately when there are no required regression commands", () => {
    expect(planIntegration(input([])).action).toBe("complete");
  });
});
