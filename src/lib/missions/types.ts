/**
 * Durable Mission Control domain types.
 *
 * The event log is the source of truth. The entity maps below are projections
 * rebuilt by `replayMissionEvents`; they are persisted only indirectly through
 * the append-only events that produced them.
 */

export const MISSION_STORE_VERSION = 2 as const;

export type MissionStatus =
  | "draft"
  | "paused"
  | "active"
  | "needs_human"
  | "blocked"
  | "failed"
  | "succeeded"
  | "cancelled"
  | "archived";

export type TaskStatus =
  | "draft"
  | "paused"
  | "blocked_by_dependency"
  | "ready"
  | "running"
  | "needs_human"
  | "blocked"
  | "failed"
  | "succeeded"
  | "cancelled"
  | "archived";

export type AttemptStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "needs_human"
  | "cancelled";

export type MissionPriority = number;
export type MissionRisk = "low" | "medium" | "high" | "critical";

export interface MissionRuntimeBinding {
  /** Project-scoped Runtime Environment id selected by the human. */
  environmentId: string;
  /** Stable digest of the complete reference-only Runtime spec at approval. */
  specFingerprint: string;
}

export interface MissionPolicy {
  /** Hard scheduler admission limit for this mission. */
  maxParallelAttempts: number;
  stopOnCriticalFailure: boolean;
  requireQualityGates: boolean;
  integrationMode: "manual" | "train";
  /** Optional private-preview execution grants; missing values fail closed. */
  networkAuthority?: "deny" | "read_only" | "allow";
  githubAuthority?: "deny" | "read_only" | "write";
  allowedTools?: string[];
  qualityCommands?: string[];
  stopOnRegression?: "continue" | "pause_mission" | "needs_human" | "cancel_mission";
  stopOnConflict?: "continue" | "pause_mission" | "needs_human" | "cancel_mission";
  /** Null means this mission intentionally runs without a prepared runtime. */
  runtimeEnvironment?: MissionRuntimeBinding | null;
}

export interface MissionBudget {
  maxAttemptsTotal: number | null;
  maxActiveMinutes: number | null;
  maxTokens: number | null;
  maxCostUsd: number | null;
}

export interface TaskRoot {
  projectId: string;
  /** Canonical project or repository root. */
  path: string;
}

export type WorktreePolicy =
  | { mode: "none" }
  | { mode: "new" }
  | { mode: "integration" }
  | { mode: "shared"; sharedWithTaskId: string };

/** Derived hard edge in the mission task DAG. */
export interface MissionDependency {
  id: string;
  missionId: string;
  taskId: string;
  dependsOnTaskId: string;
  kind: "hard";
  createdAt: number;
}

export interface Mission {
  id: string;
  projectId: string;
  title: string;
  objective: string;
  status: MissionStatus;
  taskIds: string[];
  integrationTrainIds: string[];
  policy: MissionPolicy;
  budget: MissionBudget;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  cancelledAt: number | null;
  pausedAt: number | null;
  activatedAt: number | null;
  revision: number;
}

export interface MissionTask {
  id: string;
  missionId: string;
  title: string;
  description: string;
  status: TaskStatus;
  /** 0..100, higher values schedule first. */
  priority: MissionPriority;
  role: string;
  risk: MissionRisk;
  acceptanceCriteria: string[];
  root: TaskRoot;
  worktreePolicy: WorktreePolicy;
  dependencyIds: string[];
  declaredFiles: string[];
  declaredGlobs: string[];
  maxAttempts: number;
  attemptIds: string[];
  qualityGateIds: string[];
  artifactIds: string[];
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  pausedAt: number | null;
  /** Human-provided context consumed by the next fresh retry attempt. */
  resumeInstruction?: string | null;
  requeuedAfterAttemptId?: string | null;
  selectedCandidateAttemptId?: string | null;
  /** Human-approved exception for analysis/documentation tasks that may prove no code change is needed. */
  allowNoop?: boolean;
}

