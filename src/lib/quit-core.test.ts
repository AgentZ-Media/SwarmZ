import { describe, it, expect } from "vitest";
import { hasHardBlocker, summarizeBlockers } from "./quit-core";
import type { QuitBlockers } from "@/types";

const empty: QuitBlockers = {
  sessionIds: [],
  conductorProjects: [],
  pendingTimers: 0,
  claimedTimers: 0,
  ghWrites: 0,
  reviews: 0,
  worktreeOps: 0,
};

describe("hasHardBlocker", () => {
  it("is false when nothing runs", () => {
    expect(hasHardBlocker(empty)).toBe(false);
  });

  it("pending timers alone never block (they persist + re-fire)", () => {
    expect(hasHardBlocker({ ...empty, pendingTimers: 3 })).toBe(false);
  });

  it("busy sessions, conductors and gh writes each block", () => {
    expect(hasHardBlocker({ ...empty, sessionIds: ["a"] })).toBe(true);
    expect(hasHardBlocker({ ...empty, conductorProjects: ["api"] })).toBe(true);
    expect(hasHardBlocker({ ...empty, ghWrites: 1 })).toBe(true);
  });

  it("a timer MID-FIRE blocks (quitting would drop the claimed timer)", () => {
    expect(hasHardBlocker({ ...empty, claimedTimers: 1 })).toBe(true);
    // …also when it is simultaneously counted as pending
    expect(
      hasHardBlocker({ ...empty, pendingTimers: 1, claimedTimers: 1 }),
    ).toBe(true);
  });

  it("an UNKNOWN gh-write state blocks (fail closed, never silently pass)", () => {
    expect(hasHardBlocker({ ...empty, ghWrites: -1 })).toBe(true);
  });

  it("detached reviews and worktree git ops each block", () => {
    expect(hasHardBlocker({ ...empty, reviews: 1 })).toBe(true);
    expect(hasHardBlocker({ ...empty, worktreeOps: 2 })).toBe(true);
  });
});

describe("summarizeBlockers", () => {
  it("pluralizes and joins", () => {
    expect(
      summarizeBlockers({ ...empty, sessionIds: ["a", "b"], conductorProjects: ["api"] }),
    ).toBe("2 sessions, a Conductor still running — quitting will interrupt them.");
    expect(summarizeBlockers({ ...empty, sessionIds: ["a"] })).toBe(
      "1 session still running — quitting will interrupt it.",
    );
    expect(summarizeBlockers({ ...empty, ghWrites: 2 })).toBe(
      "2 GitHub writes still running — quitting will interrupt them.",
    );
  });

  it("names firing timers, reviews, worktree ops and the unknown gh state", () => {
    expect(summarizeBlockers({ ...empty, claimedTimers: 1 })).toBe(
      "a firing timer still running — quitting will interrupt it.",
    );
    expect(summarizeBlockers({ ...empty, reviews: 2 })).toBe(
      "2 code reviews still running — quitting will interrupt them.",
    );
    expect(summarizeBlockers({ ...empty, worktreeOps: 1 })).toBe(
      "a worktree operation still running — quitting will interrupt it.",
    );
    expect(summarizeBlockers({ ...empty, ghWrites: -1 })).toBe(
      "possibly a GitHub write still running — quitting will interrupt it.",
    );
  });

  it("has a fallback when nothing is itemized", () => {
    expect(summarizeBlockers(empty)).toBe(
      "Work is still running — quitting will interrupt it.",
    );
  });
});
