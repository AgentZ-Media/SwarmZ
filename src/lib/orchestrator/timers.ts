// Conductor timers — the stateful half (pure logic in ./timers-core.ts):
// a standalone zustand store (persisted key `conductorTimers`, flushed via
// flushAllPersists), setTimeout wakeups with clamping + re-check, missed
// timers firing on hydrate, and the fire → autonomous-Conductor-turn
// delivery through controller.ts. Timers PERSIST across app restarts but
// only FIRE while the app runs; a busy Conductor chat retries every 30 s
// until the turn could be delivered (the timer stays persisted until then —
// a quit mid-retry re-fires it as "missed" on the next launch).

import { create } from "zustand";
import { nanoid } from "nanoid";
import { loadConductorTimers, saveConductorTimers } from "@/lib/transport";
import { useProjects } from "@/lib/projects/store";
import type { ConductorTimer, PersistedConductorTimers } from "@/types";
import {
  MAX_NOTE_CHARS,
  MAX_TIMERS_PER_PROJECT,
  sanitizeTimers,
  splitDue,
} from "./timers-core";

// ---- delivery seam ----
//
// Firing delivers an autonomous Conductor turn via controller.ts — but
// importing the controller HERE would close a runtime cycle
// (store.ts → timers → controller → store.ts). Instead the controller's
// `deliverTimerTurn` is REGISTERED from App.tsx bootstrap (before hydrate),
// keeping every import edge one-directional. An unregistered delivery (a
// fire racing bootstrap) counts as "retry".

export type TimerDeliveryOutcome = "delivered" | "retry" | "drop";
export type TimerDelivery = (
  projectId: string,
  note: string,
  missed: boolean,
  /**
   * The durable at-most-once claim, called by the delivery IMMEDIATELY
   * BEFORE the dispatch — i.e. INSIDE the project's serialization chain,
   * never before it (a quit while queued behind a long turn/review must
   * re-fire the timer as missed, not drop it as possibly-delivered).
   * Returns false when the timer no longer exists (cancelled while queued —
   * e.g. by a cancel_timer call from the very turn the timer waited behind):
   * the delivery must then abort without dispatching.
   */
  claim: () => Promise<boolean>,
) => Promise<TimerDeliveryOutcome>;

let deliveryFn: TimerDelivery | null = null;

/** Install the autonomous-turn delivery (App.tsx, before hydrate). */
export function registerTimerDelivery(fn: TimerDelivery): void {
  deliveryFn = fn;
}

/** Visible-notice seam (same import-direction story as the delivery): an
 * expired or claim-dropped timer is announced in the project's Conductor
 * chat instead of vanishing silently. */
export type TimerNotice = (projectId: string, text: string) => void;

let noticeFn: TimerNotice | null = null;

/** Install the timer-notice sink (App.tsx, before hydrate). */
export function registerTimerNotice(fn: TimerNotice): void {
  noticeFn = fn;
}

/** setTimeout clamps: longer waits sleep in chunks and re-check. */
const MAX_SLEEP_MS = 2 ** 31 - 1;
/** Retry gap when the Conductor chat is busy at fire time. */
const BUSY_RETRY_MS = 30_000;
/** Bounded busy-retries: after this many the timer EXPIRES visibly (a
 * "retry" outcome must never loop forever). 20 × 30 s = 10 minutes. */
const MAX_BUSY_RETRIES = 20;

interface TimersState {
  /** pending timers, all projects (small — capped per project) */
  timers: ConductorTimer[];
}

export const useConductorTimers = create<TimersState>(() => ({ timers: [] }));

// Timer mutations are rare — persist with a short debounce.
let persistTimerHandle: ReturnType<typeof setTimeout> | null = null;

function snapshot(): PersistedConductorTimers {
  return { version: 1, timers: useConductorTimers.getState().timers };
}

function schedulePersist() {
  if (persistTimerHandle) return;
  persistTimerHandle = setTimeout(() => {
    persistTimerHandle = null;
    void saveConductorTimers(snapshot());
  }, 300);
}

/** Write the pending debounce NOW — called from flushAllPersists at quit. */
export async function flushConductorTimersPersist(): Promise<void> {
  if (persistTimerHandle) {
    clearTimeout(persistTimerHandle);
    persistTimerHandle = null;
  }
  try {
    await saveConductorTimers(snapshot());
  } catch {
    /* never block quitting on a failed write */
  }
}

// ---- wakeups ----

const wakeHandles = new Map<string, ReturnType<typeof setTimeout>>();

function clearWake(id: string) {
  const h = wakeHandles.get(id);
  if (h) {
    clearTimeout(h);
    wakeHandles.delete(id);
  }
}

