import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimMissionCommandById,
  deliverMissionCommand,
  emptyMissionOutbox,
  enqueueMissionCommand,
  type EnqueueMissionCommand,
  type MissionOutboxSnapshot,
  type PersistedMissionOutbox,
} from "./outbox";

const transport = vi.hoisted(() => ({
  load: vi.fn<() => Promise<unknown>>(),
  save: vi.fn<(value: PersistedMissionOutbox) => Promise<void>>(),
}));

vi.mock("@/lib/transport", () => ({
  loadMissionOutbox: transport.load,
  saveMissionOutbox: transport.save,
}));

import { useMissionOutbox } from "./outbox-store";

const NOW = 500_000;

function command(
  id: string,
  missionId: string,
): EnqueueMissionCommand {
  return {
    missionId,
    idempotencyKey: `spawn:${id}`,
    kind: "spawn",
    payload: {
      taskId: `task-${id}`,
      attemptId: `attempt-${id}`,
      projectId: "project",
      cwd: "/repo",
      prompt: `Implement ${id}`,
    },
  };
}

function add(
  snapshot: MissionOutboxSnapshot,
  id: string,
  missionId: string,
): MissionOutboxSnapshot {
  return enqueueMissionCommand(
    snapshot,
    command(id, missionId),
    `record-${id}`,
    NOW,
  ).snapshot;
}

function markDelivered(
  snapshot: MissionOutboxSnapshot,
  id: string,
): MissionOutboxSnapshot {
  const claimed = claimMissionCommandById(
    snapshot,
    `record-${id}`,
    "worker",
    `claim-${id}`,
    NOW + 1,
    5_000,
  ).snapshot;
  return deliverMissionCommand(
    claimed,
    `record-${id}`,
    `claim-${id}`,
    { ok: true },
    NOW + 2,
  ).snapshot;
}

describe("mission outbox store pruning", () => {
  beforeAll(async () => {
    transport.load.mockResolvedValue(null);
    transport.save.mockResolvedValue();
    await useMissionOutbox.getState().hydrate();
  });

  beforeEach(async () => {
    await useMissionOutbox.getState().hydrate();
    transport.save.mockReset();
    transport.save.mockResolvedValue();
  });

  it("persists the pruned snapshot before resolving", async () => {
    let snapshot = add(emptyMissionOutbox(), "archived", "mission-archived");
    snapshot = markDelivered(snapshot, "archived");
    snapshot = add(snapshot, "active", "mission-active");
    snapshot = markDelivered(snapshot, "active");
    useMissionOutbox.setState({ snapshot });

    const removed = await useMissionOutbox.getState().pruneArchivedDelivered(
      new Set(["mission-archived"]),
      new Map([["record-archived", snapshot.records["record-archived"]]]),
    );

    expect(removed).toEqual(["record-archived"]);
    expect(transport.save).toHaveBeenCalledTimes(1);
    expect(transport.save.mock.calls[0][0].records.map((record) => record.id))
      .toEqual(["record-active"]);
    expect(useMissionOutbox.getState().snapshot.records["record-active"].status)
      .toBe("delivered");
  });

  it("serializes a concurrent enqueue behind pruning without losing either transition", async () => {
    let snapshot = add(emptyMissionOutbox(), "old", "mission-archived");
    snapshot = markDelivered(snapshot, "old");
    useMissionOutbox.setState({ snapshot });

    let releaseFirst!: () => void;
    const firstSave = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let activeWrites = 0;
    let maxActiveWrites = 0;
    transport.save.mockImplementation(async () => {
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      if (transport.save.mock.calls.length === 1) await firstSave;
      activeWrites -= 1;
    });

    const pruning = useMissionOutbox.getState().pruneArchivedDelivered(
      new Set(["mission-archived"]),
      new Map([["record-old", snapshot.records["record-old"]]]),
    );
    await vi.waitFor(() => expect(transport.save).toHaveBeenCalledTimes(1));
    const enqueue = useMissionOutbox.getState().enqueue(
      command("new", "mission-active"),
      { recordId: "record-new", now: NOW + 10 },
    );
    releaseFirst();
    await Promise.all([pruning, enqueue]);

    expect(maxActiveWrites).toBe(1);
    const finalSave = transport.save.mock.calls[transport.save.mock.calls.length - 1]?.[0];
    expect(finalSave?.records.map((record) => record.id)).toEqual(["record-new"]);
    expect(Object.keys(useMissionOutbox.getState().snapshot.records))
      .toEqual(["record-new"]);
  });
});
