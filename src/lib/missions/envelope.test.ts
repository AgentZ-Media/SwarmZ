import { describe, expect, it } from "vitest";
import {
  approveMissionEnvelope,
  authorizeEnvelopeStart,
  envelopeStopAction,
  reviseMissionEnvelope,
  validateMissionEnvelope,
  type MissionEnvelopeUsage,
  type MissionExecutionEnvelope,
} from "./envelope";

function draft(): MissionExecutionEnvelope {
  return {
    id: "envelope-1",
    missionId: "mission-1",
    revision: 1,
    issuedAt: 100,
    expiresAt: 10_000,
    limits: {
      maxTasks: 50,
      maxAttempts: 100,
      maxTokens: 1_000_000,
      maxActiveMs: 60_000,
      maxCostUsd: 25,
      maxParallel: 8,
    },
    capabilities: {
      allowedTools: ["read_file", "edit_file", "test"],
      allowedRoots: ["/repo"],
      network: "read_only",
      github: "read_only",
    },
    stopPolicy: {
      regression: "needs_human",
      conflict: "pause_mission",
      criticalFailure: "cancel_mission",
    },
    approval: null,
  };
}

const usage: MissionEnvelopeUsage = {
  tasksStarted: 0,
  attemptsStarted: 0,
  tokensUsed: 0,
  activeMs: 0,
  costUsd: 0,
  activeAttempts: 0,
};

function approved(): MissionExecutionEnvelope {
  return approveMissionEnvelope(draft(), {
    approvalId: "approval-1",
    envelopeRevision: 1,
    approvedAt: 110,
    approvedBy: "human",
  });
}

function request(patch: Partial<Parameters<typeof authorizeEnvelopeStart>[2]> = {}) {
  return {
    missionId: "mission-1",
    envelopeRevision: 1,
    rootPath: "/repo/src",
    requiredTools: ["edit_file"],
    now: 200,
    breakerOpen: false,
    ...patch,
  };
}

describe("Mission Execution Envelope", () => {
  it("requires one explicit human approval for the exact revision", () => {
    expect(authorizeEnvelopeStart(draft(), usage, request())).toMatchObject({
      ok: false,
      code: "approval_required",
    });
    expect(authorizeEnvelopeStart(approved(), usage, request())).toEqual({ ok: true });
    expect(() => approveMissionEnvelope(approved(), {
      approvalId: "approval-2",
      envelopeRevision: 1,
      approvedAt: 120,
      approvedBy: "human",
    })).toThrow(/already approved/);
    expect(() => approveMissionEnvelope(draft(), {
      approvalId: "approval-used",
      envelopeRevision: 1,
      approvedAt: 120,
      approvedBy: "human",
    }, new Set(["approval-used"]))).toThrow(/already used/);
  });

  it("invalidates approval on every revision", () => {
    const revised = reviseMissionEnvelope(approved(), {
      limits: { ...approved().limits, maxParallel: 4 },
    }, 300);
    expect(revised).toMatchObject({ revision: 2, approval: null });
    expect(authorizeEnvelopeStart(revised, usage, request({ envelopeRevision: 2 })))
      .toMatchObject({ ok: false, code: "approval_required" });
  });

  it("treats the existing breaker as the final emergency stop", () => {
    expect(authorizeEnvelopeStart(approved(), usage, request({
      breakerOpen: true,
      breakerReason: "consecutive autonomy cap",
    }))).toEqual({
      ok: false,
      code: "breaker_open",
      reason: "consecutive autonomy cap",
    });
  });

  it.each([
    ["tasksStarted", 50, "task_limit"],
    ["attemptsStarted", 100, "attempt_limit"],
    ["tokensUsed", 1_000_000, "token_limit"],
    ["activeMs", 60_000, "time_limit"],
    ["costUsd", 25, "cost_limit"],
    ["activeAttempts", 8, "parallel_limit"],
  ] as const)("fails closed at the %s boundary", (field, value, code) => {
    expect(authorizeEnvelopeStart(approved(), { ...usage, [field]: value }, request()))
      .toMatchObject({ ok: false, code });
  });

  it("fails closed on corrupt usage instead of minting allowance", () => {
    expect(authorizeEnvelopeStart(approved(), { ...usage, tokensUsed: Number.NaN }, request()))
      .toMatchObject({ ok: false, code: "invalid_envelope" });
  });

  it("enforces roots, tools, network and GitHub authority", () => {
    expect(authorizeEnvelopeStart(approved(), usage, request({ rootPath: "/foreign" })))
      .toMatchObject({ ok: false, code: "root_denied" });
    expect(authorizeEnvelopeStart(approved(), usage, request({ rootPath: "/repo/../foreign" })))
      .toMatchObject({ ok: false, code: "root_denied" });
    expect(authorizeEnvelopeStart(approved(), usage, request({ requiredTools: ["shell"] })))
      .toMatchObject({ ok: false, code: "tool_denied" });
    expect(authorizeEnvelopeStart(approved(), usage, request({ network: "allow" })))
      .toMatchObject({ ok: false, code: "network_denied" });
    expect(authorizeEnvelopeStart(approved(), usage, request({ github: "write" })))
      .toMatchObject({ ok: false, code: "github_denied" });
  });

  it("prioritizes critical failure, conflict, then regression stop policies", () => {
    const envelope = approved();
    expect(envelopeStopAction(envelope, { regression: true, conflict: true, criticalFailure: true }))
      .toBe("cancel_mission");
    expect(envelopeStopAction(envelope, { regression: true, conflict: true, criticalFailure: false }))
      .toBe("pause_mission");
    expect(envelopeStopAction(envelope, { regression: true, conflict: false, criticalFailure: false }))
      .toBe("needs_human");
  });

  it("validates all limit and approval invariants", () => {
    expect(validateMissionEnvelope({
      ...draft(),
      limits: { ...draft().limits, maxParallel: 49 },
    })).toContain("maxParallel must be 1..48");
  });
});
