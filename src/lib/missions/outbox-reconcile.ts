import type { MissionProjection, TaskAttempt } from "./types";
import {
  adoptMissionCommandReceipt,
  reapExpiredClaims,
  type MissionOutboxRecord,
  type MissionOutboxSnapshot,
} from "./outbox";

export interface ExternalOutboxReceipt {
  idempotencyKey: string;
  deliveredAt: number;
  receipt: Record<string, unknown>;
}

export interface ReconcileLiveSession {
  sessionId: string;
  attemptId: string | null;
  taskId: string | null;
  status: "active" | "idle" | "exited";
}

export type StartupReconcileAction =
  | {
      kind: "persistence_blocked";
      actionId: string;
      explanation: string;
    }
  | {
      kind: "receipt_adopted" | "claim_recovered" | "command_dead_lettered";
      actionId: string;
      recordId: string;
      explanation: string;
    }
  | {
      kind: "apply_delivered_completion";
      actionId: string;
      recordId: string;
      missionId: string;
      command: MissionOutboxRecord["command"];
      receipt: Record<string, unknown>;
      explanation: string;
    }
  | {
      kind: "settle_orphan_attempt";
      actionId: string;
      missionId: string;
      taskId: string;
      attemptId: string;
      explanation: string;
    }
  | {
      kind: "close_orphan_session";
      actionId: string;
      sessionId: string;
      explanation: string;
    };

export interface StartupReconcileInput {
  outbox: MissionOutboxSnapshot;
  projection: MissionProjection;
  liveSessions: readonly ReconcileLiveSession[];
  receipts?: readonly ExternalOutboxReceipt[];
  now: number;
}

export interface StartupReconcilePlan {
  snapshot: MissionOutboxSnapshot;
  actions: readonly StartupReconcileAction[];
  dispatchAllowed: boolean;
  explanation: string;
}

function completionApplied(
  record: MissionOutboxRecord,
  projection: MissionProjection,
): boolean {
  const command = record.command;
  if (command.kind === "settle") {
    const attempt = projection.attempts[command.payload.attemptId];
    return Boolean(
      attempt &&
        ["succeeded", "failed", "blocked", "needs_human", "cancelled"].includes(
          attempt.status,
        ),
    );
  }
  if (command.kind === "integrate") {
    const train = projection.integrationTrains[command.payload.trainId];
    return Boolean(
      train?.entries.some(
        (entry) =>
          entry.taskId === command.payload.taskId && entry.status === "integrated",
      ),
    );
  }
  if (command.kind === "gate") {
    const gate = projection.qualityGates[command.payload.gateId];
    return Boolean(gate && ["passed", "failed", "waived"].includes(gate.status));
  }
  if (command.kind === "spawn") {
    const attempt = projection.attempts[command.payload.attemptId];
    const receiptSession = record.delivery?.receipt.sessionId;
    return Boolean(
      attempt &&
        typeof receiptSession === "string" &&
        attempt.sessionId === receiptSession,
    );
  }
  // Prompt delivery has no durable MissionProjection field; the delivered
  // outbox record itself is the idempotent completion proof.
  return true;
}

function hasRecoverableSpawn(
  outbox: MissionOutboxSnapshot,
  attempt: TaskAttempt,
): boolean {
  return Object.values(outbox.records).some(
    (record) =>
      record.command.kind === "spawn" &&
      record.command.payload.attemptId === attempt.id &&
      record.status !== "dead_letter" &&
      record.status !== "delivered",
  );
}

function deliveredSpawnAwaitingProjection(
  outbox: MissionOutboxSnapshot,
  attemptId: string,
): boolean {
  return Object.values(outbox.records).some(
    (record) =>
      record.command.kind === "spawn" &&
      record.command.payload.attemptId === attemptId &&
      record.status === "delivered",
  );
}

function deliveredSettleAwaitingProjection(
  outbox: MissionOutboxSnapshot,
  attemptId: string,
): boolean {
  return Object.values(outbox.records).some(
    (record) =>
      record.command.kind === "settle" &&
      record.command.payload.attemptId === attemptId &&
      record.status === "delivered",
  );
}

function sessionBackedByDeliveredSpawn(
  outbox: MissionOutboxSnapshot,
  session: ReconcileLiveSession,
): boolean {
  return Object.values(outbox.records).some(
    (record) =>
      record.command.kind === "spawn" &&
      record.status === "delivered" &&
      record.command.payload.attemptId === session.attemptId &&
      record.command.payload.taskId === session.taskId &&
      record.delivery?.receipt.sessionId === session.sessionId,
  );
}

/**
 * Pure startup reconciliation. It never dispatches, closes, or settles work;
 * the caller executes returned actions through the same durable command/event
 * paths. This makes repeated startup scans deterministic and harmless.
 */
