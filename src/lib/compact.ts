// Context compaction decision (rebuild Phase 8) — pure, unit-tested. Shared
// by the Vibe session controller and the orchestrator chat controller: when a
// thread nears its context window, `thread/compact/start` summarizes the
// model-visible history so the next turn runs on a smaller footprint. The
// VISIBLE transcript is never touched — only the context the model carries.
//
// Two entry points use these helpers:
//   · a MANUAL button in the context gauge (always available when idle),
//   · an AUTOMATIC compaction fired BEFORE the next turn when the last turn's
//     footprint crossed the threshold. Conservative by construction (see
//     `shouldAutoCompact`): only when idle, only past the threshold, and at
//     most once per cooldown — a running turn is never interrupted and a
//     compaction that barely helps can't turn into a drum-beat.

import { contextTokens } from "./vibe/ui";

/** Auto-compact once the footprint reaches this fraction of the window. */
export const AUTO_COMPACT_PCT = 0.85;

/** Minimum gap between two AUTOMATIC compactions of the same thread — a
 * compaction that only shaved a little off must not re-fire every turn. */
export const AUTO_COMPACT_COOLDOWN_MS = 5 * 60_000;

/** A token bucket + the model context window (both from a `token_usage`
 * event). `null`/absent means "unknown" — never compact on unknown data. */
export interface CtxUsage {
  last?: Record<string, number> | null;
  modelContextWindow?: number | null;
}

/**
 * The current context footprint as a fraction of the window (0–1), or null
 * when either the window or the footprint is unknown. Uses `contextTokens`
 * (the codex-provided per-turn total), so it matches what the gauge shows.
 */
export function contextFraction(usage: CtxUsage | null | undefined): number | null {
  const window = usage?.modelContextWindow ?? 0;
  const total = contextTokens(usage?.last);
  if (!window || total <= 0) return null;
  return Math.min(total / window, 1);
}

export interface AutoCompactInput {
  usage: CtxUsage | null | undefined;
  /** the auto-compact setting (default on) */
  enabled: boolean;
  /** a turn must not be running — compaction is itself a turn */
  busy: boolean;
  /** when this thread was last auto-compacted (ms epoch), or null/undefined */
  lastCompactAt: number | null | undefined;
  now: number;
}

/**
 * Should an automatic compaction fire before the next turn? FAIL-SAFE: false
 * unless the feature is on, the session is idle, the footprint is known AND
 * at/above the threshold, and the cooldown since the last auto-compaction has
 * elapsed. The manual button ignores all of this except idleness.
 */
export function shouldAutoCompact(input: AutoCompactInput): boolean {
  if (!input.enabled || input.busy) return false;
  const frac = contextFraction(input.usage);
  if (frac === null || frac < AUTO_COMPACT_PCT) return false;
  if (
    input.lastCompactAt != null &&
    input.now - input.lastCompactAt < AUTO_COMPACT_COOLDOWN_MS
  ) {
    return false;
  }
  return true;
}
