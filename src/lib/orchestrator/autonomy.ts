// Autonomy budget / circuit breaker for the Conductor's AUTONOMOUS turns
// (timer fires + routine-approval escalations — the Phase-5 event loop will
// build on this same seam). Pure module, unit-tested.
//
// Why a DEFAULT-ON cap: every autonomous approval decision resumes the agent's
// turn, which can raise the next approval, which escalates into the next
// autonomous turn — a prompt-injected agent could keep that loop spinning
// forever (e.g. endless `git fetch` requests). The per-approval dedupe and
// the 5-second gap in controller.ts only slow such a cascade down; this
// registry CAPS it per project:
//
//   MAX_CONSECUTIVE_AUTONOMOUS_TURNS (5 by default) — autonomous turns since the last
//     HUMAN message in the project (the cascade-depth / lineage cap)
//   MAX_AUTONOMOUS_TURNS_PER_WINDOW (20 by default) per AUTONOMY_WINDOW_MS (1 h) —
//     the rolling-rate cap, human activity or not
//
// Both limits and the master switch are human-owned app settings. Disabling
// the budget explicitly clears the counters/latches and bypasses accounting;
// enabling it again starts from a clean budget with the configured limits.
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
/** Settings bounds: enough headroom for deliberate high-volume use; OFF is unlimited. */
export const MIN_AUTONOMY_BUDGET_LIMIT = 1;
export const MAX_AUTONOMY_BUDGET_LIMIT = 1000;

export interface AutonomyBudgetConfig {
  enabled: boolean;
  maxConsecutive: number;
  maxPerHour: number;
}

const DEFAULT_AUTONOMY_BUDGET_CONFIG: AutonomyBudgetConfig = {
  enabled: true,
  maxConsecutive: MAX_CONSECUTIVE_AUTONOMOUS_TURNS,
  maxPerHour: MAX_AUTONOMOUS_TURNS_PER_WINDOW,
};

let autonomyBudgetConfig = { ...DEFAULT_AUTONOMY_BUDGET_CONFIG };

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
 * is paused GLOBALLY until a verified rehydrate/restart. A message in one
 * project cannot prove the unknown budgets of every other project safe.
 */
let budgetsUnavailable = false;

