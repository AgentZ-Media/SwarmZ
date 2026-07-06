import type { Backend } from "./backend-types";
import { tauriBackend } from "./backend-tauri";

export const IS_TAURI =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

// Native-only: SwarmZ runs through Tauri and the Rust backend. Keeping this
// indirection preserves the frontend call sites while avoiding the abandoned
// browser/Node engine in production bundles.
const backend: Backend = tauriBackend;

export const ptySpawn = backend.ptySpawn;
export const ptyWrite = backend.ptyWrite;
export const ptyResize = backend.ptyResize;
export const ptyKill = backend.ptyKill;
export const ptyHasChildren = backend.ptyHasChildren;
export const onPtyData = backend.onPtyData;
export const onPtyExit = backend.onPtyExit;
export const fetchUsageForDir = backend.fetchUsageForDir;
export const fetchUsageForSession = backend.fetchUsageForSession;
export const fetchUsageTotals = backend.fetchUsageTotals;
export const onUsageChanged = backend.onUsageChanged;
export const pickDirectory = backend.pickDirectory;
export const getHome = backend.getHome;
export const fetchGitInfo = backend.fetchGitInfo;
export const openUrl = backend.openUrl;
export const ensureNotifyPermission = backend.ensureNotifyPermission;
export const notify = backend.notify;
export const detectProjectCommands = backend.detectProjectCommands;
export const loadProfiles = backend.loadProfiles;
export const saveProfiles = backend.saveProfiles;
export const loadCommandPresets = backend.loadCommandPresets;
export const saveCommandPresets = backend.saveCommandPresets;
export const loadCustomCommands = backend.loadCustomCommands;
export const saveCustomCommands = backend.saveCustomCommands;
export const loadQuickNotes = backend.loadQuickNotes;
export const saveQuickNotes = backend.saveQuickNotes;
export const loadUsageHistory = backend.loadUsageHistory;
export const saveUsageHistory = backend.saveUsageHistory;
export const loadSettings = backend.loadSettings;
export const saveSettings = backend.saveSettings;
export const loadWorkspaces = backend.loadWorkspaces;
export const saveWorkspaces = backend.saveWorkspaces;
export const loadGrid = backend.loadGrid;
export const saveGrid = backend.saveGrid;
export const loadWorkspacePresets = backend.loadWorkspacePresets;
export const saveWorkspacePresets = backend.saveWorkspacePresets;
export const fetchSubscriptionLimits = backend.fetchSubscriptionLimits;

export type { PtyDataEvent, PtyExitEvent } from "./backend-types";
