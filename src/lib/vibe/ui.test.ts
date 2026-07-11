import { describe, expect, it } from "vitest";
import {
  decayedSignal,
  shortAge,
  totalTokens,
  VIBE_FINISHED_WINDOW_MS,
  vibeSignal,
} from "./ui";
import type { VibeSessionEntry } from "./session-store";
import type { VibeItem } from "@/types";

// The signal-triad decay rule shared by the fleet grid, the Deck counters and
// the stage header — the 30 s render tick feeds `now` in, so the pure decay
// boundary is what the tick-awareness fix relies on.

const T0 = 1_700_000_000_000;

describe("decayedSignal", () => {
  it("needs-you wins over busy", () => {
    expect(decayedSignal(true, true, null, T0)).toBe("needsYou");
  });

  it("busy is working", () => {
    expect(decayedSignal(true, false, null, T0)).toBe("working");
  });

  it("shows 'finished' inside the decay window", () => {
    expect(decayedSignal(false, false, T0, T0 + 1)).toBe("finished");
    expect(
      decayedSignal(false, false, T0, T0 + VIBE_FINISHED_WINDOW_MS - 1),
    ).toBe("finished");
  });

  it("decays to 'idle' exactly at the window boundary (the tick's job)", () => {
    expect(decayedSignal(false, false, T0, T0 + VIBE_FINISHED_WINDOW_MS)).toBe(
      "idle",
    );
    expect(
      decayedSignal(false, false, T0, T0 + VIBE_FINISHED_WINDOW_MS + 60_000),
    ).toBe("idle");
  });

  it("never was busy = idle", () => {
    expect(decayedSignal(false, false, null, T0)).toBe("idle");
  });
});

describe("vibeSignal delegates to the same decay rule", () => {
  const entry = (over: Partial<VibeSessionEntry>): VibeSessionEntry =>
    ({
      session: {} as VibeSessionEntry["session"],
      items: {},
      order: [],
      turnId: null,
      diff: null,
      plan: null,
      tokenUsage: null,
      lastBusyEndAt: null,
      ...over,
    }) as VibeSessionEntry;

  it("pending approval → needsYou even while busy", () => {
    const approval: VibeItem = {
      id: "a1",
      at: T0,
      kind: "approval",
      approvalKind: "command",
      status: "pending",
      payload: {},
    };
    const e = entry({ items: { a1: approval }, order: ["a1"] });
    expect(vibeSignal(e, true, T0)).toBe("needsYou");
  });

  it("finished decays to idle with time", () => {
    const e = entry({ lastBusyEndAt: T0 });
    expect(vibeSignal(e, false, T0 + 1_000)).toBe("finished");
    expect(vibeSignal(e, false, T0 + VIBE_FINISHED_WINDOW_MS)).toBe("idle");
  });
});

describe("shortAge / totalTokens (sanity)", () => {
  it("formats ages compactly", () => {
    expect(shortAge(10_000)).toBe("now");
    expect(shortAge(3 * 60_000)).toBe("3m");
    expect(shortAge(2 * 60 * 60_000)).toBe("2h");
  });

  it("sums numeric buckets only", () => {
    expect(totalTokens({ inputTokens: 2, outputTokens: 3 })).toBe(5);
    expect(totalTokens(null)).toBe(0);
  });
});
