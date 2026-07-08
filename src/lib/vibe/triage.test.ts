import { describe, expect, it } from "vitest";
import { vibeTriageEntries } from "./triage";
import type { VibeSessionEntry, VibeState } from "./session-store";

/** A minimal session entry with a single pending approval item. */
function entryWithApproval(
  id: string,
  opts: { builderForSlug?: string } = {},
): VibeSessionEntry {
  return {
    session: {
      id,
      name: `session ${id}`,
      projectDir: `/tmp/${id}`,
      access: "workspace",
      threadId: null,
      createdAt: 0,
      ...(opts.builderForSlug ? { builderForSlug: opts.builderForSlug } : {}),
    },
    items: {
      a1: {
        id: "a1",
        at: 100,
        kind: "approval",
        approvalKind: "command",
        status: "pending",
        payload: {},
      },
    },
    order: ["a1"],
    turnId: null,
    diff: null,
    plan: null,
    tokenUsage: null,
    lastBusyEndAt: null,
  };
}

function stateOf(entries: VibeSessionEntry[]): VibeState {
  const sessions: Record<string, VibeSessionEntry> = {};
  for (const e of entries) sessions[e.session.id] = e;
  return {
    order: entries.map((e) => e.session.id),
    sessions,
  } as unknown as VibeState;
}

describe("vibeTriageEntries", () => {
  it("lists a plain session waiting on approval", () => {
    const rows = vibeTriageEntries(stateOf([entryWithApproval("s1")]));
    expect(rows.map((r) => r.id)).toEqual(["s1"]);
    expect(rows[0].since).toBe(100);
  });

  it("excludes Builder sessions — they live only in their modal", () => {
    const rows = vibeTriageEntries(
      stateOf([
        entryWithApproval("plain"),
        entryWithApproval("builder", { builderForSlug: "podcast-editor" }),
      ]),
    );
    expect(rows.map((r) => r.id)).toEqual(["plain"]);
  });
});
