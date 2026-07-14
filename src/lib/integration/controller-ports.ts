import { invoke } from "@tauri-apps/api/core";
import { persistenceIssues } from "@/lib/persistence/coordinator";
import { useSwarm } from "@/store";
import {
  addWorktree,
  listWorktrees,
  resolveWorktreeMainRoot,
} from "@/lib/worktree";
import type {
  EnqueueMissionCommand,
  MissionOutboxRecord,
} from "@/lib/missions/outbox";
import { useMissionOutbox } from "@/lib/missions/outbox-store";
import { flushMissionsPersist, useMissions } from "@/lib/missions/store";
import type {
  IntegrationTrain,
  IntegrationTrainEntry,
  MissionArtifact,
  MissionEvent,
  MissionProjection,
} from "@/lib/missions/types";
import type { WorktreeInfo, WorktreeScan } from "@/types";
import {
  applyIntegration,
  rollbackIntegration,
  runAcceptanceCommand,
  type AcceptanceCommandRequest,
  type AcceptanceCommandResult,
  type IntegrationApplyRequest,
  type IntegrationApplyResult,
  type IntegrationRollbackRequest,
  type IntegrationRollbackResult,
} from "./native";

export interface MissionGitEvidence {
  base_sha: string;
  head_sha: string;
  diff_sha256: string;
  files_changed: string[];
  dirty: boolean;
  branch: string | null;
  base_is_ancestor: boolean;
}

export interface IntegrationControllerSnapshot {
  ready: boolean;
  projection: MissionProjection;
  events: readonly MissionEvent[];
  outbox: Readonly<Record<string, MissionOutboxRecord>>;
  gitBin?: string;
}

export interface IntegrationControllerPorts {
  snapshot(): IntegrationControllerSnapshot;
  resolveMainRoot(cwd: string, gitBin?: string): Promise<string>;
  scanWorktrees(roots: string[], gitBin?: string): Promise<WorktreeScan>;
  createWorktree(args: {
    cwd: string;
    branch: string;
    copyEnv: false;
    gitBin?: string;
  }): Promise<WorktreeInfo>;
  gitEvidence(cwd: string, baseSha: string | null, gitBin?: string): Promise<MissionGitEvidence>;
  apply(request: IntegrationApplyRequest): Promise<IntegrationApplyResult>;
  rollback(request: IntegrationRollbackRequest): Promise<IntegrationRollbackResult>;
  runAcceptance(request: AcceptanceCommandRequest): Promise<AcceptanceCommandResult>;
  enqueue(command: EnqueueMissionCommand, recordId: string): Promise<MissionOutboxRecord>;
  claim(recordId: string, ownerId: string, leaseMs: number): Promise<MissionOutboxRecord | null>;
  deliver(recordId: string, claimId: string, receipt: Record<string, unknown>): Promise<MissionOutboxRecord>;
  fail(recordId: string, claimId: string, error: string, retryable: boolean): Promise<MissionOutboxRecord>;
  adoptReceipt(
    idempotencyKey: string,
    receipt: Record<string, unknown>,
    deliveredAt: number,
  ): Promise<MissionOutboxRecord | null>;
  createTrain(
    missionId: string,
    train: Omit<IntegrationTrain, "missionId" | "createdAt" | "updatedAt">,
    idempotencyKey: string,
  ): void;
  updateTrain(
    missionId: string,
    trainId: string,
    patch: { status?: IntegrationTrain["status"]; entries?: IntegrationTrainEntry[] },
    idempotencyKey: string,
    actor?: MissionEvent["actor"],
  ): void;
  recordArtifact(
    missionId: string,
    artifact: Omit<MissionArtifact, "missionId" | "createdAt"> & { createdAt?: number },
    idempotencyKey: string,
    actor?: MissionEvent["actor"],
  ): void;
  flushMissions(): Promise<void>;
  now(): number;
}

export function productionIntegrationControllerPorts(): IntegrationControllerPorts {
  return {
    snapshot: () => {
      const missions = useMissions.getState();
      const outbox = useMissionOutbox.getState();
      const issues = persistenceIssues();
      return {
        ready: missions.hydrated && missions.hydrateStatus === "ready" &&
          outbox.hydrateStatus === "ready" && outbox.snapshot.hydration === "ready" &&
          !issues.some((issue) => issue.name === "missions" || issue.name === "missionOutbox"),
        projection: missions.projection,
        events: missions.events,
        outbox: outbox.snapshot.records,
        gitBin: useSwarm.getState().settings.gitPath?.trim() || undefined,
      };
    },
    resolveMainRoot: resolveWorktreeMainRoot,
    scanWorktrees: listWorktrees,
    createWorktree: addWorktree,
    gitEvidence: (cwd, baseSha, gitBin) => invoke<MissionGitEvidence>("mission_git_evidence", {
      cwd,
      baseSha,
      bin: gitBin ?? null,
    }),
    apply: applyIntegration,
    rollback: rollbackIntegration,
    runAcceptance: runAcceptanceCommand,
    enqueue: (command, recordId) => useMissionOutbox.getState().enqueue(command, { recordId }),
    claim: (recordId, ownerId, leaseMs) =>
      useMissionOutbox.getState().claim(recordId, ownerId, { leaseMs }),
    deliver: (recordId, claimId, receipt) =>
      useMissionOutbox.getState().deliver(recordId, claimId, receipt),
    fail: (recordId, claimId, error, retryable) =>
      useMissionOutbox.getState().fail(recordId, claimId, error, { retryable }),
    adoptReceipt: (idempotencyKey, receipt, deliveredAt) =>
      useMissionOutbox.getState().adoptReceipt(idempotencyKey, receipt, deliveredAt),
    createTrain: (missionId, train, idempotencyKey) => {
      useMissions.getState().createIntegrationTrain(missionId, train, {
        actor: "system",
        idempotencyKey,
      });
    },
    updateTrain: (missionId, trainId, patch, idempotencyKey, actor = "system") => {
      useMissions.getState().updateIntegrationTrain(missionId, trainId, patch, {
        actor,
        idempotencyKey,
      });
    },
    recordArtifact: (missionId, artifact, idempotencyKey, actor = "system") => {
      useMissions.getState().recordArtifact(missionId, artifact, {
        actor,
        idempotencyKey,
      });
    },
    flushMissions: flushMissionsPersist,
    now: Date.now,
  };
}
