// Pure, memo-friendly helpers for the Vibe-Mode UI (Phase 3). No React, no
// store subscriptions — every function takes plain data so callers can wrap
// them in useMemo / zustand selectors and keep re-renders scoped. The signal
// derivation mirrors the pane rule (AgentPane.paneSignal): busy is quiet,
// amber is "needs you", green is the ephemeral "just finished" moment.

import type { VibeItem } from "@/types";
import type { VibeSessionEntry } from "./session-store";
import { unifiedDiffStats } from "./diff";
import { prettyModel } from "@/lib/utils";

/** The ephemeral "✓ finished" window — same ~5 min as the fleet cards. */
export const VIBE_FINISHED_WINDOW_MS = 5 * 60_000;

/** Context-gauge warning floor — genuine pressure only (--warning, never amber). */
export const VIBE_CTX_WARN = 0.9;

export type VibeSignal = "working" | "needsYou" | "finished" | "idle";

/** Count unified-diff body lines — re-exported from `diff.ts`, the one source
 * for +/- counting (rail counter, fileChange cards, turn-diff chip). */
export const diffStats = unifiedDiffStats;

/** Human-readable current/spawn-time runtime label shared by Fleet cards and
 * Conductor audit chips. Missing model means the user's Codex configuration,
 * not a guessed catalog default. */
export function agentRuntimeLabel(
  model: string | null | undefined,
  effort: string | null | undefined,
): string {
  return `${model ? prettyModel(model) : "Codex default"} · ${effort || "default effort"}`;
}

/** Pending approval items of a session, in transcript order (queue order). */
export function pendingApprovals(
  entry: VibeSessionEntry,
): Extract<VibeItem, { kind: "approval" }>[] {
  const out: Extract<VibeItem, { kind: "approval" }>[] = [];
  for (const id of entry.order) {
    const it = entry.items[id];
    if (it && it.kind === "approval" && it.status === "pending") out.push(it);
  }
  return out;
}

/** True while any approval item is still waiting on the human. */
export function hasPendingApproval(entry: VibeSessionEntry): boolean {
  for (const id of entry.order) {
    const it = entry.items[id];
    if (it && it.kind === "approval" && it.status === "pending") return true;
  }
  return false;
}

/** Epoch ms of the oldest still-pending approval, or null. */
export function oldestPendingApprovalAt(entry: VibeSessionEntry): number | null {
  let at: number | null = null;
  for (const id of entry.order) {
    const it = entry.items[id];
    if (it && it.kind === "approval" && it.status === "pending")
      at = at === null ? it.at : Math.min(at, it.at);
  }
  return at;
}

/**
 * The signal-triad derivation from primitives — the ONE decay rule shared by
 * the fleet grid, the Deck counters and the stage header (their selectors
 * stay pure/primitive; `now` comes from the caller's render tick, never from
 * a getSnapshot). Needs-you (a pending approval) wins over busy — a paused
 * turn waiting on the human is the thing to surface; "finished" decays to
 * "idle" once `now` leaves the window.
 */
export function decayedSignal(
  busy: boolean,
  needsYou: boolean,
  lastBusyEndAt: number | null,
  now: number,
): VibeSignal {
  if (needsYou) return "needsYou";
  if (busy) return "working";
  if (lastBusyEndAt !== null && now - lastBusyEndAt < VIBE_FINISHED_WINDOW_MS)
    return "finished";
  return "idle";
}

/**
 * One session's signal-triad state. Needs-you (a pending approval) wins over
 * busy — a paused turn waiting on the human is the thing to surface.
 */
export function vibeSignal(
  entry: VibeSessionEntry,
  busy: boolean,
  now: number,
): VibeSignal {
  return decayedSignal(busy, hasPendingApproval(entry), entry.lastBusyEndAt, now);
}

/** Compact age for status lines: "now" / "4m" / "2h". */
export function shortAge(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins <= 0) return "now";
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h`;
}

/** Sum a token-usage bucket (input + output + …) into a single total. */
export function totalTokens(
  bucket: Record<string, number> | null | undefined,
): number {
  if (!bucket) return 0;
  let sum = 0;
  for (const v of Object.values(bucket)) if (typeof v === "number") sum += v;
  return sum;
}

/**
 * The CURRENT context footprint of a turn's token bucket, in tokens. Codex'
 * `totalTokens` field IS that footprint (input — which already carries the
 * whole prior context — plus output); summing every field of the bucket
 * (as `totalTokens()` does) double-counts it, so this prefers the explicit
 * field and falls back to `inputTokens + outputTokens` when it is absent.
 * Used by the context gauges and the compaction threshold so both reflect
 * the real footprint.
 */
export function contextTokens(
  bucket: Record<string, number> | null | undefined,
): number {
  if (!bucket) return 0;
  const explicit = bucket.totalTokens;
  if (typeof explicit === "number" && explicit > 0) return explicit;
  // fallback for buckets without the explicit field: input + output ONLY —
  // `cachedInputTokens` / `reasoningOutputTokens` are SUBSETS of those, so
  // summing every field (totalTokens()) reads false-high on partial/old
  // buckets and would trip the gauge + auto-compaction threshold early
  const input = typeof bucket.inputTokens === "number" ? bucket.inputTokens : 0;
  const output =
    typeof bucket.outputTokens === "number" ? bucket.outputTokens : 0;
  return input + output;
}

/** A human command string from an approval's raw request payload. */
export function approvalCommand(payload: Record<string, unknown>): string {
  const c = payload.command;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => String(x)).join(" ");
  return "";
}

/** The one-word status label + whether it reads as an error, for a command item. */
export function commandExit(item: Extract<VibeItem, { kind: "command" }>): {
  text: string;
  failed: boolean;
} {
  if (item.status === "in_progress" || item.status === "running")
    return { text: "running", failed: false };
  if (typeof item.exitCode === "number")
    return { text: `exit ${item.exitCode}`, failed: item.exitCode !== 0 };
  if (item.status === "failed") return { text: "failed", failed: true };
  return { text: item.status || "done", failed: false };
}