export function reconcileMissionStartup(
  input: StartupReconcileInput,
): StartupReconcilePlan {
  if (input.outbox.hydration !== "ready") {
    return {
      snapshot: input.outbox,
      actions: [
        {
          kind: "persistence_blocked",
          actionId: "reconcile:persistence-blocked",
          explanation:
            "mission outbox persistence is unknown; startup dispatch is paused fail-closed",
        },
      ],
      dispatchAllowed: false,
      explanation: "startup reconciliation is blocked by unknown persistence",
    };
  }

  const actions: StartupReconcileAction[] = [];
  let snapshot = reapExpiredClaims(input.outbox, input.now);
  for (const before of Object.values(input.outbox.records).sort((a, b) => a.id.localeCompare(b.id))) {
    const after = snapshot.records[before.id];
    if (before.status === "claimed" && after?.status !== "claimed") {
      const dead = after?.status === "dead_letter";
      actions.push({
        kind: dead ? "command_dead_lettered" : "claim_recovered",
        actionId: `reconcile:${dead ? "dead" : "claim"}:${before.id}`,
        recordId: before.id,
        explanation: dead
          ? `expired claim ${before.id} exhausted its retry budget`
          : `expired claim ${before.id} was recovered for bounded replay`,
      });
    }
  }

  for (const receipt of [...(input.receipts ?? [])].sort((a, b) =>
    a.idempotencyKey.localeCompare(b.idempotencyKey),
  )) {
    const adopted = adoptMissionCommandReceipt(
      snapshot,
      receipt.idempotencyKey,
      receipt.receipt,
      receipt.deliveredAt,
    );
    if (!adopted) continue;
    snapshot = adopted.snapshot;
    if (adopted.changed) {
      actions.push({
        kind: "receipt_adopted",
        actionId: `reconcile:receipt:${adopted.record.id}`,
        recordId: adopted.record.id,
        explanation: adopted.explanation,
      });
    }
  }

  for (const record of Object.values(snapshot.records).sort((a, b) => a.id.localeCompare(b.id))) {
    if (
      record.status === "delivered" &&
      record.delivery &&
      !completionApplied(record, input.projection)
    ) {
      actions.push({
        kind: "apply_delivered_completion",
        actionId: `reconcile:completion:${record.id}`,
        recordId: record.id,
        missionId: record.missionId,
        command: record.command,
        receipt: record.delivery.receipt,
        explanation: `external ${record.command.kind} completed, but its Mission projection event is missing`,
      });
    }
  }

  const liveById = new Map(
    input.liveSessions
      .filter((session) => session.status !== "exited")
      .map((session) => [session.sessionId, session]),
  );
  for (const attempt of Object.values(input.projection.attempts).sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    if (attempt.status !== "running") continue;
    const sessionLive = attempt.sessionId ? liveById.has(attempt.sessionId) : false;
    if (
      sessionLive ||
      hasRecoverableSpawn(snapshot, attempt) ||
      deliveredSpawnAwaitingProjection(snapshot, attempt.id) ||
      deliveredSettleAwaitingProjection(snapshot, attempt.id)
    ) {
      continue;
    }
    actions.push({
      kind: "settle_orphan_attempt",
      actionId: `reconcile:attempt:${attempt.id}`,
      missionId: attempt.missionId,
      taskId: attempt.taskId,
      attemptId: attempt.id,
      explanation: attempt.sessionId
        ? `running attempt references missing session ${attempt.sessionId}`
        : "running attempt has neither a session nor a recoverable spawn command",
    });
  }

  for (const session of [...input.liveSessions].sort((a, b) =>
    a.sessionId.localeCompare(b.sessionId),
  )) {
    if (session.status === "exited") continue;
    const attempt = session.attemptId
      ? input.projection.attempts[session.attemptId]
      : null;
    const valid = Boolean(
      attempt &&
        attempt.status === "running" &&
        attempt.sessionId === session.sessionId &&
        (!session.taskId || session.taskId === attempt.taskId),
    );
    if (!valid && !sessionBackedByDeliveredSpawn(snapshot, session)) {
      actions.push({
        kind: "close_orphan_session",
        actionId: `reconcile:session:${session.sessionId}`,
        sessionId: session.sessionId,
        explanation: attempt
          ? `session disagrees with attempt ${attempt.id} or that attempt is terminal`
          : "session has no live Mission attempt",
      });
    }
  }

  return {
    snapshot,
    actions: actions.sort((a, b) => a.actionId.localeCompare(b.actionId)),
    dispatchAllowed: true,
    explanation:
      actions.length === 0
        ? "mission outbox, attempts and sessions are consistent"
        : `${actions.length} deterministic startup reconciliation actions`,
  };
}
