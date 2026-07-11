// Autonomy budget / circuit breaker for the Conductor's AUTONOMOUS turns
// (timer fires + routine-approval escalations — the Phase-5 event loop will
// build on this same seam). Pure module, unit-tested.
//
// Why a HARD cap: every autonomous approval decision resumes the agent's
// turn, which can raise the next approval, which escalates into the next
// autonomous turn — a prompt-injected agent could keep that loop spinning
// forever (e.g. endless `git fetch` requests). The per-approval dedupe and
// the 5-second gap in controller.ts only slow such a cascade down; this
// registry CAPS it per project:
//
//   MAX_CONSECUTIVE_AUTONOMOUS_TURNS (5) — autonomous turns since the last
//     HUMAN message in the project (the cascade-depth / lineage cap)
//   MAX_AUTONOMOUS_TURNS_PER_WINDOW (20) per AUTONOMY_WINDOW_MS (1 h) —
//     the rolling-rate cap, human activity or not
//
// Exhausting either cap TRIPS the breaker: it latches until a human sends a
// message in the project ("nach Erschöpfung MUSS ein Mensch fortsetzen").
// The trip is surfaced visibly (controller.ts appends a system message to
// the project's Conductor chat on the fresh trip). Timers that fire while
// the breaker is open retry bounded and then expire visibly; approval
// escalations stay with the human's card.
//
// The budget state is PERSISTED (store key `autonomyBudgets`, wired in
// store.ts — this module stays pure: serialize/hydrate below + a registered
// dirty sink). Without persistence an app relaunch/HMR would mint a fresh
// 5/20 allowance and silently un-latch a tripped breaker WITHOUT any human
// message; hydrate runs FIRST in store.ts hydrate(), before the project
// hydration that gates every delivery path, so no autonomous turn can ever
// run against un-hydrated budgets. Only a real human message re-arms.

import type {
  PersistedAutonomyBudget,
  PersistedAutonomyBudgets,
} from "@/types";

/** Rolling window of the rate cap. */
export const AUTONOMY_WINDOW_MS = 60 * 60 * 1000;
/** Max autonomous turns per project per rolling window. */
export const MAX_AUTONOMOUS_TURNS_PER_WINDOW = 20;
/** Max autonomous turns per project since the last human message. */
export const MAX_CONSECUTIVE_AUTONOMOUS_TURNS = 5;

interface ProjectBudget {
  /** fire timestamps inside the rolling window (pruned on every check) */
  firedAt: number[];
  /** autonomous turns since the last human message */
  consecutive: number;
  /** breaker latched — only a human turn resets it */
  tripped: boolean;
}

const budgets = new Map<string, ProjectBudget>();

/**
 * Fail-closed latch for a persisted-budget LOAD FAILURE. When the
 * `autonomyBudgets` store key is unreadable (corrupt/IO error — as opposed to
 * genuinely absent) we cannot know whether a breaker was tripped, so autonomy
 * is paused GLOBALLY until a human takes the wheel. Only a real human message
 * (`noteHumanTurn`) clears it — the same authority that re-arms a per-project
 * breaker. A relaunch on a corrupt store therefore never runs an unattended
 * autonomous turn against un-known budget state.
 */
let budgetsUnavailable = false;

/** Latch autonomy off globally after a persisted-budget read failure. */
export function latchAutonomyUnavailable(): void {
  if (budgetsUnavailable) return;
  budgetsUnavailable = true;
  notifyAutonomyChange();
}

/** Is autonomy globally paused because the budget store could not be read? */
export function autonomyUnavailable(): boolean {
  return budgetsUnavailable;
}

// ---- breaker-state subscription (Phase 5: the state is UI-visible) ----
// The Deck's orch dot (and later Phase-6 surfaces) read the latched state via
// useSyncExternalStore: subscribe here, snapshot via `autonomyTripped` (a
// primitive boolean — never a fresh object).

const listeners = new Set<() => void>();

