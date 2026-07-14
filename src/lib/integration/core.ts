import type {
  IntegrationTrainEntry,
  MissionArtifact,
  MissionTask,
  QualityGate,
  TaskAttempt,
} from "@/lib/missions/types";
import { buildConflictRadar } from "./conflict-radar";
import type {
  CheckpointPlan,
  EntryReadiness,
  IntegrationCheckpoint,
  IntegrationInput,
  IntegrationOperationPlan,
  IntegrationPlan,
  IntegrationStrategy,
  ObservedChangeSet,
  RegressionPlan,
  RegressionStep,
  RollbackPlan,
} from "./types";

function hash(value: string, seed: number): string {
  let state = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    state ^= value.charCodeAt(index);
    state = Math.imul(state, 16_777_619);
  }
  return (state >>> 0).toString(16).padStart(8, "0");
}

function stableId(prefix: string, parts: readonly string[]): string {
  const value = parts.join("\u001f");
  return `${prefix}_${hash(value, 2_166_136_261)}${hash(value, 3_332_666_709)}`;
}

export function operationIdFor(
  trainId: string,
  taskId: string,
  attemptId: string,
  commit: string,
  strategy: IntegrationStrategy,
  expectedHead: string,
  retryRevision = 0,
): string {
  return stableId("intop", [
    trainId,
    taskId,
    attemptId,
    commit,
    strategy,
    expectedHead,
    `retry:${Math.max(0, Math.floor(retryRevision))}`,
  ]);
}

function validCommit(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/^git:/, "");
  return /^[0-9a-f]{7,64}$/i.test(normalized) ? normalized.toLowerCase() : null;
}

function successfulAttempt(
  task: MissionTask,
  attempts: Readonly<Record<string, TaskAttempt>>,
): TaskAttempt | null {
  if (task.selectedCandidateAttemptId) {
    const selected = attempts[task.selectedCandidateAttemptId];
    return selected?.status === "succeeded" ? selected : null;
  }
  return task.attemptIds
    .map((id) => attempts[id])
    .filter((attempt): attempt is TaskAttempt => Boolean(attempt) && attempt.status === "succeeded")
    .sort((a, b) => b.ordinal - a.ordinal || b.id.localeCompare(a.id))[0] ?? null;
}

function commitForAttempt(
  task: MissionTask,
  attempt: TaskAttempt,
  artifacts: Readonly<Record<string, MissionArtifact>>,
): string | null {
  const commits = Object.values(artifacts)
    .filter(
      (artifact) =>
        artifact.kind === "commit" &&
        artifact.taskId === task.id &&
        artifact.attemptId === attempt.id,
    )
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  for (let index = commits.length - 1; index >= 0; index -= 1) {
    const artifact = commits[index];
    const metadata = artifact.metadata;
    const commit =
      validCommit(metadata.commit) ??
      validCommit(metadata.sha) ??
      validCommit(metadata.hash) ??
      validCommit(artifact.uri);
    if (commit) return commit;
  }
  return null;
}

function taskGates(
  task: MissionTask,
  gates: Readonly<Record<string, QualityGate>>,
): { required: QualityGate[]; missing: string[] } {
  const ids = new Set(task.qualityGateIds);
  for (const gate of Object.values(gates)) {
    if (gate.taskId === task.id && gate.required) ids.add(gate.id);
  }
  const required: QualityGate[] = [];
  const missing: string[] = [];
  for (const id of [...ids].sort()) {
    const gate = gates[id];
    if (!gate) missing.push(id);
    else if (gate.required) required.push(gate);
  }
  return { required, missing };
}

