import {
  MISSION_OUTBOX_VERSION,
  MAX_OUTBOX_RECORDS,
  MAX_OUTBOX_SERIALIZED_BYTES,
  emptyMissionOutbox,
  enqueueMissionCommand,
  type MissionOutboxRecord,
  type MissionOutboxSnapshot,
  type OutboxStatus,
  type PersistedMissionOutbox,
} from "./outbox";

const STATUSES = new Set<OutboxStatus>([
  "pending",
  "claimed",
  "delivered",
  "failed",
  "dead_letter",
]);

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function time(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`mission outbox ${label} is invalid`);
  }
  return Math.floor(value);
}

export function migrateMissionOutbox(raw: unknown): MissionOutboxSnapshot {
  if (raw == null) return emptyMissionOutbox("ready");
  let rawSize = 0;
  try {
    rawSize = JSON.stringify(raw).length;
  } catch {
    throw new Error("mission outbox persistence is not JSON serializable");
  }
  if (rawSize > MAX_OUTBOX_SERIALIZED_BYTES) {
    throw new Error("persisted mission outbox exceeds 16 MB");
  }
  const envelope = object(raw);
  if (!envelope || envelope.version !== MISSION_OUTBOX_VERSION || !Array.isArray(envelope.records)) {
    throw new Error("unsupported mission outbox persistence envelope");
  }
  if (envelope.records.length > MAX_OUTBOX_RECORDS) {
    throw new Error("persisted mission outbox exceeds its record cap");
  }
  let snapshot = emptyMissionOutbox("ready");
  for (const rawRecord of envelope.records) {
    const value = object(rawRecord);
    const command = object(value?.command);
    if (
      !value ||
      typeof value.id !== "string" ||
      typeof value.missionId !== "string" ||
      typeof value.idempotencyKey !== "string" ||
      !command ||
      typeof command.kind !== "string" ||
      !object(command.payload) ||
      typeof value.status !== "string" ||
      !STATUSES.has(value.status as OutboxStatus)
    ) {
      throw new Error("persisted mission outbox record is malformed");
    }
    const createdAt = time(value.createdAt, "createdAt");
    const seeded = enqueueMissionCommand(
      snapshot,
      {
        missionId: value.missionId,
        idempotencyKey: value.idempotencyKey,
        kind: command.kind,
        payload: command.payload,
        maxAttempts: value.maxAttempts,
      } as Parameters<typeof enqueueMissionCommand>[1],
      value.id,
      createdAt,
    );
    const attempts = value.attempts;
    const maxAttempts = value.maxAttempts;
    if (
      typeof attempts !== "number" ||
      !Number.isInteger(attempts) ||
      attempts < 0 ||
      typeof maxAttempts !== "number" ||
      !Number.isInteger(maxAttempts) ||
      maxAttempts < 1 ||
      maxAttempts > 20 ||
      attempts > maxAttempts
    ) {
      throw new Error("persisted mission outbox retry counters are invalid");
    }
    const status = value.status as OutboxStatus;
    const rawLease = object(value.lease);
    const lease = rawLease
      ? {
          ownerId: String(rawLease.ownerId ?? ""),
          claimId: String(rawLease.claimId ?? ""),
          claimedAt: time(rawLease.claimedAt, "lease claimedAt"),
          expiresAt: time(rawLease.expiresAt, "lease expiresAt"),
        }
      : null;
    if ((status === "claimed") !== Boolean(lease)) {
      throw new Error("persisted mission outbox claim and lease disagree");
    }
    const leaseId = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,191}$/;
    if (
      lease &&
      (!leaseId.test(lease.ownerId) ||
        !leaseId.test(lease.claimId) ||
        lease.expiresAt <= lease.claimedAt)
    ) {
      throw new Error("persisted mission outbox lease is invalid");
    }
    const rawDelivery = object(value.delivery);
    const delivery = rawDelivery
      ? {
          deliveredAt: time(rawDelivery.deliveredAt, "delivery deliveredAt"),
          receipt: object(rawDelivery.receipt) ?? {},
        }
      : null;
    if ((status === "delivered") !== Boolean(delivery)) {
      throw new Error("persisted mission outbox delivery and status disagree");
    }
    const record: MissionOutboxRecord = {
      ...seeded.record,
      status,
      updatedAt: time(value.updatedAt, "updatedAt"),
      attempts,
      maxAttempts,
      nextAttemptAt: time(value.nextAttemptAt, "nextAttemptAt"),
      lease,
      delivery,
      lastError: typeof value.lastError === "string" ? value.lastError.slice(0, 2_000) : null,
    };
    snapshot = { ...seeded.snapshot, records: { ...seeded.snapshot.records, [record.id]: record } };
  }
  return snapshot;
}

export function serializeMissionOutbox(
  snapshot: MissionOutboxSnapshot,
): PersistedMissionOutbox {
  if (snapshot.hydration !== "ready") {
    throw new Error("cannot serialize an unavailable mission outbox");
  }
  const persisted: PersistedMissionOutbox = {
    version: MISSION_OUTBOX_VERSION,
    records: Object.values(snapshot.records)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((record) => ({
        ...record,
        command: JSON.parse(JSON.stringify(record.command)) as MissionOutboxRecord["command"],
        delivery: record.delivery
          ? {
              ...record.delivery,
              receipt: JSON.parse(JSON.stringify(record.delivery.receipt)) as Record<string, unknown>,
            }
          : null,
      })),
  };
  if (JSON.stringify(persisted).length > MAX_OUTBOX_SERIALIZED_BYTES) {
    throw new Error("mission outbox exceeds its 16 MB persistence cap");
  }
  return persisted;
}
