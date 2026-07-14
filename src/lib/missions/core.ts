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
import { candidatesForBatch, selectCandidateAttempt } from "./candidates";

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
    candidateBatches: Object.create(null),
    schedules: Object.create(null),
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
    candidateBatches: { ...state.candidateBatches },
    schedules: { ...state.schedules },
    appliedEventIds: { ...state.appliedEventIds },
    idempotencyKeys: { ...state.idempotencyKeys },
  };
}

/** Full persisted event identity. Event ids bind transport metadata too. */
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

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

/** Canonical command identity: retries may have fresh event transport metadata. */
export function missionCommandFingerprint(event: MissionEvent): string {
  return JSON.stringify(canonicalValue({
    missionId: event.missionId,
    actor: event.actor,
    type: event.type,
    data: event.data,
  }));
}

function taskAttempts(state: MissionProjection, task: MissionTask): TaskAttempt[] {
  return task.attemptIds
    .map((id) => state.attempts[id])
    .filter((value): value is TaskAttempt => !!value);
}

/** Attempt whose commit is authoritative for downstream integration. */
export function selectedAttemptForTask(
  state: MissionProjection,
  task: MissionTask,
): TaskAttempt | null {
  if (task.selectedCandidateAttemptId) return state.attempts[task.selectedCandidateAttemptId] ?? null;
  const attempts = taskAttempts(state, task).filter((attempt) => attempt.status === "succeeded");
  return attempts[attempts.length - 1] ?? null;
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
  const latestBatch = Object.values(state.candidateBatches)
    .filter((batch) => batch.taskId === task.id)
    .sort((left, right) => right.requestedAt - left.requestedAt || right.id.localeCompare(left.id))[0];
  if (latestBatch && !latestBatch.selectedAttemptId) {
    const batchAttempts = latestBatch.attemptIds
      .map((id) => state.attempts[id])
      .filter((attempt): attempt is TaskAttempt => !!attempt);
    if (batchAttempts.length < latestBatch.count) {
      return batchAttempts.length === 0 ? "ready" : "running";
    }
    if (batchAttempts.some((attempt) => attempt.status === "running")) return "running";
    return "needs_human";
  }
  const selected = latestBatch?.selectedAttemptId
    ? state.attempts[latestBatch.selectedAttemptId]
    : null;
  const latest = selected ?? attempts[attempts.length - 1];
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
  if (task.allowNoop !== undefined && typeof task.allowNoop !== "boolean") {
    throw new MissionInvariantError("task allowNoop must be boolean");
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
    if (!["queued", "integrating", "integrated", "failed", "skipped"].includes(entry.status)) {
      throw new MissionInvariantError("integration train entry status is invalid");
    }
    if (entry.commit !== null && !/^[0-9a-f]{7,64}$/i.test(entry.commit)) {
      throw new MissionInvariantError("integration train entry commit is invalid");
    }
    if (entry.detail !== null && (typeof entry.detail !== "string" || entry.detail.length > 2_000)) {
      throw new MissionInvariantError("integration train entry detail is invalid");
    }
    if (entry.retryRevision !== undefined &&
      (!Number.isSafeInteger(entry.retryRevision) || entry.retryRevision < 0 || entry.retryRevision > 1_000)) {
      throw new MissionInvariantError("integration train retry revision is invalid");
    }
    if (entry.operationId !== undefined && entry.operationId !== null &&
      (typeof entry.operationId !== "string" || !entry.operationId.trim() || entry.operationId.length > 240)) {
      throw new MissionInvariantError("integration train operation id is invalid");
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
  const commandFingerprint = missionCommandFingerprint(event);
  const applied = current.appliedEventIds[event.eventId];
  if (applied !== undefined) {
    if (applied !== fingerprint) throw new MissionInvariantError("event id conflict");
    return current;
  }
  if (event.idempotencyKey) {
    assertString("idempotency key", event.idempotencyKey, 200);
    const prior = current.idempotencyKeys[event.idempotencyKey];
    if (prior !== undefined) {
      if (prior !== commandFingerprint) {
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
        !["continue", "pause_mission", "needs_human", "cancel_mission"].includes(policy.stopOnConflict)) ||
      (policy.runtimeEnvironment !== undefined && policy.runtimeEnvironment !== null &&
        (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(policy.runtimeEnvironment.environmentId) ||
          !/^sha256:[0-9a-f]{64}$/.test(policy.runtimeEnvironment.specFingerprint)))
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
      policy: {
        ...event.data.policy,
        runtimeEnvironment: event.data.policy.runtimeEnvironment
          ? { ...event.data.policy.runtimeEnvironment }
          : null,
      },
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
          selectedCandidateAttemptId: null,
          allowNoop: event.data.allowNoop === true,
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
        if (patch.allowNoop !== undefined && event.actor !== "human") {
          throw new MissionInvariantError("only a human can approve no-op task success");
        }
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
        if (candidate.allowNoop !== undefined && typeof candidate.allowNoop !== "boolean") {
          throw new MissionInvariantError("task allowNoop must be boolean");
        }
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
        if (task.status === "running" || task.attemptIds.some((id) => state.attempts[id]?.status === "running")) {
          throw new MissionInvariantError("task with a running attempt cannot be archived");
        }
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
          ["succeeded", "failed", "cancelled", "archived"].includes(task.status)
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
        const batch = event.data.candidateBatchId
          ? state.candidateBatches[event.data.candidateBatchId]
          : null;
        if (event.data.candidateBatchId &&
          (!batch || batch.taskId !== task.id || batch.selectedAttemptId || batch.attemptIds.length >= batch.count)) {
          throw new MissionInvariantError("candidate batch cannot accept this attempt");
        }
        if (["cancelled", "archived", "paused", "blocked_by_dependency"].includes(task.status) ||
          (task.status === "succeeded" && !batch) ||
          (task.status === "running" && !batch)) {
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
          candidateBatchId: batch?.id ?? null,
        };
        state.attempts[attempt.id] = attempt;
        state.tasks[task.id] = {
          ...task,
          attemptIds: [...task.attemptIds, attempt.id],
          resumeInstruction: null,
          requeuedAfterAttemptId: null,
          ...(batch ? {} : { selectedCandidateAttemptId: null }),
          updatedAt: event.occurredAt,
        };
        if (batch) {
          state.candidateBatches[batch.id] = {
            ...batch,
            attemptIds: [...batch.attemptIds, attempt.id],
          };
        }
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
      case "candidate_batch.requested": {
        if (event.actor !== "human") throw new MissionInvariantError("only a human can request candidate attempts");
        const data = event.data;
        assertId("candidate batch id", data.id);
        const task = state.tasks[data.taskId];
        if (!task || task.missionId !== event.missionId) throw new MissionInvariantError("candidate task is unknown");
        if (state.candidateBatches[data.id]) throw new MissionInvariantError("candidate batch already exists");
        if (!Number.isInteger(data.count) || data.count < 2 || data.count > 8) {
          throw new MissionInvariantError("candidate count must be 2..8");
        }
        if (!["ready", "failed", "blocked", "needs_human", "succeeded"].includes(task.status) ||
          task.attemptIds.length + data.count > task.maxAttempts) {
          throw new MissionInvariantError("candidate attempts exceed the available task budget");
        }
        if (Object.values(state.candidateBatches).some((batch) =>
          batch.taskId === task.id && !batch.selectedAttemptId)) {
          throw new MissionInvariantError("task already has an open candidate batch");
        }
        if (Object.values(state.integrationTrains).some((train) =>
          train.missionId === event.missionId &&
          train.entries.some((entry) => entry.taskId === task.id && entry.status === "integrated"))) {
          throw new MissionInvariantError("integrated tasks cannot start a new candidate batch");
        }
        assertString("candidate instruction", data.instruction, 4_000);
        if (!Number.isInteger(data.minimumEvidenceCount) || data.minimumEvidenceCount < 1 || data.minimumEvidenceCount > 64 ||
          !Number.isFinite(data.minimumScoreMargin) || data.minimumScoreMargin < 0 || data.minimumScoreMargin > 10_000) {
          throw new MissionInvariantError("candidate evidence policy is invalid");
        }
        state.candidateBatches[data.id] = {
          ...data,
          attemptIds: [],
          selectedAttemptId: null,
          selectedAt: null,
        };
        break;
      }
      case "candidate_batch.selected":
      case "candidate_batch.overridden": {
        if (event.actor !== "human") throw new MissionInvariantError("only a human can choose a candidate");
        const batch = state.candidateBatches[event.data.batchId];
        if (!batch || batch.missionId !== event.missionId || batch.selectedAttemptId) {
          throw new MissionInvariantError("candidate batch is unknown or already selected");
        }
        if (batch.attemptIds.length !== batch.count || batch.attemptIds.some((id) => state.attempts[id]?.status === "running")) {
          throw new MissionInvariantError("all candidate attempts must be terminal before selection");
        }
        const attempt = state.attempts[event.data.attemptId];
        if (!attempt || !batch.attemptIds.includes(attempt.id) || attempt.status !== "succeeded") {
          throw new MissionInvariantError("selected candidate must be a successful batch attempt");
        }
        if (!Object.values(state.artifacts).some((artifact) =>
          artifact.attemptId === attempt.id && artifact.taskId === batch.taskId)) {
          throw new MissionInvariantError("selected candidate needs artifact-backed evidence");
        }
        const selection = selectCandidateAttempt(candidatesForBatch(state, batch), {
          minimumEvidenceCount: batch.minimumEvidenceCount,
          minimumScoreMargin: batch.minimumScoreMargin,
          tieBreakers: ["lower_tokens", "lower_duration", "attempt_id"],
        });
        if (event.type === "candidate_batch.selected") {
          if (selection.decision !== "selected" || selection.selectedAttemptId !== attempt.id) {
            throw new MissionInvariantError("candidate does not match the unambiguous evidence decision");
          }
        } else {
          assertString("candidate override reason", event.data.reason, 1_000);
          if (selection.decision === "selected") {
            throw new MissionInvariantError("an unambiguous evidence decision cannot be overridden");
          }
        }
        state.candidateBatches[batch.id] = {
          ...batch,
          selectedAttemptId: attempt.id,
          selectedAt: event.data.selectedAt,
        };
        state.tasks[batch.taskId] = {
          ...state.tasks[batch.taskId],
          selectedCandidateAttemptId: attempt.id,
          updatedAt: event.data.selectedAt,
        };
        // Quality gates are projected at task level for the normal one-attempt
        // path. Candidate lanes produce independent, attempt-bound artifacts;
        // selecting a winner must therefore rematerialize every task gate from
        // that exact attempt instead of leaving the last-finishing candidate's
        // result authoritative.
        const selectedArtifacts = Object.values(state.artifacts)
          .filter((artifact) => artifact.taskId === batch.taskId && artifact.attemptId === attempt.id)
          .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
        for (const gateId of state.tasks[batch.taskId].qualityGateIds) {
          const gate = state.qualityGates[gateId];
          if (!gate || gate.status === "waived") continue;
          const artifact = [...selectedArtifacts].reverse().find((candidate) => {
            if (candidate.metadata.authority !== "swarmz_native") return false;
            if (gate.command) {
              return candidate.kind === "test_result" &&
                candidate.metadata.evidenceKind === "test" &&
                candidate.metadata.command === gate.command;
            }
            return candidate.metadata.evidenceKind === "review";
          });
          const raw = typeof artifact?.metadata.status === "string"
            ? artifact.metadata.status.toLowerCase()
            : null;
          const exitCode = typeof artifact?.metadata.exitCode === "number"
            ? artifact.metadata.exitCode
            : null;
          const passed = raw === "passed" || raw === "success" || exitCode === 0;
          const failed = raw === "failed" || raw === "failure" || (exitCode !== null && exitCode !== 0);
          state.qualityGates[gate.id] = {
            ...gate,
            status: passed ? "passed" : failed ? "failed" : "pending",
            details: artifact
              ? String(artifact.metadata.detail ?? `Selected candidate evidence: ${artifact.label}`).slice(0, 1_000)
              : "Selected candidate has no matching native evidence for this gate",
            artifactIds: artifact ? [artifact.id] : [],
            updatedAt: event.data.selectedAt,
          };
        }
        break;
      }
      case "schedule.created": {
        const schedule = event.data;
        assertId("schedule id", schedule.id);
        if (schedule.missionId !== event.missionId || schedule.projectId !== mission.projectId || state.schedules[schedule.id]) {
          throw new MissionInvariantError("mission schedule identity is invalid");
        }
        assertString("schedule note", schedule.note, 500);
        if (!Number.isFinite(schedule.at) || schedule.at < event.occurredAt - 60_000 || schedule.at > event.occurredAt + 365 * 24 * 60 * 60_000) {
          throw new MissionInvariantError("schedule time is invalid");
        }
        if (schedule.cancelledAt !== null || schedule.claimedAt !== null || schedule.firedAt !== null) {
          throw new MissionInvariantError("new schedule must be pending");
        }
        state.schedules[schedule.id] = {
          ...schedule,
          note: schedule.note.trim(),
          deliveryAttempts: schedule.deliveryAttempts ?? 0,
          lastDeliveryError: schedule.lastDeliveryError ?? null,
          nextAttemptAt: schedule.nextAttemptAt ?? null,
        };
        break;
      }
      case "schedule.cancelled":
      case "schedule.claimed":
      case "schedule.delivery_failed":
      case "schedule.fired": {
        const schedule = state.schedules[event.data.scheduleId];
        if (!schedule || schedule.missionId !== event.missionId) throw new MissionInvariantError("schedule is unknown");
        if (event.type === "schedule.cancelled") {
          if (schedule.claimedAt !== null || schedule.cancelledAt !== null) throw new MissionInvariantError("schedule is no longer cancellable");
          state.schedules[schedule.id] = { ...schedule, cancelledAt: event.data.cancelledAt };
        } else if (event.type === "schedule.claimed") {
          if (event.actor !== "system" || schedule.cancelledAt !== null || schedule.claimedAt !== null) throw new MissionInvariantError("schedule cannot be claimed");
          state.schedules[schedule.id] = {
            ...schedule,
            claimedAt: event.data.claimedAt,
            deliveryAttempts: (schedule.deliveryAttempts ?? 0) + 1,
            lastDeliveryError: null,
          };
        } else if (event.type === "schedule.delivery_failed") {
          if (event.actor !== "system" || schedule.claimedAt === null || schedule.firedAt !== null || schedule.cancelledAt !== null) {
            throw new MissionInvariantError("only a claimed reminder can record delivery failure");
          }
          assertString("schedule delivery error", event.data.error, 1_000);
          if (!Number.isFinite(event.data.nextAttemptAt) || event.data.nextAttemptAt < event.data.failedAt) {
            throw new MissionInvariantError("schedule retry time is invalid");
          }
          state.schedules[schedule.id] = {
            ...schedule,
            claimedAt: null,
            lastDeliveryError: event.data.error.trim(),
            nextAttemptAt: event.data.nextAttemptAt,
          };
        } else {
          if (event.actor !== "system" || schedule.claimedAt === null || schedule.firedAt !== null) throw new MissionInvariantError("schedule must be claimed before firing");
          state.schedules[schedule.id] = {
            ...schedule,
            firedAt: event.data.firedAt,
            lastDeliveryError: null,
            nextAttemptAt: null,
          };
        }
        break;
      }
    }
  }

  state.appliedEventIds[event.eventId] = fingerprint;
  if (event.idempotencyKey) state.idempotencyKeys[event.idempotencyKey] = commandFingerprint;
  refreshMission(state, event.missionId);
  return state;
}

export function replayMissionEvents(events: readonly MissionEvent[]): MissionProjection {
  return events.reduce(reduceMissionEvent, emptyMissionProjection());
}

export function nextMissionRevision(state: MissionProjection, missionId: string): number {
  return (state.missions[missionId]?.revision ?? 0) + 1;
}
