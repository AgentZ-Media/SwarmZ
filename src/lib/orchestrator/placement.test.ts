import { describe, expect, it } from "vitest";
import {
  MIN_PANE,
  capacityFor,
  planPlacement,
  resolveArrangement,
} from "./placement";

describe("capacity + arrangement math", () => {
  it("exposes the readability floor", () => {
    expect(MIN_PANE).toEqual({ w: 380, h: 240 });
  });

  it("computes capacity per arrangement", () => {
    expect(capacityFor({ w: 1600, h: 1000 }, "grid", 6)).toBe(16);
    expect(capacityFor({ w: 1600, h: 1000 }, "columns", 6)).toBe(4);
    expect(capacityFor(null, "grid", 6)).toBe(Infinity);
  });

  it("resolves auto arrangement by count and aspect", () => {
    expect(resolveArrangement(2, { w: 1600, h: 1000 })).toBe("columns");
    expect(resolveArrangement(2, { w: 800, h: 1200 })).toBe("rows");
    expect(resolveArrangement(5, { w: 1600, h: 1000 })).toBe("grid");
  });
});

describe("planPlacement", () => {
  it("overflows beyond target capacity into a new workspace", () => {
    const plan = planPlacement({
      workspace: "current",
      arrangement: "auto",
      activeWorkspaceId: "w1",
      workspaces: [{ id: "w1", name: "1", panes: 0, dims: { w: 800, h: 500 } }],
      newWorkspaceDims: { w: 800, h: 500 },
      specs: Array.from({ length: 6 }, () => ({ project: "api" })),
    });
    expect(plan.buckets).toHaveLength(2);
    expect(plan.buckets[0].ref).toEqual({ kind: "existing", id: "w1" });
    expect(plan.buckets[0].indices).toHaveLength(4);
    expect(plan.buckets[1].ref.kind).toBe("new");
    expect(plan.buckets[1].indices).toHaveLength(2);
    expect(plan.buckets[0].arrangement).toBe("grid");
  });

  it("keeps each project in its own bucket", () => {
    const plan = planPlacement({
      arrangement: "grid",
      activeWorkspaceId: "w1",
      workspaces: [{ id: "w1", name: "1", panes: 0, dims: { w: 800, h: 260 } }],
      newWorkspaceDims: { w: 800, h: 260 },
      specs: [{ project: "A" }, { project: "A" }, { project: "B" }, { project: "B" }],
    });
    expect(plan.buckets).toHaveLength(2);
    expect(plan.buckets[0].indices).toEqual([0, 1]);
    expect(plan.buckets[1].indices).toEqual([2, 3]);
  });

  it("keeps a group whole across the target boundary", () => {
    const plan = planPlacement({
      arrangement: "grid",
      activeWorkspaceId: "w1",
      workspaces: [{ id: "w1", name: "1", panes: 0, dims: { w: 800, h: 260 } }], // cap 2
      newWorkspaceDims: { w: 800, h: 520 }, // cap 4
      specs: [{ project: "A" }, { project: "B" }, { project: "B" }],
    });
    expect(plan.buckets[0].indices).toEqual([0]);
    expect(plan.buckets[1].indices).toEqual([1, 2]);
  });

  it("targets a brand-new workspace", () => {
    const plan = planPlacement({
      workspace: "new",
      arrangement: "auto",
      activeWorkspaceId: "w1",
      workspaces: [{ id: "w1", name: "1", panes: 0, dims: { w: 1600, h: 1000 } }],
      newWorkspaceDims: { w: 1600, h: 1000 },
      specs: [{ project: "x" }, { project: "x" }],
    });
    expect(plan.buckets[0].ref.kind).toBe("new");
    expect(plan.buckets[0].arrangement).toBe("columns");
  });

  it("resolves a workspace name case-insensitively", () => {
    const plan = planPlacement({
      workspace: "backend",
      activeWorkspaceId: "w1",
      workspaces: [
        { id: "w1", name: "1", panes: 0, dims: { w: 1600, h: 1000 } },
        { id: "w2", name: "Backend", panes: 0, dims: { w: 1600, h: 1000 } },
      ],
      newWorkspaceDims: { w: 1600, h: 1000 },
      specs: [{ project: "x" }],
    });
    expect(plan.buckets[0].ref).toEqual({ kind: "existing", id: "w2" });
  });

  it("errors on an unknown workspace name", () => {
    const plan = planPlacement({
      workspace: "nope",
      activeWorkspaceId: "w1",
      workspaces: [{ id: "w1", name: "1", panes: 0, dims: null }],
      newWorkspaceDims: null,
      specs: [{ project: "x" }],
    });
    expect(plan.error).toBeTruthy();
    expect(plan.error).toContain("unknown workspace");
  });

  it("echoes beside specs and excludes them from buckets", () => {
    const plan = planPlacement({
      activeWorkspaceId: "w1",
      workspaces: [{ id: "w1", name: "1", panes: 0, dims: { w: 1600, h: 1000 } }],
      newWorkspaceDims: { w: 1600, h: 1000 },
      specs: [
        { project: "A" },
        { project: "B", beside: { paneId: "pX", direction: "below" } },
      ],
    });
    expect(plan.beside).toEqual([{ index: 1, targetPaneId: "pX", direction: "below" }]);
    expect(plan.buckets[0].indices).toEqual([0]);
  });
});
