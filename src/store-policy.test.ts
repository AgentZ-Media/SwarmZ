import { beforeEach, describe, expect, it } from "vitest";
import { MAX_APPROVAL_RULES } from "@/lib/approval-rules";
import { useSwarm } from "./store";

beforeEach(async () => {
  useSwarm.setState({ settings: {} });
  await useSwarm.getState().setApprovalRules([]);
});

describe("security-sensitive settings actions", () => {
  it("serializes concurrent approval additions without losing either rule", async () => {
    await Promise.all([
      useSwarm.getState().addApprovalRule(["pnpm", "test"]),
      useSwarm.getState().addApprovalRule(["cargo", "test"]),
    ]);
    expect(useSwarm.getState().settings.approvalRules?.map((rule) => rule.pattern)).toEqual([
      ["pnpm", "test"],
      ["cargo", "test"],
    ]);
  });

  it("rejects a new persistent rule at capacity", async () => {
    await useSwarm.getState().setApprovalRules(
      Array.from({ length: MAX_APPROVAL_RULES }, (_, index) => ({
        id: `rule-${index}`,
        pattern: ["tool", String(index)],
        createdAt: index,
      })),
    );
    await expect(
      useSwarm.getState().addApprovalRule(["tool", "overflow"]),
    ).rejects.toThrow("rule limit");
  });

  it("persists a lane count independently and enforces single-flight", () => {
    const store = useSwarm.getState();
    expect(store.claimReviewIteration("worktree:/repo\0swarm/feature", 2)).toMatchObject({
      allowed: true,
      count: 1,
    });
    expect(store.claimReviewIteration("worktree:/repo\0swarm/feature", 2)).toMatchObject({
      allowed: false,
      reason: "active",
    });
    store.releaseReviewIteration("worktree:/repo\0swarm/feature");
    expect(store.claimReviewIteration("worktree:/repo\0swarm/feature", 2)).toMatchObject({
      allowed: true,
      count: 2,
    });
    store.releaseReviewIteration("worktree:/repo\0swarm/feature");
    expect(store.claimReviewIteration("worktree:/repo\0swarm/feature", 2)).toMatchObject({
      allowed: false,
      reason: "limit",
    });
  });
});
