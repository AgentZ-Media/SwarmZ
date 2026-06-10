import { create } from "zustand";
import { nanoid } from "nanoid";
import {
  loadProfiles,
  loadSettings,
  loadUsageHistory,
  saveProfiles,
  saveSettings,
  saveUsageHistory,
} from "@/lib/transport";
import type {
  Agent,
  AgentStatus,
  ClaudeActivity,
  LayoutNode,
  Profile,
  SessionUsage,
  UsageHistoryEntry,
} from "@/types";
import {
  collectPanes,
  findPaneByAgent,
  newPane,
  removePaneByAgent,
  setSplitSizes,
  splitPane,
} from "@/lib/layout";
import { pickColor } from "@/lib/utils";

const DEFAULT_STARTUP = "claude --dangerously-skip-permissions";

// Per-pane terminal zoom (⌘+/⌘−). Default must match the xterm setup in Terminal.tsx.
export const DEFAULT_FONT_SIZE = 12.5;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 28;

// Keep the persisted usage history bounded; oldest sessions fall off first.
const MAX_HISTORY_ENTRIES = 1000;

// Usage refreshes arrive every few seconds per agent — batch disk writes.
let persistHistoryTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersistHistory() {
  if (persistHistoryTimer) return;
  persistHistoryTimer = setTimeout(() => {
    persistHistoryTimer = null;
    const entries = Object.values(useSwarm.getState().usageHistory)
      .sort((a, b) => b.last_updated - a.last_updated)
      .slice(0, MAX_HISTORY_ENTRIES);
    void saveUsageHistory(entries);
  }, 1500);
}

interface CreateAgentOpts {
  name?: string;
  cwd?: string;
  startup?: string;
  profileId?: string;
  color?: string;
}

/** Values the New Agent dialog opens with (e.g. inherited from the pane being split). */
export interface NewAgentPrefill {
  cwd?: string;
  profileId?: string;
  startup?: string;
  /** set when the dialog was opened via a split button — the new pane splits in this direction */
  direction?: "row" | "column";
}

interface SwarmState {
  agents: Record<string, Agent>;
  order: string[];
  layout: LayoutNode | null;
  activePaneId: string | null;
  profiles: Profile[];
  /** all-time usage of claude sessions launched inside SwarmZ, keyed by session id */
  usageHistory: Record<string, UsageHistoryEntry>;
  dashboardOpen: boolean;
  newAgentOpen: boolean;
  newAgentPrefill: NewAgentPrefill | null;
  /** working directory of the most recently launched agent, persisted across restarts */
  lastCwd?: string;
  agentCounter: number;

  // derived helpers
  activeAgentId: () => string | null;

  // lifecycle
  hydrate: () => Promise<void>;
  createAgent: (opts?: CreateAgentOpts, direction?: "row" | "column") => string;
  removeAgent: (agentId: string) => void;
  focusAgent: (agentId: string) => void;
  setActivePane: (paneId: string) => void;

  // status / usage
  setStatus: (agentId: string, status: AgentStatus) => void;
  setAttention: (agentId: string, on: boolean) => void;
  setActivity: (agentId: string, activity: ClaudeActivity | undefined) => void;
  setUsage: (agentId: string, usage: SessionUsage | null) => void;
  renameAgent: (agentId: string, name: string) => void;
  setAgentTitle: (agentId: string, title: string) => void;
  /** per-pane zoom: step the font size by delta, or restore the default */
  adjustFontSize: (agentId: string, delta: number | "reset") => void;
  clearUsageHistory: () => void;

  // layout
  setSizes: (splitId: string, sizes: number[]) => void;
  splitActive: (direction: "row" | "column") => void;

  // profiles
  saveProfile: (p: Omit<Profile, "id"> & { id?: string }) => void;
  deleteProfile: (id: string) => void;

  // ui
  setDashboardOpen: (open: boolean) => void;
  setNewAgentOpen: (open: boolean) => void;
}

