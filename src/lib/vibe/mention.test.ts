import { describe, expect, it } from "vitest";
import { parseSessionMention, mentionQuery } from "./mention";

const sessions = [
  { id: "abc123", name: "api" },
  { id: "xyz789", name: "Vibe session" },
  { id: "def456", name: "api-v2" },
];

describe("parseSessionMention", () => {
  it("returns null when there is no @", () => {
    expect(parseSessionMention("hello world", sessions)).toBeNull();
  });

  it("routes @name with a body", () => {
    expect(parseSessionMention("@api do the thing", sessions)).toEqual({
      sessionId: "abc123",
      body: "do the thing",
      matched: "api",
    });
  });

  it("routes @id with a body", () => {
    expect(parseSessionMention("@abc123 fix it", sessions)).toEqual({
      sessionId: "abc123",
      body: "fix it",
      matched: "abc123",
    });
  });

  it("matches a spaced name fully", () => {
    expect(parseSessionMention("@Vibe session run tests", sessions)).toEqual({
      sessionId: "xyz789",
      body: "run tests",
      matched: "Vibe session",
    });
  });

  it("prefers the longest key (api-v2 over api)", () => {
    expect(parseSessionMention("@api-v2 ship", sessions)).toEqual({
      sessionId: "def456",
      body: "ship",
      matched: "api-v2",
    });
  });

  it("returns an empty body for a bare @name", () => {
    expect(parseSessionMention("@api", sessions)).toEqual({
      sessionId: "abc123",
      body: "",
      matched: "api",
    });
  });

  it("returns null for an unknown mention", () => {
    expect(parseSessionMention("@nope go", sessions)).toBeNull();
  });

  it("matches case-insensitively", () => {
    expect(parseSessionMention("@API hey", sessions)?.sessionId).toBe("abc123");
  });
});

describe("mentionQuery", () => {
  it("returns the partial token", () => {
    expect(mentionQuery("@ap")).toBe("ap");
  });

  it("stops suggesting after a space", () => {
    expect(mentionQuery("@api go")).toBeNull();
  });

  it("returns null without a leading @", () => {
    expect(mentionQuery("hello")).toBeNull();
  });

  it("returns an empty string for a bare @", () => {
    expect(mentionQuery("@")).toBe("");
  });
});
