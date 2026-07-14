import { describe, expect, it, vi } from "vitest";
import { emptyMissionProjection } from "./core";
import {
  claimMissionCommandById,
  DEFAULT_OUTBOX_PRUNE_BATCH,
  deliverMissionCommand,
  emptyMissionOutbox,
  enqueueMissionCommand,
  MAX_OUTBOX_RECORDS,
  type EnqueueMissionCommand,
} from "./outbox";
import {
  compactArchivedMissionOutbox,
  missionOutboxCompactionProof,
  type MissionOutboxCompactionDependencies,
} from "./outbox-compaction";
import type { Mission, TaskAttempt } from "./types";

function dependencies(
  patch: Partial<MissionOutboxCompactionDependencies> = {},
): MissionOutboxCompactionDependencies {
  return {
    flushMissionLog: vi.fn().mockResolvedValue(undefined),
    missionLogIsDurable: vi.fn().mockReturnValue(true),
    readDurableProof: vi.fn().mockReturnValue({
      archivedMissionIds: new Set(["archived"]),
      durablyAppliedRecords: new Map(),
    }),
    outboxIsReady: vi.fn().mockReturnValue(true),
    pruneBatch: vi.fn().mockResolvedValue([]),
    ...patch,
  };
}

describe("archived Mission outbox compaction", () => {
  it("proves only receipts whose exact completion is materialized", () => {
    const settle: EnqueueMissionCommand = {
      missionId: "mission",
      idempotencyKey: "settle:a1",
      kind: "settle",
      payload: {
        taskId: "task-1",
        attemptId: "attempt-1",
        status: "succeeded",
        completionId: "completion-1",
      },
    };
    let outbox = enqueueMissionCommand(
      emptyMissionOutbox(),
      settle,
      "record-settle",
      10,
    ).snapshot;
    const claim = claimMissionCommandById(
      outbox,
      "record-settle",
      "worker",
      "claim-settle",
      11,
      5_000,
    );
    outbox = deliverMissionCommand(
      claim.snapshot,
      "record-settle",
      "claim-settle",
      { completionId: "completion-1" },
      12,
    ).snapshot;
    const projection = emptyMissionProjection();
    projection.missions.mission = {
      id: "mission",
      archivedAt: 20,
    } as Mission;
    projection.attempts["attempt-1"] = {
      id: "attempt-1",
      missionId: "mission",
      taskId: "task-1",
      ordinal: 1,
      status: "failed",
      sessionId: null,
      workerLabel: null,
      startedAt: 1,
      finishedAt: 2,
      summary: null,
      error: "failed",
      report: null,
      artifactIds: [],
    } satisfies TaskAttempt;

    expect(missionOutboxCompactionProof(projection, outbox).durablyAppliedRecords.has("record-settle"))
      .toBe(false);
    projection.attempts["attempt-1"] = {
      ...projection.attempts["attempt-1"],
      status: "succeeded",
      error: null,
    };
    expect(missionOutboxCompactionProof(projection, outbox).durablyAppliedRecords.has("record-settle"))
      .toBe(true);
  });

  it("establishes durable archive proof before pruning", async () => {
    const order: string[] = [];
    const deps = dependencies({
      flushMissionLog: vi.fn(async () => { order.push("flush"); }),
      missionLogIsDurable: vi.fn(() => {
        order.push("health");
        return true;
      }),
      readDurableProof: vi.fn(() => {
        order.push("read-archive");
        return {
          archivedMissionIds: new Set(["archived"]),
          durablyAppliedRecords: new Map(),
        };
      }),
      pruneBatch: vi.fn(async () => {
        order.push("prune");
        return ["record-1"];
      }),
    });
    expect(await compactArchivedMissionOutbox(deps)).toBe(1);
    expect(order).toEqual(["read-archive", "flush", "health", "prune"]);
  });

  it("refuses pruning when the archive event log is not durable", async () => {
    const deps = dependencies({ missionLogIsDurable: () => false });
    await expect(compactArchivedMissionOutbox(deps)).rejects.toThrow(/not durable/);
    expect(deps.readDurableProof).toHaveBeenCalledTimes(1);
    expect(deps.pruneBatch).not.toHaveBeenCalled();
  });

  it("drains bounded persisted batches and stops after a short batch", async () => {
    let pass = 0;
    const deps = dependencies({
      pruneBatch: vi.fn(async () => {
        pass += 1;
        const length = pass < 3 ? DEFAULT_OUTBOX_PRUNE_BATCH : 7;
        return Array.from({ length }, (_, index) => `${pass}:${index}`);
      }),
    });
    expect(await compactArchivedMissionOutbox(deps))
      .toBe(DEFAULT_OUTBOX_PRUNE_BATCH * 2 + 7);
    expect(deps.pruneBatch).toHaveBeenCalledTimes(3);
  });

  it("has a hard pass ceiling matching the persisted record cap", async () => {
    const deps = dependencies({
      pruneBatch: vi.fn(async () =>
        Array.from({ length: DEFAULT_OUTBOX_PRUNE_BATCH }, (_, index) => String(index)),
      ),
    });
    expect(await compactArchivedMissionOutbox(deps)).toBe(MAX_OUTBOX_RECORDS);
    expect(deps.pruneBatch).toHaveBeenCalledTimes(
      MAX_OUTBOX_RECORDS / DEFAULT_OUTBOX_PRUNE_BATCH,
    );
  });
});
