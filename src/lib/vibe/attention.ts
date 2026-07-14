import type { VibeItem } from "@/types";
import type { VibeSessionEntry } from "./session-store";
import { reportForItem } from "./report-item";

export interface HumanAttention {
  kind: "approval" | "report";
  since: number;
  summary: string | null;
}

/** Pending approval items in transcript order. */
export function pendingApprovals(
  entry: VibeSessionEntry,
): Extract<VibeItem, { kind: "approval" }>[] {
  const out: Extract<VibeItem, { kind: "approval" }>[] = [];
  for (const id of entry.order) {
    const item = entry.items[id];
    if (item?.kind === "approval" && item.status === "pending") out.push(item);
  }
  return out;
}

export function hasPendingApproval(entry: VibeSessionEntry): boolean {
  return oldestPendingApprovalAt(entry) !== null;
}

export function oldestPendingApprovalAt(entry: VibeSessionEntry): number | null {
  let at: number | null = null;
  for (const id of entry.order) {
    const item = entry.items[id];
    if (item?.kind === "approval" && item.status === "pending") {
      at = at === null ? item.at : Math.min(at, item.at);
    }
  }
  return at;
}

/**
 * Latest unresolved structured needs_human report. A later human message is
 * the acknowledgement boundary; Conductor prompts deliberately are not.
 */
export function unresolvedNeedsHumanReport(
  entry: VibeSessionEntry,
): { at: number; summary: string | null } | null {
  for (let i = entry.order.length - 1; i >= 0; i--) {
    const item = entry.items[entry.order[i]];
    if (!item) continue;
    if (item.kind === "user" && item.via !== "conductor") return null;
    const report = reportForItem(item);
    if (!report) continue;
    if (!report.needsHuman) return null;
    return { at: item.at, summary: report.question ?? report.summary };
  }
  return null;
}

/** One shared attention primitive for every product surface. */
export function humanAttention(entry: VibeSessionEntry): HumanAttention | null {
  const approvalAt = oldestPendingApprovalAt(entry);
  const report = unresolvedNeedsHumanReport(entry);
  if (approvalAt === null && report === null) return null;
  if (report && (approvalAt === null || report.at < approvalAt)) {
    return { kind: "report", since: report.at, summary: report.summary };
  }
  return { kind: "approval", since: approvalAt!, summary: null };
}

export function hasHumanAttention(entry: VibeSessionEntry): boolean {
  return humanAttention(entry) !== null;
}

/** Stable selector token used by primitive Zustand signatures. */
export function humanAttentionSignature(entry: VibeSessionEntry): string {
  const attention = humanAttention(entry);
  return attention ? `${attention.kind}:${attention.since}` : "";
}
