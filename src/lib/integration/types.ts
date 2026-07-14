import type {
  IntegrationTrain,
  MissionArtifact,
  MissionTask,
  QualityGate,
  TaskAttempt,
} from "@/lib/missions/types";

export type IntegrationStrategy = "merge" | "rebase" | "cherry_pick";

export interface IntegrationStopPolicy {
  onOperationFailure: "stop" | "rollback" | "continue";
  onConflict: "stop" | "needs_human" | "rollback";
  onGateFailure: "stop" | "rollback";
  stopOnCriticalRisk: boolean;
  /** Create a checkpoint after this many newly integrated entries. */
  checkpointEvery: number;
}

export interface IntegrationCheckpoint {
  id: string;
  trainId: string;
  headCommit: string;
  integratedTaskIds: readonly string[];
  completedOperationIds: readonly string[];
  passedGateIds: readonly string[];
  createdAt: number;
}

export interface IntegrationFailure {
  operationId?: string;
  kind: "operation_failed" | "merge_conflict" | "gate_failed";
  detail: string;
  gateId?: string;
}

export interface ObservedChangeSet {
  id: string;
  taskId?: string;
  files: readonly string[];
  globs?: readonly string[];
}

export interface IntegrationInput {
  train: IntegrationTrain;
  tasks: Readonly<Record<string, MissionTask>>;
  attempts: Readonly<Record<string, TaskAttempt>>;
  artifacts: Readonly<Record<string, MissionArtifact>>;
  qualityGates: Readonly<Record<string, QualityGate>>;
  strategy: IntegrationStrategy;
  /** Current integration-branch HEAD. Every operation is conditional on it. */
  currentHead: string;
  completedOperationIds?: ReadonlySet<string>;
  /** Operations currently owned by an executor; prevents concurrent replay. */
  activeOperationIds?: ReadonlySet<string>;
  completedRegressionPlanIds?: ReadonlySet<string>;
  /** Commit ids already known to be ancestors of currentHead. */
  integratedCommits?: ReadonlySet<string>;
  checkpoints?: readonly IntegrationCheckpoint[];
  observedChanges?: readonly ObservedChangeSet[];
  failure?: IntegrationFailure | null;
  stopPolicy: IntegrationStopPolicy;
  now: number;
}

export type ReadinessCode =
  | "ready"
  | "entry_terminal"
  | "task_missing"
  | "task_not_succeeded"
  | "attempt_missing"
  | "attempt_not_succeeded"
  | "commit_missing"
  | "dependency_missing"
  | "dependency_not_succeeded"
  | "dependency_not_integrated"
  | "required_gate_pending"
  | "required_gate_failed";

export interface EntryReadiness {
  taskId: string;
  ready: boolean;
  code: ReadinessCode;
  message: string;
  blockers: readonly string[];
  attemptId: string | null;
  commit: string | null;
}

export interface ConflictRadarItem {
  candidateTaskId: string;
  sourceId: string;
  sourceTaskId?: string;
  severity: "medium" | "high" | "critical";
  kind: "exact_file" | "glob_overlap" | "critical_surface";
  evidence: readonly string[];
  message: string;
}

export type GitOperation =
  | {
      kind: "merge";
      targetBranch: string;
      commit: string;
      expectedHead: string;
      noFastForward: true;
    }
  | {
      kind: "rebase";
      targetBranch: string;
      commit: string;
      expectedHead: string;
      then: "fast_forward";
    }
  | {
      kind: "cherry_pick";
      targetBranch: string;
      commit: string;
      expectedHead: string;
    };

export interface IntegrationOperationPlan {
  operationId: string;
  trainId: string;
  taskId: string;
  attemptId: string;
  commit: string;
  operation: GitOperation;
  preconditions: readonly string[];
  explanation: string;
}

export interface RollbackPlan {
  operationId: string;
  kind: "reset_to_checkpoint";
  checkpointId: string;
  targetHead: string;
  expectedHead: string;
  explanation: string;
}

export interface CheckpointPlan {
  checkpointId: string;
  headCommit: string;
  integratedTaskIds: readonly string[];
  reason: string;
}

export interface RegressionStep {
  stepId: string;
  gateIds: readonly string[];
  label: string;
  command: string;
  required: boolean;
}

export interface RegressionPlan {
  planId: string;
  trainId: string;
  steps: readonly RegressionStep[];
  pendingGateIds: readonly string[];
  failedGateIds: readonly string[];
  ready: boolean;
  explanation: string;
}

export type IntegrationAction =
  | "execute"
  | "reconcile"
  | "checkpoint"
  | "run_regression"
  | "rollback"
  | "wait"
  | "blocked"
  | "needs_human"
  | "complete";

export interface IntegrationPlan {
  action: IntegrationAction;
  readyQueue: readonly EntryReadiness[];
  evaluations: readonly EntryReadiness[];
  conflicts: readonly ConflictRadarItem[];
  operation: IntegrationOperationPlan | null;
  rollback: RollbackPlan | null;
  checkpoint: CheckpointPlan | null;
  regression: RegressionPlan | null;
  explanation: string;
}
