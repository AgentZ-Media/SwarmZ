import { describe, expect, it } from "vitest";
import {
  CandidateSelectionError,
  selectCandidateAttempt,
  type CandidateAttempt,
} from "./candidates";

function candidate(id: string, reviewWeight: number): CandidateAttempt {
  return {
    attemptId: id,
    taskId: "task-1",
    terminalStatus: "succeeded",
    evidence: [
      {
        id: `${id}-tests`,
        label: "Unit tests",
        kind: "test",
        status: "passed",
        required: true,
        weight: 50,
        artifactId: `${id}-test-artifact`,
      },
      {
        id: `${id}-review`,
        label: "Review",
        kind: "review",
        status: "passed",
        required: true,
        weight: reviewWeight,
        artifactId: `${id}-review-artifact`,
      },
    ],
    tokensUsed: id === "a" ? 10_000 : 8_000,
    durationMs: id === "a" ? 60_000 : 80_000,
  };
}

const policy = {
  minimumEvidenceCount: 2,
  minimumScoreMargin: 5,
  tieBreakers: ["lower_tokens", "attempt_id"] as const,
};

describe("candidate attempt selection", () => {
  it("selects deterministically from explicit artifact-backed evidence", () => {
    const result = selectCandidateAttempt(
      [candidate("a", 20), candidate("b", 30)],
      { ...policy, tieBreakers: [...policy.tieBreakers] },
    );
    expect(result).toMatchObject({
      decision: "selected",
      selectedAttemptId: "b",
    });
  });

  it("withholds a winner when the evidence margin is too small", () => {
    const result = selectCandidateAttempt(
      [candidate("a", 20), candidate("b", 22)],
      { ...policy, tieBreakers: [...policy.tieBreakers] },
    );
    expect(result).toMatchObject({
      decision: "indeterminate",
      selectedAttemptId: null,
    });
  });

  it("makes missing required evidence ineligible", () => {
    const bad = candidate("a", 30);
    bad.evidence[0] = { ...bad.evidence[0], status: "missing", artifactId: null };
    const result = selectCandidateAttempt(
      [bad, candidate("b", 20)],
      { ...policy, tieBreakers: [...policy.tieBreakers] },
    );
    expect(result.selectedAttemptId).toBe("b");
    expect(result.assessments.find((item) => item.attemptId === "a")?.eligible).toBe(false);
  });

  it("rejects cross-task comparisons and unbacked passed evidence", () => {
    const other = candidate("b", 20);
    other.taskId = "task-2";
    expect(() =>
      selectCandidateAttempt([candidate("a", 20), other], {
        ...policy,
        tieBreakers: [...policy.tieBreakers],
      }),
    ).toThrow(CandidateSelectionError);
    const unbacked = candidate("b", 20);
    unbacked.evidence[0].artifactId = null;
    expect(() =>
      selectCandidateAttempt([candidate("a", 20), unbacked], {
        ...policy,
        tieBreakers: [...policy.tieBreakers],
      }),
    ).toThrow(/artifact id/);
  });
});