/** Arm (or re-arm) the wakeup for one timer — clamped sleeps re-check. */
function armWake(timer: ConductorTimer) {
  clearWake(timer.id);
  const delay = Math.max(0, timer.at - Date.now());
  const sleep = Math.min(delay, MAX_SLEEP_MS);
  wakeHandles.set(
    timer.id,
    setTimeout(() => {
      wakeHandles.delete(timer.id);
      const current = useConductorTimers
        .getState()
        .timers.find((t) => t.id === timer.id);
      if (!current) return; // cancelled meanwhile
      if (current.at > Date.now()) {
        armWake(current); // clamped long sleep — keep waiting
        return;
      }
      void fireTimer(current, false);
    }, sleep),
  );
}

/** Timers currently mid-fire — the in-memory idempotency claim (a clamped
 * wake and a hydrate pass may both reach the same due timer). */
const firing = new Set<string>();
/** Busy-retry counts per timer id (in-memory; a restart re-fires as missed). */
const retryCounts = new Map<string, number>();

/** Stamp/clear the durable at-most-once claim on one timer. */
function setFiredAt(id: string, firedAt: number | undefined): void {
  const s = useConductorTimers.getState();
  if (!s.timers.some((t) => t.id === id)) return;
  useConductorTimers.setState({
    timers: s.timers.map((t) =>
      t.id === id
        ? firedAt === undefined
          ? (({ firedAt: _drop, ...rest }) => rest)(t)
          : { ...t, firedAt }
        : t,
    ),
  });
}

/**
 * Fire one timer: deliver the autonomous Conductor turn in its project.
 * "delivered" removes the timer; "retry" (busy chat / open circuit breaker /
 * failed dispatch) re-arms in 30 s, BOUNDED — after MAX_BUSY_RETRIES the
 * timer expires with a visible notice; "drop" (project record gone, or the
 * timer was cancelled while queued) removes it silently.
 *
 * Idempotency, two layers: an in-memory `firing` claim (double wakeups /
 * hydrate overlap deliver at most once per run), and the DURABLE `firedAt`
 * stamp persisted via the `claim` callback the DELIVERY invokes immediately
 * before its dispatch — INSIDE the serialization chain, so a quit while the
 * timer waits behind a long turn/review re-fires it as missed instead of
 * dropping a never-delivered timer (at-most-once still holds: a crash
 * between claim+dispatch and removal drops the claimed timer on hydrate,
 * with a visible notice). The claim also RE-CHECKS existence — a timer
 * cancelled while queued (e.g. by cancel_timer inside the very turn it
 * waited behind) aborts instead of firing anyway. A "retry" clears the
 * stamp again (nothing ran). While the stamp is set (claim → removal) the
 * timer counts as a HARD quit blocker (`claimedTimers` in lib/quit.ts) —
 * quitting in that window would hydrate-drop it, so the user must confirm.
 */
async function fireTimer(timer: ConductorTimer, missed: boolean): Promise<void> {
  if (firing.has(timer.id)) return; // already mid-fire in this run
  firing.add(timer.id);
  try {
    let outcome: TimerDeliveryOutcome = "drop";
    try {
      if (deliveryFn) {
        const claim = async (): Promise<boolean> => {
          // cancelled while queued? (cancel_timer removed it from the store)
          const exists = useConductorTimers
            .getState()
            .timers.some((t) => t.id === timer.id);
          if (!exists) return false;
          // durable claim, flushed BEFORE the side effect
          setFiredAt(timer.id, Date.now());
          await flushConductorTimersPersist();
          return true;
        };
        outcome = await deliveryFn(timer.projectId, timer.note, missed, claim);
      } else {
        outcome = "retry"; // fire raced bootstrap — the delivery registers shortly
      }
    } catch {
      outcome = "retry"; // transient failure — try again
    }
    if (outcome === "retry") {
      // nothing was delivered — release the durable claim
      setFiredAt(timer.id, undefined);
      schedulePersist();
      const n = (retryCounts.get(timer.id) ?? 0) + 1;
      if (n >= MAX_BUSY_RETRIES) {
        retryCounts.delete(timer.id);
        removeTimerInternal(timer.id);
        noticeFn?.(
          timer.projectId,
          `⏰ Timer expired undelivered after ${MAX_BUSY_RETRIES} attempts: ${timer.note}`,
        );
        return;
      }
      retryCounts.set(timer.id, n);
      clearWake(timer.id);
      wakeHandles.set(
        timer.id,
        setTimeout(() => {
          wakeHandles.delete(timer.id);
          const current = useConductorTimers
            .getState()
            .timers.find((t) => t.id === timer.id);
          if (current) void fireTimer(current, missed);
        }, BUSY_RETRY_MS),
      );
      return;
    }
    // delivered or dropped — the timer is done
    retryCounts.delete(timer.id);
    removeTimerInternal(timer.id);
  } finally {
    firing.delete(timer.id);
  }
}

