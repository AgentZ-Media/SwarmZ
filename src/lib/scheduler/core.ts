import type { MissionTask, TaskStatus } from "@/lib/missions/types";
import {
  conflictWithLeases,
  lockKeysForTask,
  provisionalLease,
} from "./conflicts";
import type {
  AdaptiveCapacity,
  RecoveryDecision,
  RetryDecision,
  RetryPolicy,
  SchedulableTask,
  SchedulerDecision,
  SchedulerHealthSignals,
  SchedulerInput,
  SchedulerLimits,
  SchedulerReason,
  TaskControlCommand,
  TaskControlDecision,
  TaskEvaluation,
} from "./types";

const TERMINAL_STATUSES = new Set<TaskStatus>([
  "failed",
  "succeeded",
  "cancelled",
  "archived",
]);

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function nonNegativeInteger(value: number): number {
  return Math.max(0, Math.floor(finite(value)));
}

function ratio(value: number | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

/** Compute the safety-reduced fleet cap without inspecting individual tasks. */
export function adaptiveCapacity(
  limits: SchedulerLimits,
  backendActiveCount: number,
  managedActiveCount: number,
  signals: SchedulerHealthSignals = {},
): AdaptiveCapacity {
  const requested = nonNegativeInteger(limits.globalConcurrency);
  const hardCap = nonNegativeInteger(limits.hardBackendCap);
  let effective = Math.min(requested, hardCap);
  const reasons: string[] = [];
  const remaining = ratio(signals.rateLimitRemainingRatio);
  const failures = ratio(signals.recentFailureRatio);
  const memory = ratio(signals.memoryPressure);

  if (signals.paused) {
    effective = 0;
    reasons.push("scheduler is globally paused");
  } else if (signals.health === "critical") {
    effective = 0;
    reasons.push("runtime health is critical");
  } else {
    if (signals.health === "degraded" && effective > 1) {
      effective = Math.max(1, Math.ceil(effective / 2));
      reasons.push("runtime health is degraded; concurrency halved");
    }
    if (remaining != null && remaining <= 0.05) {
      effective = 0;
      reasons.push("rate-limit allowance is nearly exhausted");
    } else if (remaining != null && remaining <= 0.2 && effective > 1) {
      effective = 1;
      reasons.push("rate-limit allowance is low; concurrency reduced to one");
    }
    if (failures != null && failures >= 0.5 && effective > 1) {
      effective = Math.max(1, Math.floor(effective / 2));
      reasons.push("recent worker failure ratio is high; concurrency halved");
    } else if (failures != null && failures >= 0.25 && effective > 1) {
      effective -= 1;
      reasons.push("recent worker failures reduced concurrency by one");
    }
    if (memory != null && memory >= 0.9) {
      effective = 0;
      reasons.push("host memory pressure is critical");
    } else if (memory != null && memory >= 0.75 && effective > 1) {
      effective = Math.max(1, Math.floor(effective / 2));
      reasons.push("host memory pressure is high; concurrency halved");
    }
  }

  const hardBackendAvailable = Math.max(
    0,
    hardCap - nonNegativeInteger(backendActiveCount),
  );
  const managedAvailable = Math.max(
    0,
    effective - nonNegativeInteger(managedActiveCount),
  );
  const available = Math.min(hardBackendAvailable, managedAvailable);
  if (requested > hardCap) {
    reasons.push(`requested concurrency is capped by the hard backend limit (${hardCap})`);
  }
  if (hardBackendAvailable === 0 && hardCap > 0) {
    reasons.push("the hard backend limit is fully occupied");
  }
  if (reasons.length === 0) reasons.push("all capacity signals are healthy");
  return { requested, effective, available, hardBackendAvailable, reasons };
}

export function effectivePriority(
  candidate: SchedulableTask,
  now: number,
  agingIntervalMs: number,
): number {
  const age = Math.max(0, finite(now) - finite(candidate.enqueuedAt, now));
  const interval = Math.max(1, nonNegativeInteger(agingIntervalMs));
  return Math.min(100, Math.max(0, finite(candidate.task.priority))) + Math.floor(age / interval);
}

function compareCandidates(
  left: SchedulableTask,
  right: SchedulableTask,
  now: number,
  interval: number,
): number {
  const score = effectivePriority(right, now, interval) - effectivePriority(left, now, interval);
  if (score !== 0) return score;
  if (left.enqueuedAt !== right.enqueuedAt) return left.enqueuedAt - right.enqueuedAt;
  const project = left.task.root.projectId.localeCompare(right.task.root.projectId);
  if (project !== 0) return project;
  const mission = left.task.missionId.localeCompare(right.task.missionId);
  if (mission !== 0) return mission;
  return left.task.id.localeCompare(right.task.id);
}

function projectLimit(limits: SchedulerLimits, projectId: string): number {
  const configured = limits.perProjectConcurrency;
  return nonNegativeInteger(
    typeof configured === "number"
      ? configured
      : (configured[projectId] ?? configured.default),
  );
}

function missionLimit(limits: SchedulerLimits, missionId: string): number {
  const configured = limits.perMissionConcurrency;
  if (configured === undefined) return nonNegativeInteger(limits.globalConcurrency);
  return nonNegativeInteger(
    typeof configured === "number"
      ? configured
      : (configured[missionId] ?? configured.default),
  );
}

function dependencyReason(
  candidate: SchedulableTask,
  taskById: ReadonlyMap<string, SchedulableTask>,
): SchedulerReason | null {
  const missing: string[] = [];
  const failed: string[] = [];
  const pending: string[] = [];
  for (const dependencyId of [...new Set(candidate.task.dependencyIds)].sort()) {
    const dependency = taskById.get(dependencyId);
    if (!dependency) missing.push(dependencyId);
    else if (["failed", "cancelled", "archived"].includes(dependency.task.status))
      failed.push(dependencyId);
    else if (dependency.task.status !== "succeeded") pending.push(dependencyId);
  }
  if (missing.length > 0)
    return {
      code: "dependency_missing",
      blockers: missing,
      message: `missing dependencies: ${missing.join(", ")}`,
    };
  if (failed.length > 0)
    return {
      code: "dependency_failed",
      blockers: failed,
      message: `dependencies did not succeed: ${failed.join(", ")}`,
    };
  if (pending.length > 0)
    return {
      code: "dependency_pending",
      blockers: pending,
      message: `waiting for dependencies: ${pending.join(", ")}`,
    };
  return null;
}

function dependencyCycle(
  candidate: SchedulableTask,
  taskById: ReadonlyMap<string, SchedulableTask>,
): string[] | null {
  const origin = candidate.task.id;
  const visit = (taskId: string, path: readonly string[], seen: ReadonlySet<string>): string[] | null => {
    const current = taskById.get(taskId);
    if (!current) return null;
    for (const dependencyId of [...new Set(current.task.dependencyIds)].sort()) {
      if (dependencyId === origin) return [...path, taskId, origin];
      if (seen.has(dependencyId)) continue;
      const nextSeen = new Set(seen);
      nextSeen.add(dependencyId);
      const found = visit(dependencyId, [...path, taskId], nextSeen);
      if (found) return found;
    }
    return null;
  };
  return visit(origin, [], new Set([origin]));
}

function staticEligibility(
  candidate: SchedulableTask,
  input: SchedulerInput,
  taskById: ReadonlyMap<string, SchedulableTask>,
  activeTaskIds: ReadonlySet<string>,
): SchedulerReason | null {
  const task = candidate.task;
  if (!task.id || !task.missionId || !task.root.projectId || !task.root.path) {
    return { code: "invalid_task", message: "task identity and root must be complete" };
  }
  if (activeTaskIds.has(task.id)) {
    return { code: "already_active", message: "task already owns an active backend lease" };
  }
  if (TERMINAL_STATUSES.has(task.status)) {
    return { code: "terminal", message: `task is terminal (${task.status})` };
  }
  if (task.status === "needs_human" || task.status === "blocked") {
    return {
      code: "needs_human",
      message: `task requires intervention (${task.status})`,
    };
  }
  if (task.status === "paused") {
    return { code: "task_paused", message: "task is paused" };
  }
  if (task.status === "running") {
    return {
      code: "invalid_task",
      message: "task is marked running but owns no active backend lease",
    };
  }
  if (task.status === "draft") {
    return { code: "invalid_task", message: "draft task is not admitted to the ready queue" };
  }
  if (input.pausedMissionIds?.has(task.missionId)) {
    return { code: "mission_paused", message: "mission is paused" };
  }
  const cycle = dependencyCycle(candidate, taskById);
  if (cycle) {
    return {
      code: "dependency_cycle",
      blockers: cycle,
      message: `dependency cycle: ${cycle.join(" -> ")}`,
    };
  }
  const dependency = dependencyReason(candidate, taskById);
  if (dependency) return dependency;
  if ((candidate.nextEligibleAt ?? 0) > input.now) {
    return {
      code: "retry_backoff",
      message: `retry backoff lasts until ${candidate.nextEligibleAt}`,
    };
  }
  if (task.status !== "ready" && task.status !== "blocked_by_dependency") {
    return { code: "invalid_task", message: `status ${task.status} is not schedulable` };
  }
  return null;
}

function capacityReason(capacity: AdaptiveCapacity): SchedulerReason {
  if (capacity.hardBackendAvailable === 0) {
    return { code: "backend_capacity", message: "hard backend capacity is exhausted" };
  }
  if (capacity.effective === 0) {
    return { code: "health_paused", message: capacity.reasons.join("; ") };
  }
  return { code: "global_capacity", message: "global scheduler capacity is exhausted" };
}

function recoveryDecisions(input: SchedulerInput): RecoveryDecision[] {
  if (!input.missingBackendTaskIds?.size) return [];
  const attempts = input.attempts ?? [];
  return [...input.missingBackendTaskIds]
    .sort()
    .flatMap((taskId): RecoveryDecision[] => {
      const candidate = input.tasks.find(({ task }) => task.id === taskId);
      if (!candidate || candidate.task.status !== "running") return [];
      const attempt = attempts
        .filter((value) => value.taskId === taskId)
        .sort((a, b) => b.ordinal - a.ordinal || b.id.localeCompare(a.id))[0];
      const used = Math.max(candidate.task.attemptIds.length, attempt?.ordinal ?? 0);
      const retry = used < candidate.task.maxAttempts;
      return [
        {
          taskId,
          attemptId: attempt?.id,
          action: retry ? "retry" : "fail",
          reason: retry
            ? "persisted running task has no backend; recover through a bounded retry"
            : "persisted running task has no backend and exhausted its attempts",
        },
      ];
    });
}

/**
 * Produce a deterministic, side-effect-free admission plan. The caller must
 * atomically persist an attempt and acquire the returned locks before spawning
 * each backend; rerunning with the same snapshot produces the same decision.
 */
export function schedule(input: SchedulerInput): SchedulerDecision {
  const active = [...input.activeLeases];
  const activeTaskIds = new Set(active.map((lease) => lease.taskId));
  const taskById = new Map<string, SchedulableTask>();
  for (const candidate of [...input.tasks].sort((a, b) => a.task.id.localeCompare(b.task.id))) {
    if (!taskById.has(candidate.task.id)) taskById.set(candidate.task.id, candidate);
  }
  const capacity = adaptiveCapacity(
    input.limits,
    input.backendActiveCount,
    active.length,
    input.signals,
  );
  const projectCounts = new Map<string, number>();
  const missionCounts = new Map<string, number>();
  for (const lease of active) {
    projectCounts.set(lease.projectId, (projectCounts.get(lease.projectId) ?? 0) + 1);
    missionCounts.set(lease.missionId, (missionCounts.get(lease.missionId) ?? 0) + 1);
  }

  const ordered = [...input.tasks].sort((a, b) =>
    compareCandidates(a, b, input.now, input.limits.agingIntervalMs),
  );
  const evaluations = new Map<string, TaskEvaluation>();
  const starts: SchedulerDecision["starts"] extends readonly (infer T)[] ? T[] : never = [];
  const pending: SchedulableTask[] = [];
  let remaining = capacity.available;

  for (const candidate of ordered) {
    const { task } = candidate;
    const score = effectivePriority(candidate, input.now, input.limits.agingIntervalMs);
    const base = {
      taskId: task.id,
      missionId: task.missionId,
      projectId: task.root.projectId,
      effectivePriority: score,
      waitMs: Math.max(0, input.now - candidate.enqueuedAt),
    };
    const staticReason = staticEligibility(candidate, input, taskById, activeTaskIds);
    if (staticReason) {
      evaluations.set(task.id, { ...base, eligible: false, reason: staticReason });
      continue;
    }
    pending.push(candidate);
  }

  while (pending.length > 0) {
    pending.sort((left, right) => {
      const ranked = compareCandidates(
        left,
        right,
        input.now,
        input.limits.agingIntervalMs,
      );
      if (
        effectivePriority(left, input.now, input.limits.agingIntervalMs) !==
        effectivePriority(right, input.now, input.limits.agingIntervalMs)
      ) {
        return ranked;
      }
      // Equal-priority work rotates across projects. This prevents a project
      // with lexicographically earlier ids from monopolising a scheduling tick.
      const occupancy =
        (projectCounts.get(left.task.root.projectId) ?? 0) -
        (projectCounts.get(right.task.root.projectId) ?? 0);
      return occupancy !== 0 ? occupancy : ranked;
    });
    const candidate = pending.shift();
    if (!candidate) break;
    const { task } = candidate;
    const score = effectivePriority(candidate, input.now, input.limits.agingIntervalMs);
    const base = {
      taskId: task.id,
      missionId: task.missionId,
      projectId: task.root.projectId,
      effectivePriority: score,
      waitMs: Math.max(0, input.now - candidate.enqueuedAt),
    };
    if (remaining <= 0) {
      evaluations.set(task.id, { ...base, eligible: false, reason: capacityReason(capacity) });
      for (const waiting of pending) {
        evaluations.set(waiting.task.id, {
          taskId: waiting.task.id,
          missionId: waiting.task.missionId,
          projectId: waiting.task.root.projectId,
          effectivePriority: effectivePriority(
            waiting,
            input.now,
            input.limits.agingIntervalMs,
          ),
          waitMs: Math.max(0, input.now - waiting.enqueuedAt),
          eligible: false,
          reason: capacityReason(capacity),
        });
      }
      break;
    }
    const projectCount = projectCounts.get(task.root.projectId) ?? 0;
    const cap = projectLimit(input.limits, task.root.projectId);
    if (projectCount >= cap) {
      evaluations.set(task.id, {
        ...base,
        eligible: false,
        reason: {
          code: "project_capacity",
          message: `project concurrency limit (${cap}) is occupied`,
        },
      });
      continue;
    }
    const missionCount = missionCounts.get(task.missionId) ?? 0;
    const missionCap = missionLimit(input.limits, task.missionId);
    if (missionCount >= missionCap) {
      evaluations.set(task.id, {
        ...base,
        eligible: false,
        reason: {
          code: "mission_capacity",
          message: `mission concurrency limit (${missionCap}) is occupied`,
        },
      });
      continue;
    }
    const conflict = conflictWithLeases(candidate, active);
    if (conflict) {
      evaluations.set(task.id, { ...base, eligible: false, reason: conflict });
      continue;
    }
    const selected: SchedulerReason = {
      code: "selected",
      message: `selected at effective priority ${score}`,
    };
    starts.push({
      taskId: task.id,
      missionId: task.missionId,
      projectId: task.root.projectId,
      effectivePriority: score,
      reason: selected,
      lockKeys: lockKeysForTask(candidate),
    });
    evaluations.set(task.id, { ...base, eligible: true, reason: selected });
    active.push(provisionalLease(candidate));
    projectCounts.set(task.root.projectId, projectCount + 1);
    missionCounts.set(task.missionId, missionCount + 1);
    remaining -= 1;
  }

  return {
    starts,
    evaluations: [...evaluations.values()].sort((a, b) => a.taskId.localeCompare(b.taskId)),
    recovery: recoveryDecisions(input),
    capacity,
  };
}

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

/** Deterministic bounded exponential backoff; no random state enters replay. */
export function retryAfterFailure(
  task: MissionTask,
  now: number,
  retryable: boolean,
  policy: RetryPolicy,
): RetryDecision {
  const attemptNumber = task.attemptIds.length;
  if (!retryable || attemptNumber >= task.maxAttempts) {
    return {
      taskId: task.id,
      action: "fail",
      attemptNumber,
      nextEligibleAt: null,
      delayMs: 0,
      reason: retryable ? "maximum attempts exhausted" : "failure is not retryable",
    };
  }
  const base = Math.max(0, finite(policy.baseDelayMs));
  const cap = Math.max(base, finite(policy.maxDelayMs, base));
  const exponential = Math.min(cap, base * 2 ** Math.max(0, attemptNumber - 1));
  const jitterRatio = Math.min(0.5, Math.max(0, finite(policy.jitterRatio ?? 0.1)));
  const unit = stableHash(`${task.id}:${attemptNumber}`) / 0xffff_ffff;
  const jitter = 1 + (unit * 2 - 1) * jitterRatio;
  const delayMs = Math.max(0, Math.min(cap, Math.round(exponential * jitter)));
  return {
    taskId: task.id,
    action: "retry",
    attemptNumber,
    nextEligibleAt: now + delayMs,
    delayMs,
    reason: `retry ${attemptNumber + 1}/${task.maxAttempts} after bounded backoff`,
  };
}

/**
 * Pure task control semantics. Pause remains durable across restart; resume
 * returns the task to dependency reconciliation.
 */
export function controlTask(
  task: MissionTask,
  command: TaskControlCommand,
  now: number,
): TaskControlDecision {
  if (command === "cancel") {
    if (TERMINAL_STATUSES.has(task.status)) {
      return { task, changed: false, interruptActiveAttempt: false, reason: "task is terminal" };
    }
    return {
      task: { ...task, status: "cancelled", updatedAt: now },
      changed: true,
      interruptActiveAttempt: task.status === "running",
      reason: "task cancelled; dependents will fail dependency reconciliation",
    };
  }
  if (command === "pause") {
    if (task.status === "paused") {
      return { task, changed: false, interruptActiveAttempt: false, reason: "task is paused" };
    }
    if (TERMINAL_STATUSES.has(task.status)) {
      return { task, changed: false, interruptActiveAttempt: false, reason: "task is terminal" };
    }
    return {
      task: { ...task, status: "paused", pausedAt: now, updatedAt: now },
      changed: true,
      interruptActiveAttempt: task.status === "running",
      reason: "task paused",
    };
  }
  if (task.status !== "paused") {
    return { task, changed: false, interruptActiveAttempt: false, reason: "task is not paused" };
  }
  return {
    task: {
      ...task,
      status: task.dependencyIds.length > 0 ? "blocked_by_dependency" : "ready",
      pausedAt: null,
      updatedAt: now,
    },
    changed: true,
    interruptActiveAttempt: false,
    reason: "task resumed and queued for dependency reconciliation",
  };
}
