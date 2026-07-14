import type { AttemptStatus } from "./types";

export const MISSION_OUTBOX_VERSION = 1 as const;
export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 5;
export const MAX_OUTBOX_RECORDS = 10_000;
export const MAX_OUTBOX_SERIALIZED_BYTES = 16 * 1024 * 1024;

export type OutboxHydration = "unknown" | "ready" | "failed";
export type OutboxStatus =
  | "pending"
  | "claimed"
  | "delivered"
  | "failed"
  | "dead_letter";

export type TerminalAttemptStatus = Exclude<AttemptStatus, "queued" | "running">;

export type MissionOutboxCommand =
  | {
      kind: "spawn";
      payload: {
        taskId: string;
        attemptId: string;
        /** Deterministic final Vibe/Rust session id known before spawn. */
        sessionId?: string;
        projectId: string;
        cwd: string;
        root?: string;
        branch?: string;
        baseSha?: string;
        copyEnv?: boolean;
        prompt: string;
        model?: string;
        effort?: string;
      };
    }
  | {
      kind: "prompt";
      payload: {
        sessionId: string;
        taskId: string;
        attemptId: string;
        prompt: string;
        expectReport: boolean;
      };
    }
  | {
      kind: "settle";
      payload: {
        taskId: string;
        attemptId: string;
        status: TerminalAttemptStatus;
        summary?: string | null;
        error?: string | null;
        completionId: string;
        report?: Record<string, unknown> | null;
      };
    }
  | {
      kind: "integrate";
      payload: {
        trainId: string;
        taskId: string;
        operationId: string;
        strategy: "merge" | "rebase" | "cherry_pick";
        commit: string;
        expectedHead: string;
      };
    }
  | {
      kind: "gate";
      payload: {
        gateId: string;
        planId: string;
        command: string;
        expectedHead: string;
      };
    };

export interface OutboxLease {
  ownerId: string;
  claimId: string;
  claimedAt: number;
  expiresAt: number;
}

export interface OutboxDelivery {
  deliveredAt: number;
  receipt: Record<string, unknown>;
}

export interface MissionOutboxRecord {
  id: string;
  missionId: string;
  idempotencyKey: string;
  command: MissionOutboxCommand;
  status: OutboxStatus;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: number;
  lease: OutboxLease | null;
  delivery: OutboxDelivery | null;
  lastError: string | null;
}

export interface MissionOutboxSnapshot {
  version: typeof MISSION_OUTBOX_VERSION;
  hydration: OutboxHydration;
  records: Readonly<Record<string, MissionOutboxRecord>>;
}

export interface PersistedMissionOutbox {
  version: typeof MISSION_OUTBOX_VERSION;
  records: MissionOutboxRecord[];
}

type WithOutboxEnvelope<T> = T extends MissionOutboxCommand
  ? T & {
      missionId: string;
      idempotencyKey: string;
      maxAttempts?: number;
    }
  : never;

export type EnqueueMissionCommand = WithOutboxEnvelope<MissionOutboxCommand>;

export interface OutboxEvaluation {
  recordId: string;
  eligible: boolean;
  reason:
    | "ready"
    | "not_due"
    | "lease_active"
    | "delivered"
    | "dead_letter"
    | "attempts_exhausted";
  message: string;
}

export interface ClaimDecision {
  snapshot: MissionOutboxSnapshot;
  record: MissionOutboxRecord | null;
  evaluations: readonly OutboxEvaluation[];
  explanation: string;
}

export interface MutationDecision {
  snapshot: MissionOutboxSnapshot;
  record: MissionOutboxRecord;
  changed: boolean;
  explanation: string;
}

const ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,191}$/;

