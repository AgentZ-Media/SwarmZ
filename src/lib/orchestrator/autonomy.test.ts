import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTONOMY_WINDOW_MS,
  MAX_AUTONOMOUS_TURNS_PER_WINDOW,
  MAX_CONSECUTIVE_AUTONOMOUS_TURNS,
  autonomyTripped,
  autonomyUnavailable,
  checkAutonomyBudget,
  configureAutonomyBudget,
  getAutonomyBudgetConfig,
  hydrateAutonomyBudgets,
  latchAutonomyUnavailable,
  noteAutonomousTurn,
  noteHumanTurn,
  normalizeAutonomyBudgetLimit,
  persistAutonomyReservation,
  registerAutonomyPersist,
  releaseAutonomousTurn,
  resetAutonomyBudgets,
  serializeAutonomyBudgets,
  subscribeAutonomy,
} from "./autonomy";

const T0 = 1_700_000_000_000;

beforeEach(() => resetAutonomyBudgets());
afterEach(() => registerAutonomyPersist(null));

describe("autonomy budget", () => {
  it("uses the safe 5/20 defaults and normalizes configured limits", () => {
    expect(getAutonomyBudgetConfig()).toEqual({
      enabled: true,
      maxConsecutive: 5,
      maxPerHour: 20,
    });
    expect(normalizeAutonomyBudgetLimit(0, 5)).toBe(1);
    expect(normalizeAutonomyBudgetLimit(42.9, 5)).toBe(42);
    expect(normalizeAutonomyBudgetLimit(10_000, 5)).toBe(1000);
    expect(normalizeAutonomyBudgetLimit(Number.NaN, 5)).toBe(5);
  });

  it("honors custom consecutive and hourly caps", () => {
    configureAutonomyBudget({ maxConsecutive: 2, maxPerHour: 3 });
    noteAutonomousTurn("p", T0);
    noteAutonomousTurn("p", T0 + 1);
    const consecutive = checkAutonomyBudget("p", T0 + 2);
    expect(consecutive.ok).toBe(false);
    if (!consecutive.ok) expect(consecutive.reason).toContain("cap 2");

    resetAutonomyBudgets();
    configureAutonomyBudget({ maxConsecutive: 10, maxPerHour: 2 });
    noteAutonomousTurn("p", T0);
    noteHumanTurn("p");
    noteAutonomousTurn("p", T0 + 1);
    noteHumanTurn("p");
    const hourly = checkAutonomyBudget("p", T0 + 2);
    expect(hourly.ok).toBe(false);
    if (!hourly.ok) expect(hourly.reason).toContain("cap 2");
  });

  it("can be disabled completely and re-enabled with a clean budget", async () => {
    for (let i = 0; i < MAX_CONSECUTIVE_AUTONOMOUS_TURNS; i++) {
      noteAutonomousTurn("p", T0 + i);
    }
    expect(checkAutonomyBudget("p", T0 + 10).ok).toBe(false);

    configureAutonomyBudget({ enabled: false });
    expect(checkAutonomyBudget("p", T0 + 11).ok).toBe(true);
    expect(autonomyTripped("p")).toBe(false);
    expect(serializeAutonomyBudgets(T0 + 12).projects).toEqual({});
    expect(await persistAutonomyReservation()).toBe(true);
    hydrateAutonomyBudgets("corrupt while explicitly disabled");
    expect(autonomyUnavailable()).toBe(false);

    configureAutonomyBudget({ enabled: true });
    expect(checkAutonomyBudget("p", T0 + 13).ok).toBe(true);
  });

  it("re-evaluates an obsolete trip when the human changes a limit", () => {
    for (let i = 0; i < MAX_CONSECUTIVE_AUTONOMOUS_TURNS; i++) {
      noteAutonomousTurn("p", T0 + i);
    }
    expect(checkAutonomyBudget("p", T0 + 10).ok).toBe(false);
    configureAutonomyBudget({ maxConsecutive: 6, maxPerHour: 20 });
    expect(autonomyTripped("p")).toBe(false);
    expect(checkAutonomyBudget("p", T0 + 11).ok).toBe(true);
  });

  it("allows turns under both caps", () => {
    for (let i = 0; i < MAX_CONSECUTIVE_AUTONOMOUS_TURNS - 1; i++) {
      expect(checkAutonomyBudget("p", T0 + i).ok).toBe(true);
      noteAutonomousTurn("p", T0 + i);
    }
    expect(checkAutonomyBudget("p", T0 + 100).ok).toBe(true);
    expect(autonomyTripped("p")).toBe(false);
  });

  it("trips on the consecutive cap and latches until a human turn", () => {
    for (let i = 0; i < MAX_CONSECUTIVE_AUTONOMOUS_TURNS; i++) {
      noteAutonomousTurn("p", T0 + i);
    }
    const v = checkAutonomyBudget("p", T0 + 100);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.freshTrip).toBe(true);
      expect(v.reason).toContain("since your last message");
    }
    // latched: the follow-up refusal is NOT a fresh trip (announce once)
    const again = checkAutonomyBudget("p", T0 + 200);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.freshTrip).toBe(false);
    expect(autonomyTripped("p")).toBe(true);
    // time alone never resets the consecutive latch — a human must act
    const muchLater = checkAutonomyBudget("p", T0 + AUTONOMY_WINDOW_MS * 2);
    expect(muchLater.ok).toBe(false);
    // the human message re-arms
    noteHumanTurn("p");
    expect(autonomyTripped("p")).toBe(false);
    expect(checkAutonomyBudget("p", T0 + AUTONOMY_WINDOW_MS * 2).ok).toBe(true);
  });

  it("trips on the hourly rate cap even with interleaved human turns", () => {
    // human resets keep consecutive low, but the volume cap still counts
    for (let i = 0; i < MAX_AUTONOMOUS_TURNS_PER_WINDOW; i++) {
      noteAutonomousTurn("p", T0 + i * 1000);
      noteHumanTurn("p");
    }
    const v = checkAutonomyBudget("p", T0 + 60_000);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.freshTrip).toBe(true);
      expect(v.reason).toContain("within the last hour");
    }
    // a human turn re-arms the breaker, but the window history stays —
    // the very next check trips again until the window rolls
    noteHumanTurn("p");
    const still = checkAutonomyBudget("p", T0 + 61_000);
    expect(still.ok).toBe(false);
    // once the window rolled past the burst, turns are allowed again
    noteHumanTurn("p");
    expect(
      checkAutonomyBudget("p", T0 + AUTONOMY_WINDOW_MS + 120_000).ok,
    ).toBe(true);
  });

  it("scopes budgets per project", () => {
    for (let i = 0; i < MAX_CONSECUTIVE_AUTONOMOUS_TURNS; i++) {
      noteAutonomousTurn("a", T0 + i);
    }
    expect(checkAutonomyBudget("a", T0 + 10).ok).toBe(false);
    expect(checkAutonomyBudget("b", T0 + 10).ok).toBe(true);
  });

  it("human turns on unknown projects are a no-op", () => {
    noteHumanTurn("never-seen");
    expect(autonomyTripped("never-seen")).toBe(false);
  });

  it("releases a never-started reservation (no false trip, no false rate burn)", () => {
    // five dead-codex attempts: reserve → dispatch never starts → release
    for (let i = 0; i < MAX_CONSECUTIVE_AUTONOMOUS_TURNS + 3; i++) {
      const at = T0 + i * 1000;
      expect(checkAutonomyBudget("p", at).ok).toBe(true);
      noteAutonomousTurn("p", at);
      releaseAutonomousTurn("p", at); // never started
    }
    // nothing ran → nothing counted → the breaker never trips
    expect(checkAutonomyBudget("p", T0 + 60_000).ok).toBe(true);
    expect(autonomyTripped("p")).toBe(false);
    // a KEPT reservation still counts
    noteAutonomousTurn("p", T0 + 70_000);
    const snap = serializeAutonomyBudgets(T0 + 70_001);
    expect(snap.projects.p.consecutive).toBe(1);
    expect(snap.projects.p.firedAt).toEqual([T0 + 70_000]);
  });

  it("hydrate round-trip: a tripped breaker survives a relaunch", () => {
    // trip the breaker
    for (let i = 0; i < MAX_CONSECUTIVE_AUTONOMOUS_TURNS; i++) {
      noteAutonomousTurn("p", T0 + i);
    }
    expect(checkAutonomyBudget("p", T0 + 100).ok).toBe(false);
    expect(autonomyTripped("p")).toBe(true);
    const persisted = serializeAutonomyBudgets(T0 + 200);
    expect(persisted.version).toBe(1);
    expect(persisted.projects.p.tripped).toBe(true);

    // "relaunch": fresh module state, hydrate the persisted copy
    resetAutonomyBudgets();
    expect(autonomyTripped("p")).toBe(false); // fresh boot without hydrate
    hydrateAutonomyBudgets(persisted, T0 + 300);
    expect(autonomyTripped("p")).toBe(true); // the latch survived
    const refused = checkAutonomyBudget("p", T0 + 400);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.freshTrip).toBe(false); // no re-announce
    // only a human message re-arms — exactly like before the relaunch
    noteHumanTurn("p");
    expect(autonomyTripped("p")).toBe(false);
    expect(checkAutonomyBudget("p", T0 + 500).ok).toBe(true);
  });

  it("hydrate keeps the rate-window history and prunes stale entries", () => {
    for (let i = 0; i < MAX_AUTONOMOUS_TURNS_PER_WINDOW; i++) {
      noteAutonomousTurn("p", T0 + i * 1000);
    }
    const persisted = serializeAutonomyBudgets(T0 + 60_000);
    resetAutonomyBudgets();
    hydrateAutonomyBudgets(persisted, T0 + 60_000);
    // still within the window → still capped (no fresh 20-allowance)
    expect(checkAutonomyBudget("p", T0 + 61_000).ok).toBe(false);
    // a hydrate far in the future prunes the window; the CONSECUTIVE count
    // (turns since the last human message) still stands until a human writes
    resetAutonomyBudgets();
    hydrateAutonomyBudgets(persisted, T0 + AUTONOMY_WINDOW_MS + 120_000);
    expect(
      checkAutonomyBudget("p", T0 + AUTONOMY_WINDOW_MS + 120_000).ok,
    ).toBe(false);
    noteHumanTurn("p");
    expect(
      checkAutonomyBudget("p", T0 + AUTONOMY_WINDOW_MS + 121_000).ok,
    ).toBe(true);
  });

  it("a missing key (null/undefined) is tolerated; live state wins over a persisted copy", () => {
    hydrateAutonomyBudgets(null); // genuinely absent — fresh install, no latch
    hydrateAutonomyBudgets(undefined);
    expect(autonomyUnavailable()).toBe(false);
    // live state wins over a persisted copy of the same project
    noteAutonomousTurn("q", T0);
    hydrateAutonomyBudgets(
      { version: 1, projects: { q: { firedAt: [], consecutive: 0, tripped: true } } },
      T0 + 1,
    );
    expect(autonomyTripped("q")).toBe(false); // in-memory entry kept
    const snap = serializeAutonomyBudgets(T0 + 2);
    expect(snap.projects.q.consecutive).toBe(1);
  });

  it("mutations mark the persist sink dirty; clean projects serialize away", () => {
    let dirty = 0;
    registerAutonomyPersist(() => dirty++);
    noteAutonomousTurn("p", T0);
    expect(dirty).toBe(1);
    releaseAutonomousTurn("p", T0);
    expect(dirty).toBe(2);
    // a released-empty project drops from the snapshot (self-cleaning key)
    expect(serializeAutonomyBudgets(T0 + 1).projects.p).toBeUndefined();
    // trip + human re-arm both mark dirty
    for (let i = 0; i < MAX_CONSECUTIVE_AUTONOMOUS_TURNS; i++) {
      noteAutonomousTurn("p", T0 + i);
    }
    const before = dirty;
    expect(checkAutonomyBudget("p", T0 + 100).ok).toBe(false); // trips
    expect(dirty).toBe(before + 1);
    noteHumanTurn("p");
    expect(dirty).toBe(before + 2);
    // a human turn with nothing to change stays silent
    noteHumanTurn("p");
    expect(dirty).toBe(before + 2);
  });

  it("offers a write-through seam for a reservation before dispatch", async () => {
    const calls: string[] = [];
    registerAutonomyPersist(
      () => calls.push("dirty"),
      async () => {
        calls.push("flush");
      },
    );
    noteAutonomousTurn("p", T0);
    expect(await persistAutonomyReservation()).toBe(true);
    expect(calls).toEqual(["dirty", "flush"]);
  });

  it("breaker-state changes notify subscribers (trip + re-arm)", () => {
    // Phase 5: the Deck's orch dot reads the latched state via
    // useSyncExternalStore — trip and re-arm must both notify
    let notified = 0;
    const unsub = subscribeAutonomy(() => notified++);
    for (let i = 0; i < MAX_CONSECUTIVE_AUTONOMOUS_TURNS; i++) {
      noteAutonomousTurn("p", T0 + i);
    }
    expect(notified).toBe(0); // recording alone never notifies
    expect(checkAutonomyBudget("p", T0 + 100).ok).toBe(false); // trips
    expect(notified).toBe(1);
    // the latched follow-up refusal does NOT re-notify
    expect(checkAutonomyBudget("p", T0 + 200).ok).toBe(false);
    expect(notified).toBe(1);
    // the human re-arm notifies once; a redundant one stays silent
    noteHumanTurn("p");
    expect(notified).toBe(2);
    noteHumanTurn("p");
    expect(notified).toBe(2);
    unsub();
    // after unsubscribe: silence
    for (let i = 0; i < MAX_CONSECUTIVE_AUTONOMOUS_TURNS; i++) {
      noteAutonomousTurn("p", T0 + 300 + i);
    }
    checkAutonomyBudget("p", T0 + 400);
    expect(notified).toBe(2);
  });
});

