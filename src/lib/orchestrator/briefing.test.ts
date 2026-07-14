import { describe, expect, it } from "vitest";
import { withWorktreeBriefing, worktreeBriefing } from "./briefing";

const BASE = {
  worktreePath: "/repo/.worktrees/checkout",
  branch: "swarm/maya-checkout",
  mainRepoRoot: "/repo",
  shared: false,
};

describe("worktreeBriefing", () => {
  it("names the worktree, branch and main repo and warns about deps", () => {
    const b = worktreeBriefing(BASE);
    expect(b).toContain('"/repo/.worktrees/checkout"');
    expect(b).toContain('"swarm/maya-checkout"');
    expect(b).toContain('"/repo"');
    expect(b).toContain("leave it untouched");
    expect(b).toContain("node_modules");
    expect(b).toContain("were NOT");
    expect(b).toContain("commit --no-verify");
    expect(b).toContain("push -u origin \"swarm/maya-checkout\"");
    expect(b).toContain("without asking");
    expect(b.startsWith("[workspace]")).toBe(true);
  });

  it("adds the one-writer line only for shared worktrees", () => {
    expect(worktreeBriefing(BASE)).not.toContain("SHARE");
    expect(worktreeBriefing({ ...BASE, shared: true })).toContain(
      "one writer at a time",
    );
  });

  it("flattens control characters and quotes in every field", () => {
    const b = worktreeBriefing({
      worktreePath: '/re"po\n/.worktrees/x',
      branch: "swarm/a\r\nb",
      mainRepoRoot: "/re po",
      shared: false,
    });
    // each interpolated field is one JSON string literal on one line — a
    // crafted folder name must not fabricate a structural briefing line
    const lines = b.split("\n");
    expect(lines).toHaveLength(6);
    expect(b).toContain('"/re\\"po /.worktrees/x"');
    expect(b).toContain('"swarm/a b"');
    expect(b).toContain('"/re po"');
  });
});

describe("withWorktreeBriefing", () => {
  it("returns the task unchanged without a worktree", () => {
    expect(withWorktreeBriefing("do the thing", null)).toBe("do the thing");
  });

  it("prepends the briefing before the task, blank-line separated", () => {
    const text = withWorktreeBriefing("do the thing", BASE);
    expect(text.endsWith("\n\ndo the thing")).toBe(true);
    expect(text.startsWith("[workspace]")).toBe(true);
  });
});
