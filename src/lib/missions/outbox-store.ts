import { nanoid } from "nanoid";
import { create } from "zustand";
import { loadMissionOutbox, saveMissionOutbox } from "@/lib/transport";
import {
  createPersistenceCoordinator,
  type HydrationStatus,
} from "@/lib/persistence/coordinator";
import {
  claimNextMissionCommand,
  claimMissionCommandById,
  deliverMissionCommand,
  emptyMissionOutbox,
  enqueueMissionCommand,
  failMissionCommand,
  pruneDeliveredCommandsForArchivedMissions,
  retryDeadLetter,
  type EnqueueMissionCommand,
  type MissionOutboxRecord,
  type MissionOutboxSnapshot,
} from "./outbox";
import {
  migrateMissionOutbox,
  serializeMissionOutbox,
} from "./outbox-serialization";

export interface MissionOutboxState {
  snapshot: MissionOutboxSnapshot;
  hydrateStatus: HydrationStatus;
  hydrateError: string | null;
  hydrate(): Promise<void>;
  enqueue(
    command: EnqueueMissionCommand,
    options?: { recordId?: string; now?: number },
  ): Promise<MissionOutboxRecord>;
  claimNext(
    ownerId: string,
    options?: { claimId?: string; now?: number; leaseMs?: number },
  ): Promise<MissionOutboxRecord | null>;
  claim(
    recordId: string,
    ownerId: string,
    options?: { claimId?: string; now?: number; leaseMs?: number },
  ): Promise<MissionOutboxRecord | null>;
  deliver(
    recordId: string,
    claimId: string,
    receipt: Record<string, unknown>,
    now?: number,
  ): Promise<MissionOutboxRecord>;
  fail(
    recordId: string,
    claimId: string,
    error: string,
    options?: { now?: number; retryable?: boolean },
  ): Promise<MissionOutboxRecord>;
  retryDeadLetter(recordId: string, now?: number): Promise<MissionOutboxRecord>;
  pruneArchivedDelivered(
    archivedMissionIds: ReadonlySet<string>,
    durablyAppliedRecords: ReadonlyMap<string, MissionOutboxRecord>,
    options?: { batchSize?: number },
  ): Promise<readonly string[]>;
}

function snapshot(): ReturnType<typeof serializeMissionOutbox> {
  return serializeMissionOutbox(useMissionOutbox.getState().snapshot);
}

const persistence = createPersistenceCoordinator({
  name: "missionOutbox",
  debounceMs: 0,
  snapshot,
  save: saveMissionOutbox,
});

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function persistTransition(
  set: (patch: Partial<MissionOutboxState>) => void,
  next: MissionOutboxSnapshot,
): Promise<void> {
  set({ snapshot: next });
  persistence.schedule();
  await persistence.flush();
  const health = persistence.health();
  if (health.write === "failed" || health.hydration !== "ready") {
    const error = health.error ?? new Error("mission outbox persistence failed");
    // We do not know whether the underlying store.set or store.save crossed
    // the durability boundary. Freeze all further dispatch until a reload can
    // establish the authoritative snapshot.
    persistence.hydrationFailed(error);
    set({
      snapshot: { ...next, hydration: "failed" },
      hydrateStatus: "failed",
      hydrateError: message(error),
    });
    throw new Error(`Mission outbox write is not durable: ${message(error)}`);
  }
}

export const useMissionOutbox = create<MissionOutboxState>((set, get) => ({
  snapshot: emptyMissionOutbox("unknown"),
  hydrateStatus: "pending",
  hydrateError: null,

  hydrate: async () => {
    try {
      const loaded = migrateMissionOutbox(await loadMissionOutbox());
      set({ snapshot: loaded, hydrateStatus: "ready", hydrateError: null });
      persistence.hydrationSucceeded();
    } catch (error) {
      persistence.hydrationFailed(error);
      set({
        snapshot: emptyMissionOutbox("failed"),
        hydrateStatus: "failed",
        hydrateError: message(error),
      });
    }
  },

  enqueue: async (command, options) => {
    const decision = enqueueMissionCommand(
      get().snapshot,
      command,
      options?.recordId ?? nanoid(16),
      options?.now ?? Date.now(),
    );
    if (decision.changed) await persistTransition(set, decision.snapshot);
    return decision.record;
  },

  claimNext: async (ownerId, options) => {
    const decision = claimNextMissionCommand(
      get().snapshot,
      ownerId,
      options?.claimId ?? nanoid(16),
      options?.now ?? Date.now(),
      options?.leaseMs ?? 60_000,
    );
    if (decision.snapshot !== get().snapshot) {
      await persistTransition(set, decision.snapshot);
    }
    return decision.record;
  },

  claim: async (recordId, ownerId, options) => {
    const decision = claimMissionCommandById(
      get().snapshot,
      recordId,
      ownerId,
      options?.claimId ?? nanoid(16),
      options?.now ?? Date.now(),
      options?.leaseMs ?? 60_000,
    );
    if (decision.snapshot !== get().snapshot) await persistTransition(set, decision.snapshot);
    return decision.record;
  },

  deliver: async (recordId, claimId, receipt, now = Date.now()) => {
    const decision = deliverMissionCommand(get().snapshot, recordId, claimId, receipt, now);
    if (decision.changed) await persistTransition(set, decision.snapshot);
    return decision.record;
  },

  fail: async (recordId, claimId, error, options) => {
    const decision = failMissionCommand(
      get().snapshot,
      recordId,
      claimId,
      error,
      options?.now ?? Date.now(),
      options?.retryable ?? true,
    );
    if (decision.changed) await persistTransition(set, decision.snapshot);
    return decision.record;
  },

  retryDeadLetter: async (recordId, now = Date.now()) => {
    const decision = retryDeadLetter(get().snapshot, recordId, now);
    if (decision.changed) await persistTransition(set, decision.snapshot);
    return decision.record;
  },

  pruneArchivedDelivered: async (archivedMissionIds, durablyAppliedRecords, options) => {
    const decision = pruneDeliveredCommandsForArchivedMissions(
      get().snapshot,
      archivedMissionIds,
      durablyAppliedRecords,
      options?.batchSize,
    );
    if (decision.changed) await persistTransition(set, decision.snapshot);
    return decision.removedRecordIds;
  },
}));

export async function hydrateMissionOutbox(): Promise<void> {
  await useMissionOutbox.getState().hydrate();
}

export async function flushMissionOutboxPersist(): Promise<void> {
  await persistence.flush();
}
