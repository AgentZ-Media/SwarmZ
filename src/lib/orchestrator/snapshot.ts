// Fleet snapshot for the orchestrator (Phase 1) — a compact, serializable
// picture of every workspace and pane, computed from the live store state.
// Pure module: no React, no side effects, no store import at runtime (the
// SwarmState import is type-only); callers pass `useSwarm.getState()` in.

import type { SwarmState } from "@/store";
import type {
  Agent,
  AgentRuntime,
  AgentStatus,
  ClaudeActivity,
} from "@/types";
import { collectPanes } from "@/lib/layout";

/** One agent pane, reduced to what an orchestrator needs to reason about it. */
export interface FleetPane {
  id: string;
  name: string;
  /** last terminal title captured from the PTY (topic line), if any */
  title: string | null;
  runtime: AgentRuntime;
  cwd: string | null;
  /** project folder basename (worktree panes: the main repo's) */
  projectName: string | null;
  /** main repo root, only for worktree panes */
  worktreeRoot: string | null;
  /** worktree branch, only for worktree panes */
  branch: string | null;
  /** current git branch of the cwd, when known */
  gitBranch: string | null;
  activity: ClaudeActivity | null;
  status: AgentStatus;
  attention: boolean;
  /** primary model of the session, when usage is known */
  model: string | null;
  /** context occupancy in percent (rounded), when usage is known */
  contextPct: number | null;
  createdAt: number;
  /** the pane's own session file has been discovered/latched */
  hasSession: boolean;
  /** always false in Phase 1 — floating terminals are not captured */
  floating: false;
}

export interface FleetWorkspace {
  id: string;
  name: string;
  active: boolean;
  panes: FleetPane[];
}

function basename(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

function toPane(agent: Agent): FleetPane {
  const usage = agent.usage;
  const projectRoot = agent.worktree?.root ?? agent.cwd ?? null;
  const contextPct =
    usage && usage.context_limit > 0
      ? Math.round((usage.context_tokens / usage.context_limit) * 100)
      : null;
  return {
    id: agent.id,
    name: agent.name,
    title: agent.title ?? null,
    runtime: agent.runtime ?? "claude",
    cwd: agent.cwd ?? null,
    projectName: projectRoot ? basename(projectRoot) : null,
    worktreeRoot: agent.worktree?.root ?? null,
    branch: agent.worktree?.branch ?? null,
    gitBranch: agent.git?.branch ?? usage?.git_branch ?? null,
    activity: agent.activity ?? null,
    status: agent.status,
    attention: agent.attention,
    model: usage?.primary_model ?? null,
    contextPct,
    createdAt: agent.createdAt,
    hasSession: Boolean(agent.sessionId),
    floating: false,
  };
}

/**
 * Snapshot every workspace (tab order) with its panes (layout order; agents
 * missing from the tiling tree are appended defensively).
 */
export function fleetSnapshot(state: SwarmState): FleetWorkspace[] {
  return state.workspaceOrder
    .map((wsId) => state.workspaces[wsId])
    .filter((ws): ws is NonNullable<typeof ws> => Boolean(ws))
    .map((ws) => {
      const seen = new Set<string>();
      const panes: FleetPane[] = [];
      for (const pane of collectPanes(state.layouts[ws.id] ?? null)) {
        const agent = state.agents[pane.agentId];
        if (!agent || seen.has(agent.id)) continue;
        seen.add(agent.id);
        panes.push(toPane(agent));
      }
      for (const id of state.order) {
        const agent = state.agents[id];
        if (!agent || agent.workspaceId !== ws.id || seen.has(id)) continue;
        seen.add(id);
        panes.push(toPane(agent));
      }
      return {
        id: ws.id,
        name: ws.name,
        active: ws.id === state.activeWorkspaceId,
        panes,
      };
    });
}

/** e.g. "8 panes · 3 busy · 1 waiting · 2 workspaces" */
export function fleetSummaryLine(state: SwarmState): string {
  const workspaces = fleetSnapshot(state);
  const panes = workspaces.flatMap((w) => w.panes);
  const busy = panes.filter((p) => p.activity === "busy").length;
  const waiting = panes.filter(
    (p) => p.activity === "waiting" || p.attention,
  ).length;
  const n = (count: number, word: string) =>
    `${count} ${word}${count === 1 ? "" : "s"}`;
  return `${n(panes.length, "pane")} · ${busy} busy · ${waiting} waiting · ${n(workspaces.length, "workspace")}`;
}
