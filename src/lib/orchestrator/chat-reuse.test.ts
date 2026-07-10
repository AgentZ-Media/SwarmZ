import { describe, expect, it } from "vitest";
import {
  applyChatAssignments,
  assignChatsToProjects,
  capChats,
  collapseEmptyChats,
  isReusableEmptyChat,
  type MigratableChat,
} from "./chat-reuse";
import type { OrchestratorChatMessage } from "@/types";

/** Terse message factory — only `role` matters to the predicate. */
function msg(role: OrchestratorChatMessage["role"]): { role: typeof role } {
  return { role };
}

/** A chat with id + project + messages (all the collapse logic reads). */
function chat(
  id: string,
  roles: OrchestratorChatMessage["role"][] = [],
  projectId = "p1",
) {
  return { id, projectId, messages: roles.map(msg) };
}

describe("isReusableEmptyChat", () => {
  it("treats a truly empty chat as reusable", () => {
    expect(isReusableEmptyChat({ messages: [] })).toBe(true);
  });

  it("treats a system-ping-only chat as reusable", () => {
    expect(isReusableEmptyChat({ messages: [msg("system")] })).toBe(true);
  });

  it("treats a warning-only chat as reusable", () => {
    expect(isReusableEmptyChat({ messages: [msg("warning")] })).toBe(true);
  });

  it("treats a system + warning mix as reusable (no real turn)", () => {
    expect(
      isReusableEmptyChat({ messages: [msg("system"), msg("warning")] }),
    ).toBe(true);
  });

  it("is NOT reusable once the user has sent a turn", () => {
    expect(isReusableEmptyChat({ messages: [msg("user")] })).toBe(false);
  });

  it("is NOT reusable once the assistant has replied", () => {
    expect(
      isReusableEmptyChat({ messages: [msg("system"), msg("assistant")] }),
    ).toBe(false);
  });

  it("is NOT reusable for a full exchange", () => {
    expect(
      isReusableEmptyChat({
        messages: [msg("user"), msg("assistant"), msg("tool")],
      }),
    ).toBe(false);
  });
});