export function assessEntryReadiness(
  entry: IntegrationTrainEntry,
  input: IntegrationInput,
): EntryReadiness {
  const base = { taskId: entry.taskId, attemptId: null, commit: null };
  if (["integrated", "failed", "skipped"].includes(entry.status)) {
    return {
      ...base,
      ready: false,
      code: "entry_terminal",
      blockers: [],
      message: `train entry is ${entry.status}`,
    };
  }
  const task = input.tasks[entry.taskId];
  if (!task) {
    return { ...base, ready: false, code: "task_missing", blockers: [entry.taskId], message: "task is missing" };
  }
  if (task.status !== "succeeded") {
    return {
      ...base,
      ready: false,
      code: "task_not_succeeded",
      blockers: [task.id],
      message: `task status is ${task.status}, not succeeded`,
    };
  }
  const attempt = successfulAttempt(task, input.attempts);
  if (!attempt) {
    return {
      ...base,
      ready: false,
      code: task.attemptIds.length > 0 ? "attempt_not_succeeded" : "attempt_missing",
      blockers: task.attemptIds,
      message: "task has no successful attempt",
    };
  }
  const commit = commitForAttempt(task, attempt, input.artifacts);
  if (!commit || (entry.commit != null && validCommit(entry.commit) !== commit)) {
    return {
      ...base,
      attemptId: attempt.id,
      ready: false,
      code: "commit_missing",
      blockers: [attempt.id],
      message: entry.commit ? "entry commit does not match successful-attempt evidence" : "successful attempt has no commit evidence",
    };
  }

  const trainByTask = new Map(input.train.entries.map((value) => [value.taskId, value]));
  for (const dependencyId of [...new Set(task.dependencyIds)].sort()) {
    const dependency = input.tasks[dependencyId];
    if (!dependency) {
      return { ...base, attemptId: attempt.id, commit, ready: false, code: "dependency_missing", blockers: [dependencyId], message: `dependency ${dependencyId} is missing` };
    }
    if (dependency.status !== "succeeded") {
      return { ...base, attemptId: attempt.id, commit, ready: false, code: "dependency_not_succeeded", blockers: [dependencyId], message: `dependency ${dependencyId} has not succeeded` };
    }
    const dependencyEntry = trainByTask.get(dependencyId);
    if (dependencyEntry && dependencyEntry.status !== "integrated") {
      return { ...base, attemptId: attempt.id, commit, ready: false, code: "dependency_not_integrated", blockers: [dependencyId], message: `dependency ${dependencyId} has not joined the integration branch` };
    }
  }

  const gates = taskGates(task, input.qualityGates);
  if (gates.missing.length > 0) {
    return { ...base, attemptId: attempt.id, commit, ready: false, code: "required_gate_pending", blockers: gates.missing, message: `required gates are missing: ${gates.missing.join(", ")}` };
  }
  const failed = gates.required.filter((gate) => gate.status === "failed").map((gate) => gate.id);
  if (failed.length > 0) {
    return { ...base, attemptId: attempt.id, commit, ready: false, code: "required_gate_failed", blockers: failed, message: `required gates failed: ${failed.join(", ")}` };
  }
  const pending = gates.required
    .filter((gate) => gate.status !== "passed" && gate.status !== "waived")
    .map((gate) => gate.id);
  if (pending.length > 0) {
    return { ...base, attemptId: attempt.id, commit, ready: false, code: "required_gate_pending", blockers: pending, message: `required gates are pending: ${pending.join(", ")}` };
  }
  return {
    ...base,
    attemptId: attempt.id,
    commit,
    ready: true,
    code: "ready",
    blockers: [],
    message: `successful attempt ${attempt.id}, commit evidence and required gates verified`,
  };
}

function operationPlan(
  input: IntegrationInput,
  readiness: EntryReadiness,
): IntegrationOperationPlan {
  if (!readiness.attemptId || !readiness.commit) throw new Error("ready entry lost evidence");
  const operationId = operationIdFor(
    input.train.id,
    readiness.taskId,
    readiness.attemptId,
    readiness.commit,
    input.strategy,
    input.currentHead,
    input.train.entries.find((entry) => entry.taskId === readiness.taskId)?.retryRevision ?? 0,
  );
  const common = {
    targetBranch: input.train.integrationBranch,
    commit: readiness.commit,
    expectedHead: input.currentHead,
  };
  const operation =
    input.strategy === "merge"
      ? ({ kind: "merge", ...common, noFastForward: true } as const)
      : input.strategy === "rebase"
        ? ({ kind: "rebase", ...common, then: "fast_forward" } as const)
        : ({ kind: "cherry_pick", ...common } as const);
  return {
    operationId,
    trainId: input.train.id,
    taskId: readiness.taskId,
    attemptId: readiness.attemptId,
    commit: readiness.commit,
    operation,
    preconditions: [
      `HEAD equals ${input.currentHead}`,
      `commit ${readiness.commit} exists`,
      `operation ${operationId} is not completed`,
    ],
    explanation: `${input.strategy} task ${readiness.taskId} into ${input.train.integrationBranch}`,
  };
}

