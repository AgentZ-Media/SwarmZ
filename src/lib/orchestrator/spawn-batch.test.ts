import { describe, expect, it } from "vitest";
import { assertSafeSpawnBatch, spawnBatchSummary } from "./spawn-batch";

describe("spawn batch delivery contract", () => {
  it("refuses multiple main-checkout lanes before any worker is created", () => {
    expect(() =>
      assertSafeSpawnBatch([
        { task: "backend audit", worktree: "none" },
        { task: "frontend audit", worktree: "none" },
      ]),
    ).toThrow(/before creating agents.*worktree "new".*sequential work/i);
  });

  it("allows independent worktrees and one direct read lane", () => {
    expect(() =>
      assertSafeSpawnBatch([
        { task: "backend audit", worktree: "new" },
        { task: "frontend audit", worktree: "new" },
        { task: "read docs", worktree: "none" },
      ]),
    ).not.toThrow();
  });

  it("reports prompt acknowledgements separately from created windows", () => {
    expect(spawnBatchSummary([
      { id: "a", name: "A", delivery: "started", turnId: "turn-a" },
      { id: "b", name: "B", warning: "task not delivered" },
      { name: "C", error: "spawn failed" },
    ])).toBe(
      "created 2 agents; backend-acknowledged 1 initial task; 1 task not delivered; 1 spawn failed",
    );
  });
});
