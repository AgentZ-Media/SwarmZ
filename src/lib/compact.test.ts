import { describe, it, expect } from "vitest";
import {
  AUTO_COMPACT_COOLDOWN_MS,
  AUTO_COMPACT_PCT,
  contextFraction,
  shouldAutoCompact,
} from "./compact";

const window = 100_000;

describe("contextFraction", () => {
  it("uses the codex totalTokens field, not the summed bucket", () => {
    // totalTokens is the footprint; summing every field would double-count
    const usage = {
      last: {
        totalTokens: 50_000,
        inputTokens: 49_000,
        cachedInputTokens: 10_000,
        outputTokens: 1_000,
      },
      modelContextWindow: window,
    };
    expect(contextFraction(usage)).toBeCloseTo(0.5, 5);
  });

  it("returns null on unknown window or footprint", () => {
    expect(contextFraction(null)).toBeNull();
    expect(contextFraction({ last: null, modelContextWindow: window })).toBeNull();
    expect(
      contextFraction({ last: { totalTokens: 10 }, modelContextWindow: 0 }),
    ).toBeNull();
  });

  it("clamps to 1", () => {
    expect(
      contextFraction({
        last: { totalTokens: window * 2 },
        modelContextWindow: window,
      }),
    ).toBe(1);
  });
});

describe("shouldAutoCompact", () => {
  const base = {
    usage: { last: { totalTokens: AUTO_COMPACT_PCT * window + 1 }, modelContextWindow: window },
    enabled: true,
    busy: false,
    lastCompactAt: null,
    now: 1_000_000,
  };

  it("fires at/above the threshold when idle and enabled", () => {
    expect(shouldAutoCompact(base)).toBe(true);
  });

  it("never fires below the threshold", () => {
    expect(
      shouldAutoCompact({
        ...base,
        usage: { last: { totalTokens: 0.5 * window }, modelContextWindow: window },
      }),
    ).toBe(false);
  });

  it("never fires while busy, disabled, or on unknown usage", () => {
    expect(shouldAutoCompact({ ...base, busy: true })).toBe(false);
    expect(shouldAutoCompact({ ...base, enabled: false })).toBe(false);
    expect(shouldAutoCompact({ ...base, usage: null })).toBe(false);
  });

  it("respects the cooldown since the last compaction", () => {
    expect(
      shouldAutoCompact({ ...base, lastCompactAt: base.now - 1_000 }),
    ).toBe(false);
    expect(
      shouldAutoCompact({
        ...base,
        lastCompactAt: base.now - AUTO_COMPACT_COOLDOWN_MS - 1,
      }),
    ).toBe(true);
  });
});
