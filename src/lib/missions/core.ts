import type {
  IntegrationTrain,
  IntegrationTrainEntry,
  Mission,
  MissionDependency,
  MissionEvent,
  MissionProjection,
  MissionStatus,
  MissionTask,
  MissionTaskInput,
  TaskAttempt,
  TaskStatus,
} from "./types";

const ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,127}$/;
const FORBIDDEN_IDS = new Set(["__proto__", "prototype", "constructor"]);
const TERMINAL_ATTEMPT = new Set([
  "succeeded",
  "failed",
  "blocked",
  "needs_human",
  "cancelled",
]);

export class MissionInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissionInvariantError";
  }
}

export function emptyMissionProjection(): MissionProjection {
  return {
    missions: Object.create(null),
    tasks: Object.create(null),
    dependencies: Object.create(null),
    attempts: Object.create(null),
    artifacts: Object.create(null),
    qualityGates: Object.create(null),
    integrationTrains: Object.create(null),
    appliedEventIds: Object.create(null),
    idempotencyKeys: Object.create(null),
  };
}

function assertId(label: string, value: string): void {
  if (!ID_RE.test(value) || FORBIDDEN_IDS.has(value)) {
    throw new MissionInvariantError(`${label} is invalid`);
  }
}

function assertString(label: string, value: string, max: number): void {
  if (!value.trim() || value.length > max) {
    throw new MissionInvariantError(`${label} must be 1..${max} characters`);
  }
}

function unique(values: string[], label: string): string[] {
  const result = [...new Set(values)];
  if (result.length !== values.length) {
    throw new MissionInvariantError(`${label} contains duplicates`);
  }
  return result;
}

function assertStringList(
  label: string,
  values: string[],
  maxItems: number,
  maxLength: number,
): void {
  if (values.length > maxItems) {
    throw new MissionInvariantError(`${label} exceeds ${maxItems} items`);
  }
  for (const value of values) assertString(label, value, maxLength);
}

function copyProjection(state: MissionProjection): MissionProjection {
  return {
    missions: { ...state.missions },
    tasks: { ...state.tasks },
    dependencies: { ...state.dependencies },
    attempts: { ...state.attempts },
    artifacts: { ...state.artifacts },
    qualityGates: { ...state.qualityGates },
    integrationTrains: { ...state.integrationTrains },
    appliedEventIds: { ...state.appliedEventIds },
    idempotencyKeys: { ...state.idempotencyKeys },
  };
}

/** Stable enough for persisted event identity: JSON event data is plain data. */
export function missionEventFingerprint(event: MissionEvent): string {
  return JSON.stringify({
    missionId: event.missionId,
    revision: event.revision,
    occurredAt: event.occurredAt,
    actor: event.actor,
    type: event.type,
    data: event.data,
  });
}

function taskAttempts(state: MissionProjection, task: MissionTask): TaskAttempt[] {
  return task.attemptIds
    .map((id) => state.attempts[id])
    .filter((value): value is TaskAttempt => !!value);
}

function deriveTaskStatus(
  state: MissionProjection,
  task: MissionTask,
): TaskStatus {
  if (task.archivedAt !== null) return "archived";
  if (task.pausedAt !== null) return "paused";

  const dependencies = task.dependencyIds.map((id) => state.tasks[id]);
  if (
    dependencies.length !== task.dependencyIds.length ||
    dependencies.some((dep) => {
      if (dep.status === "succeeded") return false;
      if (dep.status !== "archived") return true;
      const attempts = taskAttempts(state, dep);
      const latest = attempts[attempts.length - 1];
      if (latest?.status !== "succeeded") return true;
      return dep.qualityGateIds
        .map((id) => state.qualityGates[id])
        .filter((gate) => gate?.required)
        .some((gate) => gate.status !== "passed" && gate.status !== "waived");
    })
  ) {
    return "blocked_by_dependency";
  }

  const attempts = taskAttempts(state, task);
  const latest = attempts[attempts.length - 1];
  if (!latest) return "ready";
  if (task.requeuedAfterAttemptId === latest.id) return "ready";
  if (latest.status === "queued" || latest.status === "running") return "running";
  if (latest.status === "cancelled") return "cancelled";
  if (latest.status === "needs_human") return "needs_human";
  if (latest.status === "blocked") return "blocked";
  if (latest.status === "failed") {
    return attempts.length < task.maxAttempts ? "ready" : "failed";
  }

  const gates = task.qualityGateIds
    .map((id) => state.qualityGates[id])
    .filter((gate) => gate?.required);
  if (gates.some((gate) => gate.status === "failed")) return "failed";
  if (gates.some((gate) => gate.status !== "passed" && gate.status !== "waived")) {
    return "blocked";
  }
  return "succeeded";
}