describe("fail-closed load-failure latch (T3)", () => {
  it("pauses ALL projects while latched, regardless of per-project state", () => {
    // a fresh project would normally be allowed
    expect(checkAutonomyBudget("p", T0).ok).toBe(true);
    latchAutonomyUnavailable();
    expect(autonomyUnavailable()).toBe(true);
    const v = checkAutonomyBudget("p", T0 + 1);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.freshTrip).toBe(false); // not a per-project trip
      expect(v.reason).toContain("could not be loaded");
    }
    // a completely different project is paused too (global latch)
    expect(checkAutonomyBudget("other", T0 + 2).ok).toBe(false);
  });

  it("a project-local human message cannot clear globally unknown state", () => {
    latchAutonomyUnavailable();
    expect(checkAutonomyBudget("p", T0).ok).toBe(false);
    noteHumanTurn("p");
    expect(autonomyUnavailable()).toBe(true);
    expect(checkAutonomyBudget("p", T0 + 1).ok).toBe(false);
  });

  it("notifies subscribers on latch but not on an unrelated human turn", () => {
    let notified = 0;
    const unsub = subscribeAutonomy(() => notified++);
    latchAutonomyUnavailable();
    expect(notified).toBe(1);
    latchAutonomyUnavailable(); // idempotent — no second notify
    expect(notified).toBe(1);
    noteHumanTurn("fresh-project");
    expect(notified).toBe(1);
    unsub();
  });

  it("resetAutonomyBudgets clears the latch (test hygiene)", () => {
    latchAutonomyUnavailable();
    resetAutonomyBudgets();
    expect(autonomyUnavailable()).toBe(false);
    expect(checkAutonomyBudget("p", T0).ok).toBe(true);
  });
});

