import { create } from "zustand";
import { nanoid } from "nanoid";
import {
  loadCommandPresets,
  loadProfiles,
  loadSettings,
  loadUsageHistory,
  loadWorkspaces,
  ptyHasChildren,
  saveCommandPresets,
  saveProfiles,
  saveSettings,
  saveUsageHistory,
  saveWorkspaces,
} from "@/lib/transport";
import type {
  Agent,
  AgentStatus,
  AppSettings,
  ClaudeActivity,
  CommandPreset,
  FloatingTerminal,
  FolderCommands,
  GitInfo,
  LayoutNode,
  Profile,
  SessionUsage,
  UsageHistoryEntry,
  Workspace,
} from "@/types";
import {
  collectPanes,
  findPaneByAgent,
  movePane as movePaneInLayout,
  newPane,
  removePaneByAgent,
  setSplitSizes,
  splitPane,
  type DropZone,
} from "@/lib/layout";
import { destroyTerm, focusTerm } from "@/lib/term-host";
import { folderName, pickColor } from "@/lib/utils";

// Built-in fallback — the effective default is settings.defaultStartup (Settings dialog).
export const DEFAULT_STARTUP = "claude --dangerously-skip-permissions";

// Per-pane terminal zoom (⌘+/⌘−). The effective default is settings.defaultFontSize.
export const DEFAULT_FONT_SIZE = 12.5;
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 28;

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

// Floating terminals open as a small PiP window; cascaded so stacked windows
// stay grabbable.
const FLOAT_DEFAULT_W = 520;
const FLOAT_DEFAULT_H = 340;

/** Command presets are keyed by project folder; agents without a cwd share "~". */
export function presetKey(cwd?: string): string {
  return cwd || "~";
}