export function latestCheckpoint(
  trainId: string,
  checkpoints: readonly IntegrationCheckpoint[],
): IntegrationCheckpoint | null {
  return [...checkpoints]
    .filter((checkpoint) => checkpoint.trainId === trainId)
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0] ?? null;
}

function rollbackPlan(input: IntegrationInput): RollbackPlan | null {
  const checkpoint = latestCheckpoint(input.train.id, input.checkpoints ?? []);
  if (!checkpoint) return null;
  return {
    operationId: stableId("rollback", [input.train.id, checkpoint.id, input.currentHead]),
    kind: "reset_to_checkpoint",
    checkpointId: checkpoint.id,
    targetHead: checkpoint.headCommit,
    expectedHead: input.currentHead,
    explanation: `restore the latest checkpoint ${checkpoint.id} at ${checkpoint.headCommit}`,
  };
}

function checkpointPlan(input: IntegrationInput): CheckpointPlan | null {
  const integrated = input.train.entries
    .filter((entry) => entry.status === "integrated")
    .sort((a, b) => a.position - b.position || a.taskId.localeCompare(b.taskId))
    .map((entry) => entry.taskId);
  const latest = latestCheckpoint(input.train.id, input.checkpoints ?? []);
  if (!latest) {
    return {
      checkpointId: stableId("checkpoint", [input.train.id, input.currentHead, ...integrated]),
      headCommit: input.currentHead,
      integratedTaskIds: integrated,
      reason: "create the baseline checkpoint before the first integration operation",
    };
  }
  const checkpointed = latest?.integratedTaskIds.filter((id) => integrated.includes(id)).length ?? 0;
  const interval = Math.max(1, Math.floor(input.stopPolicy.checkpointEvery));
  if (integrated.length === 0 || integrated.length - checkpointed < interval) return null;
  return {
    checkpointId: stableId("checkpoint", [input.train.id, input.currentHead, ...integrated]),
    headCommit: input.currentHead,
    integratedTaskIds: integrated,
    reason: `${integrated.length - checkpointed} integrations completed since the last checkpoint`,
  };
}

export function planCombinedRegression(input: IntegrationInput): RegressionPlan {
  const gates = Object.values(input.qualityGates)
    .filter(
      (gate) =>
        gate.missionId === input.train.missionId && gate.required && gate.status !== "waived",
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  const groups = new Map<string, QualityGate[]>();
  for (const gate of gates) {
    if (!gate.command?.trim()) continue;
    const command = gate.command.trim();
    const group = groups.get(command) ?? [];
    group.push(gate);
    groups.set(command, group);
  }
  const steps: RegressionStep[] = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([command, grouped]) => {
      const gateIds = grouped.map((gate) => gate.id).sort();
      return {
        stepId: stableId("regstep", [input.train.id, input.currentHead, command, ...gateIds]),
        gateIds,
        label: grouped.map((gate) => gate.label).sort().join(" + "),
        command,
        required: true,
      };
    });
  const pendingGateIds = gates
    .filter((gate) => gate.status !== "passed" && gate.status !== "waived")
    .map((gate) => gate.id);
  const failedGateIds = gates.filter((gate) => gate.status === "failed").map((gate) => gate.id);
  const commandless = gates.filter((gate) => !gate.command?.trim()).map((gate) => gate.id);
  const planId = stableId("regression", [
    input.train.id,
    input.currentHead,
    ...steps.map((step) => `${step.command}:${step.gateIds.join(",")}`),
  ]);
  const ready = failedGateIds.length === 0 && commandless.length === 0;
  return {
    planId,
    trainId: input.train.id,
    steps,
    pendingGateIds,
    failedGateIds,
    ready,
    explanation: !ready
      ? `combined regression is blocked by gates: ${[...failedGateIds, ...commandless].sort().join(", ")}`
      : steps.length === 0
        ? "no required combined regression commands"
        : `${steps.length} deduplicated combined regression steps`,
  };
}

