import { describe, expect, it } from "vitest";
import { resolveSpawnEffort } from "./agent-effort";

describe("Orchestrator worker effort policy", () => {
  it("defaults ordinary workers to high", () => {
    expect(resolveSpawnEffort(undefined, false)).toBe("high");
    expect(resolveSpawnEffort("", false)).toBe("high");
  });

  it("caps above-high effort unless the lane is explicitly critical", () => {
    expect(resolveSpawnEffort("xhigh", false)).toBe("high");
    expect(resolveSpawnEffort("max", false)).toBe("high");
    expect(resolveSpawnEffort("xhigh", true)).toBe("xhigh");
    expect(resolveSpawnEffort("max", true)).toBe("max");
  });

  it("preserves deliberate lower efforts", () => {
    expect(resolveSpawnEffort("medium", false)).toBe("medium");
    expect(resolveSpawnEffort("low", false)).toBe("low");
  });
});
