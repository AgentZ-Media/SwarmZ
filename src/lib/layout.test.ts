import { describe, expect, it, vi } from "vitest";

// Deterministic pane ids so the balanced-builder output is stable to assert.
let idc = 0;
vi.mock("nanoid", () => ({ nanoid: () => "n" + idc++ }));

const {
  buildArrangement,
  combineLayouts,
  collectPanes,
  autoArrangement,
} = await import("./layout");

describe("buildArrangement", () => {
  it("builds a columns split (side by side, equal sizes)", () => {
    const cols = buildArrangement(["a", "b", "c"], "columns", 1.6);
    expect(cols?.type).toBe("split");
    if (cols?.type !== "split") throw new Error("expected split");
    expect(cols.direction).toBe("row");
    expect(collectPanes(cols).map((p) => p.agentId)).toEqual(["a", "b", "c"]);
    expect(cols.sizes).toEqual([100 / 3, 100 / 3, 100 / 3]);
  });

  it("builds a rows split (stacked)", () => {
    const rows = buildArrangement(["a", "b"], "rows", 1.6);
    expect(rows?.type === "split" && rows.direction).toBe("column");
  });

  it("builds a grid (outer column of rows)", () => {
    const grid = buildArrangement(["a", "b", "c", "d"], "grid", 1.6);
    if (grid?.type !== "split") throw new Error("expected split");
    expect(grid.direction).toBe("column");
    expect(grid.children).toHaveLength(2);
    expect(grid.children[0].type === "split" && grid.children[0].direction).toBe("row");
    expect(collectPanes(grid)).toHaveLength(4);
  });

  it("returns a bare pane for a single id and null for none", () => {
    const solo = buildArrangement(["solo"], "auto", 1.6);
    expect(solo).toMatchObject({ type: "pane", agentId: "solo" });
    expect(buildArrangement([], "auto", 1.6)).toBeNull();
  });
});

describe("autoArrangement", () => {
  it("chooses by count and aspect", () => {
    expect(autoArrangement(2, 2)).toBe("columns");
    expect(autoArrangement(2, 0.5)).toBe("rows");
    expect(autoArrangement(5, 1)).toBe("grid");
  });
});

describe("combineLayouts", () => {
  it("grafts a new arrangement beside an existing pane, proportioned by count", () => {
    const existing = { type: "pane" as const, id: "px", agentId: "x" };
    const combined = combineLayouts(existing, buildArrangement(["a", "b"], "columns", 1.6)!, 2);
    if (combined?.type !== "split") throw new Error("expected split");
    expect(combined.direction).toBe("row");
    expect(combined.sizes).toEqual([1, 2]);
    expect(collectPanes(combined).map((p) => p.agentId)).toEqual(["x", "a", "b"]);
  });
});
