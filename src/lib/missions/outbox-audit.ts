import type {
  MissionArtifact,
  MissionProjection,
} from "./types";
import type {
  MissionOutboxRecord,
  MissionOutboxSnapshot,
} from "./outbox";
import { sha256Hex } from "@/lib/runtime/core";

const AUDIT_SCHEMA_VERSION = 1;
const AUDIT_CHUNK_SIZE = 100;
const SHORT_TEXT_LIMIT = 512;
const OUTPUT_TEXT_LIMIT = 160;
export const MAX_MISSION_OUTBOX_AUDIT_BYTES = 8 * 1024 * 1024;
const MAX_AUDIT_ENTRY_BYTES = MAX_MISSION_OUTBOX_AUDIT_BYTES - 512 * 1024;

export interface MissionOutboxCompactionProof {
  archivedMissionIds: ReadonlySet<string>;
  durablyAppliedRecords: ReadonlyMap<string, MissionOutboxRecord>;
}

function attemptIsTerminal(status: string): boolean {
  return status !== "queued" && status !== "running";
}

/** Receipts remain until their externally completed effect is materialized. */
export function missionOutboxCompactionProof(
  projection: MissionProjection,
  outbox: MissionOutboxSnapshot,
): MissionOutboxCompactionProof {
  const archivedMissionIds = new Set(
    Object.values(projection.missions)
      .filter((mission) => mission.archivedAt !== null)
      .map((mission) => mission.id),
  );
  const durablyAppliedRecords = new Map<string, MissionOutboxRecord>();
  for (const record of Object.values(outbox.records)) {
    if (record.status !== "delivered" || !record.delivery) continue;
    const command = record.command;
    if (command.kind === "spawn" || command.kind === "prompt") {
      const attempt = projection.attempts[command.payload.attemptId];
      if (attempt?.missionId === record.missionId && attemptIsTerminal(attempt.status)) {
        durablyAppliedRecords.set(record.id, record);
      }
    } else if (command.kind === "settle") {
      const attempt = projection.attempts[command.payload.attemptId];
      if (
        attempt?.missionId === record.missionId &&
        attempt.status === command.payload.status
      ) durablyAppliedRecords.set(record.id, record);
    } else if (command.kind === "integrate") {
      const train = projection.integrationTrains[command.payload.trainId];
      const entry = train?.entries.find((candidate) =>
        candidate.taskId === command.payload.taskId,
      );
      if (
        train?.missionId === record.missionId &&
        entry?.status === "integrated" &&
        entry.commit?.toLowerCase() === command.payload.commit.toLowerCase()
      ) durablyAppliedRecords.set(record.id, record);
    } else if (command.kind === "gate") {
      const gate = projection.qualityGates[command.payload.gateId];
      if (
        gate?.missionId === record.missionId &&
        ["passed", "failed", "waived"].includes(gate.status)
      ) durablyAppliedRecords.set(record.id, record);
    }
  }
  return { archivedMissionIds, durablyAppliedRecords };
}

function clipped(value: unknown, limit = SHORT_TEXT_LIMIT): unknown {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim().slice(0, limit);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean" || value === null) return value;
  return undefined;
}

