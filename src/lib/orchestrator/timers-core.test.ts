import { describe, expect, it } from "vitest";
import {
  describeRemaining,
  MAX_DELAY_MS,
  MAX_NOTE_CHARS,
  resolveFireAt,
  sanitizeTimer,
  sanitizeTimers,
  splitDue,
  timerWireText,
} from "./timers-core";

const NOW = 1_800_000_000_000;

describe("resolveFireAt", () => {
  it("requires exactly one of delay/at", () => {
    expect(resolveFireAt(NOW, undefined, undefined)).toHaveProperty("error");
    expect(resolveFireAt(NOW, 60, "2026-07-10T18:00:00Z")).toHaveProperty(
      "error",
    );
  });

  it("resolves a relative delay", () => {
    expect(resolveFireAt(NOW, 90, undefined)).toEqual({ at: NOW + 90_000 });
    expect(resolveFireAt(NOW, 0, undefined)).toHaveProperty("error");
    expect(resolveFireAt(NOW, -5, undefined)).toHaveProperty("error");
    expect(resolveFireAt(NOW, "60" as unknown, undefined)).toHaveProperty(
      "error",
    );
    expect(
      resolveFireAt(NOW, MAX_DELAY_MS / 1000 + 10, undefined),
    ).toHaveProperty("error");
  });

  it("resolves an absolute ISO time with a past grace window", () => {
    const at = new Date(NOW + 3_600_000).toISOString();
    expect(resolveFireAt(NOW, undefined, at)).toEqual({ at: NOW + 3_600_000 });
    // slightly past → clamped to now (fires immediately)
    const slightlyPast = new Date(NOW - 30_000).toISOString();
    expect(resolveFireAt(NOW, undefined, slightlyPast)).toEqual({ at: NOW });
    // clearly past / garbage / too far → error
    const past = new Date(NOW - 3_600_000).toISOString();
    expect(resolveFireAt(NOW, undefined, past)).toHaveProperty("error");
    expect(resolveFireAt(NOW, undefined, "not a time")).toHaveProperty("error");
    const far = new Date(NOW + MAX_DELAY_MS + 86_400_000).toISOString();
    expect(resolveFireAt(NOW, undefined, far)).toHaveProperty("error");
  });
});

describe("sanitize", () => {
  const valid = {
    id: "tm-1",
    projectId: "p1",
    note: "check Maya",
    at: NOW,
    createdAt: NOW - 1000,
  };

  it("passes valid timers and drops broken ones", () => {
    expect(sanitizeTimer(valid)).toEqual(valid);
    expect(sanitizeTimer(null)).toBeNull();
    expect(sanitizeTimer({ ...valid, id: "" })).toBeNull();
    expect(sanitizeTimer({ ...valid, projectId: undefined })).toBeNull();
    expect(sanitizeTimer({ ...valid, note: "   " })).toBeNull();
    expect(sanitizeTimer({ ...valid, at: "soon" })).toBeNull();
    // missing createdAt falls back to `at`
    const { createdAt: _c, ...noCreated } = valid;
    expect(sanitizeTimer(noCreated)?.createdAt).toBe(NOW);
    // over-long notes are capped
    const long = sanitizeTimer({ ...valid, note: "x".repeat(2000) });
    expect(long?.note.length).toBe(MAX_NOTE_CHARS);
  });

  it("keeps the durable firedAt claim (at-most-once across restarts)", () => {
    // a valid claim survives — hydrate uses it to DROP the timer instead of
    // double-delivering after a crash between dispatch and removal
    expect(sanitizeTimer({ ...valid, firedAt: NOW - 5 })?.firedAt).toBe(
      NOW - 5,
    );
    // junk claims are stripped, never invented
    expect(sanitizeTimer({ ...valid, firedAt: "yes" })?.firedAt).toBeUndefined();
    expect(sanitizeTimer(valid)?.firedAt).toBeUndefined();
  });

  it("dedupes by id and tolerates garbage lists", () => {
    expect(sanitizeTimers(undefined)).toEqual([]);
    expect(sanitizeTimers([valid, valid, null, 42])).toHaveLength(1);
  });
});

describe("splitDue", () => {
  it("splits and orders due timers oldest first", () => {
    const t = (id: string, at: number) => ({
      id,
      projectId: "p",
      note: "n",
      at,
      createdAt: 0,
    });
    const { due, future } = splitDue(
      [t("a", NOW - 10), t("b", NOW + 10), t("c", NOW - 99)],
      NOW,
    );
    expect(due.map((x) => x.id)).toEqual(["c", "a"]);
    expect(future.map((x) => x.id)).toEqual(["b"]);
  });
});

describe("rendering", () => {
  it("describes remaining time compactly", () => {
    expect(describeRemaining(NOW - 1, NOW)).toBe("overdue");
    expect(describeRemaining(NOW + 20_000, NOW)).toBe("in 20s");
    expect(describeRemaining(NOW + 5 * 60_000, NOW)).toBe("in 5m");
    expect(describeRemaining(NOW + 125 * 60_000, NOW)).toBe("in 2h 5m");
    expect(describeRemaining(NOW + 120 * 60_000, NOW)).toBe("in 2h");
  });

  it("wire text marks missed timers and carries the note", () => {
    expect(timerWireText("check Maya", false)).toContain("[timer fired]");
    expect(timerWireText("check Maya", false)).toContain("check Maya");
    expect(timerWireText("x", true)).toContain("missed while the app was closed");
    expect(timerWireText("x", true)).toContain("autonomous follow-up turn");
  });
});