/** Subscribe to breaker-state changes (trip / re-arm / reset). */
export function subscribeAutonomy(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function notifyAutonomyChange(): void {
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      /* a broken listener never breaks the budget */
    }
  }
}

// ---- persistence seam (the module stays store/tauri-free) ----

let persistSink: (() => void) | null = null;

/** Install the persist scheduler (store.ts) — called on every budget-state
 * mutation so the durable copy tracks the in-memory one. */
export function registerAutonomyPersist(fn: (() => void) | null): void {
  persistSink = fn;
}

function markDirty(): void {
  try {
    persistSink?.();
  } catch {
    /* a broken sink never breaks the budget */
  }
}

function budgetOf(projectId: string): ProjectBudget {
  let b = budgets.get(projectId);
  if (!b) {
    b = { firedAt: [], consecutive: 0, tripped: false };
    budgets.set(projectId, b);
  }
  return b;
}

function prune(b: ProjectBudget, now: number): void {
  b.firedAt = b.firedAt.filter((t) => t > now - AUTONOMY_WINDOW_MS);
}

export type AutonomyVerdict =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      /** true exactly once per trip — the caller surfaces it visibly then */
      freshTrip: boolean;
    };

/**
 * May an autonomous turn run in this project now? Exhaustion TRIPS the
 * breaker (latched until `noteHumanTurn`); the first refusal after a trip
 * carries `freshTrip: true` so the caller can announce the state once.
 */
export function checkAutonomyBudget(
  projectId: string,
  now: number = Date.now(),
): AutonomyVerdict {
  // fail-closed: a persisted-budget read failure pauses autonomy everywhere
  // until a human message clears it (we don't know what breakers were tripped)
  if (budgetsUnavailable) {
    return {
      ok: false,
      freshTrip: false,
      reason:
        "the autonomy budget state could not be loaded — autonomy is paused until you send a message",
    };
  }
  const b = budgetOf(projectId);
  prune(b, now);
  if (b.tripped) {
    return {
      ok: false,
      freshTrip: false,
      reason: "the autonomy circuit breaker is open — a human message resets it",
    };
  }
  if (b.consecutive >= MAX_CONSECUTIVE_AUTONOMOUS_TURNS) {
    b.tripped = true;
    notifyAutonomyChange();
    markDirty();
    return {
      ok: false,
      freshTrip: true,
      reason: `${b.consecutive} autonomous turns ran since your last message (cap ${MAX_CONSECUTIVE_AUTONOMOUS_TURNS})`,
    };
  }
  if (b.firedAt.length >= MAX_AUTONOMOUS_TURNS_PER_WINDOW) {
    b.tripped = true;
    notifyAutonomyChange();
    markDirty();
    return {
      ok: false,
      freshTrip: true,
      reason: `${b.firedAt.length} autonomous turns ran within the last hour (cap ${MAX_AUTONOMOUS_TURNS_PER_WINDOW})`,
    };
  }
  return { ok: true };
}

/**
 * Reserve one autonomous turn (call right before dispatching it). The
 * reservation is FINAL once the turn actually started — a definitive
 * pre-start failure releases it again via `releaseAutonomousTurn` so a codex
 * that won't even spawn can't trip the breaker with "N turns ran" while zero
 * turns ran.
 */
export function noteAutonomousTurn(
  projectId: string,
  now: number = Date.now(),
): void {
  const b = budgetOf(projectId);
  prune(b, now);
  b.firedAt.push(now);
  b.consecutive += 1;
  markDirty();
}

/**
 * Release a reservation whose turn NEVER STARTED (spawn failure, dead codex
 * — a turn that started and then failed mid-way stays counted: work ran).
 * `at` is the timestamp the reservation was made with.
 */
export function releaseAutonomousTurn(projectId: string, at: number): void {
  const b = budgets.get(projectId);
  if (!b) return;
  const idx = b.firedAt.lastIndexOf(at);
  if (idx >= 0) b.firedAt.splice(idx, 1);
  if (b.consecutive > 0) b.consecutive -= 1;
  markDirty();
}

