import { describe, expect, it } from "vitest";
import { collapseEmptyChats, isReusableEmptyChat } from "./chat-reuse";
import type { OrchestratorChatMessage } from "@/types";

/** Terse message factory — only `role` matters to the predicate. */
function msg(role: OrchestratorChatMessage["role"]): { role: typeof role } {
  return { role };
}

/** A chat with just an id + messages (all the collapse logic reads). */
function chat(id: string, roles: OrchestratorChatMessage["role"][] = []) {
  return { id, messages: roles.map(msg) };
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

describe("collapseEmptyChats", () => {
  it("leaves a list with one empty chat untouched", () => {
    const chats = [chat("a", ["user"]), chat("b")];
    const r = collapseEmptyChats(chats, "b");
    expect(r.chats.map((c) => c.id)).toEqual(["a", "b"]);
    expect(r.activeId).toBe("b");
  });

  it("folds several stacked empties into the active one", () => {
    // the reload-race scenario: a fresh empty ('c', active) next to two
    // persisted empties ('a','b') and one real chat ('r')
    const chats = [chat("c"), chat("a"), chat("b"), chat("r", ["user"])];
    const r = collapseEmptyChats(chats, "c");
    expect(r.chats.map((c) => c.id)).toEqual(["c", "r"]);
    expect(r.activeId).toBe("c");
  });

  it("keeps the FIRST empty and repoints active when active is a real chat", () => {
    // active names a non-empty chat, so no empty is 'the active one' → the
    // first empty ('a') is kept, 'b' dropped, active stays on the real chat
    const chats = [chat("a"), chat("b"), chat("r", ["user", "assistant"])];
    const r = collapseEmptyChats(chats, "r");
    expect(r.chats.map((c) => c.id)).toEqual(["a", "r"]);
    expect(r.activeId).toBe("r");
  });

  it("system-ping-only chats count as empty and collapse", () => {
    const chats = [chat("a", ["system"]), chat("b", ["warning"])];
    const r = collapseEmptyChats(chats, "a");
    expect(r.chats.map((c) => c.id)).toEqual(["a"]);
    expect(r.activeId).toBe("a");
  });
});