// Workspace tabs persist (name/order/defaultCwd) — debounced like the history.
let persistWorkspacesTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersistWorkspaces() {
  if (persistWorkspacesTimer) return;
  persistWorkspacesTimer = setTimeout(() => {
    persistWorkspacesTimer = null;
    const s = useSwarm.getState();
    void saveWorkspaces({
      workspaces: s.workspaceOrder
        .map((id) => s.workspaces[id])
        .filter((w): w is Workspace => !!w),
      activeId: s.activeWorkspaceId,
    });
  }, 300);
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
  /** workspace tabs — name/order/defaultCwd persist, everything inside is in-memory */
  workspaces: Record<string, Workspace>;
  workspaceOrder: string[];
  activeWorkspaceId: string;
  /** tiling tree per workspace (in-memory, like the agents) */
  layouts: Record<string, LayoutNode | null>;
  /** active pane per workspace */
  activePaneIds: Record<string, string | null>;
  /** fleet overview: every workspace rendered live as a scaled card (⌘E) */
  fleetOpen: boolean;
  /** command palette (⌘K) */
  paletteOpen: boolean;
  /** workspace pending close while it still contains agents */
  closeWorkspaceConfirm: string | null;
  /** tab highlighted as drop target while a pane is dragged over it */
  tabDropTarget: string | null;
  /** focus mode: this agent's pane is enlarged as an overlay above the grid (in-memory) */
  focusedAgentId: string | null;
  profiles: Profile[];
  /** all-time usage of claude sessions launched inside SwarmZ, keyed by session id */
  usageHistory: Record<string, UsageHistoryEntry>;
  dashboardOpen: boolean;
  newAgentOpen: boolean;
  newAgentPrefill: NewAgentPrefill | null;
  /** persisted app preferences (Settings dialog) — includes the last used folder */
  settings: AppSettings;
  agentCounter: number;
  workspaceCounter: number;
  /** PiP-style shell terminals floating above the grid (in-memory) */
  floatingTerminals: Record<string, FloatingTerminal>;
  floatingOrder: string[];
  /** quick-command customizations (presets + hidden detected), keyed by project folder (persisted) */
  commandPresets: Record<string, FolderCommands>;
  /** pending "close agent" that needs a decision about running floating terminals */
  closeConfirm: { agentId: string; termIds: string[] } | null;
  /** pending app-quit while these agents are still working (see lib/quit.ts) */
  quitConfirm: string[] | null;
  /**
   * OS file drag in progress (see lib/dnd.ts): targetId is the pty id of the
   * drop zone under the cursor, null while hovering elsewhere (in-memory)
   */
  fileDrag: { targetId: string | null } | null;

  // derived helpers
  activeAgentId: () => string | null;

  // workspaces
  createWorkspace: (opts?: {
    name?: string;
    defaultCwd?: string;
    activate?: boolean;
  }) => string;
  renameWorkspace: (id: string, name: string) => void;
  setActiveWorkspace: (id: string) => void;
  /** reorder the tab strip: move workspace `id` to position `toIndex` */
  moveWorkspace: (id: string, toIndex: number) => void;
  /** close a workspace; with agents inside it raises the confirm dialog first */
  requestCloseWorkspace: (id: string) => void;
  resolveCloseWorkspace: (confirmed: boolean) => void;
  /** move an agent's pane into another workspace (splits its active pane) */
  moveAgentToWorkspace: (agentId: string, workspaceId: string) => void;
  /** jump to the next agent that needs attention, across all workspaces (⌘⇧A) */
  attentionJump: () => void;
  setFleetOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setTabDropTarget: (id: string | null) => void;

  // lifecycle
  hydrate: () => Promise<void>;
  createAgent: (opts?: CreateAgentOpts, direction?: "row" | "column") => string;
  removeAgent: (agentId: string) => void;
  /**
   * Close an agent pane the safe way: floating terminals with a running
   * process raise the close-confirm dialog (close vs. detach); idle ones are
   * closed along with the pane. All UI close paths go through this.
   */
  requestRemoveAgent: (agentId: string) => void;
  /** resolve the pending close-confirm: kill the terminals, detach them, or cancel */
  resolveCloseConfirm: (choice: "kill" | "detach" | "cancel") => void;
  /** open/close the quit warning (busy agent ids; null = dismissed) */
  setQuitConfirm: (agentIds: string[] | null) => void;

  // floating terminals
  createFloatingTerminal: (agentId: string) => void;
  /** remove from the store — the window unmounts, which kills the PTY */
  removeFloatingTerminal: (id: string) => void;
  /** bring a window above its siblings (last in order renders on top) */
  raiseFloatingTerminal: (id: string) => void;
  updateFloatingTerminal: (
    id: string,
    patch: Partial<Omit<FloatingTerminal, "id">>,
  ) => void;

  // command presets (per project folder)
  /** create a preset, or update one in place when `id` is given (edit/override) */
  saveCommandPreset: (
    cwd: string | undefined,
    label: string,
    command: string,
    id?: string,
  ) => void;
  deleteCommandPreset: (cwd: string | undefined, id: string) => void;
  /** remove an auto-detected command from this folder's quick-command bar */
  hideDetectedCommand: (cwd: string | undefined, command: string) => void;
  /** bring back everything hidden in this folder */
  restoreHiddenCommands: (cwd: string | undefined) => void;
  focusAgent: (agentId: string) => void;
  setActivePane: (paneId: string) => void;
  /** enter/leave focus mode (null = leave) */
  setFocusedAgent: (agentId: string | null) => void;

  // status / usage
  setStatus: (agentId: string, status: AgentStatus) => void;
  setAttention: (agentId: string, on: boolean) => void;
  setActivity: (agentId: string, activity: ClaudeActivity | undefined) => void;
  setUsage: (agentId: string, usage: SessionUsage | null) => void;
  setGitInfo: (agentId: string, git: GitInfo | null) => void;
  renameAgent: (agentId: string, name: string) => void;
  setAgentTitle: (agentId: string, title: string) => void;
  /** per-pane zoom: step the font size by delta, or restore the default */
  adjustFontSize: (agentId: string, delta: number | "reset") => void;
  clearUsageHistory: () => void;

  /** merge + persist app preferences (Settings dialog) */
  updateSettings: (patch: Partial<AppSettings>) => void;

  // layout (workspace-scoped — drags must commit against the grid they started in)
  setSizes: (workspaceId: string, splitId: string, sizes: number[]) => void;
  splitActive: (direction: "row" | "column") => void;
  movePane: (
    workspaceId: string,
    srcPaneId: string,
    targetPaneId: string,
    zone: DropZone,
  ) => void;

  // profiles
  saveProfile: (p: Omit<Profile, "id"> & { id?: string }) => void;
  deleteProfile: (id: string) => void;

  // ui
  setDashboardOpen: (open: boolean) => void;
  setNewAgentOpen: (open: boolean) => void;
  setFileDrag: (drag: { targetId: string | null } | null) => void;
}