/**
 * A HUMAN sent a message in the project: the consecutive counter resets and
 * a latched breaker re-arms (the rolling-window history stays — the rate cap
 * is about volume, not lineage).
 */
export function noteHumanTurn(projectId: string): void {
  // a human is back in the loop — clear the global fail-closed latch too (a
  // load-failure pause is lifted the moment a human takes the wheel)
  let announce = false;
  if (budgetsUnavailable) {
    budgetsUnavailable = false;
    announce = true;
  }
  const b = budgets.get(projectId);
  if (!b) {
    if (announce) notifyAutonomyChange();
    return;
  }
  const wasTripped = b.tripped;
  const changed = wasTripped || b.consecutive !== 0;
  b.consecutive = 0;
  b.tripped = false;
  if (wasTripped || announce) notifyAutonomyChange();
  if (changed) markDirty();
}

/** Is the project's breaker currently latched? (UI/state introspection) */
export function autonomyTripped(projectId: string): boolean {
  return budgets.get(projectId)?.tripped ?? false;
}

// ---- persistence (serialize/hydrate — the stateful wiring lives in
// store.ts: load before ANY delivery path can run, save via the sink) ----

/**
 * Snapshot the budgets for persistence. Pruned to the rolling window;
 * projects with nothing to remember (empty window, zero consecutive, not
 * tripped) are omitted, so the key self-cleans.
 */
export function serializeAutonomyBudgets(
  now: number = Date.now(),
): PersistedAutonomyBudgets {
  const projects: Record<string, PersistedAutonomyBudget> = {};
  for (const [projectId, b] of budgets) {
    prune(b, now);
    if (!b.tripped && b.consecutive === 0 && b.firedAt.length === 0) continue;
    projects[projectId] = {
      firedAt: [...b.firedAt],
      consecutive: b.consecutive,
      tripped: b.tripped,
    };
  }
  return { version: 1, projects };
}

/**
 * Hydrate the persisted budgets (store.ts, FIRST in hydrate() — before the
 * project hydration that gates every autonomous delivery path). Hardened
 * field by field; window entries outside the rolling hour are dropped.
 * Projects already touched in memory keep their live state (they can only
 * be MORE restrictive than a fresh boot). A tripped project stays tripped —
 * only a real human message re-arms it.
 */
export function hydrateAutonomyBudgets(
  data: unknown,
  now: number = Date.now(),
): void {
  if (!data || typeof data !== "object") return;
  const projects = (data as { projects?: unknown }).projects;
  if (!projects || typeof projects !== "object") return;
  let anyTripped = false;
  for (const [projectId, raw] of Object.entries(
    projects as Record<string, unknown>,
  )) {
    if (!projectId || !raw || typeof raw !== "object") continue;
    if (budgets.has(projectId)) continue; // live state wins
    const r = raw as Record<string, unknown>;
    const firedAt = Array.isArray(r.firedAt)
      ? r.firedAt
          .filter(
            (t): t is number =>
              typeof t === "number" &&
              Number.isFinite(t) &&
              t > now - AUTONOMY_WINDOW_MS &&
              t <= now + 60_000, // clock-skew grace; far-future junk drops
          )
          .slice(0, 100)
      : [];
    const consecutive =
      typeof r.consecutive === "number" &&
      Number.isFinite(r.consecutive) &&
      r.consecutive > 0
        ? Math.min(Math.floor(r.consecutive), 1000)
        : 0;
    const tripped = r.tripped === true;
    if (!tripped && consecutive === 0 && firedAt.length === 0) continue;
    budgets.set(projectId, { firedAt, consecutive, tripped });
    if (tripped) anyTripped = true;
  }
  // the Deck's orch dot may already be subscribed — surface restored trips
  if (anyTripped) notifyAutonomyChange();
}

/** Test seam — budgets are module state. */
export function resetAutonomyBudgets(): void {
  budgets.clear();
  budgetsUnavailable = false;
  notifyAutonomyChange();
}
