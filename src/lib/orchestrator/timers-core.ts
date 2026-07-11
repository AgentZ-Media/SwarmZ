// Pure logic of the Conductor timers (no store, no Tauri — unit-tested).
// The stateful half (zustand store, setTimeout wakeups, persistence, the
// fire → autonomous-turn delivery) lives in ./timers.ts.

import type { ConductorTimer } from "@/types";
import { clip } from "./triggers-core";

/** Max pending timers per project — the set_timer tool refuses beyond it. */
export const MAX_TIMERS_PER_PROJECT = 20;
/** Timer notes are context for future-you, not documents. */
export const MAX_NOTE_CHARS = 500;
/** Furthest a timer may be scheduled ahead (365 days). */
export const MAX_DELAY_MS = 365 * 24 * 60 * 60 * 1000;
/** An `at_iso` slightly in the past still fires (clock skew grace). */
export const PAST_GRACE_MS = 60_000;

/**
 * Resolve the `set_timer` args to an absolute fire time. Exactly one of
 * `delaySeconds` / `atIso` must be given; the result is clamped to the
 * future window. Returns an error STRING (never throws) so the executor can
 * hand the model a readable message.
 */
export function resolveFireAt(
  nowMs: number,
  delaySeconds: unknown,
  atIso: unknown,
): { at: number } | { error: string } {
  const hasDelay = delaySeconds !== undefined && delaySeconds !== null;
  const hasAt = typeof atIso === "string" && atIso.trim() !== "";
  if (hasDelay === hasAt) {
    return { error: "pass exactly one of delay_seconds or at_iso" };
  }
  if (hasDelay) {
    const secs = typeof delaySeconds === "number" ? delaySeconds : NaN;
    if (!Number.isFinite(secs) || secs < 1) {
      return { error: "delay_seconds must be a number ≥ 1" };
    }
    const ms = secs * 1000;
    if (ms > MAX_DELAY_MS) {
      return { error: "delay_seconds too large — at most 365 days" };
    }
    return { at: nowMs + Math.round(ms) };
  }
  const parsed = Date.parse((atIso as string).trim());
  if (Number.isNaN(parsed)) {
    return { error: `at_iso is not a parseable ISO 8601 time: ${String(atIso)}` };
  }
  if (parsed < nowMs - PAST_GRACE_MS) {
    return { error: "at_iso is in the past" };
  }
  if (parsed > nowMs + MAX_DELAY_MS) {
    return { error: "at_iso too far ahead — at most 365 days" };
  }
  return { at: Math.max(parsed, nowMs) };
}

/** One persisted timer, hardened field by field (null = dropped). */
export function sanitizeTimer(raw: unknown): ConductorTimer | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (
    typeof t.id !== "string" ||
    !t.id ||
    typeof t.projectId !== "string" ||
    !t.projectId ||
    typeof t.note !== "string" ||
    !t.note.trim() ||
    typeof t.at !== "number" ||
    !Number.isFinite(t.at)
  ) {
    return null;
  }
  return {
    id: t.id,
    projectId: t.projectId,
    note: t.note.trim().slice(0, MAX_NOTE_CHARS),
    at: t.at,
    createdAt:
      typeof t.createdAt === "number" && Number.isFinite(t.createdAt)
        ? t.createdAt
        : t.at,
    // the durable at-most-once claim survives sanitization — hydrate uses it
    // to drop possibly-already-delivered timers instead of re-firing them
    ...(typeof t.firedAt === "number" && Number.isFinite(t.firedAt)
      ? { firedAt: t.firedAt }
      : {}),
  };
}

/** Sanitize a persisted timer list (order kept, duplicates by id dropped). */
export function sanitizeTimers(raw: unknown): ConductorTimer[] {
  if (!Array.isArray(raw)) return [];
  const out: ConductorTimer[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const t = sanitizeTimer(r);
    if (t && !seen.has(t.id)) {
      seen.add(t.id);
      out.push(t);
    }
  }
  return out;
}

/** Split timers into already-due (missed/elapsed) and future ones. */
export function splitDue(
  timers: ConductorTimer[],
  nowMs: number,
): { due: ConductorTimer[]; future: ConductorTimer[] } {
  const due: ConductorTimer[] = [];
  const future: ConductorTimer[] = [];
  for (const t of timers) (t.at <= nowMs ? due : future).push(t);
  due.sort((a, b) => a.at - b.at);
  return { due, future };
}

/** "in 12s" / "in 5m" / "in 2h 5m" / "overdue" — the list_timers rendering. */
export function describeRemaining(at: number, nowMs: number): string {
  const ms = at - nowMs;
  if (ms <= 0) return "overdue";
  const s = Math.round(ms / 1000);
  if (s < 60) return `in ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `in ${h}h ${rest}m` : `in ${h}h`;
}

/** The wire block an autonomous timer turn opens with. */
export function timerWireText(note: string, missed: boolean): string {
  const fired = missed
    ? "[timer fired — it was missed while the app was closed]"
    : "[timer fired]";
  // the note is model-authored (set_timer) — flatten it to one line so it can
  // never fabricate a structural wire marker on a later autonomous turn
  return `${fired} Your note to yourself: ${clip(note, MAX_NOTE_CHARS)}\n\nThis is an autonomous follow-up turn you scheduled. Act on the note now: check the fleet, follow up with agents where needed, and address the user only if something needs them.`;
}
