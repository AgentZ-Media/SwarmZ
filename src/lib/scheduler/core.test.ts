import { describe, expect, it } from "vitest";
import type { MissionTask, TaskAttempt } from "@/lib/missions/types";
import {
  adaptiveCapacity,
  controlTask,
  effectivePriority,
  retryAfterFailure,
  schedule,
} from "./core";
import type { ActiveLease, SchedulableTask, SchedulerInput } from "./types";

const NOW = 1_000_000;

function task(
  id: string,
  patch: Partial<MissionTask> = {},
  runtime: Partial<Omit<SchedulableTask, "task">> = {},
): SchedulableTask {
  const value: MissionTask = {
    id,
    missionId: "mission",
    title: id,
    description: "",
    status: "ready",
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
    attemptIds: [],
    qualityGateIds: [],
    artifactIds: [],
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    pausedAt: null,
    ...patch,
  };
  return {
    task: value,
    enqueuedAt: NOW,
    worktreePath: `/repo/.worktrees/${id}`,
    ...runtime,
  };
}

function lease(candidate: SchedulableTask, patch: Partial<ActiveLease> = {}): ActiveLease {
  return {
    taskId: candidate.task.id,
    attemptId: `attempt:${candidate.task.id}`,
    missionId: candidate.task.missionId,
    projectId: candidate.task.root.projectId,
    backendId: `backend:${candidate.task.id}`,
    rootPath: candidate.task.root.path,
    worktreePath: candidate.worktreePath ?? null,
    acquiredAt: NOW,
    declaredFiles: candidate.task.declaredFiles,
    declaredGlobs: candidate.task.declaredGlobs,
    resourceKeys: candidate.resourceKeys ?? [],
    ...patch,
  };
}

function input(tasks: readonly SchedulableTask[], patch: Partial<SchedulerInput> = {}): SchedulerInput {
  return {
    tasks,
    activeLeases: [],
    backendActiveCount: 0,
    now: NOW,
    limits: {
      globalConcurrency: 8,
      perProjectConcurrency: 8,
      hardBackendCap: 48,
      agingIntervalMs: 1_000,
    },
    ...patch,
  };
}

