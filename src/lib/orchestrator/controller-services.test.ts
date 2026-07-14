import { describe, expect, it } from "vitest";
import { AutonomousDispatchState } from "./autonomous-dispatcher";
import { ChatDeliveryState } from "./chat-delivery";
import { FleetSessionWatcherState } from "./session-watcher";

describe("Conductor controller service state", () => {
  it("keeps chat/backend bindings bijective and releases all chat claims", () => {
    const state = new ChatDeliveryState();

    state.link("chat-1", "backend-1");
    state.link("chat-1", "backend-2");

    expect(state.chatForBackend("backend-1")).toBeNull();
    expect(state.chatForBackend("backend-2")).toBe("chat-1");
    expect(state.backendForChat("chat-1")).toBe("backend-2");
    expect(state.claimHuman("chat-1")).toBe(true);
    expect(state.claimHuman("chat-1")).toBe(false);

    state.remove("chat-1");

    expect(state.backendForChat("chat-1")).toBeNull();
    expect(state.chatForBackend("backend-2")).toBeNull();
    expect(state.claimHuman("chat-1")).toBe(true);
  });

  it("tracks autonomous throttles, in-flight scope and retry markers independently", () => {
    const state = new AutonomousDispatchState();

    expect(state.isThrottled("chat-1", 10_000, 5_000)).toBe(false);
    state.noteDispatch("chat-1", 8_000);
    expect(state.isThrottled("chat-1", 10_000, 5_000)).toBe(true);
    expect(state.isThrottled("chat-1", 13_000, 5_000)).toBe(false);

    state.enter("chat-1");
    expect(state.isInFlight("chat-1")).toBe(true);
    state.leave("chat-1");
    expect(state.isInFlight("chat-1")).toBe(false);

    state.rememberMarker("chat-1|finish", "message-1");
    expect(state.marker("chat-1|finish")).toBe("message-1");
    state.clearMarker("chat-1|finish");
    expect(state.marker("chat-1|finish")).toBeNull();
  });

  it("encapsulates watcher generations, transition history and dedupe cleanup", () => {
    const state = new FleetSessionWatcherState();

    expect(state.start()).toBe(true);
    expect(state.start()).toBe(false);
    expect(state.observe("lane-1", false, false)).toEqual({
      busy: undefined,
      pending: undefined,
    });
    expect(state.observe("lane-1", true, false)).toEqual({
      busy: false,
      pending: false,
    });

    const first = state.nextGeneration("lane-1");
    const second = state.nextGeneration("lane-1");
    expect(state.isCurrentGeneration("lane-1", first)).toBe(false);
    expect(state.isCurrentGeneration("lane-1", second)).toBe(true);

    expect(state.claimApproval("approval-1")).toBe(true);
    expect(state.claimApproval("approval-1")).toBe(false);
    state.releaseApproval("approval-1");
    expect(state.claimApproval("approval-1")).toBe(true);

    state.noteIdleNudge("lane-1");
    expect(state.wasIdleNudged("lane-1")).toBe(true);
    state.forget("lane-1");
    expect(state.wasIdleNudged("lane-1")).toBe(false);
    state.stop();
    expect(state.start()).toBe(true);
  });
});
