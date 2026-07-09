import { describe, expect, it } from "vitest";
import { slugify } from "./types";
import { builderSessionName, slugTaken, stubAgentDef } from "./builder";

describe("builderSessionName", () => {
  it("labels new builds and refines", () => {
    expect(builderSessionName("Podcast Editor", false)).toBe(
      "Building: Podcast Editor",
    );
    expect(builderSessionName("Podcast Editor", true)).toBe(
      "Refining: Podcast Editor",
    );
  });
  it("falls back on a blank name", () => {
    expect(builderSessionName("   ", false)).toBe("Building: agent");
  });
});

describe("stubAgentDef", () => {
  it("is a valid, discoverable stub with the vibe default", () => {
    const def = stubAgentDef("Podcast Editor", "podcast-editor");
    expect(def.slug).toBe("podcast-editor");
    expect(def.name).toBe("Podcast Editor");
    expect(def.defaultRuntime).toBe("vibe");
    expect(def.emoji).toBeTruthy();
    expect(def.principles).toEqual([]);
    expect(def.defaultModel).toBeUndefined();
  });
  it("carries an optional model and falls back name→slug", () => {
    const def = stubAgentDef("   ", "seo-strategist", "gpt-5.5");
    expect(def.name).toBe("seo-strategist");
    expect(def.defaultModel).toBe("gpt-5.5");
  });
});

describe("slug collision", () => {
  it("detects a taken slug from the existing set", () => {
    const existing = ["podcast-editor", "ferris"];
    expect(slugTaken("podcast-editor", existing)).toBe(true);
    expect(slugTaken("seo-strategist", existing)).toBe(false);
    expect(slugTaken("", existing)).toBe(false);
  });
  it("slugify feeds the collision guard consistently", () => {
    // the name the user types → the slug the folder gets → the collision check
    expect(slugify("Podcast Editor!")).toBe("podcast-editor");
    expect(slugTaken(slugify("Podcast Editor!"), ["podcast-editor"])).toBe(true);
  });
});
