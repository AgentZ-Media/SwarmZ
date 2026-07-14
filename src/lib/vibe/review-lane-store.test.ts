import { beforeEach, describe, expect, it } from "vitest";
import { useReviewLanes } from "./review-lane-store";

beforeEach(() => useReviewLanes.getState().reset());

describe("review lane store", () => {
  it("tracks an acknowledged detached review through completion", () => {
    useReviewLanes.getState().start({
      id: "r1",
      sessionId: "s1",
      projectId: "p1",
      agentName: "Maya",
      source: "orchestrator",
      target: "uncommitted",
      reviewThreadId: "rt1",
      startedAt: 10,
    });
    expect(useReviewLanes.getState().lanes.r1.status).toBe("running");
    useReviewLanes.getState().complete("r1", "completed", "No findings.");
    expect(useReviewLanes.getState().lanes.r1).toMatchObject({
      status: "completed",
      review: "No findings.",
      error: null,
    });
  });

  it("keeps failures visible and only dismisses terminal lanes", () => {
    useReviewLanes.getState().start({
      id: "r1",
      sessionId: "s1",
      projectId: "p1",
      agentName: "Maya",
      source: "auto",
      target: "branch:main",
      reviewThreadId: "rt1",
      startedAt: 10,
    });
    useReviewLanes.getState().dismiss("r1");
    expect(useReviewLanes.getState().lanes.r1).toBeDefined();
    useReviewLanes.getState().fail("r1", "review crashed");
    expect(useReviewLanes.getState().lanes.r1.error).toBe("review crashed");
    useReviewLanes.getState().dismiss("r1");
    expect(useReviewLanes.getState().lanes.r1).toBeUndefined();
  });

  it("keeps every running lane visible beyond the terminal history cap", () => {
    for (let index = 0; index < 30; index++) {
      useReviewLanes.getState().start({
        id: `review-${index}`,
        sessionId: `session-${index}`,
        projectId: "project",
        agentName: `Agent ${index}`,
        source: "orchestrator",
        target: "uncommitted",
        reviewThreadId: `thread-${index}`,
        startedAt: index,
      });
    }
    expect(useReviewLanes.getState().order).toHaveLength(30);
    expect(Object.keys(useReviewLanes.getState().lanes)).toHaveLength(30);
  });
});
