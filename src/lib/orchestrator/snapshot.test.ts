import { describe, expect, it } from "vitest";
import {
  crowdingNote,
  fleetSummaryLine,
  sessionCounts,
  sessionSnapshot,
  workspaceLayout,
  type FleetWorkspace,
} from "./snapshot";
import type { SwarmState } from "@/store";
import type { Agent, LayoutNode } from "@/types";
import type { VibeSessionEntry } from "@/lib/vibe/session-store";

// The pure snapshot helpers only touch a handful of fields; casts keep the
// fixtures terse without reconstructing the full Agent / SwarmState shapes.
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

describe("fleetSummaryLine with sessions", () => {
  const state = {
    workspaceOrder: [],
    workspaces: {},
    layouts: {},
    agents: {},
    order: [],
    activeWorkspaceId: null,
  } as unknown as SwarmState;

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

  it("appends a native-sessions segment", () => {
    const line = fleetSummaryLine(state, snap);
    expect(line).toContain("0 panes");
    expect(line).toContain("3 native sessions");
    expect(line).toContain("1 working");
    expect(line).toContain("1 waits approval");
  });

  it("omits the segment without sessions", () => {
    expect(fleetSummaryLine(state, [])).not.toContain("native session");
  });
});

describe("workspaceLayout", () => {
  const mkAgent = (id: string, name: string, cwd?: string) => ({ id, name, cwd });
  const agents = {
    a: mkAgent("a", "api", "/repos/api"),
    b: mkAgent("b", "build", "/repos/api"),
    c: mkAgent("c", "review", "/repos/api"),
  } as unknown as Record<string, Agent>;

  // row[ pane a | col[ pane b / pane c ] ]
  const tree: LayoutNode = {
    type: "split",
    id: "s0",
    direction: "row",
    sizes: [50, 50],
    children: [
      { type: "pane", id: "p0", agentId: "a" },
      {
        type: "split",
        id: "s1",
        direction: "column",
        sizes: [50, 50],
        children: [
          { type: "pane", id: "p1", agentId: "b" },
          { type: "pane", id: "p2", agentId: "c" },
        ],
      },
    ],
  };

  it("walks the tree with effective px", () => {
    const wl = workspaceLayout(tree, agents, { w: 1600, h: 1000 });
    expect(wl.paneCount).toBe(3);
    expect(wl.tree).toBe(
      'cols[ "api" (api) 800×1000 | rows[ "build" (api) 800×500 / "review" (api) 800×500 ] ]',
    );
    expect(wl.smallest).toEqual({ name: "build", w: 800, h: 500 });
    expect(wl.grid).toEqual({ w: 1600, h: 1000 });
  });

  it("returns a null tree but keeps the pane count when unmeasured", () => {
    const wl = workspaceLayout(tree, agents, null);
    expect(wl.tree).toBeNull();
    expect(wl.paneCount).toBe(3);
  });
});

describe("crowdingNote", () => {
  const mkAgent = (id: string, name: string) => ({ id, name });
  const crowdAgents = {
    a: mkAgent("a", "one"),
    b: mkAgent("b", "two"),
    c: mkAgent("c", "three"),
    d: mkAgent("d", "four"),
    e: mkAgent("e", "five"),
  } as unknown as Record<string, Agent>;

  const fiveCols: LayoutNode = {
    type: "split",
    id: "sc",
    direction: "row",
    sizes: [20, 20, 20, 20, 20],
    children: ["a", "b", "c", "d", "e"].map((id, i) => ({
      type: "pane" as const,
      id: "pc" + i,
      agentId: id,
    })),
  };

  const roomyAgents = {
    a: mkAgent("a", "api"),
    b: mkAgent("b", "build"),
    c: mkAgent("c", "review"),
  } as unknown as Record<string, Agent>;
  const roomyTree: LayoutNode = {
    type: "split",
    id: "s0",
    direction: "row",
    sizes: [50, 50],
    children: [
      { type: "pane", id: "p0", agentId: "a" },
      {
        type: "split",
        id: "s1",
        direction: "column",
        sizes: [50, 50],
        children: [
          { type: "pane", id: "p1", agentId: "b" },
          { type: "pane", id: "p2", agentId: "c" },
        ],
      },
    ],
  };

  const tightWs: FleetWorkspace = {
    id: "w1",
    name: "1",
    active: true,
    panes: [],
    layout: workspaceLayout(fiveCols, crowdAgents, { w: 1600, h: 1000 }),
  };
  const roomyWs: FleetWorkspace = {
    id: "w2",
    name: "2",
    active: false,
    panes: [],
    layout: workspaceLayout(roomyTree, roomyAgents, { w: 1600, h: 1000 }),
  };

  it("flags the tight workspace", () => {
    const note = crowdingNote([tightWs, roomyWs]);
    expect(note).toContain("ws «1» is tight");
    expect(note).toContain("smallest 320×1000");
  });

  it("returns null when every workspace is roomy", () => {
    expect(crowdingNote([roomyWs])).toBeNull();
  });
});
