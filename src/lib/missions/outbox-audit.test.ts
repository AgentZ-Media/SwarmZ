import { describe, expect, it } from "vitest";
import { emptyMissionProjection } from "./core";
import {
  claimMissionCommandById,
  deliverMissionCommand,
  emptyMissionOutbox,
  enqueueMissionCommand,
} from "./outbox";
import {
  MAX_MISSION_OUTBOX_AUDIT_BYTES,
  missionOutboxAuditArtifacts,
  missionOutboxAuditEntry,
} from "./outbox-audit";
import type { Mission, QualityGate } from "./types";

function deliveredGate() {
  const queued = enqueueMissionCommand(
    emptyMissionOutbox(),
    {
      missionId: "mission",
      idempotencyKey: "gate:1",
      kind: "gate",
      payload: {
        gateId: "gate-1",
        planId: "plan-1",
        command: "pnpm test",
        expectedHead: "a".repeat(40),
      },
    },
    "record-gate",
    10,
  ).snapshot;
  const claimed = claimMissionCommandById(
    queued,
    "record-gate",
    "worker",
    "claim-gate",
    11,
    5_000,
  ).snapshot;
  return deliverMissionCommand(
    claimed,
    "record-gate",
    "claim-gate",
    {
      status: "completed",
      exitCode: 0,
      stdout: `green\n${"x".repeat(3_000)}`,
      stderr: "",
      stdoutTruncated: false,
      head: "a".repeat(40),
      headVerified: true,
    },
    12,
  ).snapshot;
}

describe("Mission archive outbox audit", () => {
  it("preserves clipped gate output and exact Git evidence", () => {
    const record = deliveredGate().records["record-gate"];
    const entry = missionOutboxAuditEntry(record);
    expect(entry).toMatchObject({
      recordId: "record-gate",
      gateId: "gate-1",
      command: "pnpm test",
      expectedHead: "a".repeat(40),
      exitCode: 0,
      headVerified: true,
    });
    expect(String(entry.stdout)).toContain("green");
    expect(String(entry.stdout).length).toBeLessThanOrEqual(2_000);
  });

  it("refuses an archive checkpoint while a delivered effect needs reconciliation", () => {
    const projection = emptyMissionProjection();
    projection.missions.mission = { id: "mission", archivedAt: null } as Mission;
    expect(() => missionOutboxAuditArtifacts(
      "mission",
      projection,
      deliveredGate(),
      20,
      "oa-test",
    )).toThrow(/still need reconciliation/);
  });

  it("creates an immutable artifact after the gate result is materialized", () => {
    const projection = emptyMissionProjection();
    projection.missions.mission = { id: "mission", archivedAt: null } as Mission;
    projection.qualityGates["gate-1"] = {
      id: "gate-1",
      missionId: "mission",
      status: "passed",
    } as QualityGate;
    const artifacts = missionOutboxAuditArtifacts(
      "mission",
      projection,
      deliveredGate(),
      20,
      "oa-test",
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      id: "oa-test-0",
      kind: "report",
      label: "mission-outbox-audit",
      createdAt: 20,
      metadata: { schemaVersion: 1, recordCount: 1 },
    });
  });

  it("bounds an adversarial 10k-record audit while retaining exact identities", () => {
    const projection = emptyMissionProjection();
    projection.missions.mission = { id: "mission", archivedAt: null } as Mission;
    projection.qualityGates["gate-1"] = {
      id: "gate-1",
      missionId: "mission",
      status: "passed",
    } as QualityGate;
    const template = deliveredGate().records["record-gate"];
    const records = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => {
      const id = `r-${String(index).padStart(5, "0")}-${"x".repeat(170)}`;
      return [id, { ...template, id, idempotencyKey: `gate:${index}` }];
    }));
    const outbox = { ...emptyMissionOutbox(), records };
    const artifacts = missionOutboxAuditArtifacts(
      "mission",
      projection,
      outbox,
      20,
      "oa-large",
    );
    const serialized = new TextEncoder().encode(JSON.stringify(artifacts));
    expect(serialized.byteLength).toBeLessThanOrEqual(MAX_MISSION_OUTBOX_AUDIT_BYTES);
    expect(artifacts).toHaveLength(100);
    expect(artifacts.every((artifact) => artifact.metadata.detailLevel === "compact"))
      .toBe(true);
    expect(artifacts.reduce(
      (count, artifact) => count + Number(artifact.metadata.recordCount),
      0,
    )).toBe(10_000);
    const first = (artifacts[0].metadata.records as Array<Record<string, unknown>>)[0];
    const lastRecords = artifacts[artifacts.length - 1].metadata.records as Array<Record<string, unknown>>;
    expect(first.recordId).toBe(`r-00000-${"x".repeat(170)}`);
    expect(lastRecords[lastRecords.length - 1].recordId)
      .toBe(`r-09999-${"x".repeat(170)}`);
    expect(first).toMatchObject({
      gateId: "gate-1",
      status: "completed",
      expectedHead: "a".repeat(40),
      head: "a".repeat(40),
    });
    expect(String(first.stdoutSha256)).toMatch(/^sha256:[0-9a-f]{64}$/);
  }, 15_000);
});
