import { replayMissionEvents } from "./core";
import {
  MISSION_STORE_VERSION,
  type MissionEvent,
  type PersistedMissions,
} from "./types";

const EVENT_TYPES = new Set([
  "mission.created",
  "mission.archived",
  "mission.cancelled",
  "mission.activated",
  "mission.paused",
  "mission.resumed",
  "task.added",
  "task.updated",
  "task.archived",
  "task.paused",
  "task.resumed",
  "task.requeued",
  "attempt.started",
  "attempt.finished",
  "artifact.recorded",
  "quality_gate.added",
  "quality_gate.resulted",
  "integration_train.created",
  "integration_train.updated",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeEvent(
  raw: unknown,
  revisions: Map<string, number>,
  legacy: boolean,
): MissionEvent {
  const value = record(raw);
  if (!value) throw new Error("mission event must be an object");
  if (typeof value.missionId !== "string" || typeof value.type !== "string") {
    throw new Error("mission event is missing missionId or type");
  }
  if (!EVENT_TYPES.has(value.type) || !record(value.data)) {
    throw new Error(`unsupported mission event: ${String(value.type)}`);
  }
  const previous = revisions.get(value.missionId) ?? 0;
  if (!legacy &&
    (typeof value.revision !== "number" || !Number.isInteger(value.revision))) {
    throw new Error("v2 mission event is missing revision");
  }
  const revision = typeof value.revision === "number" && Number.isInteger(value.revision)
    ? value.revision
    : previous + 1;
  revisions.set(value.missionId, revision);
  if (!legacy && typeof value.occurredAt !== "number") {
    throw new Error("v2 mission event is missing occurredAt");
  }
  const occurredAt =
    typeof value.occurredAt === "number"
      ? value.occurredAt
      : typeof value.at === "number"
        ? value.at
        : 0;
  if (!legacy && typeof value.eventId !== "string") {
    throw new Error("v2 mission event is missing eventId");
  }
  const eventId =
    typeof value.eventId === "string"
      ? value.eventId
      : `legacy:${value.missionId}:${revision}`;
  const validActor =
    value.actor === "human" ||
    value.actor === "orchestrator" ||
    value.actor === "scheduler" ||
    value.actor === "system"
  if (!legacy && !validActor) throw new Error("v2 mission event is missing actor");
  const actor = validActor ? value.actor as MissionEvent["actor"] : "system";
  return {
    ...value,
    eventId,
    missionId: value.missionId,
    revision,
    occurredAt,
    actor,
    type: value.type,
    data: value.data,
    ...(typeof value.idempotencyKey === "string"
      ? { idempotencyKey: value.idempotencyKey }
      : {}),
  } as MissionEvent;
}

/**
 * Parse and migrate the persisted mission event log. Invalid/newer stores
 * throw so the mission PersistenceCoordinator remains write-gated.
 */
export function migratePersistedMissions(raw: unknown): PersistedMissions {
  if (raw === null || raw === undefined) {
    return { version: MISSION_STORE_VERSION, events: [] };
  }
  const value = record(raw);
  if (!value) throw new Error("mission store must be an object");
  const version = value.version === undefined ? 1 : value.version;
  if (typeof version !== "number" || version < 1 || version > MISSION_STORE_VERSION) {
    throw new Error(`unsupported mission store version: ${String(version)}`);
  }
  if (!Array.isArray(value.events)) throw new Error("mission store events must be an array");
  if (value.events.length > 250_000) throw new Error("mission event log exceeds safety limit");
  const revisions = new Map<string, number>();
  const events = value.events.map((event) => normalizeEvent(event, revisions, version === 1));
  // Replay is also the structural/invariant validation pass. Never persist a
  // partially accepted log after one malformed or stale event.
  replayMissionEvents(events);
  return { version: MISSION_STORE_VERSION, events };
}

export function serializeMissionEvents(events: readonly MissionEvent[]): PersistedMissions {
  replayMissionEvents(events);
  return { version: MISSION_STORE_VERSION, events: [...events] };
}
