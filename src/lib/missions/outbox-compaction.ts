import { persistenceIssues } from "@/lib/persistence/coordinator";
import {
  DEFAULT_OUTBOX_PRUNE_BATCH,
  MAX_OUTBOX_RECORDS,
} from "./outbox";
import { useMissionOutbox } from "./outbox-store";
import { flushMissionsPersist, useMissions } from "./store";
import {
  missionOutboxCompactionProof,
  type MissionOutboxCompactionProof,
} from "./outbox-audit";

export { missionOutboxCompactionProof } from "./outbox-audit";
export type { MissionOutboxCompactionProof } from "./outbox-audit";

const MAX_COMPACTION_PASSES = Math.ceil(
  MAX_OUTBOX_RECORDS / DEFAULT_OUTBOX_PRUNE_BATCH,
);

export interface MissionOutboxCompactionDependencies {
  flushMissionLog(): Promise<void>;
  missionLogIsDurable(): boolean;
  readDurableProof(): MissionOutboxCompactionProof | null;
  outboxIsReady(): boolean;
  pruneBatch(proof: MissionOutboxCompactionProof): Promise<readonly string[]>;
}

const realDependencies: MissionOutboxCompactionDependencies = {
  flushMissionLog: flushMissionsPersist,
  missionLogIsDurable: () =>
    !persistenceIssues().some((issue) => issue.name === "missions"),
  readDurableProof: () => {
    const state = useMissions.getState();
    if (!state.hydrated || state.hydrateStatus !== "ready") return null;
    return missionOutboxCompactionProof(
      state.projection,
      useMissionOutbox.getState().snapshot,
    );
  },
  outboxIsReady: () => {
    const state = useMissionOutbox.getState();
    return state.hydrateStatus === "ready" && state.snapshot.hydration === "ready";
  },
  pruneBatch: (proof) =>
    useMissionOutbox.getState().pruneArchivedDelivered(
      proof.archivedMissionIds,
      proof.durablyAppliedRecords,
    ),
};

/**
 * Compact all currently eligible records in bounded, write-through batches.
 * Mission persistence is flushed and health-checked before archive state is
 * trusted, preventing the outbox key from getting ahead of an unpersisted
 * archive event in a crash.
 */
export async function compactArchivedMissionOutbox(
  dependencies: MissionOutboxCompactionDependencies = realDependencies,
): Promise<number> {
  if (!dependencies.outboxIsReady()) return 0;
  // Capture the exact projection proof first. The following flush establishes
  // durability for at least this snapshot; reading a newly archived Mission
  // only after the await could otherwise observe a later, not-yet-saved edit.
  const proof = dependencies.readDurableProof();
  if (!proof || proof.archivedMissionIds.size === 0) return 0;
  await dependencies.flushMissionLog();
  if (!dependencies.missionLogIsDurable()) {
    throw new Error("Mission archive state is not durable; outbox compaction refused");
  }

  let removed = 0;
  for (let pass = 0; pass < MAX_COMPACTION_PASSES; pass += 1) {
    if (!dependencies.outboxIsReady()) break;
    const recordIds = await dependencies.pruneBatch(proof);
    removed += recordIds.length;
    if (recordIds.length < DEFAULT_OUTBOX_PRUNE_BATCH) break;
  }
  return removed;
}

/** Coalesce Mission/outbox changes into one compaction chain. */
export function startMissionOutboxCompaction(): () => void {
  let stopped = false;
  let running = false;
  let dirty = false;

  const request = () => {
    if (stopped) return;
    dirty = true;
    if (running) return;
    running = true;
    void (async () => {
      while (!stopped && dirty) {
        dirty = false;
        try {
          await compactArchivedMissionOutbox();
        } catch {
          // Both persistence coordinators expose the failure through the
          // global fail-closed banner. A later store transition or restart
          // requests another safe pass without a hot retry loop.
        }
      }
    })().finally(() => {
      running = false;
      if (dirty && !stopped) request();
    });
  };

  const unsubscribeMissions = useMissions.subscribe(request);
  const unsubscribeOutbox = useMissionOutbox.subscribe(request);
  request();
  return () => {
    stopped = true;
    unsubscribeMissions();
    unsubscribeOutbox();
  };
}