function removeTimerInternal(id: string) {
  clearWake(id);
  const s = useConductorTimers.getState();
  if (!s.timers.some((t) => t.id === id)) return;
  useConductorTimers.setState({ timers: s.timers.filter((t) => t.id !== id) });
  schedulePersist();
}

// ---- public surface (the timer tools + hydrate) ----

/**
 * Create one timer (the `set_timer` executor). `at` is the resolved absolute
 * fire time (timers-core `resolveFireAt`). Enforces the per-project cap.
 */
export function createTimer(
  projectId: string,
  note: string,
  at: number,
): ConductorTimer {
  const trimmed = note.trim().slice(0, MAX_NOTE_CHARS);
  if (!trimmed) throw new Error("note must not be empty");
  const s = useConductorTimers.getState();
  const inProject = s.timers.filter((t) => t.projectId === projectId).length;
  if (inProject >= MAX_TIMERS_PER_PROJECT) {
    throw new Error(
      `this project already has ${inProject} pending timers (cap ${MAX_TIMERS_PER_PROJECT}) — cancel one first`,
    );
  }
  const timer: ConductorTimer = {
    id: `tm-${nanoid(8)}`,
    projectId,
    note: trimmed,
    at,
    createdAt: Date.now(),
  };
  useConductorTimers.setState({ timers: [...s.timers, timer] });
  schedulePersist();
  armWake(timer);
  return timer;
}

/** Pending timers of one project, soonest first. */
export function listTimers(projectId: string): ConductorTimer[] {
  return useConductorTimers
    .getState()
    .timers.filter((t) => t.projectId === projectId)
    .sort((a, b) => a.at - b.at);
}

/**
 * Cancel one timer by id, scoped to the calling project (a Conductor can
 * never cancel another project's timers). Returns the cancelled timer.
 */
export function cancelTimer(projectId: string, timerId: string): ConductorTimer {
  const timer = useConductorTimers
    .getState()
    .timers.find((t) => t.id === timerId && t.projectId === projectId);
  if (!timer) {
    throw new Error(
      `no pending timer "${timerId}" in this project (see list_timers)`,
    );
  }
  removeTimerInternal(timerId);
  return timer;
}

/**
 * Hydrate the persisted timers — called from store.ts hydrate() AFTER the
 * project store (drop-decisions need the project records). Safety rails:
 *
 * - a LOAD ERROR returns untouched (loadConductorTimers rethrows store
 *   errors; only a genuinely missing key is null) — an unreadable store must
 *   never be mistaken for "no timers" and persisted away,
 * - the project filter applies ONLY when the projects store verifiably
 *   hydrated — a failed project hydration must not make an empty project
 *   map look authoritative and bulk-drop every timer (delivery re-checks per
 *   fire anyway),
 * - timers carrying a durable `firedAt` claim may have already delivered
 *   before a crash/quit — they are DROPPED with a visible notice instead of
 *   double-delivered (at-most-once).
 *
 * DUE timers (missed while the app was closed) fire right away, marked as
 * missed; future ones arm their wakeups.
 */
export async function hydrateConductorTimers(): Promise<void> {
  let data: PersistedConductorTimers | null = null;
  try {
    data = await loadConductorTimers();
  } catch {
    return; // unreadable store — keep whatever is in memory, persist nothing
  }
  if (!data) return;
  const projectsState = useProjects.getState();
  const sanitized = sanitizeTimers(data.timers);
  const claimed = sanitized.filter((t) => t.firedAt !== undefined);
  const unclaimed = sanitized.filter((t) => t.firedAt === undefined);
  const timers = projectsState.hydrated
    ? unclaimed.filter((t) => !!projectsState.projects[t.projectId])
    : unclaimed;
  const existing = useConductorTimers.getState().timers;
  const merged = [
    ...existing,
    ...timers.filter((t) => !existing.some((x) => x.id === t.id)),
  ];
  useConductorTimers.setState({ timers: merged });
  const { due, future } = splitDue(merged, Date.now());
  for (const t of future) armWake(t);
  for (const t of due) void fireTimer(t, true);
  for (const t of claimed) {
    noticeFn?.(
      t.projectId,
      `⏰ A timer may have already fired right before the last shutdown — it was dropped to avoid a double delivery. Its note: ${t.note}`,
    );
  }
  if (timers.length !== sanitized.length) schedulePersist();
}
