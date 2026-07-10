import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTONOMY_WINDOW_MS,
  MAX_AUTONOMOUS_TURNS_PER_WINDOW,
  MAX_CONSECUTIVE_AUTONOMOUS_TURNS,
  autonomyTripped,
  checkAutonomyBudget,
  hydrateAutonomyBudgets,
  noteAutonomousTurn,
  noteHumanTurn,
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

  it("hydrate is hardened against junk and never clobbers live state", () => {
    hydrateAutonomyBudgets(null);
    hydrateAutonomyBudgets("garbage");
    hydrateAutonomyBudgets({ projects: { p: { firedAt: "no", consecutive: "x", tripped: "yes" } } });
    expect(autonomyTripped("p")).toBe(false);
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
