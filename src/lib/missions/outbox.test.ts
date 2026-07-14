import { describe, expect, it } from "vitest";
import {
  adoptMissionCommandReceipt,
  claimMissionCommandById,
  claimNextMissionCommand,
  deliverMissionCommand,
  emptyMissionOutbox,
  enqueueMissionCommand,
  failMissionCommand,
  MAX_OUTBOX_PRUNE_BATCH,
  OUTBOX_ADMISSION_SOFT_LIMIT,
  pruneDeliveredCommandsForArchivedMissions,
  reapExpiredClaims,
  retryDeadLetter,
  type EnqueueMissionCommand,
  type MissionOutboxSnapshot,
} from "./outbox";
import {
  migrateMissionOutbox,
  serializeMissionOutbox,
} from "./outbox-serialization";

const NOW = 100_000;

type SpawnCommand = Extract<EnqueueMissionCommand, { kind: "spawn" }>;

function spawn(index = 1): SpawnCommand {
  return {
    missionId: "mission",
    idempotencyKey: `spawn:task-${index}`,
    kind: "spawn",
    payload: {
      taskId: `task-${index}`,
      attemptId: `attempt-${index}`,
      projectId: "project",
      cwd: "/repo",
      prompt: `Implement task ${index}`,
    },
  };
}

function enqueue(
  snapshot: MissionOutboxSnapshot,
  command: EnqueueMissionCommand,
  index = 1,
  now = NOW,
): MissionOutboxSnapshot {
  return enqueueMissionCommand(snapshot, command, `record-${index}`, now).snapshot;
}

