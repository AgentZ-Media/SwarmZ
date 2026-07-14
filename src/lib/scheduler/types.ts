import type { MissionTask, TaskAttempt } from "@/lib/missions/types";

/** Runtime-only information needed to schedule a durable mission task. */
export interface SchedulableTask {
  task: MissionTask;
  /** First instant at which this task joined the ready queue. Preserved on pause. */
  enqueuedAt: number;
  /** A retry may not start before this timestamp. */
  nextEligibleAt?: number | null;
  /** Resolved checkout path. `null` means the task writes in its project root. */
  worktreePath?: string | null;
  /** Additional exclusive resources such as `database:migrations` or `port:4173`. */
  resourceKeys?: readonly string[];
}

/** An active backend owns exactly one lease. Leases, rather than UI state, hold locks. */
export interface ActiveLease {
  taskId: string;
  attemptId: string;
  missionId: string;
  projectId: string;
  backendId: string;
  rootPath: string;
  worktreePath: string | null;
  acquiredAt: number;
  declaredFiles: readonly string[];
  declaredGlobs: readonly string[];
  resourceKeys: readonly string[];
}

export interface SchedulerLimits {
  /** Desired active workers across all projects. */
  globalConcurrency: number;
  /** Default project cap, or an explicit cap per project plus `default`. */
  perProjectConcurrency: number | ({ default: number } & Record<string, number>);
  /** Mission Envelope cap; omitted missions fall back to global concurrency. */
  perMissionConcurrency?: number | ({ default: number } & Record<string, number>);
  /** Absolute safety ceiling enforced even when all adaptive inputs are healthy. */
  hardBackendCap: number;
  /** One priority point is added for each complete interval spent waiting. */
  agingIntervalMs: number;
}

export interface SchedulerHealthSignals {
  health?: "healthy" | "degraded" | "critical";
  /** Remaining request/token allowance as a 0..1 ratio. */
  rateLimitRemainingRatio?: number;
  /** Recent worker failure ratio as a 0..1 ratio. */
  recentFailureRatio?: number;
  /** Host memory pressure as a 0..1 ratio. */
  memoryPressure?: number;
  /** Explicit global pause. No new task starts while active work may wind down. */
  paused?: boolean;
}

export interface SchedulerInput {
  tasks: readonly SchedulableTask[];
  attempts?: readonly TaskAttempt[];
  activeLeases: readonly ActiveLease[];
  /** Number of actually active Codex backends, including untracked/human sessions. */
  backendActiveCount: number;
  now: number;
  limits: SchedulerLimits;
  signals?: SchedulerHealthSignals;
  /** Mission-level pause is separate from an individual task's status. */
  pausedMissionIds?: ReadonlySet<string>;
  /** Running tasks reported by persistence whose backend no longer exists. */
  missingBackendTaskIds?: ReadonlySet<string>;
}

export type SchedulerReasonCode =
  | "selected"
  | "already_active"
  | "terminal"
  | "task_paused"
  | "mission_paused"
  | "needs_human"
  | "dependency_pending"
  | "dependency_failed"
  | "dependency_missing"
  | "dependency_cycle"
  | "retry_backoff"
  | "global_capacity"
  | "project_capacity"
  | "mission_capacity"
  | "backend_capacity"
  | "health_paused"
  | "root_lock"
  | "worktree_lock"
  | "resource_lock"
  | "declared_file_conflict"
  | "invalid_task";

export interface SchedulerReason {
  code: SchedulerReasonCode;
  message: string;
  blockers?: readonly string[];
}

export interface TaskEvaluation {
  taskId: string;
  missionId: string;
  projectId: string;
  eligible: boolean;
  effectivePriority: number;
  waitMs: number;
  reason: SchedulerReason;
}

export interface StartDecision {
  taskId: string;
  missionId: string;
  projectId: string;
  effectivePriority: number;
  reason: SchedulerReason;
  /** Locks that must be atomically acquired before the backend is spawned. */
  lockKeys: readonly string[];
}

export interface RecoveryDecision {
  taskId: string;
  attemptId?: string;
  action: "retry" | "fail";
  reason: string;
}

export interface AdaptiveCapacity {
  requested: number;
  effective: number;
  available: number;
  hardBackendAvailable: number;
  reasons: readonly string[];
}

export interface SchedulerDecision {
  starts: readonly StartDecision[];
  evaluations: readonly TaskEvaluation[];
  recovery: readonly RecoveryDecision[];
  capacity: AdaptiveCapacity;
}

export interface RetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  /** Symmetric deterministic jitter, 0..0.5. Defaults to 0.1. */
  jitterRatio?: number;
}

export interface RetryDecision {
  taskId: string;
  action: "retry" | "fail";
  attemptNumber: number;
  nextEligibleAt: number | null;
  delayMs: number;
  reason: string;
}

export type TaskControlCommand = "pause" | "resume" | "cancel";

export interface TaskControlDecision {
  task: MissionTask;
  changed: boolean;
  /** A running backend must be interrupted before the new state is durable. */
  interruptActiveAttempt: boolean;
  reason: string;
}