function fields(
  source: Record<string, unknown>,
  names: readonly string[],
  outputNames: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const name of names) {
    const value = clipped(source[name], outputNames.has(name) ? OUTPUT_TEXT_LIMIT : SHORT_TEXT_LIMIT);
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function digest(value: unknown): string {
  return `sha256:${sha256Hex(JSON.stringify(value))}`;
}

/** Compact but operationally useful immutable archive copy of one receipt. */
export function missionOutboxAuditEntry(record: MissionOutboxRecord): Record<string, unknown> {
  if (record.status !== "delivered" || !record.delivery) {
    throw new Error("only delivered outbox records can enter the Mission audit checkpoint");
  }
  const command = record.command;
  const receipt = record.delivery.receipt;
  const base = {
    recordId: record.id,
    kind: command.kind,
    idempotencyKey: record.idempotencyKey,
    attempts: record.attempts,
    deliveredAt: record.delivery.deliveredAt,
    commandSha256: digest(command),
    receiptSha256: digest(receipt),
  };
  if (command.kind === "spawn") return {
    ...base,
    taskId: command.payload.taskId,
    attemptId: command.payload.attemptId,
    ...fields(receipt, ["sessionId", "turnId", "cwd", "branch", "baseSha"]),
  };
  if (command.kind === "prompt") return {
    ...base,
    taskId: command.payload.taskId,
    attemptId: command.payload.attemptId,
    sessionId: command.payload.sessionId,
    ...fields(receipt, ["turnId"]),
  };
  if (command.kind === "settle") return {
    ...base,
    taskId: command.payload.taskId,
    attemptId: command.payload.attemptId,
    completionId: command.payload.completionId,
    status: command.payload.status,
  };
  if (command.kind === "integrate") return {
    ...base,
    trainId: command.payload.trainId,
    taskId: command.payload.taskId,
    operationId: command.payload.operationId,
    commit: command.payload.commit,
    expectedHead: command.payload.expectedHead,
    ...fields(receipt, [
      "status", "headBefore", "headAfter", "branch", "headVerified",
      "checkoutRestored", "detail",
    ]),
    conflictFiles: Array.isArray(receipt.conflictFiles)
      ? receipt.conflictFiles
        .filter((value): value is string => typeof value === "string")
        .slice(0, 100)
        .map((value) => value.slice(0, SHORT_TEXT_LIMIT))
      : [],
  };
  return {
    ...base,
    gateId: command.payload.gateId,
    planId: command.payload.planId,
    command: command.payload.command.slice(0, SHORT_TEXT_LIMIT),
    expectedHead: command.payload.expectedHead,
    ...fields(
      receipt,
      [
        "status", "exitCode", "durationMs", "stdout", "stderr",
        "stdoutTruncated", "stderrTruncated", "runId", "head", "headVerified",
      ],
      new Set(["stdout", "stderr"]),
    ),
    stdoutSha256: digest(String(receipt.stdout ?? "")),
    stderrSha256: digest(String(receipt.stderr ?? "")),
  };
}

/** Fixed-size fallback that preserves audit identity/evidence, not bulky text. */
function compactAuditEntry(record: MissionOutboxRecord): Record<string, unknown> {
  const full = missionOutboxAuditEntry(record);
  const compactValue = (value: unknown) => clipped(value, 192);
  const common = {
    recordId: full.recordId,
    kind: full.kind,
    deliveredAt: full.deliveredAt,
    auditSha256: digest({ command: record.command, receipt: record.delivery?.receipt }),
  };
  if (record.command.kind === "spawn" || record.command.kind === "prompt") return {
    ...common,
    taskId: compactValue(full.taskId),
    attemptId: compactValue(full.attemptId),
    sessionId: compactValue(full.sessionId),
    turnId: compactValue(full.turnId),
    baseSha: full.baseSha,
  };
  if (record.command.kind === "settle") return {
    ...common,
    taskId: compactValue(full.taskId),
    attemptId: compactValue(full.attemptId),
    completionId: compactValue(full.completionId),
    status: full.status,
  };
  if (record.command.kind === "integrate") return {
    ...common,
    operationId: compactValue(full.operationId),
    commit: full.commit,
    expectedHead: full.expectedHead,
    status: full.status,
    headBefore: full.headBefore,
    headAfter: full.headAfter,
    headVerified: full.headVerified,
  };
  return {
    ...common,
    gateId: compactValue(full.gateId),
    expectedHead: full.expectedHead,
    status: full.status,
    exitCode: full.exitCode,
    head: full.head,
    headVerified: full.headVerified,
    stdoutSha256: full.stdoutSha256,
    stderrSha256: full.stderrSha256,
  };
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** Build deterministic chunks inserted immediately before mission.archived. */
export function missionOutboxAuditArtifacts(
  missionId: string,
  projection: MissionProjection,
  outbox: MissionOutboxSnapshot,
  archivedAt: number,
  auditIdBase: string,
): Array<Omit<MissionArtifact, "missionId"> & { missionId: string }> {
  const proof = missionOutboxCompactionProof(projection, outbox);
  const delivered = Object.values(outbox.records)
    .filter((record) =>
      record.missionId === missionId && record.status === "delivered" && record.delivery,
    )
    .sort((left, right) =>
      (left.delivery?.deliveredAt ?? 0) - (right.delivery?.deliveredAt ?? 0) ||
      left.id.localeCompare(right.id),
    );
  const unapplied = delivered.filter((record) => !proof.durablyAppliedRecords.has(record.id));
  if (unapplied.length > 0) {
    throw new Error(
      `Mission cannot be archived while ${unapplied.length} delivered command receipt(s) still need reconciliation`,
    );
  }
  let detailLevel: "full" | "compact" = "full";
  let entries = delivered.map(missionOutboxAuditEntry);
  if (serializedBytes(entries) > MAX_AUDIT_ENTRY_BYTES) {
    detailLevel = "compact";
    entries = delivered.map(compactAuditEntry);
  }
  if (serializedBytes(entries) > MAX_AUDIT_ENTRY_BYTES) {
    throw new Error("Mission outbox audit identity exceeds its 8 MiB safety cap");
  }
  const artifacts: Array<Omit<MissionArtifact, "missionId"> & { missionId: string }> = [];
  for (let offset = 0; offset < entries.length; offset += AUDIT_CHUNK_SIZE) {
    const chunk = entries.slice(offset, offset + AUDIT_CHUNK_SIZE);
    const chunkIndex = offset / AUDIT_CHUNK_SIZE;
    artifacts.push({
      id: `${auditIdBase}-${chunkIndex}`,
      missionId,
      taskId: null,
      attemptId: null,
      kind: "report",
      label: "mission-outbox-audit",
      uri: null,
      metadata: {
        schemaVersion: AUDIT_SCHEMA_VERSION,
        archivedAt,
        chunkIndex,
        chunkCount: Math.ceil(entries.length / AUDIT_CHUNK_SIZE),
        recordCount: chunk.length,
        detailLevel,
        records: chunk,
      },
      createdAt: archivedAt,
    });
  }
  // Leave 512 KiB for Mission event envelopes and persistence framing.
  if (serializedBytes(artifacts) > MAX_AUDIT_ENTRY_BYTES) {
    throw new Error("Mission outbox audit artifacts exceed their 8 MiB safety cap");
  }
  return artifacts;
}
