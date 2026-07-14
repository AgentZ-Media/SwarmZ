import { describe, expect, it } from "vitest";
import {
  MissionInsightsError,
  calculateMissionInsights,
  type MissionTaskObservation,
} from "./insights";
import { parseMissionReportV2 } from "./report-v2";

function observation(index: number, status: MissionTaskObservation["status"]): MissionTaskObservation {
  return {
    taskId: `task-${index}`,
    role: "implementer",
    status,
    attemptCount: status === "succeeded" ? 1 : 0,
    activeDurationMs: status === "succeeded" ? 60_000 + index * 1_000 : null,
    tokensUsed: status === "succeeded" ? 10_000 : null,
    costUsd: status === "succeeded" ? 0.5 + index * 0.01 : null,
    failureFingerprint: null,
    retryable: null,
  };
}

describe("mission insights", () => {
  it("withholds ETA and cost projections with insufficient evidence", () => {
    const result = calculateMissionInsights(
      [observation(0, "succeeded"), observation(1, "pending")],
      4,
    );
    expect(result.etaMs).toBeNull();
    expect(result.projectedAdditionalCostUsd).toBeNull();
    expect(result.warnings).toHaveLength(2);
  });

  it("clusters only explicit stable failure fingerprints", () => {
    const failures: MissionTaskObservation[] = [0, 1, 2].map((index) => ({
      ...observation(index, "failed"),
      attemptCount: 2,
      failureFingerprint: index < 2 ? "gate:unit_tests" : "runtime:timeout",
      retryable: index === 0,
    }));
    const result = calculateMissionInsights(failures, 2);
    expect(result.failureClusters[0]).toMatchObject({
      fingerprint: "gate:unit_tests",
      count: 2,
      retryableCount: 1,
      nonRetryableCount: 1,
    });
    expect(result.actual.retries).toBe(3);
  });

  it("analyzes a 50-task fixture with conservative confidence", () => {
    const observations = Array.from({ length: 50 }, (_, index) =>
      observation(index, index < 10 ? "succeeded" : "pending"),
    );
    const result = calculateMissionInsights(observations, 8);
    expect(result.actual.taskCount).toBe(50);
    expect(result.etaMs?.confidence).toBe("medium");
    expect(result.etaMs?.sampleSize).toBe(10);
    expect(result.projectedAdditionalCostUsd?.high).toBeGreaterThanOrEqual(
      result.projectedAdditionalCostUsd?.point ?? 0,
    );
  });

  it("rejects prose-like or malformed failure clusters", () => {
    const failed = observation(0, "failed");
    failed.failureFingerprint = "Something weird happened!";
    expect(() => calculateMissionInsights([failed], 1)).toThrow(
      MissionInsightsError,
    );
  });

  it("clusters normalized report observations without treating retryable as policy", () => {
    const report = parseMissionReportV2(JSON.stringify({
      version: 2,
      mission_id: "mission-1",
      task_id: "task-0",
      attempt_id: "attempt-0",
      status: "failed",
      summary: "The local service did not become ready",
      evidence: { base_sha: null, head_sha: "a".repeat(40), diff_sha256: null },
      files_changed: [],
      commands: [],
      artifacts: [],
      failure_fingerprint: "Runtime:Healthcheck-Timeout",
      retryable: true,
      question: null,
    }))!;
    const failed = {
      ...observation(0, "failed"),
      attemptCount: 1,
      failureFingerprint: report.failureFingerprint ?? null,
      retryable: report.retryable ?? null,
    };
    const result = calculateMissionInsights([failed], 1);
    expect(result.failureClusters).toEqual([{
      fingerprint: "runtime:healthcheck-timeout",
      count: 1,
      taskIds: ["task-0"],
      retryableCount: 1,
      nonRetryableCount: 0,
      unknownRetryabilityCount: 0,
    }]);
    expect(result.actual.retries).toBe(0);
  });
});
