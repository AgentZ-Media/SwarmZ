import { describe, expect, it } from "vitest";
import { tokenCountFromBucket } from "./controller-shared";

describe("Mission token accounting", () => {
  it("reads the real camelCase Codex cumulative usage without double-counting cache", () => {
    expect(tokenCountFromBucket({
      totalTokens: 15_043,
      inputTokens: 14_992,
      cachedInputTokens: 4_992,
      outputTokens: 51,
      reasoningOutputTokens: 0,
    })).toBe(15_043);
  });

  it("falls back across camelCase and legacy snake_case buckets", () => {
    expect(tokenCountFromBucket({ inputTokens: 100, cachedInputTokens: 80, outputTokens: 25 }))
      .toBe(125);
    expect(tokenCountFromBucket({ input_tokens: 40, cached_input_tokens: 30, output_tokens: 2 }))
      .toBe(42);
  });
});
