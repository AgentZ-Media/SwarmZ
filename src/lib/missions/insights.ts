export const MAX_INSIGHT_TASKS = 500;

export type InsightTaskStatus = "pending" | "running" | "succeeded" | "failed" | "blocked" | "cancelled";
export type InsightConfidence = "none" | "low" | "medium";

export interface MissionTaskObservation {
  taskId: string;
  role: string;
  status: InsightTaskStatus;
  attemptCount: number;
  activeDurationMs: number | null;
  tokensUsed: number | null;
  costUsd: number | null;
  /** Explicit stable gate/runtime code or bounded agent observation; descriptive only. */
  failureFingerprint: string | null;
  /** Untrusted observation used only for counts, never automatic retry authority. */
  retryable: boolean | null;
}

export interface FailureCluster {
  fingerprint: string;
  count: number;
  taskIds: string[];
  retryableCount: number;
  nonRetryableCount: number;
  unknownRetryabilityCount: number;
}

export interface EstimateRange {
  point: number;
  low: number;
  high: number;
  confidence: InsightConfidence;
  sampleSize: number;
  method: string;
}

export interface MissionInsights {
  actual: {
    taskCount: number;
    completedTasks: number;
    failedTasks: number;
    attempts: number;
    retries: number;
    tokensUsed: number;
    costUsd: number;
  };
  failureClusters: FailureCluster[];
  etaMs: EstimateRange | null;
  projectedAdditionalCostUsd: EstimateRange | null;
  warnings: string[];
}

export class MissionInsightsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissionInsightsError";
  }
}

function finiteNonNegative(label: string, value: number | null): void {
  if (value !== null && (!Number.isFinite(value) || value < 0)) throw new MissionInsightsError(`${label} is invalid`);
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)));
  return sorted[index];
}

function confidenceFor(sampleSize: number): InsightConfidence {
  return sampleSize >= 8 ? "medium" : sampleSize >= 3 ? "low" : "none";
}

function estimateByRole(
  observations: readonly MissionTaskObservation[],
  metric: "activeDurationMs" | "costUsd",
  parallelism: number,
  method: string,
): { estimate: EstimateRange | null; missingRoles: string[] } {
  const remainingByRole = new Map<string, number>();
  for (const observation of observations) {
    if (["pending", "running", "blocked"].includes(observation.status)) {
      remainingByRole.set(
        observation.role,
        (remainingByRole.get(observation.role) ?? 0) + 1,
      );
    }
  }
  if (remainingByRole.size === 0) return { estimate: null, missingRoles: [] };
  let point = 0;
  let low = 0;
  let high = 0;
  let sampleSize = 0;
  let confidence: InsightConfidence = "medium";
  const missingRoles: string[] = [];
  for (const [role, count] of [...remainingByRole].sort(([a], [b]) => a.localeCompare(b))) {
    const samples = observations
      .filter((observation) => observation.role === role && observation.status === "succeeded")
      .map((observation) => observation[metric])
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b);
    if (samples.length < 3) {
      missingRoles.push(role);
      continue;
    }
    sampleSize += samples.length;
    if (confidenceFor(samples.length) === "low") confidence = "low";
    const batches = metric === "activeDurationMs" ? Math.ceil(count / parallelism) : count;
    point += percentile(samples, 0.5) * batches;
    low += percentile(samples, 0.25) * batches;
    // ETA's upper bound assumes serial work because cross-role concurrency and
    // critical-path shape are unknown. Cost is inherently additive.
    high += percentile(samples, 0.75) * count;
  }
  if (missingRoles.length > 0) return { estimate: null, missingRoles };
  return {
    estimate: {
      point,
      low: confidence === "low" ? low * 0.75 : low,
      high: confidence === "low" ? high * 1.5 : high,
      confidence,
      sampleSize,
      method,
    },
    missingRoles: [],
  };
}

function normalizedFingerprint(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:/-]{0,119}$/.test(normalized)) {
    throw new MissionInsightsError(`invalid failure fingerprint: ${value}`);
  }
  return normalized;
}

