import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_REVIEW_ITERATIONS,
  normalizeReviewIterationLimit,
  normalizeReviewIterationCounters,
  reviewLaneKey,
  reviewLoopConfig,
} from "./review-policy";

describe("review loop policy", () => {
  it("is opt-in and defaults to two bounded iterations", () => {
    expect(reviewLoopConfig({})).toEqual({
      enabled: false,
      maxIterations: DEFAULT_MAX_REVIEW_ITERATIONS,
    });
    expect(
      reviewLoopConfig({
        autoReviewFinishedLanes: true,
        autoReviewMaxIterations: 4,
      }),
    ).toEqual({ enabled: true, maxIterations: 4 });
  });

  it("clamps malformed limits", () => {
    expect(normalizeReviewIterationLimit(0)).toBe(1);
    expect(normalizeReviewIterationLimit(99)).toBe(10);
    expect(normalizeReviewIterationLimit(2.9)).toBe(2);
    expect(normalizeReviewIterationLimit("4")).toBe(2);
  });

  it("binds shared agents to the same worktree feature lane", () => {
    const base = {
      id: "a",
      name: "A",
      projectId: "project",
      agentName: "A",
      spawnedBy: "conductor" as const,
      worktree: { root: "/repo", branch: "swarm/feature", shared: false },
      projectDir: "/repo/.worktrees/feature",
      access: "workspace" as const,
      threadId: null,
      createdAt: 1,
    };
    expect(reviewLaneKey(base)).toBe(
      reviewLaneKey({
        ...base,
        id: "b",
        projectDir: "/another/spelling/is/irrelevant",
        worktree: { ...base.worktree, shared: true },
      }),
    );
  });

  it("keeps direct-checkout sessions independent and sanitizes counters", () => {
    const base = {
      id: "a",
      name: "A",
      projectId: "project",
      agentName: "A",
      spawnedBy: "conductor" as const,
      worktree: null,
      projectDir: "/repo",
      access: "workspace" as const,
      threadId: null,
      createdAt: 1,
    };
    expect(reviewLaneKey(base)).not.toBe(reviewLaneKey({ ...base, id: "b" }));
    expect(
      normalizeReviewIterationCounters([
        { laneKey: "worktree:/repo\\0swarm/a", count: 2, updatedAt: 3 },
        { laneKey: "bad\nkey", count: 1, updatedAt: 4 },
        { laneKey: "negative", count: -1, updatedAt: 5 },
      ]),
    ).toEqual([
      { laneKey: "worktree:/repo\\0swarm/a", count: 2, updatedAt: 3 },
    ]);
  });
});
