import { describe, expect, it } from "vitest";
import type { VibeSession } from "@/types";
import {
  fleetSummaryLine,
  pendingApprovalBriefs,
  sessionCounts,
  sessionSnapshot,
  worktreeOccupancy,
} from "./snapshot";
import type { VibeSessionEntry } from "@/lib/vibe/session-store";

// The pure snapshot helpers only touch a handful of fields; casts keep the
// fixtures terse without reconstructing the full VibeSessionEntry shape.
const entry = (
  e: Omit<Partial<VibeSessionEntry>, "session"> & {
    session: Partial<VibeSession> & Pick<VibeSession, "id" | "name" | "projectDir">;
  },
) =>
  ({
    items: {},
    order: [],
    turnId: null,
    diff: null,
    plan: null,
    tokenUsage: null,
    lastBusyEndAt: null,
    ...e,
    session: {
      projectId: "p1",
      agentName: e.session.name,
      spawnedBy: "user",
      worktree: null,
      access: "workspace",
      threadId: null,
      createdAt: 0,
      ...e.session,
    },
  }) as VibeSessionEntry;

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

  it("carries worktree meta and approval briefs (v2)", () => {
    expect(snap[0].worktree).toBeNull();
    expect(snap[0].pendingApprovals).toEqual([]);
    // the pending approval surfaces as a brief with its routing class
    expect(snap[1].pendingApprovals).toHaveLength(1);
    expect(snap[1].pendingApprovals[0].id).toBe("ap");
    // no escalation on the item (pre-Phase-4) → human-only
    expect(snap[1].pendingApprovals[0].escalation).toBe("destructive");
  });
});

describe("pendingApprovalBriefs / worktreeOccupancy", () => {
  it("summarizes pending approvals with class and command", () => {
    const e = entry({
      session: { id: "s9", name: "maya", projectDir: "/repos/api/.worktrees/lane" },
      items: {
        a1: {
          id: "a1", at: 1, kind: "approval", approvalKind: "command",
          status: "pending", escalation: "routine",
          payload: { command: "/bin/zsh -lc 'touch x'" },
        },
        a2: {
          id: "a2", at: 2, kind: "approval", approvalKind: "fileChange",
          status: "accepted", escalation: "routine", payload: {},
        },
        a3: {
          id: "a3", at: 3, kind: "approval", approvalKind: "fileChange",
          status: "pending",
          payload: { changes: [{ path: "/etc/hosts" }] },
        },
      },
      order: ["a1", "a2", "a3"],
    });
    const briefs = pendingApprovalBriefs(e);
    expect(briefs.map((b) => b.id)).toEqual(["a1", "a3"]); // decided ones drop
    expect(briefs[0].escalation).toBe("routine");
    expect(briefs[0].summary).toContain("touch x");
    expect(briefs[1].escalation).toBe("destructive");
    expect(briefs[1].summary).toContain("/etc/hosts");
  });

  it("groups sessions by worktree and derives shared", () => {
    const wt = { root: "/repos/api", branch: "swarm/maya-lane", shared: true };
    const snap = sessionSnapshot({
      sessions: [
        entry({ session: { id: "s1", name: "Maya", projectDir: "/repos/api/.worktrees/lane", worktree: wt } }),
        entry({ session: { id: "s2", name: "Jonas", projectDir: "/repos/api/.worktrees/lane", worktree: wt } }),
        entry({ session: { id: "s3", name: "Kenji", projectDir: "/repos/api" } }),
      ],
      busy: {},
    });
    expect(snap[0].worktree).toEqual({ branch: "swarm/maya-lane", shared: true });
    const occ = worktreeOccupancy(snap);
    expect(occ).toHaveLength(1);
    expect(occ[0].path).toBe("/repos/api/.worktrees/lane");
    expect(occ[0].agents).toEqual(["Maya", "Jonas"]);
    expect(occ[0].shared).toBe(true);
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
