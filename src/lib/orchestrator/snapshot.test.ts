import { describe, expect, it } from "vitest";
import { fleetSummaryLine, sessionCounts, sessionSnapshot } from "./snapshot";
import type { VibeSessionEntry } from "@/lib/vibe/session-store";

// The pure snapshot helpers only touch a handful of fields; casts keep the
// fixtures terse without reconstructing the full VibeSessionEntry shape.
const entry = (e: Partial<VibeSessionEntry> & Pick<VibeSessionEntry, "session">) =>
  ({ items: {}, order: [], turnId: null, diff: null, plan: null, tokenUsage: null, lastBusyEndAt: null, ...e }) as VibeSessionEntry;

describe("sessionSnapshot / sessionCounts", () => {
  const entryA = entry({
    session: { id: "s1", name: "api", projectDir: "/repos/api", model: "gpt-5", access: "workspace", threadId: null, createdAt: 10 },
    tokenUsage: { total: { input: 100 }, modelContextWindow: 1000 } as never,
  });
  const entryB = entry({
    session: { id: "s2", name: "web", projectDir: "/repos/web", access: "full", threadId: null, createdAt: 20 },
    items: {
      ap: { id: "ap", at: 1, kind: "approval", approvalKind: "command", status: "pending", payload: {} },
    },
    order: ["ap"],
  });
  const entryC = entry({
    session: { id: "s3", name: "docs", projectDir: "/repos/docs", access: "workspace", threadId: null, createdAt: 30 },
  });

  const snap = sessionSnapshot({
    sessions: [entryA, entryB, entryC],
    busy: { s1: true, s2: true, s3: false },
  });

  it("derives status, context and project", () => {
    expect(snap[0].status).toBe("working");
    expect(snap[0].contextPct).toBe(10);
    expect(snap[0].projectName).toBe("api");
  });

  it("lets a pending approval win over busy", () => {
    expect(snap[1].status).toBe("pending-approval");
  });

  it("marks a quiet session idle", () => {
    expect(snap[2].status).toBe("idle");
  });

  it("counts sessions by status", () => {
    expect(sessionCounts(snap)).toEqual({ sessions: 3, working: 1, waitingApproval: 1 });
  });
});

describe("fleetSummaryLine", () => {
  const snap = sessionSnapshot({
    sessions: [
      entry({ session: { id: "s1", name: "api", projectDir: "/repos/api", access: "workspace", threadId: null, createdAt: 10 } }),
      entry({
        session: { id: "s2", name: "web", projectDir: "/repos/web", access: "full", threadId: null, createdAt: 20 },
        items: { ap: { id: "ap", at: 1, kind: "approval", approvalKind: "command", status: "pending", payload: {} } },
        order: ["ap"],
      }),
      entry({ session: { id: "s3", name: "docs", projectDir: "/repos/docs", access: "workspace", threadId: null, createdAt: 30 } }),
    ],
    busy: { s1: true, s2: false, s3: false },
  });

  it("summarizes the sessions", () => {
    const line = fleetSummaryLine(snap);
    expect(line).toContain("3 sessions");
    expect(line).toContain("1 working");
    expect(line).toContain("1 waits approval");
  });

  it("reads sensibly with no sessions", () => {
    expect(fleetSummaryLine([])).toBe("0 sessions · 0 working · 0 wait approval");
  });
});