describe("collapseEmptyChats (per project)", () => {
  it("leaves a list with one empty chat per project untouched", () => {
    const chats = [chat("a", ["user"]), chat("b"), chat("c", [], "p2")];
    const r = collapseEmptyChats(chats, { p1: "b", p2: "c" });
    expect(r.chats.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(r.activeByProject).toEqual({ p1: "b", p2: "c" });
  });

  it("folds several stacked empties into the project's active one", () => {
    // the reload-race scenario: a fresh empty ('c', active) next to two
    // persisted empties ('a','b') and one real chat ('r')
    const chats = [chat("c"), chat("a"), chat("b"), chat("r", ["user"])];
    const r = collapseEmptyChats(chats, { p1: "c" });
    expect(r.chats.map((c) => c.id)).toEqual(["c", "r"]);
    expect(r.activeByProject).toEqual({ p1: "c" });
  });

  it("keeps the FIRST empty and repoints active entries naming a dropped chat", () => {
    const chats = [chat("a"), chat("b"), chat("r", ["user", "assistant"])];
    // active names the second empty → it is kept instead of the first
    const kept = collapseEmptyChats(chats, { p1: "b" });
    expect(kept.chats.map((c) => c.id)).toEqual(["b", "r"]);
    // active names a real chat → first empty kept, active untouched
    const real = collapseEmptyChats(chats, { p1: "r" });
    expect(real.chats.map((c) => c.id)).toEqual(["a", "r"]);
    expect(real.activeByProject).toEqual({ p1: "r" });
  });

  it("collapses per project independently — one empty survives in each", () => {
    const chats = [
      chat("a1"),
      chat("a2"),
      chat("b1", [], "p2"),
      chat("b2", [], "p2"),
      chat("r", ["user"], "p2"),
    ];
    const r = collapseEmptyChats(chats, { p1: "a2", p2: "r" });
    expect(r.chats.map((c) => c.id)).toEqual(["a2", "b1", "r"]);
    // p1's active stays the kept empty; p2's active was the real chat
    expect(r.activeByProject).toEqual({ p1: "a2", p2: "r" });
  });

  it("system-ping-only chats count as empty and collapse", () => {
    const chats = [chat("a", ["system"]), chat("b", ["warning"])];
    const r = collapseEmptyChats(chats, { p1: "a" });
    expect(r.chats.map((c) => c.id)).toEqual(["a"]);
    expect(r.activeByProject).toEqual({ p1: "a" });
  });
});

describe("assignChatsToProjects (Phase-3 migration)", () => {
  const valid = new Set(["p1", "p2"]);
  const sessionProject = (id: string) =>
    ({ s1: "p1", s2: "p2", gone: null })[id] ?? null;

  function mig(
    id: string,
    projectId: string | null,
    touched: Record<string, number> = {},
  ): MigratableChat {
    return { id, projectId, touched };
  }

  it("keeps a valid existing projectId", () => {
    const r = assignChatsToProjects(
      [mig("c1", "p2", { s1: 100 })],
      valid,
      sessionProject,
      "p1",
    );
    expect(r).toEqual({ c1: "p2" });
  });

  it("derives the project from the MOST RECENTLY touched session", () => {
    const r = assignChatsToProjects(
      [mig("c1", null, { s1: 100, s2: 200 })],
      valid,
      sessionProject,
      null,
    );
    expect(r).toEqual({ c1: "p2" });
  });

  it("skips touched sessions that are gone and falls through in order", () => {
    // 'gone' resolves to no project → fallback applies
    const r = assignChatsToProjects(
      [mig("c1", "stale-project", { gone: 999 })],
      valid,
      sessionProject,
      "p1",
    );
    expect(r).toEqual({ c1: "p1" });
  });

  it("assigns the fallback project when nothing was touched", () => {
    const r = assignChatsToProjects([mig("c1", null)], valid, sessionProject, "p2");
    expect(r).toEqual({ c1: "p2" });
  });

  it("keeps '' when there is no valid fallback at all", () => {
    const r = assignChatsToProjects([mig("c1", null)], valid, sessionProject, null);
    expect(r).toEqual({ c1: "" });
    const stale = assignChatsToProjects(
      [mig("c2", null)],
      valid,
      sessionProject,
      "not-a-project",
    );
    expect(stale).toEqual({ c2: "" });
  });
});

describe("capChats", () => {
  const entry = (id: string, projectId: string) => ({ id, projectId });

  it("returns the same reference when under the cap", () => {
    const chats = [entry("a", "p1"), entry("b", "p2")];
    expect(capChats(chats, 5)).toBe(chats);
  });

  it("evicts oldest assigned chats first (end of list)", () => {
    const chats = [entry("new", "p1"), entry("mid", "p1"), entry("old", "p1")];
    expect(capChats(chats, 2).map((c) => c.id)).toEqual(["new", "mid"]);
  });

  it("never evicts unassigned ('') chats — they wait for healing", () => {
    const chats = [entry("a", "p1"), entry("b", ""), entry("c", "p1")];
    // over by 1 → drops the oldest ASSIGNED chat, keeps the "" one
    expect(capChats(chats, 2).map((c) => c.id)).toEqual(["a", "b"]);
    // even when only "" chats could make room, they survive
    const onlyUnassigned = [entry("x", ""), entry("y", "")];
    expect(capChats(onlyUnassigned, 1).map((c) => c.id)).toEqual(["x", "y"]);
  });
});

describe("applyChatAssignments", () => {
  const c = (id: string, projectId: string) => ({ id, projectId });

  it("applies changed assignments and reports changed", () => {
    const { chats, changed } = applyChatAssignments(
      [c("a", ""), c("b", "p1")],
      { a: "p2", b: "p1" },
    );
    expect(changed).toBe(true);
    expect(chats.map((x) => x.projectId)).toEqual(["p2", "p1"]);
  });

  it("keeps the identical array reference when nothing changes", () => {
    const input = [c("a", "p1")];
    const { chats, changed } = applyChatAssignments(input, { a: "p1" });
    expect(changed).toBe(false);
    expect(chats).toBe(input);
  });

  it("never downgrades an existing assignment to ''", () => {
    const input = [c("a", "p1")];
    const { chats, changed } = applyChatAssignments(input, { a: "" });
    expect(changed).toBe(false);
    expect(chats).toBe(input);
    expect(chats[0].projectId).toBe("p1");
  });
});
