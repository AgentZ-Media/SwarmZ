// Fleet snapshot for the orchestrator — a compact, serializable picture of
// every native Codex session, computed from the vibe store state. Pure
// module: no React, no side effects; callers pass the session entries + busy
// map in, so the shaping stays unit-testable.

import type { VibeAccess } from "@/types";
import type { VibeSessionEntry } from "@/lib/vibe/session-store";
import { hasPendingApproval, totalTokens } from "@/lib/vibe/ui";

function basename(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
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
  createdAt: number;
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
