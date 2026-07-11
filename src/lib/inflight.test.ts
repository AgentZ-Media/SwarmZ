import { describe, expect, it } from "vitest";
import { beginInflight, inflightCount } from "./inflight";

describe("beginInflight / inflightCount", () => {
  it("counts per kind and releases exactly once", () => {
    expect(inflightCount("review")).toBe(0);
    const a = beginInflight("review");
    const b = beginInflight("review");
    const w = beginInflight("worktree");
    expect(inflightCount("review")).toBe(2);
    expect(inflightCount("worktree")).toBe(1);
    a();
    a(); // idempotent — a double release never underflows
    expect(inflightCount("review")).toBe(1);
    b();
    w();
    expect(inflightCount("review")).toBe(0);
    expect(inflightCount("worktree")).toBe(0);
  });
});