function shuffled<T>(values: readonly T[], seed: number): T[] {
  const result = [...values];
  let state = seed >>> 0;
  for (let i = result.length - 1; i > 0; i -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const j = state % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

describe("scheduler admission", () => {
  it("orders by priority and then stable identity", () => {
    const decision = schedule(input([task("b", { priority: 50 }), task("a", { priority: 50 }), task("c", { priority: 80 })]));
    expect(decision.starts.map((start) => start.taskId)).toEqual(["c", "a", "b"]);
  });

  it("is deterministic across 100 permutations (property-style)", () => {
    const tasks = Array.from({ length: 50 }, (_, index) =>
      task(`task-${String(index).padStart(2, "0")}`, {
        priority: (index * 17) % 101,
        root: { projectId: `p${index % 5}`, path: `/repo/p${index % 5}` },
      }),
    );
    const expected = schedule(input(tasks, { limits: { globalConcurrency: 12, perProjectConcurrency: 4, hardBackendCap: 48, agingIntervalMs: 1_000 } })).starts.map((x) => x.taskId);
    for (let seed = 1; seed <= 100; seed += 1) {
      expect(schedule(input(shuffled(tasks, seed), { limits: { globalConcurrency: 12, perProjectConcurrency: 4, hardBackendCap: 48, agingIntervalMs: 1_000 } })).starts.map((x) => x.taskId)).toEqual(expected);
    }
  });

  it("respects a 50-task DAG", () => {
    const tasks = Array.from({ length: 50 }, (_, index) =>
      task(`t${index}`, {
        dependencyIds: index === 0 ? [] : [`t${index - 1}`],
        status: index === 0 ? "ready" : "blocked_by_dependency",
      }),
    );
    const first = schedule(input(tasks));
    expect(first.starts.map((x) => x.taskId)).toEqual(["t0"]);
    expect(first.evaluations.find((x) => x.taskId === "t49")?.reason.code).toBe("dependency_pending");

    const progressed = tasks.map((candidate, index) =>
      index < 25 ? task(`t${index}`, { ...candidate.task, status: "succeeded" }) : candidate,
    );
    expect(schedule(input(progressed)).starts.map((x) => x.taskId)).toEqual(["t25"]);
  });

  it("reports missing and failed dependencies explicitly", () => {
    const missing = task("missing-child", { dependencyIds: ["gone"] });
    const failed = task("failed", { status: "failed" });
    const child = task("child", { dependencyIds: ["failed"] });
    const decision = schedule(input([missing, failed, child]));
    expect(decision.evaluations.find((x) => x.taskId === "missing-child")?.reason.code).toBe("dependency_missing");
    expect(decision.evaluations.find((x) => x.taskId === "child")?.reason.code).toBe("dependency_failed");
  });

  it("detects dependency cycles instead of waiting forever", () => {
    const a = task("a", { status: "blocked_by_dependency", dependencyIds: ["b"] });
    const b = task("b", { status: "blocked_by_dependency", dependencyIds: ["c"] });
    const c = task("c", { status: "blocked_by_dependency", dependencyIds: ["a"] });
    const decision = schedule(input([a, b, c]));
    expect(decision.starts).toHaveLength(0);
    expect(decision.evaluations.every((value) => value.reason.code === "dependency_cycle")).toBe(true);
  });

  it("prevents starvation through unbounded aging", () => {
    const oldLow = task("old", { priority: 1 }, { enqueuedAt: NOW - 200_000 });
    const freshHigh = task("fresh", { priority: 100 });
    expect(effectivePriority(oldLow, NOW, 1_000)).toBe(201);
    const decision = schedule(input([freshHigh, oldLow], { limits: { globalConcurrency: 1, perProjectConcurrency: 1, hardBackendCap: 48, agingIntervalMs: 1_000 } }));
    expect(decision.starts[0]?.taskId).toBe("old");
  });

  it("enforces global, per-project and hard backend caps", () => {
    const tasks = Array.from({ length: 10 }, (_, index) =>
      task(`t${index}`, { root: { projectId: index < 8 ? "busy" : "other", path: `/repo/${index < 8 ? "busy" : "other"}` } }),
    );
    const byProject = schedule(input(tasks, { limits: { globalConcurrency: 6, perProjectConcurrency: { default: 3, busy: 2 }, hardBackendCap: 48, agingIntervalMs: 1_000 } }));
    expect(byProject.starts.filter((x) => x.projectId === "busy")).toHaveLength(2);
    expect(byProject.starts.length).toBeLessThanOrEqual(5);

    const hard = schedule(input(tasks, { backendActiveCount: 47, limits: { globalConcurrency: 8, perProjectConcurrency: 8, hardBackendCap: 48, agingIntervalMs: 1_000 } }));
    expect(hard.starts).toHaveLength(1);
    expect(hard.capacity.hardBackendAvailable).toBe(1);

    const exhausted = schedule(input([task("blocked")], { backendActiveCount: 48 }));
    expect(exhausted.evaluations[0]?.reason.code).toBe("backend_capacity");
  });

  it("enforces the Mission Envelope concurrency independently of project capacity", () => {
    const tasks = [
      task("a1", { missionId: "alpha" }),
      task("a2", { missionId: "alpha" }),
      task("b1", { missionId: "beta" }),
    ];
    const decision = schedule(
      input(tasks, {
        limits: {
          globalConcurrency: 8,
          perProjectConcurrency: 8,
          perMissionConcurrency: { default: 2, alpha: 1 },
          hardBackendCap: 48,
          agingIntervalMs: 1_000,
        },
      }),
    );
    expect(decision.starts.filter((start) => start.missionId === "alpha")).toHaveLength(1);
    expect(
      decision.evaluations.find((evaluation) =>
        evaluation.missionId === "alpha" && !evaluation.eligible,
      )?.reason.code,
    ).toBe("mission_capacity");
    expect(decision.starts.some((start) => start.missionId === "beta")).toBe(true);
  });

  it("round-robins equal-priority capacity across projects", () => {
    const tasks = Array.from({ length: 8 }, (_, index) =>
      task(`t${index}`, {
        root: {
          projectId: index < 4 ? "alpha" : "beta",
          path: index < 4 ? "/alpha" : "/beta",
        },
      }),
    );
    const starts = schedule(input(tasks, {
      limits: { globalConcurrency: 4, perProjectConcurrency: 8, hardBackendCap: 48, agingIntervalMs: 1_000 },
    })).starts;
    expect(starts.filter((value) => value.projectId === "alpha")).toHaveLength(2);
    expect(starts.filter((value) => value.projectId === "beta")).toHaveLength(2);
  });

  it("counts active leases against managed and project capacity", () => {
    const activeTask = task("active", { root: { projectId: "p", path: "/repo/p" } });
    const queued = task("queued", { root: { projectId: "p", path: "/repo/p" } });
    const decision = schedule(input([activeTask, queued], {
      activeLeases: [lease(activeTask)],
      backendActiveCount: 1,
      limits: { globalConcurrency: 2, perProjectConcurrency: 1, hardBackendCap: 48, agingIntervalMs: 1_000 },
    }));
    expect(decision.starts).toHaveLength(0);
    expect(decision.evaluations.find((x) => x.taskId === "queued")?.reason.code).toBe("project_capacity");
  });

  it("checks conflicts among tasks selected in the same tick", () => {
    const a = task("a", { declaredFiles: ["src/shared.ts"] });
    const b = task("b", { declaredFiles: ["src/shared.ts"] });
    const decision = schedule(input([a, b]));
    expect(decision.starts.map((x) => x.taskId)).toEqual(["a"]);
    expect(decision.evaluations.find((x) => x.taskId === "b")?.reason).toMatchObject({ code: "declared_file_conflict", blockers: ["a"] });
  });

  it("explains health pause, mission pause and retry backoff", () => {
    const health = schedule(input([task("a")], { signals: { health: "critical" } }));
    expect(health.evaluations[0]?.reason.code).toBe("health_paused");
    const mission = schedule(input([task("a")], { pausedMissionIds: new Set(["mission"]) }));
    expect(mission.evaluations[0]?.reason.code).toBe("mission_paused");
    const backoff = schedule(input([task("a", {}, { nextEligibleAt: NOW + 1 })]));
    expect(backoff.evaluations[0]?.reason.code).toBe("retry_backoff");
  });

  it("emits crash-recovery actions from persisted state", () => {
    const running = task("running", { status: "running", attemptIds: ["a1"], maxAttempts: 2 });
    const exhausted = task("exhausted", { status: "running", attemptIds: ["e1"], maxAttempts: 1 });
    const attempts: TaskAttempt[] = [
      { id: "a1", missionId: "mission", taskId: "running", ordinal: 1, status: "running", sessionId: "s", workerLabel: null, startedAt: 1, finishedAt: null, summary: null, error: null, report: null, artifactIds: [] },
      { id: "e1", missionId: "mission", taskId: "exhausted", ordinal: 1, status: "running", sessionId: "s2", workerLabel: null, startedAt: 1, finishedAt: null, summary: null, error: null, report: null, artifactIds: [] },
    ];
    expect(schedule(input([running, exhausted], { attempts, missingBackendTaskIds: new Set(["running", "exhausted"]) })).recovery).toEqual([
      expect.objectContaining({ taskId: "exhausted", action: "fail" }),
      expect.objectContaining({ taskId: "running", action: "retry" }),
    ]);
  });
});

describe("adaptive concurrency", () => {
  it("reduces deterministically for rate limits, failures and memory", () => {
    expect(adaptiveCapacity({ globalConcurrency: 10, perProjectConcurrency: 10, hardBackendCap: 48, agingIntervalMs: 1_000 }, 0, 0, { health: "degraded" }).effective).toBe(5);
    expect(adaptiveCapacity({ globalConcurrency: 10, perProjectConcurrency: 10, hardBackendCap: 48, agingIntervalMs: 1_000 }, 0, 0, { rateLimitRemainingRatio: 0.1 }).effective).toBe(1);
    expect(adaptiveCapacity({ globalConcurrency: 10, perProjectConcurrency: 10, hardBackendCap: 48, agingIntervalMs: 1_000 }, 0, 0, { memoryPressure: 0.95 }).effective).toBe(0);
  });

  it("never exceeds the hard cap for malformed or oversized input", () => {
    for (let requested = -5; requested < 100; requested += 1) {
      const result = adaptiveCapacity({ globalConcurrency: requested, perProjectConcurrency: 10, hardBackendCap: 48, agingIntervalMs: 1_000 }, 0, 0);
      expect(result.effective).toBeGreaterThanOrEqual(0);
      expect(result.effective).toBeLessThanOrEqual(48);
    }
  });
});

describe("retry and controls", () => {
  it("uses bounded deterministic exponential backoff", () => {
    const candidate = task("retry", { attemptIds: ["a1", "a2"], maxAttempts: 4 }).task;
    const first = retryAfterFailure(candidate, NOW, true, { baseDelayMs: 1_000, maxDelayMs: 10_000 });
    const second = retryAfterFailure(candidate, NOW, true, { baseDelayMs: 1_000, maxDelayMs: 10_000 });
    expect(first).toEqual(second);
    expect(first.action).toBe("retry");
    expect(first.delayMs).toBeGreaterThanOrEqual(1_800);
    expect(first.delayMs).toBeLessThanOrEqual(2_200);
  });

  it("fails non-retryable and exhausted tasks", () => {
    const candidate = task("retry", { attemptIds: ["a1"], maxAttempts: 1 }).task;
    expect(retryAfterFailure(candidate, NOW, true, { baseDelayMs: 1_000, maxDelayMs: 10_000 }).action).toBe("fail");
    expect(retryAfterFailure({ ...candidate, maxAttempts: 3 }, NOW, false, { baseDelayMs: 1_000, maxDelayMs: 10_000 }).action).toBe("fail");
  });

  it("pauses, resumes and cancels without hidden side effects", () => {
    const running = task("run", { status: "running" }).task;
    const paused = controlTask(running, "pause", NOW);
    expect(paused).toMatchObject({ changed: true, interruptActiveAttempt: true, task: { status: "paused", pausedAt: NOW } });
    expect(controlTask(paused.task, "resume", NOW + 1)).toMatchObject({ changed: true, task: { status: "ready", pausedAt: null } });
    expect(controlTask(running, "cancel", NOW)).toMatchObject({ changed: true, interruptActiveAttempt: true, task: { status: "cancelled" } });
    expect(controlTask(task("done", { status: "succeeded" }).task, "cancel", NOW).changed).toBe(false);
  });
});