function integratedSources(input: IntegrationInput): ObservedChangeSet[] {
  return input.train.entries
    .filter((entry) => entry.status === "integrated")
    .flatMap((entry): ObservedChangeSet[] => {
      const task = input.tasks[entry.taskId];
      return task
        ? [{ id: `integrated:${task.id}`, taskId: task.id, files: task.declaredFiles, globs: task.declaredGlobs }]
        : [];
    });
}

function failurePlan(input: IntegrationInput): IntegrationPlan | null {
  const failure = input.failure;
  if (!failure) return null;
  const policy =
    failure.kind === "gate_failed"
      ? input.stopPolicy.onGateFailure
      : failure.kind === "merge_conflict"
        ? input.stopPolicy.onConflict
        : input.stopPolicy.onOperationFailure;
  if (policy === "rollback") {
    const rollback = rollbackPlan(input);
    return {
      action: rollback ? "rollback" : "blocked",
      readyQueue: [],
      evaluations: [],
      conflicts: [],
      operation: null,
      rollback,
      checkpoint: null,
      regression: null,
      explanation: rollback
        ? `${failure.kind}: ${failure.detail}; rollback planned`
        : `${failure.kind}: ${failure.detail}; rollback requested but no checkpoint exists`,
    };
  }
  return {
    action: policy === "needs_human" ? "needs_human" : policy === "continue" ? "reconcile" : "blocked",
    readyQueue: [],
    evaluations: [],
    conflicts: [],
    operation: null,
    rollback: null,
    checkpoint: null,
    regression: null,
    explanation:
      policy === "continue"
        ? `${failure.kind}: ${failure.detail}; settle the failed entry before continuing`
        : `${failure.kind}: ${failure.detail}`,
  };
}