function deriveMissionStatus(
  state: MissionProjection,
  mission: Mission,
): MissionStatus {
  if (mission.archivedAt !== null) return "archived";
  if (mission.cancelledAt !== null) return "cancelled";
  if (mission.pausedAt !== null) return "paused";
  const tasks = mission.taskIds
    .map((id) => state.tasks[id])
    .filter((task): task is MissionTask => !!task);
  const live = tasks.filter((task) => task.status !== "archived");
  if (live.length === 0) return mission.activatedAt === null ? "draft" : "active";
  if (live.every((task) => task.status === "succeeded")) {
    if (mission.policy.integrationMode === "manual") return "succeeded";
    const trains = mission.integrationTrainIds
      .map((id) => state.integrationTrains[id])
      .filter((train): train is IntegrationTrain => !!train);
    // A train-mode mission is not complete merely because isolated branches
    // are green. Every repository root needs one durable completed train.
    if (trains.some((train) => train.status === "blocked")) return "blocked";
    if (trains.some((train) => train.status === "cancelled")) return "failed";
    const integratedTaskIds = new Set(
      trains
        .filter((train) => train.status === "completed")
        .flatMap((train) => train.entries)
        .filter((entry) => entry.status === "integrated" || entry.status === "skipped")
        .map((entry) => entry.taskId),
    );
    if (trains.some((train) => train.status !== "completed") ||
      live.some((task) => !integratedTaskIds.has(task.id))) {
      return "active";
    }
    return "succeeded";
  }
  if (live.some((task) => task.status === "needs_human")) return "needs_human";
  if (live.some((task) => task.status === "running" || task.status === "ready")) {
    return "active";
  }
  if (live.some((task) => task.status === "failed")) return "failed";
  return "blocked";
}

/** Recompute dependency-sensitive tasks to a fixed point, then mission status. */
function refreshMission(state: MissionProjection, missionId: string): void {
  const mission = state.missions[missionId];
  if (!mission) return;
  for (let pass = 0; pass <= mission.taskIds.length; pass += 1) {
    let changed = false;
    for (const taskId of mission.taskIds) {
      const task = state.tasks[taskId];
      if (!task) continue;
      const status = deriveTaskStatus(state, task);
      if (status !== task.status) {
        state.tasks[taskId] = { ...task, status };
        changed = true;
      }
    }
    if (!changed) break;
  }
  const updated = state.missions[missionId];
  state.missions[missionId] = {
    ...updated,
    status: deriveMissionStatus(state, updated),
  };
}

function assertTaskInput(
  state: MissionProjection,
  missionId: string,
  task: MissionTaskInput,
): void {
  assertId("task id", task.id);
  if (task.missionId !== missionId) {
    throw new MissionInvariantError("task belongs to another mission");
  }
  if (state.tasks[task.id]) throw new MissionInvariantError("task id already exists");
  assertString("task title", task.title, 300);
  if (task.description.length > 20_000) throw new MissionInvariantError("task description is too long");
  assertString("task role", task.role, 100);
  if (!Number.isInteger(task.priority) || task.priority < 0 || task.priority > 100) {
    throw new MissionInvariantError("task priority must be an integer from 0 to 100");
  }
  if (!Number.isInteger(task.maxAttempts) || task.maxAttempts < 1 || task.maxAttempts > 20) {
    throw new MissionInvariantError("task maxAttempts must be 1..20");
  }
  if (!task.root.path.trim() || !task.root.projectId.trim()) {
    throw new MissionInvariantError("task root must identify a project and path");
  }
  if (task.root.path.length > 8_192 || task.root.projectId.length > 200) {
    throw new MissionInvariantError("task root is too long");
  }
  assertStringList("acceptance criterion", task.acceptanceCriteria, 100, 1_000);
  assertStringList("declared file", task.declaredFiles, 1_000, 2_000);
  assertStringList("declared glob", task.declaredGlobs, 1_000, 2_000);
  if (task.dependencyIds.length > 500) {
    throw new MissionInvariantError("task has too many dependencies");
  }
  unique(task.dependencyIds, "task dependencies");
  for (const dependencyId of task.dependencyIds) {
    const dependency = state.tasks[dependencyId];
    if (!dependency || dependency.missionId !== missionId) {
      throw new MissionInvariantError(`unknown task dependency: ${dependencyId}`);
    }
  }
}

