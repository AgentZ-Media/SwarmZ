import { describe, expect, it } from "vitest";
import type { VibeItem, VibeSession } from "@/types";
import type { VibeSessionEntry } from "./session-store";
import { unresolvedNeedsHumanReport } from "./triage";
import { vibeSignal } from "./ui";

function entry(items: VibeItem[]): VibeSessionEntry {
  return {
    session: {
      id: "lane-1",
      name: "Attempt 01",
      projectId: "project-1",
      agentName: "Attempt 01",
      spawnedBy: "conductor",
      worktree: null,
      projectDir: "/repo",
      access: "workspace",
      threadId: "thread-1",
      createdAt: 1,
    } satisfies VibeSession,
    items: Object.fromEntries(items.map((item) => [item.id, item])),
    order: items.map((item) => item.id),
    turnId: null,
    diff: null,
    plan: null,
    tokenUsage: null,
    lastBusyEndAt: null,
  };
}

function report(
  id: string,
  at: number,
  needsHuman: boolean,
): Extract<VibeItem, { kind: "assistant" }> {
  return {
    id,
    at,
    kind: "assistant",
    report: true,
    text: JSON.stringify({
      done: !needsHuman,
      summary: needsHuman ? "Blocked on a product decision" : "Complete",
      files_changed: [],
      tests_pass: null,
      needs_human: needsHuman,
      question: needsHuman ? "Which API shape should I use?" : null,
      followups: [],
    }),
  };
}

describe("unresolvedNeedsHumanReport", () => {
  it("surfaces a stamped structured report that needs the human", () => {
    const state = entry([report("r1", 20, true)]);
    expect(unresolvedNeedsHumanReport(state)).toEqual({
      at: 20,
      summary: "Which API shape should I use?",
    });
    expect(vibeSignal(state, false, 25)).toBe("needsYou");
  });

  it("is cleared by a later human message", () => {
    const state = entry([
      report("r1", 20, true),
      { id: "u1", at: 30, kind: "user", text: "Use option B." },
    ]);
    expect(unresolvedNeedsHumanReport(state)).toBeNull();
  });

  it("is not cleared by a later Conductor prompt", () => {
    const state = entry([
      report("r1", 20, true),
      {
        id: "u1",
        at: 30,
        kind: "user",
        text: "Please wait for the human.",
        via: "conductor",
      },
    ]);
    expect(unresolvedNeedsHumanReport(state)?.at).toBe(20);
  });

  it("uses the newest report as the authoritative state", () => {
    const state = entry([report("r1", 20, true), report("r2", 40, false)]);
    expect(unresolvedNeedsHumanReport(state)).toBeNull();
  });
});
