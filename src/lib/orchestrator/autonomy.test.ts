import { beforeEach, describe, expect, it } from "vitest";
import {
  AUTONOMY_WINDOW_MS,
  MAX_AUTONOMOUS_TURNS_PER_WINDOW,
  MAX_CONSECUTIVE_AUTONOMOUS_TURNS,
  autonomyTripped,
  checkAutonomyBudget,
  noteAutonomousTurn,
  noteHumanTurn,
  resetAutonomyBudgets,
} from "./autonomy";

const T0 = 1_700_000_000_000;

beforeEach(() => resetAutonomyBudgets());

describe("autonomy budget", () => {
  it("allows turns under both caps", () => {
    for (let i = 0; i < MAX_CONSECUTIVE_AUTONOMOUS_TURNS - 1; i++) {
      expect(checkAutonomyBudget("p", T0 + i).ok).toBe(true);
      noteAutonomousTurn("p", T0 + i);
    }
    expect(checkAutonomyBudget("p", T0 + 100).ok).toBe(true);
    expect(autonomyTripped("p")).toBe(false);
  });

  it("trips on the consecutive cap and latches until a human turn", () => {
    for (let i = 0; i < MAX_CONSECUTIVE_AUTONOMOUS_TURNS; i++) {
      noteAutonomousTurn("p", T0 + i);
    }
    const v = checkAutonomyBudget("p", T0 + 100);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.freshTrip).toBe(true);
      expect(v.reason).toContain("since your last message");
    }
    // latched: the follow-up refusal is NOT a fresh trip (announce once)
    const again = checkAutonomyBudget("p", T0 + 200);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.freshTrip).toBe(false);
    expect(autonomyTripped("p")).toBe(true);
    // time alone never resets the consecutive latch — a human must act
    const muchLater = checkAutonomyBudget("p", T0 + AUTONOMY_WINDOW_MS * 2);
    expect(muchLater.ok).toBe(false);
    // the human message re-arms
    noteHumanTurn("p");
    expect(autonomyTripped("p")).toBe(false);
    expect(checkAutonomyBudget("p", T0 + AUTONOMY_WINDOW_MS * 2).ok).toBe(true);
  });

  it("trips on the hourly rate cap even with interleaved human turns", () => {
    // human resets keep consecutive low, but the volume cap still counts
    for (let i = 0; i < MAX_AUTONOMOUS_TURNS_PER_WINDOW; i++) {
      noteAutonomousTurn("p", T0 + i * 1000);
      noteHumanTurn("p");
    }
    const v = checkAutonomyBudget("p", T0 + 60_000);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.freshTrip).toBe(true);
      expect(v.reason).toContain("within the last hour");
    }
    // a human turn re-arms the breaker, but the window history stays —
    // the very next check trips again until the window rolls
    noteHumanTurn("p");
    const still = checkAutonomyBudget("p", T0 + 61_000);
    expect(still.ok).toBe(false);
    // once the window rolled past the burst, turns are allowed again
    noteHumanTurn("p");
    expect(
      checkAutonomyBudget("p", T0 + AUTONOMY_WINDOW_MS + 120_000).ok,
    ).toBe(true);
  });

  it("scopes budgets per project", () => {
    for (let i = 0; i < MAX_CONSECUTIVE_AUTONOMOUS_TURNS; i++) {
      noteAutonomousTurn("a", T0 + i);
    }
    expect(checkAutonomyBudget("a", T0 + 10).ok).toBe(false);
    expect(checkAutonomyBudget("b", T0 + 10).ok).toBe(true);
  });

  it("human turns on unknown projects are a no-op", () => {
    noteHumanTurn("never-seen");
    expect(autonomyTripped("never-seen")).toBe(false);
  });
});