export const useSwarm = create<SwarmState>((set, get) => ({
  agents: {},
  order: [],
  layout: null,
  activePaneId: null,
  profiles: [],
  usageHistory: {},
  dashboardOpen: false,
  newAgentOpen: false,
  newAgentPrefill: null,
  lastCwd: undefined,
  agentCounter: 0,

  activeAgentId: () => {
    const { layout, activePaneId } = get();
    if (!activePaneId) return null;
    const pane = collectPanes(layout).find((p) => p.id === activePaneId);
    return pane?.agentId ?? null;
  },

  hydrate: async () => {
    try {
      const settings = await loadSettings();
      if (settings?.lastCwd) set({ lastCwd: settings.lastCwd });
    } catch {
      /* ignore */
    }
    try {
      const history = await loadUsageHistory();
      if (history?.length) {
        const map: Record<string, UsageHistoryEntry> = {};
        for (const e of history) map[e.session_id] = e;
        set({ usageHistory: map });
      }
    } catch {
      /* ignore */
    }
    try {
      const saved = await loadProfiles();
      if (saved && saved.length) {
        set({ profiles: saved });
        return;
      }
    } catch {
      /* ignore */
    }
    const seed: Profile[] = [
      {
        id: nanoid(8),
        name: "Claude · skip permissions",
        startup: DEFAULT_STARTUP,
        color: pickColor(0),
      },
      {
        id: nanoid(8),
        name: "Claude · plain",
        startup: "claude",
        color: pickColor(2),
      },
      {
        id: nanoid(8),
        name: "Shell",
        startup: "",
        color: pickColor(5),
      },
    ];
    set({ profiles: seed });
    void saveProfiles(seed);
  },

  createAgent: (opts = {}, direction = "row") => {
    const state = get();
    const id = nanoid(10);
    const n = state.agentCounter + 1;
    const profile = opts.profileId
      ? state.profiles.find((p) => p.id === opts.profileId)
      : undefined;
    const agent: Agent = {
      id,
      name: opts.name?.trim() || `Agent ${n}`,
      // a name typed in the dialog wins over captured terminal titles
      renamed: !!opts.name?.trim(),
      cwd: opts.cwd || profile?.defaultCwd,
      startup: opts.startup ?? profile?.startup ?? DEFAULT_STARTUP,
      color: opts.color || profile?.color || pickColor(n),
      status: "starting",
      attention: false,
      createdAt: Date.now(),
      profileId: opts.profileId,
    };

    let layout = state.layout;
    let activePaneId = state.activePaneId;

    if (!layout) {
      const pane = newPane(id);
      layout = pane;
      activePaneId = pane.id;
    } else {
      const panes = collectPanes(layout);
      const targetPaneId =
        panes.find((p) => p.id === state.activePaneId)?.id ?? panes[0]?.id;
      if (targetPaneId) {
        layout = splitPane(layout, targetPaneId, id, direction);
      }
      const created = findPaneByAgent(layout, id);
      activePaneId = created?.id ?? activePaneId;
    }

    set({
      agents: { ...state.agents, [id]: agent },
      order: [...state.order, id],
      layout,
      activePaneId,
      agentCounter: n,
      newAgentOpen: false,
      newAgentPrefill: null,
      ...(agent.cwd ? { lastCwd: agent.cwd } : {}),
    });
    if (agent.cwd) void saveSettings({ lastCwd: agent.cwd });
    return id;
  },

  removeAgent: (agentId) => {
    const state = get();
    const layout = removePaneByAgent(state.layout, agentId);
    const { [agentId]: _removed, ...rest } = state.agents;
    const order = state.order.filter((id) => id !== agentId);
    let activePaneId = state.activePaneId;
    const panes = collectPanes(layout);
    if (!panes.find((p) => p.id === activePaneId)) {
      activePaneId = panes[0]?.id ?? null;
    }
    set({ agents: rest, order, layout, activePaneId });
  },

  focusAgent: (agentId) => {
    const state = get();
    const pane = findPaneByAgent(state.layout, agentId);
    if (pane) set({ activePaneId: pane.id });
    if (state.agents[agentId]?.attention) {
      get().setAttention(agentId, false);
    }
  },

  setActivePane: (paneId) => {
    const state = get();
    const pane = collectPanes(state.layout).find((p) => p.id === paneId);
    set({ activePaneId: paneId });
    if (pane && state.agents[pane.agentId]?.attention) {
      get().setAttention(pane.agentId, false);
    }
  },

  setStatus: (agentId, status) => {
    const state = get();
    const agent = state.agents[agentId];
    if (!agent) return;
    set({ agents: { ...state.agents, [agentId]: { ...agent, status } } });
  },

  setAttention: (agentId, on) => {
    const state = get();
    const agent = state.agents[agentId];
    if (!agent || agent.attention === on) return;
    set({
      agents: {
        ...state.agents,
        [agentId]: {
          ...agent,
          attention: on,
          status: on ? "attention" : agent.status === "attention" ? "running" : agent.status,
        },
      },
    });
  },

  setActivity: (agentId, activity) => {
    const state = get();
    const agent = state.agents[agentId];
    if (!agent || agent.activity === activity) return;
    set({ agents: { ...state.agents, [agentId]: { ...agent, activity } } });
  },

  setUsage: (agentId, usage) => {
    const state = get();
    const agent = state.agents[agentId];
    if (!agent || !usage) return;
    // latch onto this agent's own session once it shows real activity
    const sessionId =
      agent.sessionId ||
      (usage.message_count > 0 ? usage.session_id ?? undefined : undefined);

    // mirror the session into the persistent all-time history; sessions with
    // no claude activity (plain shells, dev servers, …) never get an entry
    let usageHistory = state.usageHistory;
    if (usage.message_count > 0 && usage.session_id) {
      const prev = usageHistory[usage.session_id];
      const changed =
        !prev ||
        prev.message_count !== usage.message_count ||
        prev.cost_usd !== usage.cost_usd ||
        prev.input_tokens !== usage.input_tokens ||
        prev.output_tokens !== usage.output_tokens ||
        prev.cache_creation_tokens !== usage.cache_creation_tokens ||
        prev.cache_read_tokens !== usage.cache_read_tokens ||
        prev.agent_name !== agent.name;
      if (changed) {
        usageHistory = {
          ...usageHistory,
          [usage.session_id]: {
            session_id: usage.session_id,
            agent_name: agent.name,
            cwd: usage.cwd ?? agent.cwd ?? null,
            started_at: prev?.started_at ?? agent.createdAt,
            last_updated: Date.now(),
            message_count: usage.message_count,
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_creation_tokens: usage.cache_creation_tokens,
            cache_read_tokens: usage.cache_read_tokens,
            cost_usd: usage.cost_usd,
            by_model: usage.by_model,
          },
        };
        schedulePersistHistory();
      }
    }

    set({
      agents: { ...state.agents, [agentId]: { ...agent, usage, sessionId } },
      usageHistory,
    });
  },

  clearUsageHistory: () => {
    set({ usageHistory: {} });
    void saveUsageHistory([]);
  },

  renameAgent: (agentId, name) => {
    const state = get();
    const agent = state.agents[agentId];
    if (!agent) return;
    const trimmed = name.trim();
    // clearing the name hands naming back to the captured terminal title
    set({
      agents: {
        ...state.agents,
        [agentId]: trimmed
          ? { ...agent, name: trimmed, renamed: true }
          : { ...agent, name: agent.title || agent.name, renamed: false },
      },
    });
  },

  setAgentTitle: (agentId, title) => {
    const state = get();
    const agent = state.agents[agentId];
    if (!agent || agent.title === title) return;
    set({
      agents: {
        ...state.agents,
        [agentId]: {
          ...agent,
          title,
          ...(agent.renamed ? {} : { name: title }),
        },
      },
    });
  },

  adjustFontSize: (agentId, delta) => {
    const state = get();
    const agent = state.agents[agentId];
    if (!agent) return;
    const fontSize =
      delta === "reset"
        ? undefined
        : Math.min(
            MAX_FONT_SIZE,
            Math.max(MIN_FONT_SIZE, (agent.fontSize ?? DEFAULT_FONT_SIZE) + delta),
          );
    if (fontSize === agent.fontSize) return;
    set({ agents: { ...state.agents, [agentId]: { ...agent, fontSize } } });
  },

  setSizes: (splitId, sizes) => {
    const state = get();
    if (!state.layout) return;
    set({ layout: setSplitSizes(state.layout, splitId, sizes) });
  },

  splitActive: (direction) => {
    const state = get();
    const activeId = state.activeAgentId();
    const agent = activeId ? state.agents[activeId] : undefined;
    // open the New Agent dialog inheriting the split-source pane's setup
    set({
      newAgentOpen: true,
      newAgentPrefill: {
        cwd: agent?.cwd,
        profileId: agent?.profileId,
        startup: agent?.startup,
        direction,
      },
    });
  },

  saveProfile: (p) => {
    const state = get();
    let profiles: Profile[];
    if (p.id) {
      profiles = state.profiles.map((x) =>
        x.id === p.id ? ({ ...x, ...p, id: p.id! } as Profile) : x,
      );
    } else {
      profiles = [...state.profiles, { ...p, id: nanoid(8) } as Profile];
    }
    set({ profiles });
    void saveProfiles(profiles);
  },

  deleteProfile: (id) => {
    const profiles = get().profiles.filter((p) => p.id !== id);
    set({ profiles });
    void saveProfiles(profiles);
  },

  setDashboardOpen: (open) => set({ dashboardOpen: open }),
  setNewAgentOpen: (open) =>
    set(open ? { newAgentOpen: true, newAgentPrefill: null } : { newAgentOpen: false }),
}));
