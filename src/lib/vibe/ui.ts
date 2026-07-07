// Pure, memo-friendly helpers for the Vibe-Mode UI (Phase 3). No React, no
// store subscriptions — every function takes plain data so callers can wrap
// them in useMemo / zustand selectors and keep re-renders scoped. The signal
// derivation mirrors the pane rule (AgentPane.paneSignal): busy is quiet,
// amber is "needs you", green is the ephemeral "just finished" moment.

import type { VibeItem } from "@/types";
import type { VibeSessionEntry } from "./session-store";
import { unifiedDiffStats } from "./diff";

/** The ephemeral "✓ finished" window — same ~5 min as the fleet cards. */
export const VIBE_FINISHED_WINDOW_MS = 5 * 60_000;

/** Context-gauge warning floor — genuine pressure only (--warning, never amber). */
export const VIBE_CTX_WARN = 0.9;

export type VibeSignal = "working" | "needsYou" | "finished" | "idle";

/** Count unified-diff body lines — re-exported from `diff.ts`, the one source
 * for +/- counting (rail counter, fileChange cards, turn-diff chip). */
export const diffStats = unifiedDiffStats;

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
 * One session's signal-triad state. Needs-you (a pending approval) wins over
 * busy — a paused turn waiting on the human is the thing to surface.
 */
export function vibeSignal(
  entry: VibeSessionEntry,
  busy: boolean,
  now: number,
): VibeSignal {
  if (hasPendingApproval(entry)) return "needsYou";
  if (busy) return "working";
  if (
    entry.lastBusyEndAt !== null &&
    now - entry.lastBusyEndAt < VIBE_FINISHED_WINDOW_MS
  )
    return "finished";
  return "idle";
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
