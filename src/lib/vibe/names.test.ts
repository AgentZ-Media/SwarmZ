import { describe, expect, it } from "vitest";
import {
  AGENT_NAME_POOL,
  asciiSlug,
  branchSlugForAgent,
  pickAgentName,
} from "./names";

/** Deterministic rng from a fixed sequence (repeats the last value). */
function seqRng(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

describe("AGENT_NAME_POOL", () => {
  it("has 120+ unique names", () => {
    expect(AGENT_NAME_POOL.length).toBeGreaterThanOrEqual(120);
    const lower = AGENT_NAME_POOL.map((n) => n.toLowerCase());
    expect(new Set(lower).size).toBe(AGENT_NAME_POOL.length);
  });

  it("every name slugs to a non-empty ASCII branch fragment", () => {
    for (const name of AGENT_NAME_POOL) {
      const slug = asciiSlug(name);
      expect(slug, name).toMatch(/^[a-z0-9-]+$/);
      expect(slug.length, name).toBeGreaterThan(0);
    }
  });
});

describe("pickAgentName", () => {
  it("is deterministic under an injected rng", () => {
    expect(pickAgentName([], seqRng([0]))).toBe(AGENT_NAME_POOL[0]);
    expect(pickAgentName([], seqRng([0.999999]))).toBe(
      AGENT_NAME_POOL[AGENT_NAME_POOL.length - 1],
    );
    // same rng, same taken set → same result
    const taken = ["Maya", "Kenji"];
    expect(pickAgentName(taken, seqRng([0.42]))).toBe(
      pickAgentName(taken, seqRng([0.42])),
    );
  });

  it("never returns a taken name (case-insensitive, trimmed)", () => {
    const taken = AGENT_NAME_POOL.slice(0, 50).map((n) =>
      ` ${n.toUpperCase()} `,
    );
    for (let i = 0; i < 200; i++) {
      const name = pickAgentName(taken);
      expect(taken.map((t) => t.trim().toLowerCase())).not.toContain(
        name.toLowerCase(),
      );
    }
  });

  it("stays collision-free until the whole pool is used", () => {
    const taken: string[] = [];
    for (let i = 0; i < AGENT_NAME_POOL.length; i++) {
      const name = pickAgentName(taken);
      expect(taken).not.toContain(name);
      taken.push(name);
    }
    expect(new Set(taken).size).toBe(AGENT_NAME_POOL.length);
  });

  it("suffixes with the lowest free number once the pool is exhausted", () => {
    const taken = [...AGENT_NAME_POOL];
    const first = pickAgentName(taken, seqRng([0]));
    expect(first).toBe(`${AGENT_NAME_POOL[0]} 2`);
    taken.push(first);
    expect(pickAgentName(taken, seqRng([0]))).toBe(`${AGENT_NAME_POOL[0]} 3`);
  });
});

describe("asciiSlug", () => {
  it("normalizes diacritics", () => {
    expect(asciiSlug("Zoë")).toBe("zoe");
    expect(asciiSlug("Björn")).toBe("bjorn");
    expect(asciiSlug("Nicolás")).toBe("nicolas");
    expect(asciiSlug("Sofía")).toBe("sofia");
  });

  it("collapses non-alphanumerics into single hyphens and trims", () => {
    expect(asciiSlug("fix the  checkout / flow!")).toBe("fix-the-checkout-flow");
    expect(asciiSlug("--already--sluggy--")).toBe("already-sluggy");
    expect(asciiSlug("日本語")).toBe("");
  });
});

describe("branchSlugForAgent", () => {
  it("builds swarm/<name> without a task", () => {
    expect(branchSlugForAgent("Maya")).toBe("swarm/maya");
    expect(branchSlugForAgent("Zoë")).toBe("swarm/zoe");
    expect(branchSlugForAgent("Maya 2")).toBe("swarm/maya-2");
  });

  it("appends the slugged task", () => {
    expect(branchSlugForAgent("Maya", "checkout")).toBe("swarm/maya-checkout");
    expect(branchSlugForAgent("Kenji", "Fix the Login-Flow")).toBe(
      "swarm/kenji-fix-the-login-flow",
    );
  });

  it("caps long tasks at a word boundary", () => {
    const branch = branchSlugForAgent(
      "Maya",
      "refactor the whole authentication and session handling subsystem",
    );
    expect(branch.startsWith("swarm/maya-")).toBe(true);
    expect(branch.length).toBeLessThanOrEqual("swarm/maya-".length + 24);
    expect(branch.endsWith("-")).toBe(false);
  });

  it("falls back to 'agent' for unsluggable names and drops empty tasks", () => {
    expect(branchSlugForAgent("日本語")).toBe("swarm/agent");
    expect(branchSlugForAgent("Maya", "!!!")).toBe("swarm/maya");
  });
});
