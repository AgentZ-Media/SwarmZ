import { beforeEach, describe, expect, it } from "vitest";
import { useOrchestrator } from "./chat-store";

beforeEach(() => {
  useOrchestrator.setState({
    chats: [],
    activeByProject: {},
    busy: {},
    tokenUsage: {},
    status: null,
  });
});

describe("Orchestrator delivery rollback state", () => {
  it("removes a user bubble when its turn definitively never starts", () => {
    const id = useOrchestrator.getState().newChat("project-1");
    const messageId = useOrchestrator
      .getState()
      .appendMessage(id, { role: "user", text: "ship it" });

    useOrchestrator.getState().removeMessage(id, messageId);

    expect(
      useOrchestrator
        .getState()
        .chats.find((chat) => chat.id === id)?.messages,
    ).toEqual([]);
  });

  it("restores status pings consumed by a pre-start failure", () => {
    const id = useOrchestrator.getState().newChat("project-1");
    useOrchestrator.getState().addPendingPing(id, {
      paneId: "lane-1",
      paneName: "Lane 01",
      activity: "idle",
      at: 42,
    });
    const claimed = useOrchestrator.getState().takePendingPings(id);
    expect(claimed).toHaveLength(1);
    expect(
      useOrchestrator
        .getState()
        .chats.find((chat) => chat.id === id)?.pendingPings[0].delivered,
    ).toBe(true);

    useOrchestrator.getState().restorePendingPings(id, claimed);
    expect(
      useOrchestrator
        .getState()
        .chats.find((chat) => chat.id === id)?.pendingPings[0].delivered,
    ).toBe(false);
  });
});