/** Deterministic operational insights over explicit task measurements. */
export function calculateMissionInsights(
  observations: readonly MissionTaskObservation[],
  maxParallelAttempts: number,
): MissionInsights {
  if (!Array.isArray(observations)) throw new MissionInsightsError("observations must be an array");
  if (observations.length > MAX_INSIGHT_TASKS) throw new MissionInsightsError(`insights exceed ${MAX_INSIGHT_TASKS} tasks`);
  if (!Number.isInteger(maxParallelAttempts) || maxParallelAttempts < 1 || maxParallelAttempts > 48) {
    throw new MissionInsightsError("maxParallelAttempts must be 1..48");
  }
  const ids = new Set<string>();
  const clusters = new Map<string, FailureCluster>();
  let attempts = 0;
  let tokens = 0;
  let cost = 0;
  for (const observation of observations) {
    if (!observation || typeof observation !== "object") throw new MissionInsightsError("mission contains an invalid observation");
    if (typeof observation.taskId !== "string" || !observation.taskId.trim() || observation.taskId.length > 120 || ids.has(observation.taskId)) {
      throw new MissionInsightsError(`duplicate or invalid task id: ${observation.taskId}`);
    }
    ids.add(observation.taskId);
    if (typeof observation.role !== "string" || !observation.role.trim() || observation.role.length > 100) throw new MissionInsightsError(`invalid role for ${observation.taskId}`);
    if (!(["pending", "running", "succeeded", "failed", "blocked", "cancelled"] as unknown[]).includes(observation.status)) {
      throw new MissionInsightsError(`invalid status for ${observation.taskId}`);
    }
    if (!Number.isInteger(observation.attemptCount) || observation.attemptCount < 0 || observation.attemptCount > 100) {
      throw new MissionInsightsError(`invalid attempt count for ${observation.taskId}`);
    }
    finiteNonNegative("activeDurationMs", observation.activeDurationMs);
    finiteNonNegative("tokensUsed", observation.tokensUsed);
    finiteNonNegative("costUsd", observation.costUsd);
    if (observation.activeDurationMs !== null && observation.activeDurationMs > 315_576_000_000) {
      throw new MissionInsightsError(`activeDurationMs is unbounded for ${observation.taskId}`);
    }
    if (observation.tokensUsed !== null && (!Number.isSafeInteger(observation.tokensUsed) || observation.tokensUsed > 1_000_000_000_000)) {
      throw new MissionInsightsError(`tokensUsed is unbounded for ${observation.taskId}`);
    }
    if (observation.costUsd !== null && observation.costUsd > 1_000_000_000) {
      throw new MissionInsightsError(`costUsd is unbounded for ${observation.taskId}`);
    }
    attempts += observation.attemptCount;
    tokens += observation.tokensUsed ?? 0;
    cost += observation.costUsd ?? 0;
    if (observation.retryable !== null && typeof observation.retryable !== "boolean") {
      throw new MissionInsightsError(`invalid retryable flag for ${observation.taskId}`);
    }
    if (observation.failureFingerprint !== null && typeof observation.failureFingerprint !== "string") {
      throw new MissionInsightsError(`invalid failure fingerprint for ${observation.taskId}`);
    }
    if (observation.failureFingerprint) {
      if (observation.status !== "failed" && observation.status !== "blocked") {
        throw new MissionInsightsError(`non-failed task ${observation.taskId} carries a failure fingerprint`);
      }
      const fingerprint = normalizedFingerprint(observation.failureFingerprint);
      const cluster = clusters.get(fingerprint) ?? {
        fingerprint,
        count: 0,
        taskIds: [],
        retryableCount: 0,
        nonRetryableCount: 0,
        unknownRetryabilityCount: 0,
      };
      cluster.count += 1;
      cluster.taskIds.push(observation.taskId);
      if (observation.retryable === true) cluster.retryableCount += 1;
      else if (observation.retryable === false) cluster.nonRetryableCount += 1;
      else cluster.unknownRetryabilityCount += 1;
      clusters.set(fingerprint, cluster);
    }
  }

  const completed = observations.filter((observation) => observation.status === "succeeded");
  const remaining = observations.filter((observation) => observation.status === "pending" || observation.status === "running" || observation.status === "blocked").length;
  const warnings: string[] = [];
  const eta = estimateByRole(
    observations,
    "activeDurationMs",
    Math.min(maxParallelAttempts, Math.max(1, remaining)),
    "role-matched completed-task duration medians; observed quartiles; serial upper bound where dependency shape is unknown",
  );
  const projectedCost = estimateByRole(
    observations,
    "costUsd",
    1,
    "role-matched completed-task cost medians with observed quartile range",
  );
  if (eta.missingRoles.length > 0) warnings.push(`ETA withheld: fewer than three completed duration samples for roles ${eta.missingRoles.join(", ")}.`);
  if (projectedCost.missingRoles.length > 0) warnings.push(`Cost projection withheld: fewer than three completed cost samples for roles ${projectedCost.missingRoles.join(", ")}.`);
  const etaMs = eta.estimate;
  const projectedAdditionalCostUsd = projectedCost.estimate;

  return {
    actual: {
      taskCount: observations.length,
      completedTasks: completed.length,
      failedTasks: observations.filter((observation) => observation.status === "failed").length,
      attempts,
      retries: observations.reduce((sum, observation) => sum + Math.max(0, observation.attemptCount - 1), 0),
      tokensUsed: tokens,
      costUsd: cost,
    },
    failureClusters: [...clusters.values()]
      .map((cluster) => ({ ...cluster, taskIds: cluster.taskIds.sort() }))
      .sort((a, b) => b.count - a.count || a.fingerprint.localeCompare(b.fingerprint)),
    etaMs,
    projectedAdditionalCostUsd,
    warnings,
  };
}
