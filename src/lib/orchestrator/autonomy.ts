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
    return {
      ok: false,
      freshTrip: true,
      reason: `${b.consecutive} autonomous turns ran since your last message (cap ${MAX_CONSECUTIVE_AUTONOMOUS_TURNS})`,
    };
  }
  if (b.firedAt.length >= MAX_AUTONOMOUS_TURNS_PER_WINDOW) {
    b.tripped = true;
    return {
      ok: false,
      freshTrip: true,
      reason: `${b.firedAt.length} autonomous turns ran within the last hour (cap ${MAX_AUTONOMOUS_TURNS_PER_WINDOW})`,
    };
  }
  return { ok: true };
}

/** Record one autonomous turn (call right before dispatching it). */
export function noteAutonomousTurn(
  projectId: string,
  now: number = Date.now(),
): void {
  const b = budgetOf(projectId);
  prune(b, now);
  b.firedAt.push(now);
  b.consecutive += 1;
}

/**
 * A HUMAN sent a message in the project: the consecutive counter resets and
 * a latched breaker re-arms (the rolling-window history stays — the rate cap
 * is about volume, not lineage).
 */
export function noteHumanTurn(projectId: string): void {
  const b = budgets.get(projectId);
  if (!b) return;
  b.consecutive = 0;
  b.tripped = false;
}

/** Is the project's breaker currently latched? (UI/state introspection) */
export function autonomyTripped(projectId: string): boolean {
  return budgets.get(projectId)?.tripped ?? false;
}

/** Test seam — budgets are module state. */
export function resetAutonomyBudgets(): void {
  budgets.clear();
}
