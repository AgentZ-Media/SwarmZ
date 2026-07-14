import { describe, expect, it } from "vitest";
import {
  adoptMissionCommandReceipt,
  claimNextMissionCommand,
  deliverMissionCommand,
  emptyMissionOutbox,
  enqueueMissionCommand,
  failMissionCommand,
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

function spawn(index = 1): EnqueueMissionCommand {
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

  it("fails closed for unknown persistence and corrupt envelopes", () => {
    expect(() => enqueueMissionCommand(emptyMissionOutbox("unknown"), spawn(), "record-1", NOW)).toThrow(/not safely hydrated/);
    expect(() => claimNextMissionCommand(emptyMissionOutbox("failed"), "worker", "claim", NOW, 1_000)).toThrow(/not safely hydrated/);
    expect(() => migrateMissionOutbox({ version: 99, records: [] })).toThrow(/unsupported/);
    expect(() => migrateMissionOutbox({ version: 1, records: [{ id: "broken" }] })).toThrow(/malformed/);
  });
});
