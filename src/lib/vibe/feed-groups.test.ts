import { describe, expect, it } from "vitest";
import type { VibeItem } from "@/types";
import {
  compactWorkerFeedIds,
  groupWorkerFeed,
  markdownPreview,
  trailingWorkerActivityCount,
} from "./feed-groups";

const items: Record<string, VibeItem> = {
  user: { id: "user", at: 1, kind: "user", text: "audit" },
  cmd1: { id: "cmd1", at: 2, kind: "command", command: "rg", status: "completed", output: "" },
  search: { id: "search", at: 3, kind: "webSearch", query: "docs" },
  edit: {
    id: "edit",
    at: 3.5,
    kind: "fileChange",
    status: "completed",
    changes: [{ path: "src/app.ts", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new" }],
  },
  assistant: { id: "assistant", at: 4, kind: "assistant", text: "## Found it" },
  cmd2: { id: "cmd2", at: 5, kind: "command", command: "pnpm test", status: "inProgress", output: "" },
};

describe("worker feed grouping", () => {
  const order = ["user", "cmd1", "search", "edit", "assistant", "cmd2"];

  it("folds consecutive technical events but preserves chat rows", () => {
    expect(groupWorkerFeed(order, items)).toEqual([
      { kind: "item", id: "user" },
      { kind: "activity", key: "activity:cmd1", ids: ["cmd1", "search", "edit"] },
      { kind: "item", id: "assistant" },
      { kind: "activity", key: "activity:cmd2", ids: ["cmd2"] },
    ]);
  });

  it("prefers human-readable rows in the Fleet preview", () => {
    expect(compactWorkerFeedIds(order, items)).toEqual(["user", "assistant"]);
    expect(trailingWorkerActivityCount(order, items)).toBe(1);
  });

  it("removes common Markdown syntax from compact previews", () => {
    expect(markdownPreview("### Result\n- **Fixed** [store](/repo/store.ts:2)\n| A | B |"))
      .toBe("Result Fixed store A · B ·");
  });
});
