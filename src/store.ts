import { create } from "zustand";
import { nanoid } from "nanoid";
import {
  IS_TAURI,
  loadCommandPresets,
  loadCustomCommands,
  loadGrid,
  loadProfiles,
  loadQuickNotes,
  loadSettings,
  loadUsageHistory,
  loadWorkspacePresets,
  loadWorkspaces,
  ptyHasChildren,
  saveCommandPresets,
  saveCustomCommands,
  saveGrid,
  saveProfiles,
  saveQuickNotes,
  saveSettings,
  saveUsageHistory,
  saveWorkspacePresets,
  saveWorkspaces,
} from "@/lib/transport";
import type {
  Agent,
  AgentRuntime,
  AgentStatus,
  AppSettings,
  ClaudeActivity,
  CommandPreset,
  CustomCommand,
  CustomCommandsData,
  DictationState,
  FloatingTerminal,
  FolderCommands,
  GitInfo,
  LayoutNode,
  LocalSttStatus,
  NoteItem,
  OpenrouterKeyStatus,
  PersistedGrid,
  PresetLayoutNode,
  Profile,
  QuickNotesData,
  SessionUsage,
  UsageHistoryEntry,
  Workspace,
  WorkspacePreset,
  WorktreeEntry,
  WorktreeMeta,
  WorktreeStatus,
} from "@/types";
import { listWorktrees, removeWorktree, worktreeStatus } from "@/lib/worktree";
import { pushFleetEvent } from "@/lib/events";
import {
  flushOrchestratorPersist,
  hydrateOrchestratorChats,
} from "@/lib/orchestrator/chat-store";
import {
  flushVibePersist,
  hydrateVibeSessions,
} from "@/lib/vibe/session-store";
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
import {
  presetLayoutFromGrid,
  presetNeedsFolder,
  seedPresets,
} from "@/lib/presets";
import { folderName, pickColor, runtimeFromStartup } from "@/lib/utils";

// Built-in fallbacks — the effective defaults are settings.defaultRuntime +
// settings.defaultStartup (Settings dialog). Fresh installs default to Codex
// in full-access mode so new panes are ready for unattended agent work.
export const DEFAULT_RUNTIME: AgentRuntime = "codex";
export const DEFAULT_STARTUP = "claude --dangerously-skip-permissions";
export const DEFAULT_CODEX_STARTUP =
  "codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen";
export const CODEX_WORKSPACE_STARTUP =
  "codex --sandbox workspace-write --ask-for-approval on-request --no-alt-screen";
export const CODEX_READONLY_STARTUP =
  "codex --sandbox read-only --ask-for-approval on-request --no-alt-screen";

export function defaultStartupForRuntime(runtime: AgentRuntime): string {
  if (runtime === "codex") return DEFAULT_CODEX_STARTUP;
  if (runtime === "claude") return DEFAULT_STARTUP;
  return "";
}

// Per-pane terminal zoom (⌘+/⌘−). The effective default is settings.defaultFontSize.
export const DEFAULT_FONT_SIZE = 12.5;
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 28;

// Keep the persisted usage history bounded; oldest sessions fall off first.
const MAX_HISTORY_ENTRIES = 1000;

function runtimeOf(startup: string | undefined, runtime?: AgentRuntime): AgentRuntime {
  return runtime ?? runtimeFromStartup(startup);
}

function normalizeLoadedSettings(settings: AppSettings): AppSettings {
  if (settings.defaultRuntime !== undefined) return settings;
  if (settings.defaultStartup !== undefined) {
    return {
      ...settings,
      defaultRuntime: runtimeFromStartup(settings.defaultStartup),
    };
  }
  return {
    ...settings,
    defaultRuntime: "claude",
  };
}

function codexStandardProfiles(): Profile[] {
  return [
    {
      id: nanoid(8),
      name: "Codex · YOLO",
      runtime: "codex",
      startup: DEFAULT_CODEX_STARTUP,
      color: pickColor(4),
    },
    {
      id: nanoid(8),
      name: "Codex · workspace",
      runtime: "codex",
      startup: CODEX_WORKSPACE_STARTUP,
      color: pickColor(3),
    },
    {
      id: nanoid(8),
      name: "Codex · read-only",
      runtime: "codex",
      startup: CODEX_READONLY_STARTUP,
      color: pickColor(2),
    },
  ];
}

function withCodexStandardProfiles(profiles: Profile[]): Profile[] {
  const existingStartups = new Set(profiles.map((p) => p.startup.trim()));
  const missing = codexStandardProfiles().filter(
    (p) => !existingStartups.has(p.startup),
  );
  return missing.length ? [...profiles, ...missing] : profiles;
}

function usageHistoryKey(runtime: AgentRuntime | undefined, sessionId: string): string {
  return `${runtime ?? "claude"}:${sessionId}`;
}

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

