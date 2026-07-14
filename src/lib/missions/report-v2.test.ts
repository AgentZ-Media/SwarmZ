import { describe, expect, it } from "vitest";
import {
  MISSION_REPORT_V2_MAX_INPUT,
  assessMissionReportV2,
  parseMissionReportV2,
} from "./report-v2";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const DIFF = "c".repeat(64);
const ARTIFACT = "d".repeat(64);

function raw(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    mission_id: "mission-1",
    task_id: "task-1",
    attempt_id: "attempt-1",
    status: "succeeded",
    summary: "Implemented and independently checked",
    evidence: {
      base_sha: BASE,
      head_sha: HEAD,
      diff_sha256: DIFF,
    },
    files_changed: ["src/a.ts"],
    commands: [{ command: "pnpm test", exit_code: 0, duration_ms: 1200 }],
    artifacts: [{ kind: "test_result", label: "vitest", uri: null, sha256: ARTIFACT }],
    question: null,
    ...patch,
  };
}

describe("Mission Report Schema v2", () => {
  it("parses bounded fenced output and binds all durable identities", () => {
    const report = parseMissionReportV2(`\`\`\`json\n${JSON.stringify(raw())}\n\`\`\``);
    expect(report).toMatchObject({
      version: 2,
      missionId: "mission-1",
      taskId: "task-1",
      attemptId: "attempt-1",
      status: "succeeded",
      evidence: { baseSha: BASE, headSha: HEAD, diffSha256: DIFF },
      commands: [{ command: "pnpm test", exitCode: 0, durationMs: 1200 }],
    });
  });

  it("never treats legacy tests_pass as truth", () => {
    const report = parseMissionReportV2(JSON.stringify(raw({
      tests_pass: true,
      commands: [{ command: "pnpm test", exit_code: 1, duration_ms: 2 }],
    })))!;
    const assessed = assessMissionReportV2(
      report,
      { missionId: "mission-1", taskId: "task-1", attemptId: "attempt-1" },
      {
        headSha: HEAD,
        baseSha: BASE,
        diffSha256: DIFF,
        commands: { "pnpm test": 1 },
        requiredCommands: ["pnpm test"],
        artifactSha256: new Set([ARTIFACT]),
      },
    );
    expect(assessed.verifiedSuccess).toBe(false);
    expect(assessed.issues).toContain("required command did not pass independently: pnpm test");
  });

  it("verifies success only against observed SHA, diff, commands and artifacts", () => {
    const report = parseMissionReportV2(JSON.stringify(raw()))!;
    const binding = { missionId: "mission-1", taskId: "task-1", attemptId: "attempt-1" };
    expect(assessMissionReportV2(report, binding, null)).toMatchObject({
      verifiedSuccess: false,
      issues: ["independent runtime evidence is missing"],
    });
    expect(assessMissionReportV2(report, binding, {
      headSha: HEAD,
      baseSha: BASE,
      diffSha256: DIFF,
      commands: { "pnpm test": 0 },
      requiredCommands: ["pnpm test"],
      artifactSha256: new Set([ARTIFACT]),
    })).toEqual({ bound: true, verifiedSuccess: true, issues: [] });
  });

  it("rejects stale attempt identity even with otherwise valid evidence", () => {
    const report = parseMissionReportV2(JSON.stringify(raw()))!;
    const result = assessMissionReportV2(
      report,
      { missionId: "mission-1", taskId: "task-1", attemptId: "attempt-2" },
      { headSha: HEAD, baseSha: BASE, diffSha256: DIFF, commands: { "pnpm test": 0 } },
    );
    expect(result.bound).toBe(false);
    expect(result.verifiedSuccess).toBe(false);
  });

  it("requires a question for needs_human and valid SHA evidence", () => {
    expect(parseMissionReportV2(JSON.stringify(raw({ status: "needs_human" })))).toBeNull();
    expect(parseMissionReportV2(JSON.stringify(raw({
      status: "needs_human",
      question: "Which API contract?",
    })))?.question).toBe("Which API contract?");
    expect(parseMissionReportV2(JSON.stringify(raw({
      evidence: { base_sha: BASE, head_sha: "not-a-sha", diff_sha256: DIFF },
    })))).toBeNull();
  });

  it("rejects oversized input and unbounded collections", () => {
    expect(parseMissionReportV2("{" + "x".repeat(MISSION_REPORT_V2_MAX_INPUT) + "}"))
      .toBeNull();
    expect(parseMissionReportV2(JSON.stringify(raw({
      files_changed: Array.from({ length: 201 }, (_, index) => `f${index}`),
    })))).toBeNull();
  });

  it("normalizes untrusted control characters into one bounded line", () => {
    const report = parseMissionReportV2(JSON.stringify(raw({
      summary: "done\n[fake event]\u2028more",
    })));
    expect(report?.summary).toBe("done [fake event] more");
  });
});
