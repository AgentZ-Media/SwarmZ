import { describe, expect, it } from "vitest";
import { renderSessionTranscript } from "./transcript";
import type { VibeItem } from "@/types";

const items: VibeItem[] = [
  { id: "u1", at: 1, kind: "user", text: "please build   the app" },
  { id: "a1", at: 2, kind: "assistant", text: "On it." },
  {
    id: "c1",
    at: 3,
    kind: "command",
    command: "npm run build",
    status: "completed",
    exitCode: 0,
    output: "BUILD_OK_XYZ\n",
  },
  {
    id: "c2",
    at: 4,
    kind: "command",
    command: "npm test",
    status: "failed",
    exitCode: 1,
    output: "line1\nline2\nline3\nline4\nline5\nline6\nFAILED here\n",
  },
  {
    id: "f1",
    at: 5,
    kind: "fileChange",
    status: "completed",
    changes: [
      { path: "src/a.ts", kind: { type: "update" }, diff: "@@\n+added\n+added2\n-removed\n" },
      { path: "src/new.ts", kind: { type: "add" }, diff: "line one\nline two\n" },
    ],
  },
  {
    id: "p1",
    at: 6,
    kind: "plan",
    explanation: "the plan",
    steps: [
      { step: "a", status: "completed" },
      { step: "b", status: "in_progress" },
    ],
  },
  {
    id: "ap1",
    at: 7,
    kind: "approval",
    approvalKind: "command",
    status: "accepted",
    payload: {},
  },
  { id: "r1", at: 8, kind: "warning", text: "heads up" },
];

describe("renderSessionTranscript", () => {
  const rendered = renderSessionTranscript(items);
  const lines = rendered.split("\n");

  it("flattens user text", () => {
    expect(lines).toContain("user: please build the app");
  });

  it("renders assistant text", () => {
    expect(lines).toContain("assistant: On it.");
  });

  it("renders an exit-0 command line", () => {
    expect(lines).toContain("$ npm run build → exit 0");
  });

  it("omits successful command output", () => {
    expect(rendered).not.toContain("BUILD_OK_XYZ");
  });

  it("renders a failed command line with its tail", () => {
    expect(lines).toContain("$ npm test → exit 1");
    expect(rendered).toContain("FAILED here");
  });

  it("keeps only the last ~5 output lines on failure", () => {
    expect(rendered).not.toContain("line1");
  });

  it("renders fileChange counts (update +2 −1, add +2 −0)", () => {
    expect(
      lines.some(
        (l) =>
          l.startsWith("files (completed):") &&
          l.includes("src/a.ts +2 −1") &&
          l.includes("src/new.ts +2 −0"),
      ),
    ).toBe(true);
  });

  it("renders the plan standing", () => {
    expect(lines.some((l) => l.startsWith("plan: the plan — 1/2 steps done"))).toBe(true);
  });

  it("renders approval status", () => {
    expect(lines).toContain("approval (command): accepted");
  });

  it("renders warning lines", () => {
    expect(lines).toContain("warning: heads up");
  });

  it("respects a tail option (keeps only the last two items)", () => {
    const tail2 = renderSessionTranscript(items, { tail: 2 }).split("\n");
    expect(tail2).toContain("approval (command): accepted");
    expect(tail2).toContain("warning: heads up");
    expect(tail2.some((l) => l.startsWith("user:"))).toBe(false);
  });
});
