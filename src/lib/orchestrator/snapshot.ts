// Fleet snapshot for the orchestrator — a compact, serializable picture of
// every native Codex session, computed from the vibe store state. Pure
// module: no React, no side effects; callers pass the session entries + busy
// map in, so the shaping stays unit-testable. Phase 4 (fleet_snapshot v2)
// adds per-session worktree info and the pending-approval briefs (with the
// Conductor routing class).

import type { VibeAccess } from "@/types";
import type { VibeSessionEntry } from "@/lib/vibe/session-store";
import { hasPendingApproval, totalTokens } from "@/lib/vibe/ui";

function basename(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

/** One pending approval, reduced to what the Conductor decides on. */
export interface ApprovalBrief {
  /** the approval id decide_approval takes */
  id: string;
  kind: "command" | "fileChange";
  /** routing class — "routine" = the Conductor may decide, else human-only */
  escalation: "routine" | "destructive";
  /** command line or changed paths, one line */
  summary: string;
}

/** One native session, reduced to what the orchestrator reasons about. */
export interface FleetSession {
  id: string;
  name: string;
  cwd: string;
  /** project folder basename */
  projectName: string | null;
  model: string | null;
  access: VibeAccess;
  /** exact status: a paused approval wins over a running turn */
  status: "working" | "idle" | "pending-approval";
  /** a turn is currently in flight */
  turnActive: boolean;
  /** context occupancy in percent (rounded), when token usage is known */
  contextPct: number | null;
  /** the worktree the agent works in (null = directly in the project dir) */
  worktree: { branch: string; shared: boolean } | null;
  /** unanswered approvals, oldest first (decide_approval targets) */
  pendingApprovals: ApprovalBrief[];
  createdAt: number;
}

/** One-line summary of an approval request payload (pure). */
export function approvalBriefSummary(payload: Record<string, unknown>): string {
  const command = typeof payload.command === "string" ? payload.command : "";
  if (command) return command.slice(0, 160);
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  const paths = changes
    .map((c) =>
      c && typeof c === "object" && typeof (c as { path?: unknown }).path === "string"
        ? (c as { path: string }).path
        : null,
    )
    .filter((p): p is string => !!p);
  if (paths.length) return `file change: ${paths.join(", ")}`.slice(0, 160);
  const reason = typeof payload.reason === "string" ? payload.reason : "";
  return (reason || "unknown request").slice(0, 160);
}

/** All PENDING approvals of one session entry, oldest first (pure). */
export function pendingApprovalBriefs(entry: VibeSessionEntry): ApprovalBrief[] {
  const briefs: ApprovalBrief[] = [];
  for (const id of entry.order) {
    const item = entry.items[id];
    if (item?.kind === "approval" && item.status === "pending") {
      briefs.push({
        id: item.id,
        kind: item.approvalKind,
        // missing class (pre-Phase-4 item) degrades to human-only
        escalation: item.escalation === "routine" ? "routine" : "destructive",
        summary: approvalBriefSummary(item.payload),
      });
    }
  }
  return briefs;
}

/** Pure builder — pass the ordered session entries + the busy map. */
export function sessionSnapshot(input: {
  sessions: VibeSessionEntry[];
  busy: Record<string, boolean>;
}): FleetSession[] {
  return input.sessions.map((e) => {
    const pending = hasPendingApproval(e);
    const busy = !!input.busy[e.session.id];
    const window = e.tokenUsage?.modelContextWindow ?? 0;
    const total = totalTokens(e.tokenUsage?.total);
    const contextPct =
      window > 0 && total > 0 ? Math.round((total / window) * 100) : null;
    return {
      id: e.session.id,
      name: e.session.name,
      cwd: e.session.projectDir,
      projectName: e.session.projectDir ? basename(e.session.projectDir) : null,
      model: e.session.model ?? null,
      access: e.session.access,
      status: pending ? "pending-approval" : busy ? "working" : "idle",
      turnActive: busy,
      contextPct,
      worktree: e.session.worktree
        ? { branch: e.session.worktree.branch, shared: e.session.worktree.shared }
        : null,
      pendingApprovals: pending ? pendingApprovalBriefs(e) : [],
      createdAt: e.session.createdAt,
    };
  });
}

export interface SessionCounts {
  sessions: number;
  working: number;
  /** sessions with a pending approval (waiting on the human) */
  waitingApproval: number;
}

export function sessionCounts(list: FleetSession[]): SessionCounts {
  return {
    sessions: list.length,
    working: list.filter((s) => s.status === "working").length,
    waitingApproval: list.filter((s) => s.status === "pending-approval").length,
  };
}

/**
 * e.g. "3 sessions · 1 working · 1 waits approval" — the summary Rust
 * prepends to every user message.
 */
export function fleetSummaryLine(sessions: FleetSession[]): string {
  const sc = sessionCounts(sessions);
  const n = (count: number, word: string) =>
    `${count} ${word}${count === 1 ? "" : "s"}`;
  let line = n(sc.sessions, "session");
  line += ` · ${sc.working} working`;
  line += ` · ${sc.waitingApproval} ${sc.waitingApproval === 1 ? "waits" : "wait"} approval`;
  return line;
}

/**
 * Group the fleet's sessions by worktree — the fleet_snapshot v2 "who works
 * where" section (pure). Sessions without a worktree are omitted.
 */
export function worktreeOccupancy(
  sessions: FleetSession[],
): { path: string; branch: string; shared: boolean; agents: string[] }[] {
  const byPath = new Map<string, { branch: string; agents: string[] }>();
  for (const s of sessions) {
    if (!s.worktree) continue;
    const slot = byPath.get(s.cwd) ?? { branch: s.worktree.branch, agents: [] };
    slot.agents.push(s.name);
    byPath.set(s.cwd, slot);
  }
  return [...byPath.entries()].map(([path, v]) => ({
    path,
    branch: v.branch,
    shared: v.agents.length > 1,
    agents: v.agents,
  }));
}