/** Produce exactly one safe next integration action from a durable snapshot. */
export function planIntegration(input: IntegrationInput): IntegrationPlan {
  const failed = failurePlan(input);
  if (failed) return failed;
  if (input.train.status === "cancelled") {
    return { action: "blocked", readyQueue: [], evaluations: [], conflicts: [], operation: null, rollback: null, checkpoint: null, regression: null, explanation: "integration train is cancelled" };
  }
  if (input.train.status === "blocked") {
    return { action: "blocked", readyQueue: [], evaluations: [], conflicts: [], operation: null, rollback: null, checkpoint: null, regression: null, explanation: "integration train is blocked" };
  }

  const entries = [...input.train.entries].sort(
    (a, b) => a.position - b.position || a.taskId.localeCompare(b.taskId),
  );
  const evaluations = entries.map((entry) => assessEntryReadiness(entry, input));
  const readyQueue = evaluations.filter((entry) => entry.ready);
  const failedEntry = entries.find((entry) => entry.status === "failed");
  if (failedEntry) {
    const critical =
      input.stopPolicy.stopOnCriticalRisk &&
      input.tasks[failedEntry.taskId]?.risk === "critical";
    if (input.stopPolicy.onOperationFailure === "rollback" && !critical) {
      const rollback = rollbackPlan(input);
      return { action: rollback ? "rollback" : "blocked", readyQueue, evaluations, conflicts: [], operation: null, rollback, checkpoint: null, regression: null, explanation: rollback ? `entry ${failedEntry.taskId} failed; rollback planned` : `entry ${failedEntry.taskId} failed; no checkpoint exists` };
    }
    return { action: input.stopPolicy.onOperationFailure === "continue" && !critical ? "reconcile" : "blocked", readyQueue, evaluations, conflicts: [], operation: null, rollback: null, checkpoint: null, regression: null, explanation: critical ? `critical task ${failedEntry.taskId} failed; train stopped` : `entry ${failedEntry.taskId} failed; settle it according to the stop policy` };
  }
  const failedGateEvaluation = evaluations.find((entry) => entry.code === "required_gate_failed");
  if (failedGateEvaluation) {
    if (input.stopPolicy.onGateFailure === "rollback") {
      const rollback = rollbackPlan(input);
      return { action: rollback ? "rollback" : "blocked", readyQueue, evaluations, conflicts: [], operation: null, rollback, checkpoint: null, regression: null, explanation: rollback ? `${failedGateEvaluation.message}; rollback planned` : `${failedGateEvaluation.message}; no checkpoint exists` };
    }
    return { action: "blocked", readyQueue, evaluations, conflicts: [], operation: null, rollback: null, checkpoint: null, regression: null, explanation: failedGateEvaluation.message };
  }
  const allSettled = entries.every((entry) => ["integrated", "skipped"].includes(entry.status));
  if (input.train.status === "completed" && !allSettled) {
    return { action: "blocked", readyQueue, evaluations, conflicts: [], operation: null, rollback: null, checkpoint: null, regression: null, explanation: "train is marked completed but still has unsettled entries" };
  }
  if (allSettled) {
    const regression = planCombinedRegression(input);
    const completed = input.completedRegressionPlanIds?.has(regression.planId) ?? false;
    if (!regression.ready) {
      return { action: "blocked", readyQueue, evaluations, conflicts: [], operation: null, rollback: null, checkpoint: null, regression, explanation: regression.explanation };
    }
    if (regression.steps.length > 0 && !completed) {
      return { action: "run_regression", readyQueue, evaluations, conflicts: [], operation: null, rollback: null, checkpoint: null, regression, explanation: regression.explanation };
    }
    if (completed && regression.pendingGateIds.length > 0) {
      return { action: "wait", readyQueue, evaluations, conflicts: [], operation: null, rollback: null, checkpoint: null, regression, explanation: `regression operation completed; waiting for gate results: ${regression.pendingGateIds.join(", ")}` };
    }
    return { action: "complete", readyQueue, evaluations, conflicts: [], operation: null, rollback: null, checkpoint: null, regression, explanation: "all entries and combined regression gates are complete" };
  }

  const checkpoint = checkpointPlan(input);
  if (checkpoint) {
    return { action: "checkpoint", readyQueue, evaluations, conflicts: [], operation: null, rollback: null, checkpoint, regression: null, explanation: checkpoint.reason };
  }
  const next = readyQueue[0];
  if (!next) {
    return { action: "wait", readyQueue, evaluations, conflicts: [], operation: null, rollback: null, checkpoint: null, regression: null, explanation: "no train entry currently satisfies attempt, commit, dependency and gate requirements" };
  }
  const task = input.tasks[next.taskId];
  const conflicts = buildConflictRadar(task, [...integratedSources(input), ...(input.observedChanges ?? [])]);
  const blockingConflict = conflicts.find((conflict) => conflict.severity !== "medium");
  if (blockingConflict) {
    if (input.stopPolicy.onConflict === "rollback") {
      const rollback = rollbackPlan(input);
      return { action: rollback ? "rollback" : "blocked", readyQueue, evaluations, conflicts, operation: null, rollback, checkpoint: null, regression: null, explanation: rollback ? `${blockingConflict.message}; rollback planned` : `${blockingConflict.message}; no checkpoint exists` };
    }
    return { action: input.stopPolicy.onConflict === "needs_human" ? "needs_human" : "blocked", readyQueue, evaluations, conflicts, operation: null, rollback: null, checkpoint: null, regression: null, explanation: blockingConflict.message };
  }
  if (input.stopPolicy.stopOnCriticalRisk && task.risk === "critical") {
    return { action: "needs_human", readyQueue, evaluations, conflicts, operation: null, rollback: null, checkpoint: null, regression: null, explanation: `critical-risk task ${task.id} requires human confirmation` };
  }

  const operation = operationPlan(input, next);
  if (input.activeOperationIds?.has(operation.operationId)) {
    return { action: "wait", readyQueue, evaluations, conflicts, operation, rollback: null, checkpoint: null, regression: null, explanation: `operation ${operation.operationId} is already owned by an active executor` };
  }
  if (
    input.completedOperationIds?.has(operation.operationId) ||
    input.integratedCommits?.has(operation.commit)
  ) {
    return { action: "reconcile", readyQueue, evaluations, conflicts, operation, rollback: null, checkpoint: null, regression: null, explanation: `operation ${operation.operationId} is already effective; reconcile the durable train entry without executing git again` };
  }
  return { action: "execute", readyQueue, evaluations, conflicts, operation, rollback: null, checkpoint: null, regression: null, explanation: operation.explanation };
}