// the app always has at least one workspace — created synchronously so
// agents can be spawned before hydrate() finishes
const initialWorkspace: Workspace = { id: nanoid(8), name: "Workspace 1" };

export const useSwarm = create<SwarmState>((set, get) => ({
  agents: {},
  order: [],
  workspaces: { [initialWorkspace.id]: initialWorkspace },
  workspaceOrder: [initialWorkspace.id],
  activeWorkspaceId: initialWorkspace.id,
  layouts: { [initialWorkspace.id]: null },
  activePaneIds: { [initialWorkspace.id]: null },
  fleetOpen: false,
  paletteOpen: false,
  closeWorkspaceConfirm: null,
  tabDropTarget: null,
  focusedAgentId: null,
  profiles: [],
  usageHistory: {},
  dashboardOpen: false,
  newAgentOpen: false,
  newAgentPrefill: null,
  settings: {},
  agentCounter: 0,
  workspaceCounter: 1,
  floatingTerminals: {},
  floatingOrder: [],
  commandPresets: {},
  closeConfirm: null,
  quitConfirm: null,
  fileDrag: null,

  activeAgentId: () => {
    const { layouts, activePaneIds, activeWorkspaceId } = get();
    const paneId = activePaneIds[activeWorkspaceId];
    if (!paneId) return null;
    const pane = collectPanes(layouts[activeWorkspaceId] ?? null).find(
      (p) => p.id === paneId,
    );
    return pane?.agentId ?? null;
  },

  createWorkspace: (opts = {}) => {
    const state = get();
    const id = nanoid(8);
    const n = state.workspaceCounter + 1;
    const name =
      opts.name?.trim() ||
      (opts.defaultCwd ? folderName(opts.defaultCwd) : `Workspace ${n}`);
    const ws: Workspace = {
      id,
      name,
      renamed: !!opts.name?.trim(),
      defaultCwd: opts.defaultCwd,
    };
    set({
      workspaces: { ...state.workspaces, [id]: ws },
      workspaceOrder: [...state.workspaceOrder, id],
      layouts: { ...state.layouts, [id]: null },
      activePaneIds: { ...state.activePaneIds, [id]: null },
      workspaceCounter: n,
      ...(opts.activate !== false
        ? { activeWorkspaceId: id, focusedAgentId: null, fleetOpen: false }
        : {}),
    });
    schedulePersistWorkspaces();
    return id;
  },

  renameWorkspace: (id, name) => {
    const state = get();
    const ws = state.workspaces[id];
    const trimmed = name.trim();
    if (!ws || !trimmed || (ws.name === trimmed && ws.renamed)) return;
    set({
      workspaces: {
        ...state.workspaces,
        [id]: { ...ws, name: trimmed, renamed: true },
      },
    });
    schedulePersistWorkspaces();
  },

  setActiveWorkspace: (id) => {
    const state = get();
    if (!state.workspaces[id] || state.activeWorkspaceId === id) {
      // clicking the active tab while the fleet is open still exits the fleet
      if (state.fleetOpen && state.activeWorkspaceId === id)
        set({ fleetOpen: false });
      return;
    }
    set({ activeWorkspaceId: id, focusedAgentId: null, fleetOpen: false });
    schedulePersistWorkspaces();
  },

  moveWorkspace: (id, toIndex) => {
    const state = get();
    const from = state.workspaceOrder.indexOf(id);
    if (from < 0) return;
    const to = Math.max(0, Math.min(state.workspaceOrder.length - 1, toIndex));
    if (from === to) return;
    const workspaceOrder = [...state.workspaceOrder];
    workspaceOrder.splice(from, 1);
    workspaceOrder.splice(to, 0, id);
    set({ workspaceOrder });
    schedulePersistWorkspaces();
  },

  requestCloseWorkspace: (id) => {
    const state = get();
    if (!state.workspaces[id]) return;
    const hasAgents = state.order.some(
      (aid) => state.agents[aid]?.workspaceId === id,
    );
    if (hasAgents) set({ closeWorkspaceConfirm: id });
    else closeWorkspace(id);
  },

  resolveCloseWorkspace: (confirmed) => {
    const id = get().closeWorkspaceConfirm;
    set({ closeWorkspaceConfirm: null });
    if (confirmed && id) closeWorkspace(id);
  },

  moveAgentToWorkspace: (agentId, workspaceId) => {
    const state = get();
    const agent = state.agents[agentId];
    if (!agent || !state.workspaces[workspaceId]) return;
    if (agent.workspaceId === workspaceId) return;
    const srcId = agent.workspaceId;

    const srcLayout = removePaneByAgent(state.layouts[srcId] ?? null, agentId);
    const srcPanes = collectPanes(srcLayout);
    const srcActive = srcPanes.find(
      (p) => p.id === state.activePaneIds[srcId],
    )
      ? state.activePaneIds[srcId]
      : (srcPanes[0]?.id ?? null);

    let dstLayout = state.layouts[workspaceId] ?? null;
    if (!dstLayout) {
      dstLayout = newPane(agentId);
    } else {
      const dstPanes = collectPanes(dstLayout);
      const target =
        dstPanes.find((p) => p.id === state.activePaneIds[workspaceId]) ??
        dstPanes[0];
      dstLayout = splitPane(dstLayout, target.id, agentId, "row");
    }
    const created = findPaneByAgent(dstLayout, agentId);

    set({
      agents: {
        ...state.agents,
        [agentId]: { ...agent, workspaceId },
      },
      layouts: {
        ...state.layouts,
        [srcId]: srcLayout,
        [workspaceId]: dstLayout,
      },
      activePaneIds: {
        ...state.activePaneIds,
        [srcId]: srcActive,
        [workspaceId]: created?.id ?? state.activePaneIds[workspaceId] ?? null,
      },
      focusedAgentId:
        state.focusedAgentId === agentId ? null : state.focusedAgentId,
      tabDropTarget: null,
    });
  },

  attentionJump: () => {
    const { agents, order } = get();
    const waiting = order.filter((id) => {
      const a = agents[id];
      return a && (a.attention || a.activity === "waiting");
    });
    if (waiting.length === 0) return;
    const current = get().activeAgentId();
    const idx = current ? waiting.indexOf(current) : -1;
    const next = waiting[(idx + 1) % waiting.length];
    set({ fleetOpen: false });
    get().focusAgent(next);
    focusTerm(next);
  },

  setFleetOpen: (open) =>
    set(open ? { fleetOpen: true, focusedAgentId: null } : { fleetOpen: false }),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setTabDropTarget: (id) => {
    if (get().tabDropTarget !== id) set({ tabDropTarget: id });
  },

  hydrate: async () => {
    try {
      const settings = await loadSettings();
      if (settings) set({ settings });
    } catch {
      /* ignore */
    }
    try {
      const persisted = await loadWorkspaces();
      if (persisted?.workspaces.length) {
        const state = get();
        // normally the untouched seed workspace is replaced; if an agent was
        // already spawned before hydrate resolved, keep its workspace and
        // merge the persisted tabs in after it — never drop saved tabs
        const keepSeed = state.order.length > 0;
        const workspaces: Record<string, Workspace> = keepSeed
          ? { ...state.workspaces }
          : {};
        const layouts: Record<string, LayoutNode | null> = keepSeed
          ? { ...state.layouts }
          : {};
        const activePaneIds: Record<string, string | null> = keepSeed
          ? { ...state.activePaneIds }
          : {};
        const workspaceOrder: string[] = keepSeed
          ? [...state.workspaceOrder]
          : [];
        for (const w of persisted.workspaces) {
          if (workspaces[w.id]) continue;
          workspaces[w.id] = w;
          layouts[w.id] = null;
          activePaneIds[w.id] = null;
          workspaceOrder.push(w.id);
        }
        // avoid duplicate default names after restarts ("Workspace 3" twice)
        let counter = workspaceOrder.length;
        for (const id of workspaceOrder) {
          const m = /^Workspace (\d+)$/.exec(workspaces[id]?.name ?? "");
          if (m) counter = Math.max(counter, Number(m[1]));
        }
        set({
          workspaces,
          workspaceOrder,
          layouts,
          activePaneIds,
          activeWorkspaceId: keepSeed
            ? get().activeWorkspaceId
            : persisted.activeId && workspaces[persisted.activeId]
              ? persisted.activeId
              : workspaceOrder[0],
          workspaceCounter: counter,
        });
      }
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
      const presets = await loadCommandPresets();
      if (presets) {
        // tolerate the pre-release shape where a folder mapped to a bare
        // preset array (no hidden list)
        const normalized: Record<string, FolderCommands> = {};
        for (const [key, value] of Object.entries(presets)) {
          normalized[key] = Array.isArray(value)
            ? { presets: value, hidden: [] }
            : value;
        }
        set({ commandPresets: normalized });
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
    const wsId = state.activeWorkspaceId;
    const profile = opts.profileId
      ? state.profiles.find((p) => p.id === opts.profileId)
      : undefined;
    const agent: Agent = {
      id,
      name: opts.name?.trim() || `Agent ${n}`,
      workspaceId: wsId,
      // a name typed in the dialog wins over captured terminal titles
      renamed: !!opts.name?.trim(),
      cwd: opts.cwd || profile?.defaultCwd,
      startup:
        opts.startup ??
        profile?.startup ??
        state.settings.defaultStartup ??
        DEFAULT_STARTUP,
      color: opts.color || profile?.color || pickColor(n),
      status: "starting",
      attention: false,
      createdAt: Date.now(),
      profileId: opts.profileId,
    };

    let layout = state.layouts[wsId] ?? null;
    let activePaneId = state.activePaneIds[wsId] ?? null;

    if (!layout) {
      const pane = newPane(id);
      layout = pane;
      activePaneId = pane.id;
    } else {
      const panes = collectPanes(layout);
      const targetPaneId =
        panes.find((p) => p.id === activePaneId)?.id ?? panes[0]?.id;
      if (targetPaneId) {
        layout = splitPane(layout, targetPaneId, id, direction);
      }
      const created = findPaneByAgent(layout, id);
      activePaneId = created?.id ?? activePaneId;
    }

    // the first project folder names the tab and becomes its default cwd
    // (until the user renames the workspace / a defaultCwd exists)
    let workspaces = state.workspaces;
    const ws = state.workspaces[wsId];
    if (ws && agent.cwd && !ws.defaultCwd) {
      workspaces = {
        ...workspaces,
        [wsId]: {
          ...ws,
          defaultCwd: agent.cwd,
          ...(ws.renamed ? {} : { name: folderName(agent.cwd) }),
        },
      };
    }

    set({
      agents: { ...state.agents, [id]: agent },
      order: [...state.order, id],
      workspaces,
      layouts: { ...state.layouts, [wsId]: layout },
      activePaneIds: { ...state.activePaneIds, [wsId]: activePaneId },
      agentCounter: n,
      newAgentOpen: false,
      newAgentPrefill: null,
      // a new pane should be visible immediately — leave focus mode & fleet
      focusedAgentId: null,
      fleetOpen: false,
    });
    if (workspaces !== state.workspaces) schedulePersistWorkspaces();
    if (agent.cwd) get().updateSettings({ lastCwd: agent.cwd });
    return id;
  },

  removeAgent: (agentId) => {
    const state = get();
    const agent = state.agents[agentId];
    if (!agent) return;
    // panes only detach on unmount — the terminal + PTY die here
    destroyTerm(agentId);
    const wsId = agent.workspaceId;
    const layout = removePaneByAgent(state.layouts[wsId] ?? null, agentId);
    const { [agentId]: _removed, ...rest } = state.agents;
    const order = state.order.filter((id) => id !== agentId);
    let activePaneId = state.activePaneIds[wsId] ?? null;
    const panes = collectPanes(layout);
    if (!panes.find((p) => p.id === activePaneId)) {
      activePaneId = panes[0]?.id ?? null;
    }
    set({
      agents: rest,
      order,
      layouts: { ...state.layouts, [wsId]: layout },
      activePaneIds: { ...state.activePaneIds, [wsId]: activePaneId },
      focusedAgentId:
        state.focusedAgentId === agentId ? null : state.focusedAgentId,
    });
  },

  requestRemoveAgent: (agentId) => {
    const state = get();
    const termIds = state.floatingOrder.filter(
      (tid) => state.floatingTerminals[tid]?.agentId === agentId,
    );
    if (termIds.length === 0) {
      get().removeAgent(agentId);
      return;
    }
    void (async () => {
      // a floating terminal blocks the close only while something actually
      // runs in it — exited/idle shells are closed along with the pane
      const busy: string[] = [];
      await Promise.all(
        termIds.map(async (tid) => {
          if (get().floatingTerminals[tid]?.status === "exited") return;
          if (await ptyHasChildren(tid)) busy.push(tid);
        }),
      );
      if (busy.length > 0) {
        set({ closeConfirm: { agentId, termIds: busy } });
      } else {
        for (const tid of termIds) get().removeFloatingTerminal(tid);
        get().removeAgent(agentId);
      }
    })();
  },

  resolveCloseConfirm: (choice) => {
    const confirm = get().closeConfirm;
    if (!confirm) return;
    set({ closeConfirm: null });
    if (choice === "cancel") return;
    const state = get();
    const termIds = state.floatingOrder.filter(
      (tid) => state.floatingTerminals[tid]?.agentId === confirm.agentId,
    );
    for (const tid of termIds) {
      if (choice === "detach" && confirm.termIds.includes(tid)) {
        // keep the PTY alive as an unowned, minimized pill
        get().updateFloatingTerminal(tid, { agentId: null, minimized: true });
      } else {
        get().removeFloatingTerminal(tid);
      }
    }
    get().removeAgent(confirm.agentId);
  },

  setQuitConfirm: (agentIds) => set({ quitConfirm: agentIds }),

  createFloatingTerminal: (agentId) => {
    const state = get();
    const agent = state.agents[agentId];
    if (!agent) return;
    const id = `float-${nanoid(10)}`;
    const term: FloatingTerminal = {
      id,
      agentId,
      cwd: agent.cwd,
      name: "Terminal",
      status: "running",
      minimized: false,
      // positioned bottom-right by the window component once it knows the
      // grid size (x/y null = not laid out yet)
      x: null,
      y: null,
      w: FLOAT_DEFAULT_W,
      h: FLOAT_DEFAULT_H,
      z:
        Math.max(
          0,
          ...Object.values(state.floatingTerminals).map((t) => t.z),
        ) + 1,
    };
    set({
      floatingTerminals: { ...state.floatingTerminals, [id]: term },
      floatingOrder: [...state.floatingOrder, id],
    });
  },

  removeFloatingTerminal: (id) => {
    const state = get();
    // removal is what kills the PTY (windows stay mounted while minimized/detached)
    destroyTerm(id);
    const { [id]: _removed, ...rest } = state.floatingTerminals;
    set({
      floatingTerminals: rest,
      floatingOrder: state.floatingOrder.filter((tid) => tid !== id),
    });
  },

  raiseFloatingTerminal: (id) => {
    const state = get();
    const term = state.floatingTerminals[id];
    if (!term) return;
    const top = Math.max(
      0,
      ...Object.values(state.floatingTerminals).map((t) => t.z),
    );
    if (term.z === top) return;
    get().updateFloatingTerminal(id, { z: top + 1 });
  },

  updateFloatingTerminal: (id, patch) => {
    const state = get();
    const term = state.floatingTerminals[id];
    if (!term) return;
    set({
      floatingTerminals: {
        ...state.floatingTerminals,
        [id]: { ...term, ...patch },
      },
    });
  },

  saveCommandPreset: (cwd, label, command, id) => {
    const trimmed = command.trim();
    if (!trimmed) return;
    const key = presetKey(cwd);
    const state = get();
    const folder = state.commandPresets[key] ?? { presets: [], hidden: [] };
    const finalLabel = label.trim() || trimmed;
    let presets: CommandPreset[];
    if (id && folder.presets.some((p) => p.id === id)) {
      // edit in place — keeps the chip's position
      presets = folder.presets.map((p) =>
        p.id === id ? { ...p, label: finalLabel, command: trimmed } : p,
      );
    } else {
      // re-saving an identical command just refreshes its label
      presets = [
        ...folder.presets.filter((p) => p.command !== trimmed),
        { id: nanoid(8), label: finalLabel, command: trimmed },
      ];
    }
    const commandPresets = {
      ...state.commandPresets,
      [key]: { ...folder, presets },
    };
    set({ commandPresets });
    void saveCommandPresets(commandPresets);
  },

  deleteCommandPreset: (cwd, id) => {
    const key = presetKey(cwd);
    const state = get();
    const folder = state.commandPresets[key];
    if (!folder) return;
    const presets = folder.presets.filter((p) => p.id !== id);
    const commandPresets = { ...state.commandPresets, [key]: { ...folder, presets } };
    if (presets.length === 0 && folder.hidden.length === 0)
      delete commandPresets[key];
    set({ commandPresets });
    void saveCommandPresets(commandPresets);
  },

  hideDetectedCommand: (cwd, command) => {
    const key = presetKey(cwd);
    const state = get();
    const folder = state.commandPresets[key] ?? { presets: [], hidden: [] };
    if (folder.hidden.includes(command)) return;
    const commandPresets = {
      ...state.commandPresets,
      [key]: { ...folder, hidden: [...folder.hidden, command] },
    };
    set({ commandPresets });
    void saveCommandPresets(commandPresets);
  },

  restoreHiddenCommands: (cwd) => {
    const key = presetKey(cwd);
    const state = get();
    const folder = state.commandPresets[key];
    if (!folder?.hidden.length) return;
    const commandPresets = {
      ...state.commandPresets,
      [key]: { ...folder, hidden: [] },
    };
    if (folder.presets.length === 0) delete commandPresets[key];
    set({ commandPresets });
    void saveCommandPresets(commandPresets);
  },

  focusAgent: (agentId) => {
    const state = get();
    const agent = state.agents[agentId];
    if (!agent) return;
    const wsId = agent.workspaceId;
    const pane = findPaneByAgent(state.layouts[wsId] ?? null, agentId);
    const switchingWs = wsId !== state.activeWorkspaceId;
    set({
      ...(switchingWs
        ? { activeWorkspaceId: wsId, focusedAgentId: null }
        : {}),
      ...(pane
        ? { activePaneIds: { ...state.activePaneIds, [wsId]: pane.id } }
        : {}),
    });
    if (switchingWs) schedulePersistWorkspaces();
    if (agent.attention) {
      get().setAttention(agentId, false);
    }
  },

  setFocusedAgent: (agentId) => {
    if (agentId) get().focusAgent(agentId);
    set({ focusedAgentId: agentId });
  },

  setActivePane: (paneId) => {
    const state = get();
    const wsId = state.activeWorkspaceId;
    const pane = collectPanes(state.layouts[wsId] ?? null).find(
      (p) => p.id === paneId,
    );
    set({ activePaneIds: { ...state.activePaneIds, [wsId]: paneId } });
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

  setGitInfo: (agentId, git) => {
    const state = get();
    const agent = state.agents[agentId];
    if (!agent) return;
    // polled every few seconds — only touch the store when something changed
    const prev = agent.git;
    const same =
      prev === git ||
      (!!prev &&
        !!git &&
        prev.repo === git.repo &&
        prev.branch === git.branch &&
        prev.insertions === git.insertions &&
        prev.deletions === git.deletions &&
        prev.untracked === git.untracked &&
        prev.remote_url === git.remote_url);
    if (same) return;
    set({ agents: { ...state.agents, [agentId]: { ...agent, git } } });
  },

  clearUsageHistory: () => {
    set({ usageHistory: {} });
    void saveUsageHistory([]);
  },

  updateSettings: (patch) => {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    void saveSettings(settings);
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
    const base =
      agent.fontSize ?? state.settings.defaultFontSize ?? DEFAULT_FONT_SIZE;
    const fontSize =
      delta === "reset"
        ? undefined
        : Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, base + delta));
    if (fontSize === agent.fontSize) return;
    set({ agents: { ...state.agents, [agentId]: { ...agent, fontSize } } });
  },

  setSizes: (workspaceId, splitId, sizes) => {
    const state = get();
    const layout = state.layouts[workspaceId];
    if (!layout) return;
    set({
      layouts: {
        ...state.layouts,
        [workspaceId]: setSplitSizes(layout, splitId, sizes),
      },
    });
  },

  movePane: (workspaceId, srcPaneId, targetPaneId, zone) => {
    const state = get();
    const layout = state.layouts[workspaceId];
    if (!layout) return;
    set({
      layouts: {
        ...state.layouts,
        [workspaceId]: movePaneInLayout(layout, srcPaneId, targetPaneId, zone),
      },
    });
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
  setFileDrag: (drag) => {
    // drag-over fires at mouse-move rate — only re-render on actual changes
    const cur = get().fileDrag;
    if (!!cur === !!drag && cur?.targetId === drag?.targetId) return;
    set({ fileDrag: drag });
  },
}));

/**
 * Tear a workspace down: kill its agents (terminals + their floating
 * terminals; detached floats survive), drop its layout, and keep the app in a
 * valid state — at least one workspace always exists, and closing the active
 * tab activates its neighbour.
 */
function closeWorkspace(id: string) {
  const store = useSwarm.getState();
  if (!store.workspaces[id]) return;
  const agentIds = store.order.filter(
    (aid) => store.agents[aid]?.workspaceId === id,
  );

  // owned floating terminals die with their agents (this also kills their PTYs)
  for (const tid of [...store.floatingOrder]) {
    const t = useSwarm.getState().floatingTerminals[tid];
    if (t?.agentId && agentIds.includes(t.agentId)) {
      store.removeFloatingTerminal(tid);
    }
  }
  for (const aid of agentIds) destroyTerm(aid);

  const state = useSwarm.getState();
  const agents = { ...state.agents };
  for (const aid of agentIds) delete agents[aid];
  const order = state.order.filter((aid) => !agentIds.includes(aid));

  const workspaces = { ...state.workspaces };
  delete workspaces[id];
  const layouts = { ...state.layouts };
  delete layouts[id];
  const activePaneIds = { ...state.activePaneIds };
  delete activePaneIds[id];
  let workspaceOrder = state.workspaceOrder.filter((w) => w !== id);
  let activeWorkspaceId = state.activeWorkspaceId;
  let workspaceCounter = state.workspaceCounter;

  if (workspaceOrder.length === 0) {
    const fresh: Workspace = {
      id: nanoid(8),
      name: `Workspace ${++workspaceCounter}`,
    };
    workspaces[fresh.id] = fresh;
    layouts[fresh.id] = null;
    activePaneIds[fresh.id] = null;
    workspaceOrder = [fresh.id];
    activeWorkspaceId = fresh.id;
  } else if (activeWorkspaceId === id) {
    const oldIdx = state.workspaceOrder.indexOf(id);
    activeWorkspaceId =
      workspaceOrder[Math.min(Math.max(oldIdx - 1, 0), workspaceOrder.length - 1)];
  }

  useSwarm.setState({
    agents,
    order,
    workspaces,
    workspaceOrder,
    layouts,
    activePaneIds,
    activeWorkspaceId,
    workspaceCounter,
    focusedAgentId:
      state.focusedAgentId && agentIds.includes(state.focusedAgentId)
        ? null
        : state.focusedAgentId,
  });
  schedulePersistWorkspaces();
}
