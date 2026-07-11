import { describe, expect, it } from "vitest";
import type { VibeItem } from "@/types";
import { reportForItem, reportItemIdOf } from "./report-item";

const REPORT_JSON = JSON.stringify({
  done: true,
  summary: "Implemented the fix and ran the checks.",
  files_changed: ["src/a.ts", "src/b.ts"],
  tests_pass: true,
  needs_human: false,
  question: null,
  followups: ["consider a follow-up refactor"],
});

function assistant(
  id: string,
  text: string,
  extra?: Partial<Extract<VibeItem, { kind: "assistant" }>>,
): VibeItem {
  return { id, at: 1, kind: "assistant", text, ...extra };
}

function user(id: string, text: string): VibeItem {
  return { id, at: 1, kind: "user", text };
}

function byId(items: VibeItem[]): Record<string, VibeItem> {
  return Object.fromEntries(items.map((i) => [i.id, i]));
}

describe("reportItemIdOf", () => {
  it("finds the last assistant message when it parses as a report", () => {
    const items = [
      user("u1", "do the thing"),
      assistant("a1", "Starting now."),
      assistant("a2", REPORT_JSON),
    ];
    expect(reportItemIdOf(items.map((i) => i.id), byId(items))).toBe("a2");
  });

  it("skips trailing non-assistant items (command after the report)", () => {
    const items = [
      assistant("a1", REPORT_JSON),
      {
        id: "c1",
        at: 1,
        kind: "command",
        command: "ls",
        status: "completed",
        output: "",
      } as VibeItem,
    ];
    expect(reportItemIdOf(items.map((i) => i.id), byId(items))).toBe("a1");
  });

  it("returns null when the last assistant message is not report JSON — even if an earlier one is", () => {
    const items = [
      assistant("a1", REPORT_JSON),
      assistant("a2", "All done, see above."),
    ];
    expect(reportItemIdOf(items.map((i) => i.id), byId(items))).toBeNull();
  });

  it("returns null for JSON missing a required core field", () => {
    const items = [assistant("a1", '{"summary":"x","needs_human":false}')];
    expect(reportItemIdOf(items.map((i) => i.id), byId(items))).toBeNull();
  });

  it("returns null on an empty / assistant-less transcript", () => {
    expect(reportItemIdOf([], {})).toBeNull();
    const items = [user("u1", "hello")];
    expect(reportItemIdOf(items.map((i) => i.id), byId(items))).toBeNull();
  });

  it("accepts a fenced ```json report (parser strips the fence)", () => {
    const items = [assistant("a1", "```json\n" + REPORT_JSON + "\n```")];
    expect(reportItemIdOf(items.map((i) => i.id), byId(items))).toBe("a1");
  });
});

describe("reportForItem", () => {
  it("parses a stamped report item", () => {
    const r = reportForItem(assistant("a1", REPORT_JSON, { report: true }));
    expect(r).not.toBeNull();
    expect(r?.done).toBe(true);
    expect(r?.testsPass).toBe(true);
    expect(r?.filesChanged).toEqual(["src/a.ts", "src/b.ts"]);
    expect(r?.followups).toEqual(["consider a follow-up refactor"]);
  });

  it("never classifies UNSTAMPED report-shaped JSON as a report (no false alarms)", () => {
    expect(reportForItem(assistant("a1", REPORT_JSON))).toBeNull();
  });

  it("returns null while the stamped item is still streaming", () => {
    expect(
      reportForItem(assistant("a1", REPORT_JSON, { report: true, streaming: true })),
    ).toBeNull();
  });

  it("returns null when a stamped item's text no longer parses", () => {
    expect(reportForItem(assistant("a1", "not json", { report: true }))).toBeNull();
  });

  it("returns null for non-assistant items", () => {
    expect(reportForItem(user("u1", REPORT_JSON))).toBeNull();
  });

  it("surfaces needs_human question payloads", () => {
    const q = JSON.stringify({
      done: false,
      summary: "Blocked on a decision.",
      files_changed: [],
      tests_pass: null,
      needs_human: true,
      question: "Keep the legacy endpoint?",
      followups: [],
    });
    const r = reportForItem(assistant("a1", q, { report: true }));
    expect(r?.needsHuman).toBe(true);
    expect(r?.question).toBe("Keep the legacy endpoint?");
    expect(r?.testsPass).toBeNull();
  });
});
