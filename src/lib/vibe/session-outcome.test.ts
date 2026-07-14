import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVibe, type VibeTurnOutcome } from "./session-store";
import { vibeSignal } from "./ui";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  useVibe.setState({
    sessions: {},
    order: [],
    activeId: null,
    activeIdByProject: {},
    busy: {},
  });
  useVibe.getState().createSession({
    id: "s",
    name: "Agent",
    projectId: "p",
    projectDir: "/repo",
    access: "workspace",
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function endWith(outcome: VibeTurnOutcome) {
  const store = useVibe.getState();
  store.setBusy("s", true);
  useVibe.getState().setTurnOutcome("s", outcome);
  useVibe.getState().setBusy("s", false);
  return useVibe.getState().sessions.s;
}

describe("session outcome signal invariant", () => {
  it("shows a completed turn as recently finished", () => {
    const entry = endWith("completed");
    expect(entry.lastBusyEndAt).toBe(Date.now());
    expect(vibeSignal(entry, false, Date.now())).toBe("finished");
  });

  it.each(["failed", "interrupted", "exited", "compacted"] as const)(
    "keeps %s neutral instead of green finished",
    (outcome) => {
      const entry = endWith(outcome);
      expect(entry.lastBusyEndAt).toBeNull();
      expect(entry.lastTurnOutcome).toBe(outcome);
      expect(vibeSignal(entry, false, Date.now())).toBe("idle");
    },
  );

  it("revokes a stale completed signal when a late exit arrives", () => {
    endWith("completed");
    useVibe.getState().setTurnOutcome("s", "exited");
    const entry = useVibe.getState().sessions.s;
    expect(entry.lastBusyEndAt).toBeNull();
    expect(vibeSignal(entry, false, Date.now())).toBe("idle");
  });
});
