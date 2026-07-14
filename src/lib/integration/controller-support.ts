import type { MissionOutboxRecord } from "@/lib/missions/outbox";
import type {
  IntegrationTrain,
  IntegrationTrainEntry,
  MissionArtifact,
  MissionProjection,
  MissionTask,
  QualityGate,
  TaskAttempt,
} from "@/lib/missions/types";
import type { IntegrationControllerSnapshot } from "./controller-ports";
import type {
  IntegrationCheckpoint,
  IntegrationStopPolicy,
  RegressionPlan,
} from "./types";

export const OUTPUT_RECEIPT_LIMIT = 4_000;

function hash(value: string, seed = 2_166_136_261): string {
  let state = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    state ^= value.charCodeAt(index);
    state = Math.imul(state, 16_777_619);
  }
  return (state >>> 0).toString(36);
}

export function stableId(prefix: string, ...parts: readonly string[]): string {
  const joined = parts.join("\u001f");
  return `${prefix}-${hash(joined)}${hash(joined, 3_332_666_709)}`;
}

export function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\0]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2_000) || "unknown integration error";
}

export function clipped(value: string): string {
  return value.length <= OUTPUT_RECEIPT_LIMIT
    ? value
    : `${value.slice(0, OUTPUT_RECEIPT_LIMIT)}…`;
}

export function validCommit(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/^git:/, "");
  return /^[0-9a-f]{7,64}$/i.test(normalized) ? normalized.toLowerCase() : null;
}

function successfulAttempt(task: MissionTask, projection: MissionProjection): TaskAttempt | null {
  const attempts = task.attemptIds
    .map((id) => projection.attempts[id])
    .filter((attempt): attempt is TaskAttempt => Boolean(attempt) && attempt.status === "succeeded")
    .sort((left, right) => right.ordinal - left.ordinal || right.id.localeCompare(left.id));
  return attempts[0] ?? null;
}

export function commitForTask(task: MissionTask, projection: MissionProjection): string | null {
  const attempt = successfulAttempt(task, projection);
  if (!attempt) return null;
  const artifacts = Object.values(projection.artifacts)
    .filter((artifact) =>
      artifact.kind === "commit" &&
      artifact.taskId === task.id &&
      artifact.attemptId === attempt.id,
    )
    .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
  for (const artifact of artifacts) {
    const commit = validCommit(artifact.metadata.commit) ??
      validCommit(artifact.metadata.sha) ??
      validCommit(artifact.metadata.hash) ??
      validCommit(artifact.uri);
    if (commit) return commit;
  }
  return null;
}

export function outboxRecords(
  snapshot: IntegrationControllerSnapshot,
  missionId: string,
  kind?: MissionOutboxRecord["command"]["kind"],
): MissionOutboxRecord[] {
  return Object.values(snapshot.outbox)
    .filter((record) => record.missionId === missionId && (!kind || record.command.kind === kind))
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

export function sameEntries(
  left: readonly IntegrationTrainEntry[],
  right: readonly IntegrationTrainEntry[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function checkpointFromArtifact(artifact: MissionArtifact): IntegrationCheckpoint | null {
  if (artifact.label !== "integration-checkpoint") return null;
  const trainId = typeof artifact.metadata.trainId === "string" ? artifact.metadata.trainId : null;
  const headCommit = validCommit(artifact.metadata.headCommit) ?? validCommit(artifact.uri);
  const strings = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
  if (!trainId || !headCommit) return null;
  return {
    id: artifact.id,
    trainId,
    headCommit,
    integratedTaskIds: strings(artifact.metadata.integratedTaskIds),
    completedOperationIds: strings(artifact.metadata.completedOperationIds),
    passedGateIds: strings(artifact.metadata.passedGateIds),
    createdAt: artifact.createdAt,
  };
}

export function controllerStopPolicy(): IntegrationStopPolicy {
  return {
    onOperationFailure: "stop",
    onConflict: "needs_human",
    onGateFailure: "stop",
    stopOnCriticalRisk: false,
    checkpointEvery: 1,
  };
}

export function integrationRecordsFor(
  snapshot: IntegrationControllerSnapshot,
  trainId: string,
  taskId: string,
  commit: string,
): MissionOutboxRecord[] {
  return outboxRecords(snapshot, snapshot.projection.integrationTrains[trainId]?.missionId ?? "", "integrate")
    .filter((record) => record.command.kind === "integrate" &&
      record.command.payload.trainId === trainId &&
      record.command.payload.taskId === taskId &&
      record.command.payload.commit.toLowerCase() === commit.toLowerCase());
}

export function gateGreen(record: MissionOutboxRecord): boolean {
  return record.status === "delivered" &&
    record.delivery?.receipt.status === "completed" &&
    record.delivery.receipt.exitCode === 0 &&
    record.delivery.receipt.headVerified === true;
}

export function integrationReceiptEffective(record: MissionOutboxRecord): boolean {
  if (record.status !== "delivered" || record.command.kind !== "integrate") return false;
  const receipt = record.delivery?.receipt;
  return receipt?.headVerified === true &&
    ["applied", "already_applied", "reconciled"].includes(String(receipt.status)) &&
    String(receipt.commit).toLowerCase() === record.command.payload.commit.toLowerCase();
}

function gateRecordsForPlan(
  snapshot: IntegrationControllerSnapshot,
  missionId: string,
  plan: RegressionPlan,
): MissionOutboxRecord[] {
  return outboxRecords(snapshot, missionId, "gate").filter((record) =>
    record.command.kind === "gate" && record.command.payload.planId === plan.planId,
  );
}

export function completedRegressionPlans(
  snapshot: IntegrationControllerSnapshot,
  missionId: string,
  plan: RegressionPlan,
): Set<string> {
  if (plan.steps.length === 0) return new Set();
  const records = gateRecordsForPlan(snapshot, missionId, plan);
  const complete = plan.steps.every((step) => records.some((record) =>
    record.command.kind === "gate" &&
    record.command.payload.command === step.command &&
    gateGreen(record),
  ));
  return complete ? new Set([plan.planId]) : new Set();
}

export function regressionGates(
  projection: MissionProjection,
  missionId: string,
  train: IntegrationTrain,
): Record<string, QualityGate> {
  const taskIds = new Set(train.entries.map((entry) => entry.taskId));
  return Object.fromEntries(Object.values(projection.qualityGates)
    .filter((gate) => gate.missionId === missionId && (gate.taskId === null || taskIds.has(gate.taskId)))
    .filter((gate) => gate.command?.trim() || !["passed", "waived"].includes(gate.status))
    .map((gate) => [gate.id, gate]));
}

export function trainEntries(tasks: readonly MissionTask[]): IntegrationTrainEntry[] {
  return [...tasks]
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .map((task, position) => ({
      taskId: task.id,
      position,
      status: "queued" as const,
      commit: null,
      detail: null,
    }));
}