/** Latch autonomy off globally after a persisted-budget read failure. */
export function latchAutonomyUnavailable(): void {
  if (!autonomyBudgetConfig.enabled) return;
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
let flushPersistSink: (() => Promise<void>) | null = null;

/** Install the persist scheduler (store.ts) — called on every budget-state
 * mutation so the durable copy tracks the in-memory one. */
export function registerAutonomyPersist(
  fn: (() => void) | null,
  flush?: (() => Promise<void>) | null,
): void {
  persistSink = fn;
  flushPersistSink = flush ?? null;
}

/** Durably persist a just-booked reservation before its autonomous side
 * effect starts. Store wiring remains outside this pure budget module. */
export async function persistAutonomyReservation(): Promise<boolean> {
  if (!autonomyBudgetConfig.enabled) return true;
  await flushPersistSink?.();
  return !budgetsUnavailable;
}

function markDirty(): void {
  try {
    persistSink?.();
  } catch {
    /* a broken sink never breaks the budget */
  }
}

/** Sanitize persisted/user-entered limits at the pure budget boundary. */
export function normalizeAutonomyBudgetLimit(
  value: unknown,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(
    MAX_AUTONOMY_BUDGET_LIMIT,
    Math.max(MIN_AUTONOMY_BUDGET_LIMIT, Math.floor(value)),
  );
}

/**
 * Apply the human-owned settings snapshot. Missing/invalid fields retain the
 * safe 5/20 defaults. Turning the budget off is an explicit reset: stale
 * counters, trips and a prior unavailable latch must not reappear when it is
 * enabled again. Changing a limit re-evaluates existing counters on the next
 * check instead of leaving an obsolete trip latched.
 */
export function configureAutonomyBudget(
  config: Partial<AutonomyBudgetConfig>,
): void {
  const next: AutonomyBudgetConfig = {
    enabled: config.enabled !== false,
    maxConsecutive: normalizeAutonomyBudgetLimit(
      config.maxConsecutive,
      MAX_CONSECUTIVE_AUTONOMOUS_TURNS,
    ),
    maxPerHour: normalizeAutonomyBudgetLimit(
      config.maxPerHour,
      MAX_AUTONOMOUS_TURNS_PER_WINDOW,
    ),
  };
  const previous = autonomyBudgetConfig;
  const enabledChanged = previous.enabled !== next.enabled;
  const limitsChanged =
    previous.maxConsecutive !== next.maxConsecutive ||
    previous.maxPerHour !== next.maxPerHour;
  autonomyBudgetConfig = next;

  if (!next.enabled) {
    if (enabledChanged || budgets.size > 0 || budgetsUnavailable) {
      budgets.clear();
      budgetsUnavailable = false;
      notifyAutonomyChange();
      markDirty();
    }
    return;
  }

  if (previous.enabled && limitsChanged) {
    let rearmed = false;
    for (const budget of budgets.values()) {
      if (!budget.tripped) continue;
      budget.tripped = false;
      rearmed = true;
    }
    if (rearmed) {
      notifyAutonomyChange();
      markDirty();
    }
  }
}

/** Current normalized configuration (a copy; callers cannot mutate it). */
export function getAutonomyBudgetConfig(): AutonomyBudgetConfig {
  return { ...autonomyBudgetConfig };
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
  if (!autonomyBudgetConfig.enabled) return { ok: true };
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
  if (b.consecutive >= autonomyBudgetConfig.maxConsecutive) {
    b.tripped = true;
    notifyAutonomyChange();
    markDirty();
    return {
      ok: false,
      freshTrip: true,
      reason: `${b.consecutive} autonomous turns ran since your last message (cap ${autonomyBudgetConfig.maxConsecutive})`,
    };
  }
  if (b.firedAt.length >= autonomyBudgetConfig.maxPerHour) {
    b.tripped = true;
    notifyAutonomyChange();
    markDirty();
    return {
      ok: false,
      freshTrip: true,
      reason: `${b.firedAt.length} autonomous turns ran within the last hour (cap ${autonomyBudgetConfig.maxPerHour})`,
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
  if (!autonomyBudgetConfig.enabled) return;
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
  if (!autonomyBudgetConfig.enabled) return;
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
  const b = budgets.get(projectId);
  if (!b) return;
  const wasTripped = b.tripped;
  const changed = wasTripped || b.consecutive !== 0;
  b.consecutive = 0;
  b.tripped = false;
  if (wasTripped) notifyAutonomyChange();
  if (changed) markDirty();
}

/**
 * Is autonomy currently latched off for this project? The Deck's orch dot and
 * the breaker notice read this. It reflects BOTH the per-project circuit
 * breaker AND the global fail-closed `autonomyUnavailable` latch (a corrupt/
 * unreadable persisted budget, or a persist WRITE failure): otherwise a
 * corruption-triggered pause would stop autonomy SILENTLY, with the breaker
 * indicator still dark. Either state means "autonomy is not running here".
 */
export function autonomyTripped(projectId: string): boolean {
  if (!autonomyBudgetConfig.enabled) return false;
  if (budgetsUnavailable) return true;
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
  if (!autonomyBudgetConfig.enabled) return { version: 1, projects };
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
 * Parse one persisted budget entry. Returns the ProjectBudget, `null` when the
 * entry is structurally VALID but empty (nothing to remember — skip it), or
 * the `INVALID` sentinel when the entry is CORRUPT in a way that could HIDE a
 * tripped breaker (wrong-typed `tripped`, a negative/non-numeric `consecutive`,
 * a non-array `firedAt`, or not an object at all). A corrupt entry must
 * fail-closed, never silently coerce a latched breaker to open.
 */
const INVALID_BUDGET = Symbol("invalid-budget");
function parseBudgetEntry(
  raw: unknown,
  now: number,
): ProjectBudget | null | typeof INVALID_BUDGET {
  if (!raw || typeof raw !== "object") return INVALID_BUDGET;
  const r = raw as Record<string, unknown>;
  // `tripped` MUST be a real boolean — a corrupt/truthy-but-not-true value
  // could mask a latched breaker; fail closed rather than read it as `false`.
  if (typeof r.tripped !== "boolean") return INVALID_BUDGET;
  // `consecutive` MUST be a finite, non-negative number (absurd/negative → fail
  // closed); a huge-but-positive value is clamped, still restrictive.
  if (
    typeof r.consecutive !== "number" ||
    !Number.isFinite(r.consecutive) ||
    r.consecutive < 0
  )
    return INVALID_BUDGET;
  // `firedAt` MUST be an array. A MALFORMED individual element (non-number /
  // NaN / Infinity) is ENTRY corruption, NOT droppable noise: silently
  // dropping one element can turn a full 20/20 rolling window into 19 and mint
  // a fresh allowance (exactly the un-latch risk the `tripped` flag can't
  // cover — the count itself is the guard). Fail closed on any malformed
  // element. Only two element transforms are legitimate and stay silent:
  //   · a genuinely EXPIRED timestamp (≤ now − window) is pruned — the rolling
  //     window is about volume, and an expired entry no longer counts;
  //   · a far-FUTURE finite timestamp is CLAMPED to `now` (kept, restrictive)
  //     rather than dropped — a clamp never lowers the count.
  if (!Array.isArray(r.firedAt)) return INVALID_BUDGET;
  const firedAt: number[] = [];
  for (const t of r.firedAt) {
    if (typeof t !== "number" || !Number.isFinite(t)) return INVALID_BUDGET;
    if (t <= now - AUTONOMY_WINDOW_MS) continue; // genuinely expired — legit prune
    firedAt.push(t > now + 60_000 ? now : t); // clock-skew grace; clamp, never drop
  }
  firedAt.splice(100); // hard cap (already far above the window cap — stays restrictive)
  const consecutive = Math.min(Math.floor(r.consecutive), 1000);
  const tripped = r.tripped;
  if (!tripped && consecutive === 0 && firedAt.length === 0) return null;
  return { firedAt, consecutive, tripped };
}

/**
 * Hydrate the persisted budgets (store.ts, FIRST in hydrate() — before the
 * project hydration that gates every autonomous delivery path). Hardened
 * field by field; window entries outside the rolling hour are dropped.
 * Projects already touched in memory keep their live state (they can only
 * be MORE restrictive than a fresh boot). A tripped project stays tripped —
 * only a real human message re-arms it.
 *
 * `null`/`undefined` = a genuinely MISSING store key (fresh install) → no
 * restriction. But a PRESENT-BUT-INVALID value (wrong shape / version, or a
 * structurally corrupt entry) is treated exactly like a store READ ERROR:
 * FAIL CLOSED (`latchAutonomyUnavailable`) — a corrupt persisted copy must
 * never silently un-latch a tripped breaker or mint a fresh allowance. Only a
 * human message clears it. (store.ts already latches when the LOAD itself
 * throws; this covers a load that resolves to junk.)
 */
export function hydrateAutonomyBudgets(
  data: unknown,
  now: number = Date.now(),
): void {
  if (!autonomyBudgetConfig.enabled) {
    if (data !== null && data !== undefined) markDirty();
    return;
  }
  // genuinely absent — fresh install, no restriction
  if (data === null || data === undefined) return;
  // present but not the expected envelope → fail closed
  if (
    typeof data !== "object" ||
    (data as { version?: unknown }).version !== 1 ||
    typeof (data as { projects?: unknown }).projects !== "object" ||
    !(data as { projects?: unknown }).projects ||
    Array.isArray((data as { projects?: unknown }).projects)
  ) {
    latchAutonomyUnavailable();
    return;
  }
  const projects = (data as { projects: Record<string, unknown> }).projects;
  let anyTripped = false;
  for (const [projectId, raw] of Object.entries(projects)) {
    if (!projectId) continue; // an empty id addresses no project — skip
    if (budgets.has(projectId)) continue; // live state wins
    const parsed = parseBudgetEntry(raw, now);
    if (parsed === INVALID_BUDGET) {
      // a corrupt entry could hide a latched breaker → fail closed globally
      latchAutonomyUnavailable();
      return;
    }
    if (!parsed) continue; // structurally valid but empty — nothing to keep
    budgets.set(projectId, parsed);
    if (parsed.tripped) anyTripped = true;
  }
  // the Deck's orch dot may already be subscribed — surface restored trips
  if (anyTripped) notifyAutonomyChange();
}

/** Test seam — budgets are module state. */
export function resetAutonomyBudgets(): void {
  budgets.clear();
  budgetsUnavailable = false;
  autonomyBudgetConfig = { ...DEFAULT_AUTONOMY_BUDGET_CONFIG };
  notifyAutonomyChange();
}
