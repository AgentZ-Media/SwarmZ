import { describe, expect, it } from "vitest";
import type { VibeSessionEntry } from "@/lib/vibe/session-store";
import { resolveSessionReference } from "./executor-agents";

function entry(
  id: string,
  name: string,
  agentName = name,
): VibeSessionEntry {
  return {
    session: {
      id,
      name,
      agentName,
      projectId: "project",
      spawnedBy: "conductor",
      worktree: null,
      projectDir: "/repo",
      access: "workspace",
      threadId: null,
      createdAt: 0,
    },
    items: {},
    order: [],
    turnId: null,
    diff: null,
    plan: null,
    tokenUsage: null,
    lastBusyEndAt: null,
    lastTurnOutcome: null,
  };
}

describe("executor agent resolution characterization", () => {
  const sessions = [
    entry("session-1", "Lane 01", "alpha"),
    entry("session-2", "Lane 02", "beta"),
  ];

  it("resolves an exact raw id before display names", () => {
    expect(resolveSessionReference(sessions, "session-2", true).session.id).toBe(
      "session-2",
    );
  });

  it("resolves optional @ prefixes, display names and operational labels case-insensitively", () => {
    expect(resolveSessionReference(sessions, "@ALPHA", true).session.id).toBe(
      "session-1",
    );
    expect(resolveSessionReference(sessions, "lane 02", true).session.id).toBe(
      "session-2",
    );
  });

  it("fails closed when a display/agent label is ambiguous", () => {
    const ambiguous = [entry("a", "Shared", "first"), entry("b", "Other", "shared")];
    expect(() => resolveSessionReference(ambiguous, "@shared", true)).toThrow(
      'ambiguous agent name "@shared" — matches: a ("Shared"), b ("Other"); use the id',
    );
  });

  it("lists only the already-scoped valid sessions in unknown-agent errors", () => {
    expect(() => resolveSessionReference(sessions, "missing", true)).toThrow(
      'unknown agent "missing" — valid agents in this project: session-1 ("Lane 01"), session-2 ("Lane 02")',
    );
    expect(() => resolveSessionReference([], undefined, false)).toThrow(
      'unknown agent "undefined" — valid agents: (no agents)',
    );
  });
});