function assertId(label: string, value: string): void {
  if (!ID_RE.test(value) || ["__proto__", "prototype", "constructor"].includes(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function assertReady(snapshot: MissionOutboxSnapshot): void {
  if (snapshot.hydration !== "ready") {
    throw new Error("Mission outbox persistence is not safely hydrated");
  }
}

function finiteTime(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error("timestamp is invalid");
  return Math.floor(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function safeReceipt(receipt: Record<string, unknown>): Record<string, unknown> {
  let serialized: string;
  try {
    serialized = JSON.stringify(receipt);
  } catch {
    throw new Error("outbox receipt must be JSON serializable");
  }
  if (serialized.length > 32_768) throw new Error("outbox receipt exceeds 32 KB");
  return stableValue(receipt) as Record<string, unknown>;
}

export function commandFingerprint(command: EnqueueMissionCommand): string {
  return JSON.stringify(
    stableValue({
      missionId: command.missionId,
      idempotencyKey: command.idempotencyKey,
      kind: command.kind,
      payload: command.payload,
    }),
  );
}

function recordFingerprint(record: MissionOutboxRecord): string {
  return commandFingerprint({
    missionId: record.missionId,
    idempotencyKey: record.idempotencyKey,
    ...record.command,
  });
}

function validateCommand(command: EnqueueMissionCommand): void {
  assertId("mission id", command.missionId);
  assertId("idempotency key", command.idempotencyKey);
  const serialized = JSON.stringify(command.payload);
  if (serialized.length > 100_000) throw new Error("outbox payload exceeds 100 KB");
  switch (command.kind) {
    case "spawn": {
      const payload = command.payload;
      assertId("task id", payload.taskId);
      assertId("attempt id", payload.attemptId);
      if (payload.sessionId) assertId("session id", payload.sessionId);
      if (payload.baseSha && !/^[0-9a-f]{40,64}$/i.test(payload.baseSha)) {
        throw new Error("spawn base SHA is invalid");
      }
      if (payload.copyEnv === true) throw new Error("mission spawn may not copy environment files");
      assertId("project id", payload.projectId);
      if (!payload.cwd.trim() || !payload.prompt.trim()) throw new Error("spawn cwd and prompt are required");
      break;
    }
    case "prompt": {
      const payload = command.payload;
      assertId("session id", payload.sessionId);
      assertId("task id", payload.taskId);
      assertId("attempt id", payload.attemptId);
      if (!payload.prompt.trim()) throw new Error("prompt text is required");
      break;
    }
    case "settle": {
      const payload = command.payload;
      assertId("task id", payload.taskId);
      assertId("attempt id", payload.attemptId);
      assertId("completion id", payload.completionId);
      break;
    }
    case "integrate": {
      const payload = command.payload;
      assertId("train id", payload.trainId);
      assertId("task id", payload.taskId);
      assertId("operation id", payload.operationId);
      if (!/^[0-9a-f]{7,64}$/i.test(payload.commit) || !/^[0-9a-f]{7,64}$/i.test(payload.expectedHead)) {
        throw new Error("integration commits are invalid");
      }
      break;
    }
    case "gate": {
      const payload = command.payload;
      assertId("gate id", payload.gateId);
      assertId("plan id", payload.planId);
      if (!payload.command.trim() || !/^[0-9a-f]{7,64}$/i.test(payload.expectedHead)) {
        throw new Error("gate command or expected head is invalid");
      }
      break;
    }
    default:
      throw new Error("unknown mission outbox command kind");
  }
}

export function emptyMissionOutbox(
  hydration: OutboxHydration = "ready",
): MissionOutboxSnapshot {
  return { version: MISSION_OUTBOX_VERSION, hydration, records: Object.create(null) };
}

function replaceRecord(
  snapshot: MissionOutboxSnapshot,
  record: MissionOutboxRecord,
): MissionOutboxSnapshot {
  return { ...snapshot, records: { ...snapshot.records, [record.id]: record } };
}

export function enqueueMissionCommand(
  snapshot: MissionOutboxSnapshot,
  command: EnqueueMissionCommand,
  recordId: string,
  now: number,
): MutationDecision {
  assertReady(snapshot);
  validateCommand(command);
  assertId("outbox record id", recordId);
  finiteTime(now);
  const fingerprint = commandFingerprint(command);
  const sameKey = Object.values(snapshot.records).find(
    (record) => record.idempotencyKey === command.idempotencyKey,
  );
  if (sameKey) {
    if (recordFingerprint(sameKey) !== fingerprint) {
      throw new Error("idempotency key is already bound to a different command");
    }
    return {
      snapshot,
      record: sameKey,
      changed: false,
      explanation: `idempotency key reuses outbox record ${sameKey.id}`,
    };
  }
  if (snapshot.records[recordId]) throw new Error("outbox record id already exists");
  if (Object.keys(snapshot.records).length >= MAX_OUTBOX_RECORDS) {
    throw new Error("mission outbox capacity is exhausted");
  }
  const maxAttempts = Math.min(
    20,
    Math.max(1, Math.floor(command.maxAttempts ?? DEFAULT_OUTBOX_MAX_ATTEMPTS)),
  );
  const record: MissionOutboxRecord = {
    id: recordId,
    missionId: command.missionId,
    idempotencyKey: command.idempotencyKey,
    command: { kind: command.kind, payload: command.payload } as MissionOutboxCommand,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    maxAttempts,
    nextAttemptAt: now,
    lease: null,
    delivery: null,
    lastError: null,
  };
  return {
    snapshot: replaceRecord(snapshot, record),
    record,
    changed: true,
    explanation: `write-ahead ${command.kind} command queued`,
  };
}

function retryDelay(record: MissionOutboxRecord): number {
  const base = 1_000 * 2 ** Math.max(0, record.attempts - 1);
  const capped = Math.min(5 * 60_000, base);
  let hash = 2_166_136_261;
  const key = `${record.id}:${record.attempts}`;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  const jitter = 0.9 + ((hash >>> 0) / 0xffff_ffff) * 0.2;
  return Math.round(capped * jitter);
}

function expireLease(record: MissionOutboxRecord, now: number): MissionOutboxRecord {
  if (record.status !== "claimed" || !record.lease || record.lease.expiresAt > now) {
    return record;
  }
  const exhausted = record.attempts >= record.maxAttempts;
  return {
    ...record,
    status: exhausted ? "dead_letter" : "failed",
    updatedAt: now,
    nextAttemptAt: exhausted ? Number.MAX_SAFE_INTEGER : now + retryDelay(record),
    lease: null,
    lastError: "claim lease expired before durable delivery acknowledgement",
  };
}

export function reapExpiredClaims(
  snapshot: MissionOutboxSnapshot,
  now: number,
): MissionOutboxSnapshot {
  assertReady(snapshot);
  finiteTime(now);
  let changed = false;
  const records: Record<string, MissionOutboxRecord> = {};
  for (const [id, value] of Object.entries(snapshot.records)) {
    const record = expireLease(value, now);
    records[id] = record;
    if (record !== value) changed = true;
  }
  return changed ? { ...snapshot, records } : snapshot;
}

export function claimNextMissionCommand(
  snapshot: MissionOutboxSnapshot,
  ownerId: string,
  claimId: string,
  now: number,
  leaseMs: number,
): ClaimDecision {
  assertReady(snapshot);
  assertId("claim owner", ownerId);
  assertId("claim id", claimId);
  finiteTime(now);
  const duration = Math.min(60 * 60_000, Math.max(1_000, Math.floor(leaseMs)));
  let current = reapExpiredClaims(snapshot, now);
  const evaluations: OutboxEvaluation[] = [];
  const ordered = Object.values(current.records).sort(
    (a, b) => a.nextAttemptAt - b.nextAttemptAt || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
  let selected: MissionOutboxRecord | null = null;
  for (const record of ordered) {
    let evaluation: OutboxEvaluation;
    if (record.status === "delivered") {
      evaluation = { recordId: record.id, eligible: false, reason: "delivered", message: "already delivered" };
    } else if (record.status === "dead_letter") {
      evaluation = { recordId: record.id, eligible: false, reason: "dead_letter", message: "manual retry is required" };
    } else if (record.status === "claimed") {
      evaluation = { recordId: record.id, eligible: false, reason: "lease_active", message: `claimed until ${record.lease?.expiresAt ?? 0}` };
    } else if (record.attempts >= record.maxAttempts) {
      evaluation = { recordId: record.id, eligible: false, reason: "attempts_exhausted", message: "retry budget is exhausted" };
      const dead: MissionOutboxRecord = { ...record, status: "dead_letter", lease: null, updatedAt: now, nextAttemptAt: Number.MAX_SAFE_INTEGER };
      current = replaceRecord(current, dead);
    } else if (record.nextAttemptAt > now) {
      evaluation = { recordId: record.id, eligible: false, reason: "not_due", message: `retry is due at ${record.nextAttemptAt}` };
    } else if (!selected) {
      evaluation = { recordId: record.id, eligible: true, reason: "ready", message: "oldest due command selected" };
      selected = {
        ...record,
        status: "claimed",
        attempts: record.attempts + 1,
        updatedAt: now,
        lease: { ownerId, claimId, claimedAt: now, expiresAt: now + duration },
        lastError: null,
      };
      current = replaceRecord(current, selected);
    } else {
      evaluation = { recordId: record.id, eligible: false, reason: "not_due", message: "a prior due command won this claim" };
    }
    evaluations.push(evaluation);
  }
  return {
    snapshot: current,
    record: selected,
    evaluations: evaluations.sort((a, b) => a.recordId.localeCompare(b.recordId)),
    explanation: selected
      ? `claimed ${selected.id} as attempt ${selected.attempts}/${selected.maxAttempts}`
      : "no outbox command is currently claimable",
  };
}

/** Claim one known write-ahead record without stealing another subsystem's command. */
export function claimMissionCommandById(
  snapshot: MissionOutboxSnapshot,
  recordId: string,
  ownerId: string,
  claimId: string,
  now: number,
  leaseMs: number,
): ClaimDecision {
  assertReady(snapshot);
  assertId("outbox record id", recordId);
  assertId("claim owner", ownerId);
  assertId("claim id", claimId);
  finiteTime(now);
  const duration = Math.min(60 * 60_000, Math.max(1_000, Math.floor(leaseMs)));
  let current = reapExpiredClaims(snapshot, now);
  const record = current.records[recordId];
  if (!record) throw new Error("outbox record is unknown");
  let evaluation: OutboxEvaluation;
  let selected: MissionOutboxRecord | null = null;
  if (record.status === "delivered") {
    evaluation = { recordId, eligible: false, reason: "delivered", message: "already delivered" };
  } else if (record.status === "dead_letter") {
    evaluation = { recordId, eligible: false, reason: "dead_letter", message: "manual retry is required" };
  } else if (record.status === "claimed") {
    evaluation = { recordId, eligible: false, reason: "lease_active", message: `claimed until ${record.lease?.expiresAt ?? 0}` };
  } else if (record.attempts >= record.maxAttempts) {
    const dead = { ...record, status: "dead_letter" as const, lease: null, updatedAt: now, nextAttemptAt: Number.MAX_SAFE_INTEGER };
    current = replaceRecord(current, dead);
    evaluation = { recordId, eligible: false, reason: "attempts_exhausted", message: "retry budget is exhausted" };
  } else if (record.nextAttemptAt > now) {
    evaluation = { recordId, eligible: false, reason: "not_due", message: `retry is due at ${record.nextAttemptAt}` };
  } else {
    selected = {
      ...record,
      status: "claimed",
      attempts: record.attempts + 1,
      updatedAt: now,
      lease: { ownerId, claimId, claimedAt: now, expiresAt: now + duration },
      lastError: null,
    };
    current = replaceRecord(current, selected);
    evaluation = { recordId, eligible: true, reason: "ready", message: "requested command claimed" };
  }
  return {
    snapshot: current,
    record: selected,
    evaluations: [evaluation],
    explanation: selected ? `claimed ${selected.id} directly` : evaluation.message,
  };
}

function recordForClaim(
  snapshot: MissionOutboxSnapshot,
  recordId: string,
  claimId: string,
): MissionOutboxRecord {
  const record = snapshot.records[recordId];
  if (!record) throw new Error("outbox record is unknown");
  if (record.status === "delivered") return record;
  if (record.status !== "claimed" || record.lease?.claimId !== claimId) {
    throw new Error("outbox claim is stale or not owned by this delivery");
  }
  return record;
}

export function deliverMissionCommand(
  snapshot: MissionOutboxSnapshot,
  recordId: string,
  claimId: string,
  receipt: Record<string, unknown>,
  now: number,
): MutationDecision {
  assertReady(snapshot);
  finiteTime(now);
  const record = recordForClaim(snapshot, recordId, claimId);
  if (record.status === "delivered") {
    return { snapshot, record, changed: false, explanation: "duplicate completion ignored" };
  }
  const delivered: MissionOutboxRecord = {
    ...record,
    status: "delivered",
    updatedAt: now,
    lease: null,
    delivery: { deliveredAt: now, receipt: safeReceipt(receipt) },
    lastError: null,
  };
  return { snapshot: replaceRecord(snapshot, delivered), record: delivered, changed: true, explanation: `delivery of ${record.id} recorded durably` };
}

export function failMissionCommand(
  snapshot: MissionOutboxSnapshot,
  recordId: string,
  claimId: string,
  error: string,
  now: number,
  retryable = true,
): MutationDecision {
  assertReady(snapshot);
  finiteTime(now);
  const record = recordForClaim(snapshot, recordId, claimId);
  if (record.status === "delivered") {
    return { snapshot, record, changed: false, explanation: "delivered command cannot be failed" };
  }
  const dead = !retryable || record.attempts >= record.maxAttempts;
  const failed: MissionOutboxRecord = {
    ...record,
    status: dead ? "dead_letter" : "failed",
    updatedAt: now,
    lease: null,
    nextAttemptAt: dead ? Number.MAX_SAFE_INTEGER : now + retryDelay(record),
    lastError: error.trim().replace(/\s+/g, " ").slice(0, 2_000) || "delivery failed",
  };
  return {
    snapshot: replaceRecord(snapshot, failed),
    record: failed,
    changed: true,
    explanation: dead
      ? `command ${record.id} moved to dead-letter after ${record.attempts} attempts`
      : `command ${record.id} will retry at ${failed.nextAttemptAt}`,
  };
}

/** Adopt an authoritative external idempotency receipt after a crash window. */
export function adoptMissionCommandReceipt(
  snapshot: MissionOutboxSnapshot,
  idempotencyKey: string,
  receipt: Record<string, unknown>,
  deliveredAt: number,
): MutationDecision | null {
  assertReady(snapshot);
  finiteTime(deliveredAt);
  const record = Object.values(snapshot.records).find(
    (candidate) => candidate.idempotencyKey === idempotencyKey,
  );
  if (!record) return null;
  if (record.status === "delivered") {
    return { snapshot, record, changed: false, explanation: "external receipt was already adopted" };
  }
  const delivered: MissionOutboxRecord = {
    ...record,
    status: "delivered",
    updatedAt: deliveredAt,
    lease: null,
    delivery: { deliveredAt, receipt: safeReceipt(receipt) },
    lastError: null,
  };
  return { snapshot: replaceRecord(snapshot, delivered), record: delivered, changed: true, explanation: `external receipt recovered ${record.id} without redispatch` };
}

export function retryDeadLetter(
  snapshot: MissionOutboxSnapshot,
  recordId: string,
  now: number,
): MutationDecision {
  assertReady(snapshot);
  const record = snapshot.records[recordId];
  if (!record) throw new Error("outbox record is unknown");
  if (record.status !== "dead_letter") {
    return { snapshot, record, changed: false, explanation: "record is not dead-lettered" };
  }
  const pending: MissionOutboxRecord = {
    ...record,
    status: "pending",
    attempts: 0,
    nextAttemptAt: finiteTime(now),
    updatedAt: now,
    lease: null,
    lastError: null,
  };
  return { snapshot: replaceRecord(snapshot, pending), record: pending, changed: true, explanation: `manual retry re-armed ${record.id}` };
}