export function assertAcyclicMissionTasks(
  tasks: Record<string, MissionTask>,
  missionId: string,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string) => {
    if (visiting.has(taskId)) throw new MissionInvariantError("task dependency cycle");
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    const task = tasks[taskId];
    if (task?.missionId === missionId) {
      for (const dependencyId of task.dependencyIds) visit(dependencyId);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of Object.values(tasks)) {
    if (task.missionId === missionId) visit(task.id);
  }
}

function assertTrainEntries(
  state: MissionProjection,
  missionId: string,
  entries: IntegrationTrainEntry[],
): void {
  const positions = new Set<number>();
  const tasks = new Set<string>();
  for (const entry of entries) {
    const task = state.tasks[entry.taskId];
    if (!task || task.missionId !== missionId) {
      throw new MissionInvariantError(`integration train task is unknown: ${entry.taskId}`);
    }
    if (
      !Number.isInteger(entry.position) ||
      entry.position < 0 ||
      positions.has(entry.position) ||
      tasks.has(entry.taskId)
    ) {
      throw new MissionInvariantError("integration train entries must be unique");
    }
    positions.add(entry.position);
    tasks.add(entry.taskId);
  }
}

function dependencyId(taskId: string, dependsOnTaskId: string): string {
  return `dependency:${taskId}:${dependsOnTaskId}`;
}

function replaceTaskDependencies(
  state: MissionProjection,
  task: MissionTask,
): void {
  for (const [id, dependency] of Object.entries(state.dependencies)) {
    if (dependency.taskId === task.id) delete state.dependencies[id];
  }
  for (const dependsOnTaskId of task.dependencyIds) {
    const dependency: MissionDependency = {
      id: dependencyId(task.id, dependsOnTaskId),
      missionId: task.missionId,
      taskId: task.id,
      dependsOnTaskId,
      kind: "hard",
      createdAt: task.createdAt,
    };
    state.dependencies[dependency.id] = dependency;
  }
}

/**
 * Apply one event without mutating the input projection. Exact duplicate
 * events/idempotency retries return the original object. Conflicting or stale
 * events throw; callers must not append them to the durable log.
 */