export interface TaskAttempt {
  id: string;
  missionId: string;
  taskId: string;
  ordinal: number;
  status: AttemptStatus;
  sessionId: string | null;
  workerLabel: string | null;
  resumeInstruction?: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  summary: string | null;
  error: string | null;
  report: Record<string, unknown> | null;
  artifactIds: string[];
  /** Present only for human-approved A/B(/N) comparison runs. */
  candidateBatchId?: string | null;
}

export interface CandidateBatch {
  id: string;
  missionId: string;
  taskId: string;
  count: number;
  instruction: string;
  minimumEvidenceCount: number;
  minimumScoreMargin: number;
  attemptIds: string[];
  selectedAttemptId: string | null;
  requestedAt: number;
  selectedAt: number | null;
}

export interface MissionSchedule {
  id: string;
  missionId: string;
  projectId: string;
  note: string;
  at: number;
  createdAt: number;
  cancelledAt: number | null;
  /** Durable at-most-once claim; a claimed reminder is never fired again. */
  claimedAt: number | null;
  firedAt: number | null;
  /** Failed native delivery is retryable and remains visible; a claimed-only record is uncertain. */
  deliveryAttempts?: number;
  lastDeliveryError?: string | null;
  nextAttemptAt?: number | null;
}

export type ArtifactKind =
  | "file"
  | "diff"
  | "commit"
  | "pull_request"
  | "report"
  | "log"
  | "test_result"
  | "other";