describe("mission durable outbox", () => {
  it("queues every supported write-ahead command kind", () => {
    const commands: EnqueueMissionCommand[] = [
      spawn(1),
      {
        missionId: "mission",
        idempotencyKey: "prompt:1",
        kind: "prompt",
        payload: { sessionId: "session-1", taskId: "task-1", attemptId: "attempt-1", prompt: "Continue", expectReport: true },
      },
      {
        missionId: "mission",
        idempotencyKey: "settle:1",
        kind: "settle",
        payload: { taskId: "task-1", attemptId: "attempt-1", status: "succeeded", completionId: "completion-1" },
      },
      {
        missionId: "mission",
        idempotencyKey: "integrate:1",
        kind: "integrate",
        payload: { trainId: "train-1", taskId: "task-1", operationId: "operation-1", strategy: "merge", commit: "aaaaaaa", expectedHead: "bbbbbbb" },
      },
      {
        missionId: "mission",
        idempotencyKey: "gate:1",
        kind: "gate",
        payload: { gateId: "gate-1", planId: "plan-1", command: "pnpm test", expectedHead: "bbbbbbb" },
      },
    ];
    let snapshot = emptyMissionOutbox();
    commands.forEach((command, index) => {
      snapshot = enqueue(snapshot, command, index + 1, NOW + index);
    });
    expect(Object.values(snapshot.records).map((record) => record.command.kind)).toEqual([
      "spawn",
      "prompt",
      "settle",
      "integrate",
      "gate",
    ]);
  });

  it("deduplicates identical idempotency keys and rejects conflicting reuse", () => {
    const first = enqueueMissionCommand(emptyMissionOutbox(), spawn(), "record-1", NOW);
    const duplicate = enqueueMissionCommand(first.snapshot, spawn(), "record-2", NOW + 1);
    expect(duplicate.changed).toBe(false);
    expect(duplicate.record.id).toBe("record-1");
    expect(() => enqueueMissionCommand(first.snapshot, { ...spawn(2), idempotencyKey: spawn().idempotencyKey }, "record-2", NOW)).toThrow(/different command/);
  });

  it("claims the oldest due command deterministically and explains every record", () => {
    let snapshot = enqueue(emptyMissionOutbox(), spawn(2), 2, NOW + 1);
    snapshot = enqueue(snapshot, spawn(1), 1, NOW);
    const claim = claimNextMissionCommand(snapshot, "worker", "claim-1", NOW + 2, 5_000);
    expect(claim.record).toMatchObject({ id: "record-1", status: "claimed", attempts: 1, lease: { ownerId: "worker", claimId: "claim-1", expiresAt: NOW + 5_002 } });
    expect(claim.evaluations).toHaveLength(2);
  });

  it("claims one requested record without stealing another subsystem's due command", () => {
    let snapshot = enqueue(emptyMissionOutbox(), spawn(1), 1, NOW);
    snapshot = enqueue(snapshot, spawn(2), 2, NOW + 1);
    const claim = claimMissionCommandById(snapshot, "record-2", "spawn-controller", "claim-2", NOW + 2, 5_000);
    expect(claim.record).toMatchObject({ id: "record-2", status: "claimed" });
    expect(claim.snapshot.records["record-1"].status).toBe("pending");
  });

  it("records delivery once and ignores duplicate completion", () => {
    const queued = enqueue(emptyMissionOutbox(), spawn(), 1);
    const claimed = claimNextMissionCommand(queued, "worker", "claim-1", NOW, 5_000).snapshot;
    const delivered = deliverMissionCommand(claimed, "record-1", "claim-1", { sessionId: "session-1" }, NOW + 1);
    expect(delivered.record).toMatchObject({ status: "delivered", lease: null, delivery: { receipt: { sessionId: "session-1" } } });
    const duplicate = deliverMissionCommand(delivered.snapshot, "record-1", "stale-claim", { sessionId: "other" }, NOW + 2);
    expect(duplicate.changed).toBe(false);
    expect(duplicate.record.delivery?.receipt).toEqual({ sessionId: "session-1" });
  });

  it("rejects stale ABA completions after an expired lease is reclaimed", () => {
    const queued = enqueue(emptyMissionOutbox(), spawn(), 1);
    const first = claimNextMissionCommand(queued, "worker", "claim-old", NOW, 1_000).snapshot;
    const expired = reapExpiredClaims(first, NOW + 1_001);
    const due = expired.records["record-1"].nextAttemptAt;
    const second = claimNextMissionCommand(expired, "worker", "claim-new", due, 1_000).snapshot;
    expect(() => deliverMissionCommand(second, "record-1", "claim-old", {}, due + 1)).toThrow(/stale/);
    expect(deliverMissionCommand(second, "record-1", "claim-new", {}, due + 1).record.status).toBe("delivered");
  });

  it("uses bounded deterministic backoff and dead-letters exhausted work", () => {
    const command = { ...spawn(), maxAttempts: 2 };
    const queued = enqueueMissionCommand(emptyMissionOutbox(), command, "record-1", NOW).snapshot;
    const firstClaim = claimNextMissionCommand(queued, "worker", "claim-1", NOW, 1_000).snapshot;
    const firstFailure = failMissionCommand(firstClaim, "record-1", "claim-1", "network", NOW + 1);
    const repeat = failMissionCommand(firstClaim, "record-1", "claim-1", "network", NOW + 1);
    expect(firstFailure.record.nextAttemptAt).toBe(repeat.record.nextAttemptAt);
    const secondClaim = claimNextMissionCommand(firstFailure.snapshot, "worker", "claim-2", firstFailure.record.nextAttemptAt, 1_000).snapshot;
    expect(failMissionCommand(secondClaim, "record-1", "claim-2", "again", NOW + 10_000).record.status).toBe("dead_letter");
  });

  it("dead-letters repeated crash windows and supports explicit manual retry", () => {
    const queued = enqueueMissionCommand(emptyMissionOutbox(), { ...spawn(), maxAttempts: 1 }, "record-1", NOW).snapshot;
    const claimed = claimNextMissionCommand(queued, "worker", "claim-1", NOW, 1_000).snapshot;
    const dead = reapExpiredClaims(claimed, NOW + 1_001);
    expect(dead.records["record-1"].status).toBe("dead_letter");
    expect(retryDeadLetter(dead, "record-1", NOW + 2_000).record).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("adopts an external receipt after success-before-ack without redispatch", () => {
    const queued = enqueue(emptyMissionOutbox(), spawn(), 1);
    const claimed = claimNextMissionCommand(queued, "worker", "claim-1", NOW, 5_000).snapshot;
    const adopted = adoptMissionCommandReceipt(claimed, spawn().idempotencyKey, { sessionId: "session-1" }, NOW + 1);
    expect(adopted?.record.status).toBe("delivered");
    expect(adoptMissionCommandReceipt(adopted!.snapshot, spawn().idempotencyKey, {}, NOW + 2)?.changed).toBe(false);
  });

  it("round-trips 50 durable task commands across restart", () => {
    let snapshot = emptyMissionOutbox();
    for (let index = 1; index <= 50; index += 1) {
      snapshot = enqueue(snapshot, spawn(index), index, NOW + index);
    }
    const restored = migrateMissionOutbox(JSON.parse(JSON.stringify(serializeMissionOutbox(snapshot))));
    expect(Object.keys(restored.records)).toHaveLength(50);
    expect(serializeMissionOutbox(restored)).toEqual(serializeMissionOutbox(snapshot));
  });

  it("prunes only receipted delivered records owned by archived missions", () => {
    let snapshot = emptyMissionOutbox();
    for (let index = 1; index <= 5; index += 1) {
      snapshot = enqueue(snapshot, {
        ...spawn(index),
        missionId: index === 5 ? "active-mission" : "archived-mission",
      }, index, NOW + index);
    }
    for (const index of [1, 2, 5]) {
      const claim = claimMissionCommandById(
        snapshot,
        `record-${index}`,
        "worker",
        `claim-${index}`,
        NOW + 10,
        5_000,
      );
      snapshot = deliverMissionCommand(
        claim.snapshot,
        `record-${index}`,
        `claim-${index}`,
        { accepted: true },
        NOW + 20 + index,
      ).snapshot;
    }
    const failedClaim = claimMissionCommandById(
      snapshot,
      "record-3",
      "worker",
      "claim-3",
      NOW + 10,
      5_000,
    );
    snapshot = failMissionCommand(
      failedClaim.snapshot,
      "record-3",
      "claim-3",
      "keep evidence",
      NOW + 30,
      false,
    ).snapshot;

    const decision = pruneDeliveredCommandsForArchivedMissions(
      snapshot,
      new Set(["archived-mission"]),
      new Map(Object.entries(snapshot.records)),
    );
    expect(decision.removedRecordIds).toEqual(["record-1", "record-2"]);
    expect(Object.keys(decision.snapshot.records).sort()).toEqual([
      "record-3",
      "record-4",
      "record-5",
    ]);
    expect(decision.snapshot.records["record-3"].status).toBe("dead_letter");
    expect(decision.snapshot.records["record-4"].status).toBe("pending");
    expect(decision.snapshot.records["record-5"].status).toBe("delivered");
  });

  it("prunes deterministically in hard-bounded batches", () => {
    let snapshot = emptyMissionOutbox();
    for (let index = 1; index <= 4; index += 1) {
      snapshot = enqueue(snapshot, spawn(index), index, NOW + index);
      const claim = claimMissionCommandById(
        snapshot,
        `record-${index}`,
        "worker",
        `claim-${index}`,
        NOW + 10,
        5_000,
      );
      snapshot = deliverMissionCommand(
        claim.snapshot,
        `record-${index}`,
        `claim-${index}`,
        {},
        NOW + 30 - index,
      ).snapshot;
    }
    const first = pruneDeliveredCommandsForArchivedMissions(
      snapshot,
      new Set(["mission"]),
      new Map(Object.entries(snapshot.records)),
      2,
    );
    expect(first.removedRecordIds).toEqual(["record-4", "record-3"]);
    expect(Object.keys(first.snapshot.records)).toHaveLength(2);

    const capped = pruneDeliveredCommandsForArchivedMissions(
      snapshot,
      new Set(["mission"]),
      new Map(Object.entries(snapshot.records)),
      Number.MAX_SAFE_INTEGER,
    );
    expect(capped.removedRecordIds.length).toBeLessThanOrEqual(MAX_OUTBOX_PRUNE_BATCH);
  });

  it("retains delivered records whose Mission effect lacks durable projection proof", () => {
    let snapshot = enqueue(emptyMissionOutbox(), spawn(), 1);
    const claimed = claimMissionCommandById(
      snapshot,
      "record-1",
      "worker",
      "claim-1",
      NOW,
      5_000,
    );
    snapshot = deliverMissionCommand(
      claimed.snapshot,
      "record-1",
      "claim-1",
      { sessionId: "session-1" },
      NOW + 1,
    ).snapshot;
    const decision = pruneDeliveredCommandsForArchivedMissions(
      snapshot,
      new Set(["mission"]),
      new Map(),
    );
    expect(decision.changed).toBe(false);
    expect(decision.snapshot.records["record-1"]).toBe(snapshot.records["record-1"]);
  });

  it("fences pruning against same-id record replacement after proof capture", () => {
    let snapshot = enqueue(emptyMissionOutbox(), spawn(), 1);
    const claimed = claimMissionCommandById(snapshot, "record-1", "worker", "claim-1", NOW, 5_000);
    snapshot = deliverMissionCommand(
      claimed.snapshot,
      "record-1",
      "claim-1",
      { ok: true },
      NOW + 1,
    ).snapshot;
    const proof = new Map([["record-1", snapshot.records["record-1"]]]);
    const replacement = {
      ...snapshot,
      records: {
        ...snapshot.records,
        "record-1": { ...snapshot.records["record-1"] },
      },
    };
    const decision = pruneDeliveredCommandsForArchivedMissions(
      replacement,
      new Set(["mission"]),
      proof,
    );
    expect(decision.changed).toBe(false);
  });

  it("fails closed for unknown persistence and corrupt envelopes", () => {
    expect(() => enqueueMissionCommand(emptyMissionOutbox("unknown"), spawn(), "record-1", NOW)).toThrow(/not safely hydrated/);
    expect(() => claimNextMissionCommand(emptyMissionOutbox("failed"), "worker", "claim", NOW, 1_000)).toThrow(/not safely hydrated/);
    expect(() => migrateMissionOutbox({ version: 99, records: [] })).toThrow(/unsupported/);
    expect(() => migrateMissionOutbox({ version: 1, records: [{ id: "broken" }] })).toThrow(/malformed/);
  });

  it("reserves capacity for terminal settlement under admission backpressure", () => {
    const seed = enqueueMissionCommand(emptyMissionOutbox(), spawn(), "seed", NOW).record;
    const records: Record<string, typeof seed> = Object.create(null);
    for (let index = 0; index < OUTBOX_ADMISSION_SOFT_LIMIT; index += 1) {
      const id = `capacity-${index}`;
      records[id] = {
        ...seed,
        id,
        idempotencyKey: `capacity:${index}`,
      };
    }
    const saturated = { ...emptyMissionOutbox(), records };
    expect(() => enqueueMissionCommand(
      saturated,
      spawn(99),
      "new-spawn",
      NOW,
    )).toThrow(/backpressure.*archive completed missions/i);
    const settlement = enqueueMissionCommand(
      saturated,
      {
        missionId: "mission",
        idempotencyKey: "settle:capacity",
        kind: "settle",
        payload: {
          taskId: "task-capacity",
          attemptId: "attempt-capacity",
          status: "failed",
          completionId: "completion-capacity",
        },
      },
      "settle-capacity",
      NOW,
    );
    expect(settlement.record.status).toBe("pending");
    expect(Object.keys(settlement.snapshot.records)).toHaveLength(
      OUTBOX_ADMISSION_SOFT_LIMIT + 1,
    );
  });

  it("rejects unknown runtime command kinds and environment-copy spawns", () => {
    expect(() => enqueueMissionCommand(
      emptyMissionOutbox(),
      { ...spawn(), kind: "unexpected_kind" } as unknown as EnqueueMissionCommand,
      "record-1",
      NOW,
    )).toThrow(/unknown.*kind/i);
    expect(() => enqueueMissionCommand(
      emptyMissionOutbox(),
      {
        ...spawn(),
        payload: { ...spawn().payload, copyEnv: true },
      },
      "record-1",
      NOW,
    )).toThrow(/may not copy environment/i);
  });
});