export function reduceMissionEvent(
  current: MissionProjection,
  event: MissionEvent,
): MissionProjection {
  assertId("event id", event.eventId);
  assertId("mission id", event.missionId);
  const fingerprint = missionEventFingerprint(event);
  const applied = current.appliedEventIds[event.eventId];
  if (applied !== undefined) {
    if (applied !== fingerprint) throw new MissionInvariantError("event id conflict");
    return current;
  }
  if (event.idempotencyKey) {
    assertString("idempotency key", event.idempotencyKey, 200);
    const prior = current.idempotencyKeys[event.idempotencyKey];
    if (prior !== undefined) {
      if (prior !== fingerprint) {
        throw new MissionInvariantError("idempotency key conflict");
      }
      return current;
    }
  }

  const previousMission = current.missions[event.missionId];
  const expectedRevision = (previousMission?.revision ?? 0) + 1;
  if (event.revision !== expectedRevision) {
    throw new MissionInvariantError(
      `stale mission revision ${event.revision}; expected ${expectedRevision}`,
    );
  }
  if (!Number.isFinite(event.occurredAt) || event.occurredAt < 0) {
    throw new MissionInvariantError("event timestamp is invalid");
  }

  const state = copyProjection(current);
  if (event.type === "mission.created") {
    if (previousMission) throw new MissionInvariantError("mission already exists");
    assertString("mission title", event.data.title, 300);
    assertString("mission objective", event.data.objective, 10_000);
    if (!event.data.projectId.trim()) throw new MissionInvariantError("project id is required");
    if (
      !Number.isInteger(event.data.policy.maxParallelAttempts) ||
      event.data.policy.maxParallelAttempts < 1 ||
      event.data.policy.maxParallelAttempts > 48
    ) {
      throw new MissionInvariantError("maxParallelAttempts must be 1..48");
    }
    if (
      typeof event.data.policy.stopOnCriticalFailure !== "boolean" ||
      typeof event.data.policy.requireQualityGates !== "boolean" ||
      typeof event.data.policy.archiveCompletedWorkers !== "boolean" ||
      !["manual", "train"].includes(event.data.policy.integrationMode)
    ) {
      throw new MissionInvariantError("mission policy is invalid");
    }
    const policy = event.data.policy;
    if (
      (policy.networkAuthority !== undefined &&
        !["deny", "read_only", "allow"].includes(policy.networkAuthority)) ||
      (policy.githubAuthority !== undefined &&
        !["deny", "read_only", "write"].includes(policy.githubAuthority)) ||
      (policy.allowedTools !== undefined &&
        (policy.allowedTools.length > 100 ||
          policy.allowedTools.some((tool) => !/^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,199}$/.test(tool)))) ||
      (policy.qualityCommands !== undefined &&
        (policy.qualityCommands.length > 20 ||
          policy.qualityCommands.some((command) =>
            typeof command !== "string" || !command.trim() || command.length > 1_000))) ||
      (policy.stopOnRegression !== undefined &&
        !["continue", "pause_mission", "needs_human", "cancel_mission"].includes(policy.stopOnRegression)) ||
      (policy.stopOnConflict !== undefined &&
        !["continue", "pause_mission", "needs_human", "cancel_mission"].includes(policy.stopOnConflict))
    ) {
      throw new MissionInvariantError("mission execution policy is invalid");
    }
    const { budget } = event.data;
    if (
      (budget.maxAttemptsTotal !== null &&
        (!Number.isInteger(budget.maxAttemptsTotal) || budget.maxAttemptsTotal < 1)) ||
      (budget.maxActiveMinutes !== null &&
        (!Number.isFinite(budget.maxActiveMinutes) || budget.maxActiveMinutes <= 0)) ||
      (budget.maxTokens !== null &&
        (!Number.isInteger(budget.maxTokens) || budget.maxTokens < 1)) ||
      (budget.maxCostUsd !== null &&
        (!Number.isFinite(budget.maxCostUsd) || budget.maxCostUsd <= 0))
    ) {
      throw new MissionInvariantError("mission budget is invalid");
    }
    state.missions[event.missionId] = {
      id: event.missionId,
      projectId: event.data.projectId,
      title: event.data.title.trim(),
      objective: event.data.objective.trim(),
      status: "draft",
      taskIds: [],
      integrationTrainIds: [],
      policy: { ...event.data.policy },
      budget: { ...event.data.budget },
      createdAt: event.data.createdAt,
      updatedAt: event.occurredAt,
      archivedAt: null,
      cancelledAt: null,
      pausedAt: null,
      activatedAt: null,
      revision: event.revision,
    };
  } else {
    const mission = previousMission;
    if (!mission) throw new MissionInvariantError("mission must be created first");
    if (mission.archivedAt !== null) {
      throw new MissionInvariantError("archived missions are immutable");
    }
    state.missions[event.missionId] = {
      ...mission,
      updatedAt: event.occurredAt,
      revision: event.revision,
    };

    switch (event.type) {
      case "mission.archived":
        if (mission.taskIds.some((id) => state.tasks[id]?.status === "running")) {
          throw new MissionInvariantError("mission with running tasks cannot be archived");
        }
        state.missions[event.missionId] = {
          ...state.missions[event.missionId],
          archivedAt: event.data.archivedAt,
        };
        break;
      case "mission.cancelled":
        state.missions[event.missionId] = {
          ...state.missions[event.missionId],
          cancelledAt: event.data.cancelledAt,
        };
        break;
      case "mission.activated":
        state.missions[event.missionId] = {
          ...state.missions[event.missionId],
          activatedAt: event.data.activatedAt,
          pausedAt: null,
        };
        break;
      case "mission.paused":
        state.missions[event.missionId] = {
          ...state.missions[event.missionId],
          pausedAt: event.data.pausedAt,
        };
        break;
      case "mission.resumed":
        state.missions[event.missionId] = {
          ...state.missions[event.missionId],
          pausedAt: null,
        };
        break;
      case "task.added": {
        assertTaskInput(current, event.missionId, event.data);
        const task: MissionTask = {
          ...event.data,
          title: event.data.title.trim(),
          description: event.data.description.trim(),
          dependencyIds: [...event.data.dependencyIds],
          acceptanceCriteria: [...event.data.acceptanceCriteria],
          declaredFiles: [...event.data.declaredFiles],
          declaredGlobs: [...event.data.declaredGlobs],
          worktreePolicy: { ...event.data.worktreePolicy },
          root: { ...event.data.root },
          status: "draft",
          attemptIds: [],
          qualityGateIds: [],
          artifactIds: [],
          updatedAt: event.data.createdAt,
          archivedAt: null,
          pausedAt: null,
          resumeInstruction: null,
          requeuedAfterAttemptId: null,
        };
        state.tasks[task.id] = task;
        replaceTaskDependencies(state, task);
        state.missions[event.missionId] = {
          ...state.missions[event.missionId],
          taskIds: [...mission.taskIds, task.id],
        };
        assertAcyclicMissionTasks(state.tasks, event.missionId);
        break;
      }
      case "task.updated": {
        const task = state.tasks[event.data.taskId];
        if (!task || task.missionId !== event.missionId) {
          throw new MissionInvariantError("task is unknown");
        }
        if (task.status === "running" || task.archivedAt !== null) {
          throw new MissionInvariantError("active or archived task cannot be edited");
        }
        const patch = event.data.patch;
        if (patch.priority !== undefined &&
          (!Number.isInteger(patch.priority) || patch.priority < 0 || patch.priority > 100)) {
          throw new MissionInvariantError("task priority must be an integer from 0 to 100");
        }
        if (patch.maxAttempts !== undefined &&
          (!Number.isInteger(patch.maxAttempts) ||
            patch.maxAttempts < task.attemptIds.length ||
            patch.maxAttempts > 20)) {
          throw new MissionInvariantError("maxAttempts cannot be below attempt count or above 20");
        }
        if (patch.dependencyIds) {
          unique(patch.dependencyIds, "task dependencies");
          for (const id of patch.dependencyIds) {
            const dependency = state.tasks[id];
            if (!dependency || dependency.missionId !== event.missionId) {
              throw new MissionInvariantError(`unknown task dependency: ${id}`);
            }
          }
        }
        state.tasks[task.id] = {
          ...task,
          ...patch,
          ...(patch.root ? { root: { ...patch.root } } : {}),
          ...(patch.worktreePolicy ? { worktreePolicy: { ...patch.worktreePolicy } } : {}),
          ...(patch.dependencyIds ? { dependencyIds: [...patch.dependencyIds] } : {}),
          ...(patch.acceptanceCriteria ? { acceptanceCriteria: [...patch.acceptanceCriteria] } : {}),
          ...(patch.declaredFiles ? { declaredFiles: [...patch.declaredFiles] } : {}),
          ...(patch.declaredGlobs ? { declaredGlobs: [...patch.declaredGlobs] } : {}),
          updatedAt: event.data.updatedAt,
        };
        // Validate the complete candidate, not only fields touched by this
        // patch, so a migrated malformed task can never be laundered forward.
        const candidate = state.tasks[task.id];
        assertString("task title", candidate.title, 300);
        if (candidate.description.length > 20_000) throw new MissionInvariantError("task description is too long");
        assertString("task role", candidate.role, 100);
        if (!candidate.root.path.trim() || !candidate.root.projectId.trim() ||
          candidate.root.path.length > 8_192 || candidate.root.projectId.length > 200) {
          throw new MissionInvariantError("task root is invalid");
        }
        assertStringList("acceptance criterion", candidate.acceptanceCriteria, 100, 1_000);
        assertStringList("declared file", candidate.declaredFiles, 1_000, 2_000);
        assertStringList("declared glob", candidate.declaredGlobs, 1_000, 2_000);
        replaceTaskDependencies(state, state.tasks[task.id]);
        assertAcyclicMissionTasks(state.tasks, event.missionId);
        break;
      }
      case "task.archived": {
        const task = state.tasks[event.data.taskId];
        if (!task || task.missionId !== event.missionId) throw new MissionInvariantError("task is unknown");
        if (task.status === "running") throw new MissionInvariantError("running task cannot be archived");
        state.tasks[task.id] = { ...task, archivedAt: event.data.archivedAt, updatedAt: event.occurredAt };
        break;
      }
      case "task.paused":
      case "task.resumed": {
        const task = state.tasks[event.data.taskId];
        if (!task || task.missionId !== event.missionId) throw new MissionInvariantError("task is unknown");
        if (event.type === "task.resumed" && task.status !== "paused") {
          throw new MissionInvariantError("only a paused task can be resumed");
        }
        if (
          event.type === "task.paused" &&
          ["running", "succeeded", "failed", "cancelled", "archived"].includes(task.status)
        ) {
          throw new MissionInvariantError(`task cannot be paused from ${task.status}`);
        }
        state.tasks[task.id] = {
          ...task,
          pausedAt: event.type === "task.paused" ? event.data.pausedAt : null,
          updatedAt: event.occurredAt,
        };
        break;
      }
      case "task.requeued": {
        if (event.actor !== "human") {
          throw new MissionInvariantError("only a human can requeue a task");
        }
        const task = state.tasks[event.data.taskId];
        if (!task || task.missionId !== event.missionId) throw new MissionInvariantError("task is unknown");
        const latestAttemptId = task.attemptIds[task.attemptIds.length - 1];
        const latest = latestAttemptId ? state.attempts[latestAttemptId] : null;
        if (!latest || latest.id !== event.data.afterAttemptId ||
          !["needs_human", "blocked", "failed", "cancelled"].includes(latest.status)) {
          throw new MissionInvariantError("requeue must bind the latest terminal attempt");
        }
        assertString("resume instruction", event.data.instruction, 4_000);
        state.tasks[task.id] = {
          ...task,
          resumeInstruction: event.data.instruction.trim(),
          requeuedAfterAttemptId: latest.id,
          updatedAt: event.data.requeuedAt,
        };
        break;
      }
      case "attempt.started": {
        assertId("attempt id", event.data.id);
        if (state.attempts[event.data.id]) throw new MissionInvariantError("attempt id already exists");
        const task = state.tasks[event.data.taskId];
        if (!task || task.missionId !== event.missionId) throw new MissionInvariantError("task is unknown");
        if (["running", "succeeded", "cancelled", "archived", "paused", "blocked_by_dependency"].includes(task.status)) {
          throw new MissionInvariantError(`task cannot start from ${task.status}`);
        }
        if (task.attemptIds.length >= task.maxAttempts) throw new MissionInvariantError("task retry budget exhausted");
        const attempt: TaskAttempt = {
          id: event.data.id,
          missionId: event.missionId,
          taskId: task.id,
          ordinal: task.attemptIds.length + 1,
          status: "running",
          sessionId: event.data.sessionId ?? null,
          workerLabel: event.data.workerLabel ?? null,
          resumeInstruction: task.resumeInstruction,
          startedAt: event.data.startedAt,
          finishedAt: null,
          summary: null,
          error: null,
          report: null,
          artifactIds: [],
        };
        state.attempts[attempt.id] = attempt;
        state.tasks[task.id] = {
          ...task,
          attemptIds: [...task.attemptIds, attempt.id],
          resumeInstruction: null,
          requeuedAfterAttemptId: null,
          updatedAt: event.occurredAt,
        };
        break;
      }
      case "attempt.finished": {
        const attempt = state.attempts[event.data.attemptId];
        if (!attempt || attempt.missionId !== event.missionId) throw new MissionInvariantError("attempt is unknown");
        if (TERMINAL_ATTEMPT.has(attempt.status)) throw new MissionInvariantError("terminal attempt is immutable");
        if (event.data.finishedAt < (attempt.startedAt ?? 0)) throw new MissionInvariantError("attempt finishes before it started");
        state.attempts[attempt.id] = {
          ...attempt,
          status: event.data.status,
          finishedAt: event.data.finishedAt,
          summary: event.data.summary ?? null,
          error: event.data.error ?? null,
          report: event.data.report ? { ...event.data.report } : null,
        };
        state.tasks[attempt.taskId] = {
          ...state.tasks[attempt.taskId],
          updatedAt: event.occurredAt,
        };
        break;
      }
      case "artifact.recorded": {
        const artifact = event.data;
        assertId("artifact id", artifact.id);
        if (artifact.missionId !== event.missionId || state.artifacts[artifact.id]) {
          throw new MissionInvariantError("artifact is invalid or already exists");
        }
        if (artifact.taskId) {
          const task = state.tasks[artifact.taskId];
          if (!task || task.missionId !== event.missionId) throw new MissionInvariantError("artifact task is unknown");
          state.tasks[task.id] = { ...task, artifactIds: [...task.artifactIds, artifact.id] };
        }
        if (artifact.attemptId) {
          const attempt = state.attempts[artifact.attemptId];
          if (!attempt || attempt.missionId !== event.missionId || attempt.taskId !== artifact.taskId) {
            throw new MissionInvariantError("artifact attempt is unknown");
          }
          if (TERMINAL_ATTEMPT.has(attempt.status)) {
            throw new MissionInvariantError("terminal attempt is immutable");
          }
          state.attempts[attempt.id] = { ...attempt, artifactIds: [...attempt.artifactIds, artifact.id] };
        }
        state.artifacts[artifact.id] = { ...artifact, metadata: { ...artifact.metadata } };
        break;
      }
      case "quality_gate.added": {
        const gate = event.data;
        assertId("quality gate id", gate.id);
        if (gate.missionId !== event.missionId || state.qualityGates[gate.id]) {
          throw new MissionInvariantError("quality gate is invalid or already exists");
        }
        if (gate.taskId) {
          const task = state.tasks[gate.taskId];
          if (!task || task.missionId !== event.missionId) throw new MissionInvariantError("quality gate task is unknown");
          state.tasks[task.id] = { ...task, qualityGateIds: [...task.qualityGateIds, gate.id] };
        }
        state.qualityGates[gate.id] = {
          ...gate,
          status: "pending",
          details: null,
          artifactIds: [],
          updatedAt: gate.createdAt,
        };
        break;
      }
      case "quality_gate.resulted": {
        const gate = state.qualityGates[event.data.gateId];
        if (!gate || gate.missionId !== event.missionId) throw new MissionInvariantError("quality gate is unknown");
        for (const id of event.data.artifactIds ?? []) {
          if (!state.artifacts[id] || state.artifacts[id].missionId !== event.missionId) {
            throw new MissionInvariantError(`quality gate artifact is unknown: ${id}`);
          }
        }
        state.qualityGates[gate.id] = {
          ...gate,
          status: event.data.status,
          details: event.data.details ?? null,
          artifactIds: [...(event.data.artifactIds ?? [])],
          updatedAt: event.data.updatedAt,
        };
        break;
      }
      case "integration_train.created": {
        const train = event.data;
        assertId("integration train id", train.id);
        if (train.missionId !== event.missionId || state.integrationTrains[train.id]) {
          throw new MissionInvariantError("integration train is invalid or already exists");
        }
        assertTrainEntries(state, event.missionId, train.entries);
        state.integrationTrains[train.id] = { ...train, entries: train.entries.map((entry) => ({ ...entry })) };
        state.missions[event.missionId] = {
          ...state.missions[event.missionId],
          integrationTrainIds: [...mission.integrationTrainIds, train.id],
        };
        break;
      }
      case "integration_train.updated": {
        const train = state.integrationTrains[event.data.trainId];
        if (!train || train.missionId !== event.missionId) throw new MissionInvariantError("integration train is unknown");
        const entries = event.data.entries ?? train.entries;
        assertTrainEntries(state, event.missionId, entries);
        state.integrationTrains[train.id] = {
          ...train,
          ...(event.data.status ? { status: event.data.status } : {}),
          entries: entries.map((entry) => ({ ...entry })),
          updatedAt: event.data.updatedAt,
        };
        break;
      }
    }
  }

  state.appliedEventIds[event.eventId] = fingerprint;
  if (event.idempotencyKey) state.idempotencyKeys[event.idempotencyKey] = fingerprint;
  refreshMission(state, event.missionId);
  return state;
}

export function replayMissionEvents(events: readonly MissionEvent[]): MissionProjection {
  return events.reduce(reduceMissionEvent, emptyMissionProjection());
}

export function nextMissionRevision(state: MissionProjection, missionId: string): number {
  return (state.missions[missionId]?.revision ?? 0) + 1;
}