describe("present-but-invalid persisted budgets fail closed (TF6)", () => {
  it("a corrupt ENVELOPE latches instead of minting fresh state", () => {
    hydrateAutonomyBudgets("garbage");
    expect(autonomyUnavailable()).toBe(true);
  });

  it("a missing or unknown schema version latches", () => {
    hydrateAutonomyBudgets({
      projects: { p: { firedAt: [], consecutive: 0, tripped: false } },
    });
    expect(autonomyUnavailable()).toBe(true);
    resetAutonomyBudgets();
    hydrateAutonomyBudgets({ version: 2, projects: {} });
    expect(autonomyUnavailable()).toBe(true);
  });

  it("a non-object projects field (array/null) latches", () => {
    hydrateAutonomyBudgets({ version: 1, projects: [] });
    expect(autonomyUnavailable()).toBe(true);
    resetAutonomyBudgets();
    hydrateAutonomyBudgets({ version: 1, projects: null });
    expect(autonomyUnavailable()).toBe(true);
  });

  it("a corrupt entry that could HIDE a trip latches (tripped not a boolean)", () => {
    // the exact un-latch risk: `tripped: "yes"` would coerce to false and
    // silently open a latched breaker — fail closed instead
    hydrateAutonomyBudgets({
      version: 1,
      projects: { p: { firedAt: [], consecutive: 0, tripped: "yes" } },
    });
    expect(autonomyUnavailable()).toBe(true);
  });

  it("negative/non-numeric consecutive or a non-array firedAt latches", () => {
    hydrateAutonomyBudgets({
      version: 1,
      projects: { p: { firedAt: [], consecutive: -3, tripped: false } },
    });
    expect(autonomyUnavailable()).toBe(true);
    resetAutonomyBudgets();
    hydrateAutonomyBudgets({
      version: 1,
      projects: { p: { firedAt: "no", consecutive: 0, tripped: false } },
    });
    expect(autonomyUnavailable()).toBe(true);
    resetAutonomyBudgets();
    hydrateAutonomyBudgets({
      version: 1,
      projects: { p: { firedAt: [], consecutive: "x", tripped: false } },
    });
    expect(autonomyUnavailable()).toBe(true);
  });

  it("a corrupt entry fails closed even after an earlier VALID entry applied", () => {
    hydrateAutonomyBudgets(
      {
        version: 1,
        projects: {
          a: { firedAt: [], consecutive: 2, tripped: false },
          b: { firedAt: [], consecutive: 0, tripped: 3 },
        },
      },
      T0,
    );
    expect(autonomyUnavailable()).toBe(true); // the whole load is untrusted
  });

  it("a MALFORMED firedAt element latches instead of silently dropping (T3a)", () => {
    // the exact un-latch risk: dropping one junk element from a full 20/20
    // window turns it into 19 and mints a fresh allowance — fail closed
    hydrateAutonomyBudgets({
      version: 1,
      projects: {
        p: { firedAt: [T0 - 1000, "junk", T0 - 2000], consecutive: 0, tripped: false },
      },
    });
    expect(autonomyUnavailable()).toBe(true);
    resetAutonomyBudgets();
    hydrateAutonomyBudgets({
      version: 1,
      projects: { p: { firedAt: [T0, NaN], consecutive: 0, tripped: false } },
    });
    expect(autonomyUnavailable()).toBe(true);
  });

  it("legitimately EXPIRED firedAt elements prune without latching; far-future clamps", () => {
    // an expired timestamp (outside the rolling hour) is a legit prune, not
    // corruption — no latch; a far-future finite value clamps (kept, restrictive)
    hydrateAutonomyBudgets(
      {
        version: 1,
        projects: {
          p: {
            firedAt: [T0 - AUTONOMY_WINDOW_MS - 5000, T0 - 1000, T0 + 10 * 60_000],
            consecutive: 0,
            tripped: false,
          },
        },
      },
      T0,
    );
    expect(autonomyUnavailable()).toBe(false);
    // the expired one dropped, the in-window + clamped ones remain (2 entries)
    const snap = serializeAutonomyBudgets(T0);
    expect(snap.projects.p.firedAt.length).toBe(2);
  });

  it("autonomyTripped reflects the global fail-closed latch (T3b)", () => {
    // a corrupt budget pauses autonomy globally — the Deck dot / breaker notice
    // read autonomyTripped, which must surface the pause (never dark & silent)
    expect(autonomyTripped("p")).toBe(false);
    latchAutonomyUnavailable();
    expect(autonomyTripped("p")).toBe(true);
    expect(autonomyTripped("any-other")).toBe(true);
    noteHumanTurn("p");
    expect(autonomyTripped("p")).toBe(true);
  });

  it("a well-formed empty envelope hydrates cleanly (no false latch)", () => {
    hydrateAutonomyBudgets({ version: 1, projects: {} });
    expect(autonomyUnavailable()).toBe(false);
  });

  it("valid entries (incl. a tripped one, a huge clamped consecutive) restore without latching", () => {
    hydrateAutonomyBudgets(
      {
        version: 1,
        projects: {
          p: { firedAt: [], consecutive: 0, tripped: true },
          q: { firedAt: [], consecutive: 9_999_999, tripped: false },
        },
      },
      T0,
    );
    expect(autonomyUnavailable()).toBe(false);
    expect(autonomyTripped("p")).toBe(true);
    // a huge-but-positive consecutive is clamped (still restrictive), not junk
    expect(checkAutonomyBudget("q", T0 + 1).ok).toBe(false);
  });
});