export interface MissionArtifact {
  id: string;
  missionId: string;
  taskId: string | null;
  attemptId: string | null;
  kind: ArtifactKind;
  label: string;
  uri: string | null;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export type QualityGateKind =
  | "typecheck"
  | "unit_tests"
  | "integration_tests"
  | "lint"
  | "build"
  | "security"
  | "review"
  | "custom";

export type QualityGateStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "waived";

export interface QualityGate {
  id: string;
  missionId: string;
  taskId: string | null;
  kind: QualityGateKind;
  label: string;
  command: string | null;
  required: boolean;
  status: QualityGateStatus;
  details: string | null;
  artifactIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface IntegrationTrainEntry {
  taskId: string;
  position: number;
  status: "queued" | "integrating" | "integrated" | "failed" | "skipped";
  commit: string | null;
  detail: string | null;
  /** Durable generation for an explicitly human-approved retry. */
  retryRevision?: number;
  /** Exact durable operation currently associated with this entry. */
  operationId?: string | null;
}

export interface IntegrationTrain {
  id: string;
  missionId: string;
  baseBranch: string;
  integrationBranch: string;
  status: "open" | "running" | "blocked" | "completed" | "cancelled";
  entries: IntegrationTrainEntry[];
  createdAt: number;
  updatedAt: number;
}

export interface MissionProjection {
  missions: Record<string, Mission>;
  tasks: Record<string, MissionTask>;
  dependencies: Record<string, MissionDependency>;
  attempts: Record<string, TaskAttempt>;
  artifacts: Record<string, MissionArtifact>;
  qualityGates: Record<string, QualityGate>;
  integrationTrains: Record<string, IntegrationTrain>;
  candidateBatches: Record<string, CandidateBatch>;
  schedules: Record<string, MissionSchedule>;
  /** Event id -> stable fingerprint; used for exact idempotency checks. */
  appliedEventIds: Record<string, string>;
  /** Optional command idempotency key -> event fingerprint. */
  idempotencyKeys: Record<string, string>;
}

export interface MissionCreatedPayload {
  projectId: string;
  title: string;
  objective: string;
  policy: MissionPolicy;
  budget: MissionBudget;
  createdAt: number;
}

export type MissionTaskInput = Omit<
  MissionTask,
  | "status"
  | "attemptIds"
  | "qualityGateIds"
  | "artifactIds"
  | "createdAt"
  | "updatedAt"
  | "archivedAt"
  | "pausedAt"
  | "resumeInstruction"
  | "requeuedAfterAttemptId"
  | "selectedCandidateAttemptId"
> & { createdAt: number };

export type MissionEventPayload =
  | { type: "mission.created"; data: MissionCreatedPayload }
  | { type: "mission.archived"; data: { archivedAt: number } }
  | { type: "mission.cancelled"; data: { cancelledAt: number } }
  | { type: "mission.activated"; data: { activatedAt: number } }
  | { type: "mission.paused"; data: { pausedAt: number } }
  | { type: "mission.resumed"; data: { resumedAt: number } }
  | { type: "task.added"; data: MissionTaskInput }
  | {
      type: "task.updated";
      data: {
        taskId: string;
        updatedAt: number;
        patch: Partial<
          Pick<
            MissionTask,
            | "title"
            | "description"
            | "priority"
            | "role"
            | "risk"
            | "acceptanceCriteria"
            | "root"
            | "worktreePolicy"
            | "dependencyIds"
            | "declaredFiles"
            | "declaredGlobs"
            | "maxAttempts"
            | "allowNoop"
          >
        >;
      };
    }
  | { type: "task.archived"; data: { taskId: string; archivedAt: number } }
  | { type: "task.paused"; data: { taskId: string; pausedAt: number } }
  | { type: "task.resumed"; data: { taskId: string; resumedAt: number } }
  | {
      type: "task.requeued";
      data: {
        taskId: string;
        afterAttemptId: string;
        instruction: string;
        requeuedAt: number;
      };
    }
  | {
      type: "attempt.started";
      data: {
        id: string;
        taskId: string;
        candidateBatchId?: string | null;
        sessionId?: string | null;
        workerLabel?: string | null;
        startedAt: number;
      };
    }
  | {
      type: "attempt.finished";
      data: {
        attemptId: string;
        status: Exclude<AttemptStatus, "queued" | "running">;
        finishedAt: number;
        summary?: string | null;
        error?: string | null;
        report?: Record<string, unknown> | null;
      };
    }
  | { type: "artifact.recorded"; data: MissionArtifact }
  | {
      type: "quality_gate.added";
      data: Omit<QualityGate, "status" | "details" | "artifactIds" | "updatedAt">;
    }
  | {
      type: "quality_gate.resulted";
      data: {
        gateId: string;
        status: Exclude<QualityGateStatus, "pending" | "running">;
        details?: string | null;
        artifactIds?: string[];
        updatedAt: number;
      };
    }
  | { type: "integration_train.created"; data: IntegrationTrain }
  | {
      type: "integration_train.updated";
      data: {
        trainId: string;
        status?: IntegrationTrain["status"];
        entries?: IntegrationTrainEntry[];
        updatedAt: number;
      };
    }
  | {
      type: "candidate_batch.requested";
      data: Omit<CandidateBatch, "attemptIds" | "selectedAttemptId" | "selectedAt">;
    }
  | {
      type: "candidate_batch.selected";
      data: { batchId: string; attemptId: string; selectedAt: number };
    }
  | {
      type: "candidate_batch.overridden";
      data: { batchId: string; attemptId: string; reason: string; selectedAt: number };
    }
  | { type: "schedule.created"; data: MissionSchedule }
  | { type: "schedule.cancelled"; data: { scheduleId: string; cancelledAt: number } }
  | { type: "schedule.claimed"; data: { scheduleId: string; claimedAt: number } }
  | {
      type: "schedule.delivery_failed";
      data: { scheduleId: string; failedAt: number; error: string; nextAttemptAt: number };
    }
  | { type: "schedule.fired"; data: { scheduleId: string; firedAt: number } };

export type MissionEventType = MissionEventPayload["type"];

export type MissionEvent = MissionEventPayload & {
  eventId: string;
  missionId: string;
  /** Strictly increasing per mission. */
  revision: number;
  occurredAt: number;
  idempotencyKey?: string;
  actor: "human" | "orchestrator" | "scheduler" | "system";
};

export interface PersistedMissionsV2 {
  version: typeof MISSION_STORE_VERSION;
  events: MissionEvent[];
}

/** Initial private-preview format accepted by the v2 migration. */
export interface PersistedMissionsV1 {
  version?: 1;
  events?: unknown[];
}

export type PersistedMissions = PersistedMissionsV2;
