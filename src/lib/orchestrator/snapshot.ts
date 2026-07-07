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
  VibeAccess,
} from "@/types";
import { collectPanes } from "@/lib/layout";
import type { LayoutNode } from "@/types";
import type { VibeSessionEntry } from "@/lib/vibe/session-store";
import { hasPendingApproval, totalTokens } from "@/lib/vibe/ui";

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
  /** effective tiling layout (only present when grid dims were measured) */
  layout?: WorkspaceLayoutInfo;
}

// ---- Layout sensing (grid size + effective pane px) --------------------------
//
// So the orchestrator can reason about SPACE, not just pane counts: the
// measured grid-container size plus the tiling tree rendered with EFFECTIVE
// pane pixel sizes (fraction × container). Container dims are gathered in the
// executor (real DOM measurement — all grids stay mounted); the shaping here
// is a pure function so it is unit-testable.

/** Measured grid-container size in CSS px. */
export interface LayoutDims {
  w: number;
  h: number;
}

export interface WorkspaceLayoutInfo {
  /** measured grid-container size (null = empty workspace or not measured) */
  grid: LayoutDims | null;
  paneCount: number;
  /**
   * Compact nested layout string with effective pane px, e.g.
   * `cols[ "api" (repo) 800×1000 | rows[ "build" (repo) 800×500 / "review" (repo) 800×500 ] ]`
   * — `cols[…|…]` = side by side, `rows[…/…]` = stacked. Null when unmeasured.
   */
  tree: string | null;
  /** smallest leaf by area — the crowding signal */
  smallest: { name: string; w: number; h: number } | null;
}

interface LeafSize {
  name: string;
  project: string | null;
  w: number;
  h: number;
}

function leafLabel(agent: Agent | undefined): { name: string; project: string | null } {
  if (!agent) return { name: "(gone)", project: null };
  const projectRoot = agent.worktree?.root ?? agent.cwd ?? null;
  return { name: agent.name, project: projectRoot ? basename(projectRoot) : null };
}

/** Recursive walk: layout tree + container px → compact string + leaf sizes. */
function walkLayout(
  node: LayoutNode,
  w: number,
  h: number,
  agents: Record<string, Agent>,
  leaves: LeafSize[],
): string {
  if (node.type === "pane") {
    const { name, project } = leafLabel(agents[node.agentId]);
    const rw = Math.round(w);
    const rh = Math.round(h);
    leaves.push({ name, project, w: rw, h: rh });
    return `"${name}"${project ? ` (${project})` : ""} ${rw}×${rh}`;
  }
  const total = node.sizes.reduce((a, b) => a + b, 0) || node.children.length;
  const parts = node.children.map((child, i) => {
    const frac = (node.sizes[i] ?? total / node.children.length) / total;
    return node.direction === "row"
      ? walkLayout(child, frac * w, h, agents, leaves)
      : walkLayout(child, w, frac * h, agents, leaves);
  });
  return node.direction === "row"
    ? `cols[ ${parts.join(" | ")} ]`
    : `rows[ ${parts.join(" / ")} ]`;
}

/** Pure: layout tree + measured container dims → compact layout description. */
export function workspaceLayout(
  layout: LayoutNode | null,
  agents: Record<string, Agent>,
  dims: LayoutDims | null,
): WorkspaceLayoutInfo {
  const paneCount = collectPanes(layout).length;
  if (!layout || !dims || dims.w <= 0 || dims.h <= 0) {
    return { grid: dims ?? null, paneCount, tree: null, smallest: null };
  }
  const leaves: LeafSize[] = [];
  const tree = walkLayout(layout, dims.w, dims.h, agents, leaves);
  let smallest: LeafSize | null = null;
  for (const l of leaves) {
    if (!smallest || l.w * l.h < smallest.w * smallest.h) smallest = l;
  }
  return {
    grid: dims,
    paneCount,
    tree,
    smallest: smallest
      ? { name: smallest.name, w: smallest.w, h: smallest.h }
      : null,
  };
}

/** Panes at or below this size read as crowded (above MIN_PANE, comfort floor). */
const COMFORT_PANE = { w: 500, h: 320 };

/**
 * A short crowding note for the summary line, e.g.
 * `ws «1» is tight: 5 panes, smallest 420×260` — the tightest measured
 * workspace whose smallest pane dips below the comfort floor, else null.
 */
export function crowdingNote(workspaces: FleetWorkspace[]): string | null {
  let tight: { name: string; small: { w: number; h: number }; panes: number } | null =
    null;
  for (const ws of workspaces) {
    const info = ws.layout;
    if (!info || !info.smallest || info.paneCount < 2) continue;
    const s = info.smallest;
    if (s.w >= COMFORT_PANE.w && s.h >= COMFORT_PANE.h) continue;
    if (!tight || s.w * s.h < tight.small.w * tight.small.h)
      tight = { name: ws.name, small: { w: s.w, h: s.h }, panes: info.paneCount };
  }
  if (!tight) return null;
  return `ws «${tight.name}» is tight: ${tight.panes} panes, smallest ${tight.small.w}×${tight.small.h}`;
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
 * missing from the tiling tree are appended defensively). Pass `dims`
 * (workspaceId → measured grid size) to attach the effective-px layout.
 */
export function fleetSnapshot(
  state: SwarmState,
  dims?: Record<string, LayoutDims | null>,
): FleetWorkspace[] {
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
        ...(dims
          ? {
              layout: workspaceLayout(
                state.layouts[ws.id] ?? null,
                state.agents,
                dims[ws.id] ?? null,
              ),
            }
          : {}),
      };
    });
}

/** Shared fleet counting rules — single source for the orchestrator's
 * summary line AND the fleet overview's header (WorkspaceLayer.tsx). */
export interface FleetCounts {
  panes: number;
  busy: number;
  /** needs-you: waiting activity or bell attention */
  waiting: number;
  workspaces: number;
}

export function fleetCounts(state: SwarmState): FleetCounts {
  const workspaces = fleetSnapshot(state);
  const panes = workspaces.flatMap((w) => w.panes);
  return {
    panes: panes.length,
    busy: panes.filter((p) => p.activity === "busy").length,
    waiting: panes.filter((p) => p.activity === "waiting" || p.attention)
      .length,
    workspaces: workspaces.length,
  };
}

// ---- native Vibe sessions (Phase 5) ----
//
// The second agent species: native Codex sessions live in the standalone
// vibe store, not SwarmState. Their snapshot is a pure function over the
// session entries + the busy map so the executor (and unit tests) can build
// it without touching React.

/** One native Vibe session, reduced to what the orchestrator reasons about. */
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
 * e.g. "8 panes · 3 busy · 1 waiting · 2 workspaces" — with native sessions,
 * a trailing "· 2 native sessions, 1 working, 1 waits approval" segment
 * (the summary Rust prepends to every user message).
 */
export function fleetSummaryLine(
  state: SwarmState,
  sessions: FleetSession[] = [],
): string {
  const c = fleetCounts(state);
  const n = (count: number, word: string) =>
    `${count} ${word}${count === 1 ? "" : "s"}`;
  let line = `${n(c.panes, "pane")} · ${c.busy} busy · ${c.waiting} waiting · ${n(c.workspaces, "workspace")}`;
  if (sessions.length) {
    const sc = sessionCounts(sessions);
    line += ` · ${n(sc.sessions, "native session")}`;
    if (sc.working) line += `, ${sc.working} working`;
    if (sc.waitingApproval)
      line += `, ${sc.waitingApproval} ${sc.waitingApproval === 1 ? "waits" : "wait"} approval`;
  }
  return line;
}