/** Replace one quick-notes list; emptied folder lists drop their key. */
function withNoteList(
  data: QuickNotesData,
  folderKey: string | null,
  list: NoteItem[],
): QuickNotesData {
  if (!folderKey) return { ...data, global: list };
  const folders = { ...data.folders, [folderKey]: list };
  if (list.length === 0) delete folders[folderKey];
  return { ...data, folders };
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

/**
 * Restore-relevant snapshot of the live grid: agent panes + tiling trees.
 * Persisted continuously (debounced) and flushed on quit (lib/quit.ts), so a
 * restart — or a crash — can respawn every pane and resume its agent session.
 */
function snapshotGrid(): PersistedGrid {
  const s = useSwarm.getState();
  return {
    version: 1,
    agents: s.order
      .map((id) => s.agents[id])
      .filter((a): a is Agent => !!a)
      .map((a) => ({
        id: a.id,
        runtime: a.runtime,
        name: a.name,
        renamed: a.renamed,
        workspaceId: a.workspaceId,
        cwd: a.cwd,
        startup: a.startup,
        color: a.color,
        profileId: a.profileId,
        fontSize: a.fontSize,
        sessionId: a.sessionId,
        worktree: a.worktree,
      })),
    layouts: s.layouts,
    activePaneIds: s.activePaneIds,
  };
}

let persistGridTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersistGrid() {
  if (persistGridTimer) return;
  persistGridTimer = setTimeout(() => {
    persistGridTimer = null;
    void saveGrid(snapshotGrid());
  }, 500);
}

/**
 * Write every debounced slice NOW — quit must not lose any debounce window.
 * The grid alone isn't enough: a tab renamed (or a workspace created) right
 * before ⌘Q would otherwise leave a grid snapshot referencing a workspace
 * that never made it into the `workspaces` key, and the restore would
 * silently drop those panes.
 */
export async function flushAllPersists(): Promise<void> {
  if (persistGridTimer) {
    clearTimeout(persistGridTimer);
    persistGridTimer = null;
  }
  if (persistWorkspacesTimer) {
    clearTimeout(persistWorkspacesTimer);
    persistWorkspacesTimer = null;
  }
  if (persistHistoryTimer) {
    clearTimeout(persistHistoryTimer);
    persistHistoryTimer = null;
  }
  const s = useSwarm.getState();
  try {
    await Promise.all([
      saveGrid(snapshotGrid()),
      saveWorkspaces({
        workspaces: s.workspaceOrder
          .map((id) => s.workspaces[id])
          .filter((w): w is Workspace => !!w),
        activeId: s.activeWorkspaceId,
      }),
      saveUsageHistory(
        Object.values(s.usageHistory)
          .sort((a, b) => b.last_updated - a.last_updated)
          .slice(0, MAX_HISTORY_ENTRIES),
      ),
      // the orchestrator chat sidebar keeps its own debounced slice
      flushOrchestratorPersist(),
      // the vibe-mode sessions keep their own debounced slice
      flushVibePersist(),
    ]);
  } catch {
    /* never block quitting on a failed write */
  }
}

interface CreateAgentOpts {
  name?: string;
  runtime?: AgentRuntime;
  cwd?: string;
  startup?: string;
  profileId?: string;
  color?: string;
  /** the pane lives in this SwarmZ-managed worktree (cwd = worktree path) */
  worktree?: WorktreeMeta;
}

/** Values the New Agent dialog opens with (e.g. inherited from the pane being split). */
export interface NewAgentPrefill {
  runtime?: AgentRuntime;
  cwd?: string;
  profileId?: string;
  startup?: string;
  /** set when the dialog was opened via a split button — the new pane splits in this direction */
  direction?: "row" | "column";
  /** preselect the worktree toggle (split from a worktree pane) */
  worktree?: boolean;
}

/**
 * Worktrees scheduled for deletion once their pane actually closes — decided
 * in requestRemoveAgent (clean) or the CloseWorktreeDialog (user picked
 * delete), executed in removeAgent. Module-level so a cancel anywhere in the
 * close flow (e.g. the floating-terminal dialog) can drop the entry again.
 */
const pendingWorktreeCleanup = new Map<
  string,
  WorktreeMeta & {
    path: string;
    /** true = the user explicitly chose "delete" in the dialog; false = a
     * silent clean-at-decision-time verdict, which removeAgent re-checks
     * right before executing (the decision may be minutes old by then) */
    confirmed: boolean;
  }
>();

export interface SwarmState {
  agents: Record<string, Agent>;
  order: string[];
  /** workspace tabs — name/order/defaultCwd persist */
  workspaces: Record<string, Workspace>;
  workspaceOrder: string[];
  activeWorkspaceId: string;
  /** tiling tree per workspace — snapshotted with the agents for restore-on-launch */
  layouts: Record<string, LayoutNode | null>;
  /** active pane per workspace */
  activePaneIds: Record<string, string | null>;
  /** fleet overview: every workspace rendered live as a scaled card (⌘E) */
  fleetOpen: boolean;
  /** command palette (⌘K) */
  paletteOpen: boolean;
  /** insert-command picker (⌘⇧K) — pastes a custom command into the active pane */
  commandPickerOpen: boolean;
  /** command picked in ⌘K that still needs its {{input}} values — consumed when the picker opens (in-memory) */
  commandPickerPreselect: { cmd: CustomCommand; submit: boolean } | null;
  /** workspace pending close while it still contains agents */
  closeWorkspaceConfirm: { id: string } | null;
  /** tab highlighted as drop target while a pane is dragged over it */
  tabDropTarget: string | null;
  /** focus mode: this agent's pane is enlarged as an overlay above the grid (in-memory) */
  focusedAgentId: string | null;
  profiles: Profile[];
  /** named workspace blueprints, loadable from the empty-workspace screen (persisted) */
  workspacePresets: WorkspacePreset[];
  /** preset waiting for a folder choice before loading (LoadPresetDialog) */
  loadPresetRequest: string | null;
  /** "save workspace as preset" name dialog */
  savePresetOpen: boolean;
  /** all-time usage of agent sessions launched inside SwarmZ, keyed by runtime+session id */
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
  /** custom prompt snippets for the insert picker — global + per folder (persisted) */
  customCommands: CustomCommandsData;
  /** quick notes (checklists) — global + per project folder (persisted) */
  quickNotes: QuickNotesData;
  /** quick-notes drawer (title bar / ⌘N) */
  notesOpen: boolean;
  /** pending "close agent" that needs a decision about running floating terminals */
  closeConfirm: { agentId: string; termIds: string[] } | null;
  /** pending app-quit while these agents are still working (see lib/quit.ts) */
  quitConfirm: string[] | null;
  /**
   * OS file drag in progress (see lib/dnd.ts): targetId is the pty id of the
   * drop zone under the cursor, null while hovering elsewhere (in-memory)
   */
  fileDrag: { targetId: string | null } | null;
  /** voice dictation in flight (see lib/dictation.ts) — one at a time (in-memory) */
  dictation: DictationState | null;
  /** OpenRouter key state — null until the first check; gates all dictation UI (in-memory) */
  openrouterStatus: OpenrouterKeyStatus | null;
  /** local speech model state — null until the first check; gates dictation UI when engine = "local" (in-memory) */
  localSttStatus: LocalSttStatus | null;
  /** SwarmZ worktrees on disk (title-bar panel + icon visibility) — refreshed on demand (in-memory) */
  worktrees: WorktreeEntry[];
  /** pane close waiting on a keep-vs-delete decision for its worktree */
  closeWorktreeConfirm: { agentId: string; status: WorktreeStatus } | null;
  /** pane close waiting on confirmation because an agent is still working in it */
  closeBusyConfirm: string | null;

  // derived helpers
  activeAgentId: () => string | null;
  /** project root of the active pane (worktree → main repo), or the workspace default */
  activeProjectRoot: () => string | null;

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
  resolveCloseWorkspace: (choice: "cancel" | "close" | "cleanup-safe") => void;
  /** move an agent's pane into another workspace (splits its active pane) */
  moveAgentToWorkspace: (agentId: string, workspaceId: string) => void;
  /** jump to the next agent that needs attention, across all workspaces (⌘⇧A) */
  attentionJump: () => void;
  /** cycle panes in the active workspace, layout order + wrap (⌘] / ⌘[) */
  cycleActivePane: (delta: 1 | -1) => void;
  setFleetOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setCommandPickerOpen: (open: boolean) => void;
  setCommandPickerPreselect: (
    pre: { cmd: CustomCommand; submit: boolean } | null,
  ) => void;
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
  /** resolve the busy-pane close warning (true = close anyway) */
  resolveCloseBusy: (close: boolean) => void;
  /** open/close the quit warning (busy agent ids; null = dismissed) */
  setQuitConfirm: (agentIds: string[] | null) => void;

  // git worktrees
  /** resolve the keep-vs-delete decision of a closing worktree pane */
  resolveCloseWorktree: (choice: "keep" | "delete" | "cancel") => void;
  /** rescan all known repos for SwarmZ worktrees (panel + icon visibility) */
  refreshWorktrees: () => Promise<void>;
  /** remember a repo root for the worktree scan (persisted in settings) */
  registerWorktreeRepo: (root: string) => void;
  /** delete a worktree from the management panel (folder + branch) */
  deleteWorktree: (entry: WorktreeEntry) => Promise<void>;
  /** delete every safe, unattached worktree currently shown in the panel */
  cleanupSafeWorktrees: (root?: string) => Promise<void>;

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

  // custom commands (insert picker, ⌘⇧K)
  /** create a snippet, or update one in place when `id` is given; folderKey null = global */
  saveCustomCommand: (
    folderKey: string | null,
    label: string,
    text: string,
    id?: string,
  ) => void;
  deleteCustomCommand: (folderKey: string | null, id: string) => void;

  // quick notes (title-bar drawer, ⌘N) — folderKey null = global
  setNotesOpen: (open: boolean) => void;
  addNote: (folderKey: string | null, text: string) => void;
  updateNote: (
    folderKey: string | null,
    id: string,
    patch: Partial<Omit<NoteItem, "id">>,
  ) => void;
  deleteNote: (folderKey: string | null, id: string) => void;
  /** reorder within a list: move note `id` to position `toIndex` */
  moveNote: (folderKey: string | null, id: string, toIndex: number) => void;
  /** drop every checked-off item of a list */
  clearDoneNotes: (folderKey: string | null) => void;

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
  /** Replace a workspace's tiling tree wholesale (orchestrator create_panes
   * balancing) — agents keep their PTYs; only pane node placement changes. */
  setWorkspaceLayout: (
    workspaceId: string,
    layout: LayoutNode | null,
    activeAgentId?: string,
  ) => void;

  // profiles
  saveProfile: (p: Omit<Profile, "id"> & { id?: string }) => void;
  deleteProfile: (id: string) => void;

  // workspace presets
  /** load a preset: asks for a folder first when a pane inherits its cwd */
  requestLoadPreset: (presetId: string) => void;
  /** spawn a preset's panes — into the active workspace if empty, else a new tab */
  applyPreset: (presetId: string, folder?: string) => void;
  setLoadPresetRequest: (presetId: string | null) => void;
  setSavePresetOpen: (open: boolean) => void;
  /** snapshot the active workspace's grid as a new preset */
  saveWorkspacePreset: (name: string) => void;
  updateWorkspacePreset: (preset: WorkspacePreset) => void;
  deleteWorkspacePreset: (id: string) => void;

  // ui
  /** switch the app-wide view (grid tiling wall ↔ vibe sessions); persisted via settings */
  setUiMode: (mode: "grid" | "vibe") => void;
  setDashboardOpen: (open: boolean) => void;
  setNewAgentOpen: (open: boolean) => void;
  setFileDrag: (drag: { targetId: string | null } | null) => void;
  setDictation: (d: DictationState | null) => void;
  setOpenrouterStatus: (status: OpenrouterKeyStatus | null) => void;
  setLocalSttStatus: (status: LocalSttStatus | null) => void;
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
  commandPickerOpen: false,
  commandPickerPreselect: null,
  closeWorkspaceConfirm: null,
  tabDropTarget: null,
  focusedAgentId: null,
  profiles: [],
  workspacePresets: [],
  loadPresetRequest: null,
  savePresetOpen: false,
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
  customCommands: { global: [], folders: {} },
  quickNotes: { global: [], folders: {} },
  notesOpen: false,
  closeConfirm: null,
  quitConfirm: null,
  fileDrag: null,
  dictation: null,
  openrouterStatus: null,
  localSttStatus: null,
  worktrees: [],
  closeWorktreeConfirm: null,
  closeBusyConfirm: null,

  activeAgentId: () => {
    const { layouts, activePaneIds, activeWorkspaceId } = get();
    const paneId = activePaneIds[activeWorkspaceId];
    if (!paneId) return null;
    const pane = collectPanes(layouts[activeWorkspaceId] ?? null).find(
      (p) => p.id === paneId,
    );
    return pane?.agentId ?? null;
  },

  activeProjectRoot: () => {
    const s = get();
    const id = s.activeAgentId();
    const agent = id ? s.agents[id] : undefined;
    // a worktree pane counts as its main repo — notes belong to the project,
    // not the throwaway .worktrees/<slug> folder
    return (
      agent?.worktree?.root ??
      agent?.cwd ??
      s.workspaces[s.activeWorkspaceId]?.defaultCwd ??
      null
    );
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
    if (hasAgents) set({ closeWorkspaceConfirm: { id } });
    else closeWorkspace(id);
  },

  resolveCloseWorkspace: (choice) => {
    const id = get().closeWorkspaceConfirm?.id;
    set({ closeWorkspaceConfirm: null });
    if (choice !== "cancel" && id) closeWorkspace(id, choice === "cleanup-safe");
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
    schedulePersistGrid();
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

  cycleActivePane: (delta) => {
    const s = get();
    const panes = collectPanes(s.layouts[s.activeWorkspaceId] ?? null);
    if (panes.length === 0) return;
    const activePane = s.activePaneIds[s.activeWorkspaceId] ?? null;
    const idx = panes.findIndex((p) => p.id === activePane);
    // stale/missing active pane starts the cycle from the first pane
    const next = panes[(Math.max(idx, 0) + delta + panes.length) % panes.length];
    if (!next) return;
    // in focus mode the shortcut moves the zoomed pane along
    if (s.focusedAgentId) get().setFocusedAgent(next.agentId);
    else get().focusAgent(next.agentId);
    focusTerm(next.agentId);
  },

  setFleetOpen: (open) =>
    set(open ? { fleetOpen: true, focusedAgentId: null } : { fleetOpen: false }),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setCommandPickerOpen: (open) => set({ commandPickerOpen: open }),
  setCommandPickerPreselect: (pre) => set({ commandPickerPreselect: pre }),
  setTabDropTarget: (id) => {
    if (get().tabDropTarget !== id) set({ tabDropTarget: id });
  },

  hydrate: async () => {
    try {
      const settings = await loadSettings();
      if (settings) set({ settings: normalizeLoadedSettings(settings) });
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
      // restore the last grid: rebuild every persisted pane — mounting them
      // spawns the PTYs, and TerminalView appends `--resume` (agent.resume)
      // so each tracked agent pane reopens its previous conversation
      const grid = await loadGrid();
      const state = get();
      if (
        state.settings.restoreAgents === true &&
        state.order.length === 0 && // nothing spawned before hydrate resolved
        grid?.agents?.length
      ) {
        // field-level hardening: one malformed entry (older build, partial
        // corruption) must only cost that entry, never the whole restore —
        // entries without a usable id/workspaceId are skipped, everything
        // else gets a safe default
        const saved = new Map(
          grid.agents
            .filter(
              (a) =>
                a &&
                typeof a.id === "string" &&
                typeof a.workspaceId === "string",
            )
            .map((a) => [
              a.id,
              {
                ...a,
                name: typeof a.name === "string" ? a.name : "Agent",
                startup: typeof a.startup === "string" ? a.startup : "",
                color: typeof a.color === "string" ? a.color : pickColor(0),
              },
            ]),
        );
        const agents: Record<string, Agent> = {};
        const order: string[] = [];
        const layouts = { ...state.layouts };
        const activePaneIds = { ...state.activePaneIds };
        // walk the persisted trees — panes whose agent (or workspace) didn't
        // make it back are pruned, agents in no pane are dropped, so even a
        // torn snapshot restores to something consistent
        for (const wsId of state.workspaceOrder) {
          // per-workspace guard: a corrupt tree skips this workspace only
          try {
            let layout = grid.layouts?.[wsId] ?? null;
            for (const pane of collectPanes(layout)) {
              const p = saved.get(pane.agentId);
              if (!p || p.workspaceId !== wsId || agents[p.id]) {
                layout = removePaneByAgent(layout, pane.agentId);
                continue;
              }
              agents[p.id] = {
                id: p.id,
                runtime: runtimeOf(p.startup, p.runtime),
                name: p.name,
                renamed: p.renamed,
                workspaceId: wsId,
                cwd: p.cwd,
                startup: p.startup,
                color: p.color,
                status: "starting",
                attention: false,
                createdAt: Date.now(),
                profileId: p.profileId,
                fontSize: p.fontSize,
                // the pane IS that session again — usage latches right back on
                sessionId: p.sessionId,
                resume: p.sessionId,
                worktree: p.worktree,
              };
              order.push(p.id);
            }
            const panes = collectPanes(layout);
            // a tree whose panes were all pruned must become null — a
            // zero-pane layout would otherwise swallow future createAgent
            // calls (no target pane → invisible orphan agents)
            layouts[wsId] = panes.length ? layout : null;
            const active = grid.activePaneIds?.[wsId];
            activePaneIds[wsId] =
              panes.find((pn) => pn.id === active)?.id ?? panes[0]?.id ?? null;
          } catch {
            layouts[wsId] = null;
            activePaneIds[wsId] = null;
          }
        }
        if (order.length) {
          // keep default names unique after the restore ("Agent 3" twice)
          let counter = state.agentCounter;
          for (const id of order) {
            const m = /^Agent (\d+)$/.exec(agents[id].name);
            if (m) counter = Math.max(counter, Number(m[1]));
          }
          set({ agents, order, layouts, activePaneIds, agentCounter: counter });
        }
      }
    } catch {
      /* ignore */
    }
    try {
      const history = await loadUsageHistory();
      if (history?.length) {
        const map: Record<string, UsageHistoryEntry> = {};
        for (const e of history) {
          map[usageHistoryKey(e.runtime ?? "claude", e.session_id)] = e;
        }
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
      const cc = await loadCustomCommands();
      if (cc) {
        set({
          customCommands: { global: cc.global ?? [], folders: cc.folders ?? {} },
        });
      }
    } catch {
      /* ignore */
    }
    try {
      const notes = await loadQuickNotes();
      if (notes) {
        set({
          quickNotes: { global: notes.global ?? [], folders: notes.folders ?? {} },
        });
      }
    } catch {
      /* ignore */
    }
    try {
      // orchestrator chat sidebar — hydrates its own store (chat-store.ts)
      await hydrateOrchestratorChats();
    } catch {
      /* ignore */
    }
    try {
      // vibe-mode native codex sessions — hydrates its own store
      await hydrateVibeSessions();
    } catch {
      /* ignore */
    }
    try {
      // null = key never written → seed the starter grids; a saved empty
      // list means the user deleted them all — don't resurrect
      const presets = await loadWorkspacePresets();
      if (presets) {
        set({ workspacePresets: presets });
      } else {
        const seed = seedPresets();
        set({ workspacePresets: seed });
        void saveWorkspacePresets(seed);
      }
    } catch {
      /* ignore */
    }
    // initial worktree scan — restores the title-bar panel/icon (also for
    // orphans whose pane never came back)
    void get().refreshWorktrees();
    try {
      const saved = await loadProfiles();
      if (saved && saved.length) {
        const profiles = withCodexStandardProfiles(
          saved.map((p) => ({
            ...p,
            runtime: runtimeOf(p.startup, p.runtime),
          })),
        );
        set({ profiles });
        if (profiles.length !== saved.length) void saveProfiles(profiles);
        return;
      }
    } catch {
      /* ignore */
    }
    const seed: Profile[] = [
      ...codexStandardProfiles(),
      {
        id: nanoid(8),
        name: "Claude · skip permissions",
        runtime: "claude",
        startup: DEFAULT_STARTUP,
        color: pickColor(0),
      },
      {
        id: nanoid(8),
        name: "Claude · plain",
        runtime: "claude",
        startup: "claude",
        color: pickColor(6),
      },
      {
        id: nanoid(8),
        name: "Shell",
        runtime: "shell",
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
    const startup =
      opts.startup ??
      profile?.startup ??
      state.settings.defaultStartup ??
      defaultStartupForRuntime(state.settings.defaultRuntime ?? DEFAULT_RUNTIME);
    const runtime = runtimeOf(startup, opts.runtime ?? profile?.runtime);
    const agent: Agent = {
      id,
      runtime,
      name: opts.name?.trim() || `Agent ${n}`,
      workspaceId: wsId,
      // a name typed in the dialog wins over captured terminal titles
      renamed: !!opts.name?.trim(),
      cwd: opts.cwd || profile?.defaultCwd,
      startup,
      color: opts.color || profile?.color || pickColor(n),
      status: "starting",
      attention: false,
      createdAt: Date.now(),
      profileId: opts.profileId,
      worktree: opts.worktree,
    };
    // for tab naming / default cwd / last-used folder, a worktree pane
    // counts as its main repo — never the .worktrees/<slug> path
    const projectCwd = agent.worktree?.root ?? agent.cwd;

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
    if (ws && projectCwd && !ws.defaultCwd) {
      workspaces = {
        ...workspaces,
        [wsId]: {
          ...ws,
          defaultCwd: projectCwd,
          ...(ws.renamed ? {} : { name: folderName(projectCwd) }),
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
    schedulePersistGrid();
    if (projectCwd) get().updateSettings({ lastCwd: projectCwd });
    if (agent.worktree) get().registerWorktreeRepo(agent.worktree.root);
    pushFleetEvent({
      kind: "created",
      paneId: id,
      paneName: agent.name,
      workspaceId: wsId,
    });
    return id;
  },

  removeAgent: (agentId) => {
    const state = get();
    const agent = state.agents[agentId];
    if (!agent) return;
    // Deck ticker: closing a still-live pane ends it; already-exited panes
    // logged their event in setStatus
    if (agent.status !== "exited") {
      pushFleetEvent({
        kind: "exited",
        paneId: agentId,
        paneName: agent.name,
        workspaceId: agent.workspaceId,
      });
    }
    // a worktree marked for cleanup dies with its pane (folder + branch)
    const cleanup = pendingWorktreeCleanup.get(agentId);
    pendingWorktreeCleanup.delete(agentId);
    // panes only detach on unmount — the terminal + PTY die here (before the
    // cleanup below, so nothing can write into the worktree anymore)
    destroyTerm(agentId);
    if (cleanup) {
      const gitBin = state.settings.gitPath?.trim() || undefined;
      void (async () => {
        try {
          if (!cleanup.confirmed) {
            // the silent "clean" verdict may be minutes old — confirm
            // dialogs can sit open while an agent keeps writing. Re-check,
            // and on doubt keep the worktree (it shows up as unattached
            // in the panel instead of being force-deleted)
            const st = await worktreeStatus(cleanup.path, gitBin);
            if (st.exists && (st.dirty || st.ahead > 0)) return;
          }
          await removeWorktree({
            root: cleanup.root,
            path: cleanup.path,
            branch: cleanup.branch,
            gitBin,
          });
        } catch {
          /* can't tell / removal failed — keep the worktree */
        } finally {
          void get().refreshWorktrees();
        }
      })();
    }
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
      // confirm dialogs must not outlive their target — their buttons would
      // resolve against a dead id and silently no-op
      closeConfirm:
        state.closeConfirm?.agentId === agentId ? null : state.closeConfirm,
      closeWorktreeConfirm:
        state.closeWorktreeConfirm?.agentId === agentId
          ? null
          : state.closeWorktreeConfirm,
      closeBusyConfirm:
        state.closeBusyConfirm === agentId ? null : state.closeBusyConfirm,
    });
    schedulePersistGrid();
  },

  requestRemoveAgent: (agentId) => {
    const state = get();
    const agent = state.agents[agentId];
    if (!agent) return;
    // a misclick on ✕/⌘W must not interrupt a running agent job — ask
    // first (the quit guard exists for exactly the same reason)
    if (agent.activity === "busy" && agent.status !== "exited") {
      set({ closeBusyConfirm: agentId });
      return;
    }
    proceedRemoveAgent(agentId);
  },

  resolveCloseBusy: (close) => {
    const agentId = get().closeBusyConfirm;
    set({ closeBusyConfirm: null });
    if (!close || !agentId) return;
    proceedRemoveAgent(agentId);
  },

  resolveCloseWorktree: (choice) => {
    const confirm = get().closeWorktreeConfirm;
    if (!confirm) return;
    set({ closeWorktreeConfirm: null });
    if (choice === "cancel") return;
    const agent = get().agents[confirm.agentId];
    if (!agent) return;
    if (choice === "delete" && agent.worktree && agent.cwd) {
      // explicit user decision — removeAgent executes it without a re-check
      pendingWorktreeCleanup.set(confirm.agentId, {
        ...agent.worktree,
        path: agent.cwd,
        confirmed: true,
      });
    }
    // "keep" closes the pane and leaves the worktree on disk — it shows up
    // as unattached in the title-bar worktree panel
    continueRemoveAgent(confirm.agentId);
  },

  refreshWorktrees: async () => {
    if (!IS_TAURI) return;
    const state = get();
    // persisted registry ∪ roots of live worktree panes (covers a fresh
    // worktree whose settings write hasn't landed yet)
    const roots = new Set(state.settings.worktreeRepos ?? []);
    for (const id of state.order) {
      const root = state.agents[id]?.worktree?.root;
      if (root) roots.add(root);
    }
    if (roots.size === 0) {
      if (get().worktrees.length) set({ worktrees: [] });
      return;
    }
    try {
      const scan = await listWorktrees(
        [...roots],
        state.settings.gitPath?.trim() || undefined,
      );
      set({ worktrees: scan.entries });
      // prune registry roots with nothing left — the title-bar icon
      // disappears again once every worktree is gone. Only roots whose
      // scan actually succeeded may be pruned (an unmounted volume or a
      // broken git override is not "no worktrees"), and the prune is
      // computed against the *current* registry, not the pre-await
      // snapshot — a root registered while the scan ran must survive.
      const live = new Set(scan.entries.map((e) => e.root));
      for (const id of get().order) {
        const root = get().agents[id]?.worktree?.root;
        if (root) live.add(root);
      }
      const scanned = new Set(scan.scanned);
      const current = get().settings.worktreeRepos ?? [];
      const kept = current.filter(
        (r) => live.has(r) || !scanned.has(r) || !roots.has(r),
      );
      if (kept.length !== current.length) {
        get().updateSettings({ worktreeRepos: kept });
      }
    } catch {
      /* scan failed (no git?) — keep the last known list */
    }
  },

  registerWorktreeRepo: (root) => {
    const repos = get().settings.worktreeRepos ?? [];
    if (!repos.includes(root)) {
      get().updateSettings({ worktreeRepos: [...repos, root] });
    }
    void get().refreshWorktrees();
  },

  deleteWorktree: async (entry) => {
    try {
      await removeWorktree({
        root: entry.root,
        path: entry.path,
        branch: entry.branch,
        gitBin: get().settings.gitPath?.trim() || undefined,
      });
    } catch {
      /* the refresh below shows what actually happened */
    } finally {
      void get().refreshWorktrees();
    }
  },

  cleanupSafeWorktrees: async (root) => {
    const state = get();
    const openPaths = new Set(
      state.order
        .map((id) => state.agents[id]?.cwd)
        .filter((cwd): cwd is string => !!cwd),
    );
    const entries = state.worktrees.filter(
      (entry) =>
        (!root || entry.root === root) &&
        !openPaths.has(entry.path) &&
        !entry.dirty &&
        entry.ahead === 0,
    );
    if (entries.length === 0) return;
    const gitBin = state.settings.gitPath?.trim() || undefined;
    await Promise.allSettled(
      entries.map(async (entry) => {
        try {
          const st = await worktreeStatus(entry.path, gitBin);
          if (st.exists && (st.dirty || st.ahead > 0)) return;
          await removeWorktree({
            root: entry.root,
            path: entry.path,
            branch: entry.branch,
            gitBin,
          });
        } catch {
          /* on doubt keep the worktree */
        }
      }),
    );
    void get().refreshWorktrees();
  },

  resolveCloseConfirm: (choice) => {
    const confirm = get().closeConfirm;
    if (!confirm) return;
    set({ closeConfirm: null });
    if (choice === "cancel") {
      // also forget a worktree cleanup decided earlier in this close flow
      pendingWorktreeCleanup.delete(confirm.agentId);
      return;
    }
    if (choice === "detach") {
      // the kept process keeps the worktree as its cwd — deleting the
      // folder under a detached dev server would break it with ENOENT
      // noise. The worktree stays and shows as unattached in the panel.
      pendingWorktreeCleanup.delete(confirm.agentId);
    }
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

  saveCustomCommand: (folderKey, label, text, id) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const state = get();
    const list = folderKey
      ? (state.customCommands.folders[folderKey] ?? [])
      : state.customCommands.global;
    const finalLabel = label.trim() || trimmed.split("\n")[0];
    let next: CustomCommand[];
    if (id && list.some((c) => c.id === id)) {
      // edit in place — keeps the item's position
      next = list.map((c) =>
        c.id === id ? { ...c, label: finalLabel, text: trimmed } : c,
      );
    } else {
      next = [...list, { id: nanoid(8), label: finalLabel, text: trimmed }];
    }
    const customCommands: CustomCommandsData = folderKey
      ? {
          ...state.customCommands,
          folders: { ...state.customCommands.folders, [folderKey]: next },
        }
      : { ...state.customCommands, global: next };
    set({ customCommands });
    void saveCustomCommands(customCommands);
  },

  deleteCustomCommand: (folderKey, id) => {
    const state = get();
    let customCommands: CustomCommandsData;
    if (folderKey) {
      const list = (state.customCommands.folders[folderKey] ?? []).filter(
        (c) => c.id !== id,
      );
      const folders = { ...state.customCommands.folders, [folderKey]: list };
      if (list.length === 0) delete folders[folderKey];
      customCommands = { ...state.customCommands, folders };
    } else {
      customCommands = {
        ...state.customCommands,
        global: state.customCommands.global.filter((c) => c.id !== id),
      };
    }
    set({ customCommands });
    void saveCustomCommands(customCommands);
  },

  setNotesOpen: (open) => set({ notesOpen: open }),

  addNote: (folderKey, text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const state = get();
    const list = folderKey
      ? (state.quickNotes.folders[folderKey] ?? [])
      : state.quickNotes.global;
    const quickNotes = withNoteList(state.quickNotes, folderKey, [
      ...list,
      { id: nanoid(8), text: trimmed, done: false },
    ]);
    set({ quickNotes });
    void saveQuickNotes(quickNotes);
  },

  updateNote: (folderKey, id, patch) => {
    const state = get();
    const list = folderKey
      ? (state.quickNotes.folders[folderKey] ?? [])
      : state.quickNotes.global;
    if (!list.some((n) => n.id === id)) return;
    const quickNotes = withNoteList(
      state.quickNotes,
      folderKey,
      list.map((n) => (n.id === id ? { ...n, ...patch, id } : n)),
    );
    set({ quickNotes });
    void saveQuickNotes(quickNotes);
  },

  deleteNote: (folderKey, id) => {
    const state = get();
    const list = folderKey
      ? (state.quickNotes.folders[folderKey] ?? [])
      : state.quickNotes.global;
    const next = list.filter((n) => n.id !== id);
    if (next.length === list.length) return;
    const quickNotes = withNoteList(state.quickNotes, folderKey, next);
    set({ quickNotes });
    void saveQuickNotes(quickNotes);
  },

  moveNote: (folderKey, id, toIndex) => {
    const state = get();
    const list = folderKey
      ? (state.quickNotes.folders[folderKey] ?? [])
      : state.quickNotes.global;
    const from = list.findIndex((n) => n.id === id);
    if (from < 0) return;
    const to = Math.max(0, Math.min(list.length - 1, toIndex));
    if (from === to) return;
    const next = [...list];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    const quickNotes = withNoteList(state.quickNotes, folderKey, next);
    set({ quickNotes });
    void saveQuickNotes(quickNotes);
  },

  clearDoneNotes: (folderKey) => {
    const state = get();
    const list = folderKey
      ? (state.quickNotes.folders[folderKey] ?? [])
      : state.quickNotes.global;
    const next = list.filter((n) => !n.done);
    if (next.length === list.length) return;
    const quickNotes = withNoteList(state.quickNotes, folderKey, next);
    set({ quickNotes });
    void saveQuickNotes(quickNotes);
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
    // Deck ticker: the pane's process ended (closing the pane later is
    // silent then — removeAgent only emits for still-running panes)
    if (status === "exited" && agent.status !== "exited") {
      pushFleetEvent({
        kind: "exited",
        paneId: agentId,
        paneName: agent.name,
        workspaceId: agent.workspaceId,
      });
    }
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
          // bell-only needs-you gets a waiting-since for the triage ordering
          // (OSC "waiting" panes are timestamped by lastBusyEndAt instead)
          waitingSince: on
            ? (agent.waitingSince ??
              (agent.activity !== "waiting" ? Date.now() : undefined))
            : undefined,
        },
      },
    });
    // Deck ticker: bell attention is the other needs-you entry (a pane
    // already "waiting" is deduped by the feed's 3s waiting guard)
    if (on && agent.status !== "exited") {
      pushFleetEvent({
        kind: "waiting",
        paneId: agentId,
        paneName: agent.name,
        workspaceId: agent.workspaceId,
      });
    }
  },

  setActivity: (agentId, activity) => {
    const state = get();
    const agent = state.agents[agentId];
    if (!agent || agent.activity === activity) return;
    const firstBusyAt =
      agent.firstBusyAt ?? (activity === "busy" ? Date.now() : undefined);
    // leaving busy stamps the "just finished" moment (ephemeral green signal)
    const lastBusyEndAt =
      agent.activity === "busy" && activity !== "busy"
        ? Date.now()
        : agent.lastBusyEndAt;
    set({
      agents: {
        ...state.agents,
        [agentId]: { ...agent, activity, firstBusyAt, lastBusyEndAt },
      },
    });
    // Deck ticker: entering needs-you beats a plain finish (busy → waiting
    // emits "waiting", not both); busy → idle is the quiet green "finished"
    if (activity === "waiting") {
      pushFleetEvent({
        kind: "waiting",
        paneId: agentId,
        paneName: agent.name,
        workspaceId: agent.workspaceId,
      });
    } else if (agent.activity === "busy" && activity === "idle") {
      pushFleetEvent({
        kind: "finished",
        paneId: agentId,
        paneName: agent.name,
        workspaceId: agent.workspaceId,
      });
    }
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
    // no agent activity (plain shells, dev servers, …) never get an entry
    let usageHistory = state.usageHistory;
    if (usage.message_count > 0 && usage.session_id) {
      const runtime = agent.runtime ?? usage.runtime ?? "claude";
      const key = usageHistoryKey(runtime, usage.session_id);
      const prev = usageHistory[key];
      const changed =
        !prev ||
        prev.message_count !== usage.message_count ||
        prev.cost_usd !== usage.cost_usd ||
        prev.input_tokens !== usage.input_tokens ||
        prev.output_tokens !== usage.output_tokens ||
        prev.cache_creation_tokens !== usage.cache_creation_tokens ||
        prev.cache_read_tokens !== usage.cache_read_tokens ||
        prev.reasoning_output_tokens !== usage.reasoning_output_tokens ||
        prev.agent_name !== agent.name;
      if (changed) {
        usageHistory = {
          ...usageHistory,
          [key]: {
            runtime,
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
            reasoning_output_tokens: usage.reasoning_output_tokens,
            cost_usd: usage.cost_usd,
            by_model: usage.by_model,
          },
        };
        schedulePersistHistory();
      }
    }

    const titlePatch =
      usage.title && !agent.renamed ? { name: usage.title, title: usage.title } : {};
    // Codex reports activity through usage events — stamp the busy→idle
    // transition here too (Claude's path is setActivity via OSC 9;4)
    const activityPatch = usage.activity
      ? {
          activity: usage.activity,
          ...(agent.activity === "busy" && usage.activity !== "busy"
            ? { lastBusyEndAt: Date.now() }
            : {}),
        }
      : {};
    // Deck ticker — mirror the setActivity transitions for the Codex path
    if (usage.activity && usage.activity !== agent.activity) {
      if (usage.activity === "waiting") {
        pushFleetEvent({
          kind: "waiting",
          paneId: agentId,
          paneName: agent.name,
          workspaceId: agent.workspaceId,
        });
      } else if (agent.activity === "busy" && usage.activity === "idle") {
        pushFleetEvent({
          kind: "finished",
          paneId: agentId,
          paneName: agent.name,
          workspaceId: agent.workspaceId,
        });
      }
    }
    set({
      agents: {
        ...state.agents,
        [agentId]: {
          ...agent,
          ...titlePatch,
          ...activityPatch,
          usage,
          sessionId,
        },
      },
      usageHistory,
    });
    // a freshly latched session id is what makes this pane resumable
    if (sessionId && !agent.sessionId) schedulePersistGrid();
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
    settings.defaultRuntime ??= DEFAULT_RUNTIME;
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
    schedulePersistGrid();
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
    if (!agent.renamed) schedulePersistGrid();
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
    schedulePersistGrid();
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
    schedulePersistGrid();
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
    schedulePersistGrid();
  },

  setWorkspaceLayout: (workspaceId, layout, activeAgentId) => {
    const state = get();
    if (!state.workspaces[workspaceId]) return;
    const panes = collectPanes(layout);
    let activePaneId = state.activePaneIds[workspaceId] ?? null;
    const wanted = activeAgentId
      ? panes.find((p) => p.agentId === activeAgentId)
      : null;
    if (wanted) activePaneId = wanted.id;
    else if (!panes.find((p) => p.id === activePaneId))
      activePaneId = panes[0]?.id ?? null;
    set({
      layouts: { ...state.layouts, [workspaceId]: layout },
      activePaneIds: { ...state.activePaneIds, [workspaceId]: activePaneId },
    });
    schedulePersistGrid();
  },

  splitActive: (direction) => {
    const state = get();
    const activeId = state.activeAgentId();
    const agent = activeId ? state.agents[activeId] : undefined;
    // open the New Agent dialog inheriting the split-source pane's setup.
    // Splitting a worktree pane preselects the worktree toggle on the MAIN
    // repo — "another parallel worker on this project", on a fresh branch
    set({
      newAgentOpen: true,
      newAgentPrefill: {
        runtime: agent?.runtime,
        cwd: agent?.worktree?.root ?? agent?.cwd,
        profileId: agent?.profileId,
        startup: agent?.startup,
        direction,
        worktree: !!agent?.worktree,
      },
    });
  },

  saveProfile: (p) => {
    const state = get();
    const normalized = {
      ...p,
      runtime: runtimeOf(p.startup, p.runtime),
    };
    let profiles: Profile[];
    if (p.id) {
      profiles = state.profiles.map((x) =>
        x.id === p.id ? ({ ...x, ...normalized, id: p.id! } as Profile) : x,
      );
    } else {
      profiles = [...state.profiles, { ...normalized, id: nanoid(8) } as Profile];
    }
    set({ profiles });
    void saveProfiles(profiles);
  },

  deleteProfile: (id) => {
    const profiles = get().profiles.filter((p) => p.id !== id);
    set({ profiles });
    void saveProfiles(profiles);
  },

  requestLoadPreset: (presetId) => {
    const preset = get().workspacePresets.find((p) => p.id === presetId);
    if (!preset) return;
    if (presetNeedsFolder(preset)) set({ loadPresetRequest: presetId });
    else get().applyPreset(presetId);
  },

  applyPreset: (presetId, folder) => {
    const preset = get().workspacePresets.find((p) => p.id === presetId);
    if (!preset) return;
    // fill the active workspace while it's still empty, otherwise open a new tab
    let wsId = get().activeWorkspaceId;
    if (get().layouts[wsId]) {
      wsId = get().createWorkspace({ name: preset.name });
    }
    const state = get();

    // one pass: spawn an agent per pane template and mirror the preset tree
    // into a live layout (same shape, fresh ids)
    let counter = state.agentCounter;
    const agents = { ...state.agents };
    const order = [...state.order];
    const build = (node: PresetLayoutNode): LayoutNode => {
      if (node.type === "split") {
        return {
          type: "split",
          id: nanoid(8),
          direction: node.direction,
          sizes: [...node.sizes],
          children: node.children.map(build),
        };
      }
      const id = nanoid(10);
      const n = ++counter;
      const profile = state.profiles.find((p) => p.id === node.profileId);
      const startup =
        node.startup ??
        state.settings.defaultStartup ??
        defaultStartupForRuntime(state.settings.defaultRuntime ?? DEFAULT_RUNTIME);
      const profileId = profile ? node.profileId : undefined;
      agents[id] = {
        id,
        runtime: runtimeOf(startup, node.runtime ?? profile?.runtime),
        name: node.name?.trim() || `Agent ${n}`,
        renamed: !!node.name?.trim(),
        workspaceId: wsId,
        cwd: node.cwd || folder,
        startup,
        color: node.color || pickColor(n),
        status: "starting",
        attention: false,
        createdAt: Date.now(),
        // the template may reference a profile that's gone — drop it then
        profileId,
      };
      order.push(id);
      return newPane(id);
    };
    const layout = build(preset.layout);
    const firstPaneId = collectPanes(layout)[0]?.id ?? null;

    // the tab takes the preset's name; the asked-for folder (or the first
    // fixed one) becomes its default cwd like a first agent would
    const ws = state.workspaces[wsId];
    const defaultCwd =
      ws?.defaultCwd ??
      folder ??
      order.map((id) => agents[id]).find((a) => a?.workspaceId === wsId && a.cwd)
        ?.cwd;
    const workspaces = ws
      ? {
          ...state.workspaces,
          [wsId]: {
            ...ws,
            name: preset.name.trim() || ws.name,
            renamed: true,
            defaultCwd,
          },
        }
      : state.workspaces;

    set({
      agents,
      order,
      workspaces,
      layouts: { ...state.layouts, [wsId]: layout },
      activePaneIds: { ...state.activePaneIds, [wsId]: firstPaneId },
      agentCounter: counter,
      activeWorkspaceId: wsId,
      loadPresetRequest: null,
      focusedAgentId: null,
      fleetOpen: false,
    });
    schedulePersistWorkspaces();
    schedulePersistGrid();
    if (folder) get().updateSettings({ lastCwd: folder });
    // Deck ticker: preset-built panes are creations too (this path bypasses
    // createAgent, which emits for every other create)
    for (const id of order) {
      const a = agents[id];
      if (a && a.workspaceId === wsId && !state.agents[id]) {
        pushFleetEvent({
          kind: "created",
          paneId: id,
          paneName: a.name,
          workspaceId: wsId,
        });
      }
    }
  },

  setLoadPresetRequest: (presetId) => set({ loadPresetRequest: presetId }),
  setSavePresetOpen: (open) => set({ savePresetOpen: open }),

  saveWorkspacePreset: (name) => {
    const state = get();
    const wsId = state.activeWorkspaceId;
    const layout = state.layouts[wsId];
    if (!layout) return;
    const preset: WorkspacePreset = {
      id: nanoid(8),
      name: name.trim() || state.workspaces[wsId]?.name || "Preset",
      layout: presetLayoutFromGrid(layout, state.agents),
    };
    const workspacePresets = [...state.workspacePresets, preset];
    set({ workspacePresets, savePresetOpen: false });
    void saveWorkspacePresets(workspacePresets);
  },

  updateWorkspacePreset: (preset) => {
    const workspacePresets = get().workspacePresets.map((p) =>
      p.id === preset.id ? preset : p,
    );
    set({ workspacePresets });
    void saveWorkspacePresets(workspacePresets);
  },

  deleteWorkspacePreset: (id) => {
    const workspacePresets = get().workspacePresets.filter((p) => p.id !== id);
    set({ workspacePresets });
    void saveWorkspacePresets(workspacePresets);
  },

  // uiMode lives in settings (persisted + hydrated with every other app
  // preference) — the switch is a thin wrapper over updateSettings
  setUiMode: (mode) => {
    if ((get().settings.uiMode ?? "grid") === mode) return;
    get().updateSettings({ uiMode: mode });
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
  setDictation: (d) => set({ dictation: d }),
  setOpenrouterStatus: (status) => set({ openrouterStatus: status }),
  setLocalSttStatus: (status) => set({ localSttStatus: status }),
}));

/**
 * First stage of closing a pane (after the busy-confirm gate): worktree
 * panes decide the worktree's fate — clean → silent cleanup with the pane,
 * dirty/local-only → keep-vs-delete dialog.
 */
function proceedRemoveAgent(agentId: string) {
  const get = useSwarm.getState;
  const agent = get().agents[agentId];
  if (!agent) return;
  if (agent.worktree && agent.cwd && IS_TAURI) {
    const path = agent.cwd;
    const meta = agent.worktree;
    void (async () => {
      let status: WorktreeStatus | null = null;
      try {
        status = await worktreeStatus(
          path,
          get().settings.gitPath?.trim() || undefined,
        );
      } catch {
        // can't tell → keep the worktree, never silent-delete
      }
      // the pane may have been removed while the status check ran (double
      // close, workspace close) — don't resurrect a cleanup entry for it
      if (!get().agents[agentId]) return;
      if (status?.exists && !status.dirty && status.ahead === 0) {
        pendingWorktreeCleanup.set(agentId, { ...meta, path, confirmed: false });
        continueRemoveAgent(agentId);
      } else if (status?.exists) {
        useSwarm.setState({ closeWorktreeConfirm: { agentId, status } });
      } else {
        // folder gone (or unreadable) — close the pane, touch nothing
        continueRemoveAgent(agentId);
      }
    })();
    return;
  }
  continueRemoveAgent(agentId);
}

/**
 * Second stage of closing a pane, after any worktree decision was made:
 * floating terminals with a running process raise the close-confirm dialog
 * (kill vs detach); idle ones are closed along with the pane.
 */
function continueRemoveAgent(agentId: string) {
  const store = useSwarm.getState();
  const termIds = store.floatingOrder.filter(
    (tid) => store.floatingTerminals[tid]?.agentId === agentId,
  );
  if (termIds.length === 0) {
    store.removeAgent(agentId);
    return;
  }
  void (async () => {
    // a floating terminal blocks the close only while something actually
    // runs in it — exited/idle shells are closed along with the pane
    const busy: string[] = [];
    await Promise.all(
      termIds.map(async (tid) => {
        if (useSwarm.getState().floatingTerminals[tid]?.status === "exited")
          return;
        if (await ptyHasChildren(tid)) busy.push(tid);
      }),
    );
    if (busy.length > 0) {
      useSwarm.setState({ closeConfirm: { agentId, termIds: busy } });
    } else {
      const s = useSwarm.getState();
      for (const tid of termIds) s.removeFloatingTerminal(tid);
      s.removeAgent(agentId);
    }
  })();
}

/**
 * Tear a workspace down: kill its agents (terminals + their floating
 * terminals; detached floats survive), drop its layout, and keep the app in a
 * valid state — at least one workspace always exists, and closing the active
 * tab activates its neighbour. By default worktrees of the closed agents stay
 * on disk; the optional cleanup removes only those still clean after the
 * terminals are gone.
 */
function closeWorkspace(id: string, cleanupSafeWorktrees = false) {
  const store = useSwarm.getState();
  if (!store.workspaces[id]) return;
  const agentIds = store.order.filter(
    (aid) => store.agents[aid]?.workspaceId === id,
  );
  const cleanupCandidates = cleanupSafeWorktrees
    ? agentIds
        .map((aid) => {
          const agent = store.agents[aid];
          if (!agent?.worktree || !agent.cwd) return null;
          return { ...agent.worktree, path: agent.cwd };
        })
        .filter((c): c is WorktreeMeta & { path: string } => !!c)
    : [];

  // owned floating terminals die with their agents (this also kills their PTYs)
  for (const tid of [...store.floatingOrder]) {
    const t = useSwarm.getState().floatingTerminals[tid];
    if (t?.agentId && agentIds.includes(t.agentId)) {
      store.removeFloatingTerminal(tid);
    }
  }
  for (const aid of agentIds) {
    destroyTerm(aid);
    // their worktrees stay on disk — drop any stale cleanup decision
    pendingWorktreeCleanup.delete(aid);
  }
  if (cleanupCandidates.length > 0) {
    const gitBin = store.settings.gitPath?.trim() || undefined;
    void (async () => {
      await Promise.allSettled(
        cleanupCandidates.map(async (candidate) => {
          try {
            const st = await worktreeStatus(candidate.path, gitBin);
            if (st.exists && (st.dirty || st.ahead > 0)) return;
            await removeWorktree({
              root: candidate.root,
              path: candidate.path,
              branch: candidate.branch,
              gitBin,
            });
          } catch {
            /* on doubt keep the worktree */
          }
        }),
      );
      void useSwarm.getState().refreshWorktrees();
    })();
  }

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
    // confirm dialogs targeting a removed agent must not survive the close —
    // they'd sit there looking actionable while their buttons no-op
    closeConfirm:
      state.closeConfirm && agentIds.includes(state.closeConfirm.agentId)
        ? null
        : state.closeConfirm,
    closeWorktreeConfirm:
      state.closeWorktreeConfirm &&
      agentIds.includes(state.closeWorktreeConfirm.agentId)
        ? null
        : state.closeWorktreeConfirm,
    closeBusyConfirm:
      state.closeBusyConfirm && agentIds.includes(state.closeBusyConfirm)
        ? null
        : state.closeBusyConfirm,
  });
  schedulePersistWorkspaces();
  schedulePersistGrid();
}
