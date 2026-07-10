import type { Backend } from "./backend-types";
import { tauriBackend } from "./backend-tauri";

export const IS_TAURI =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

// Native-only: SwarmZ runs through Tauri and the Rust backend. Keeping this
// indirection preserves the frontend call sites while avoiding the abandoned
// browser/Node engine in production bundles.
const backend: Backend = tauriBackend;

export const pickDirectory = backend.pickDirectory;
export const getHome = backend.getHome;
export const fetchGitInfo = backend.fetchGitInfo;
export const openUrl = backend.openUrl;
export const ensureNotifyPermission = backend.ensureNotifyPermission;
export const notify = backend.notify;
export const loadQuickNotes = backend.loadQuickNotes;
export const saveQuickNotes = backend.saveQuickNotes;
export const loadOrchestratorChats = backend.loadOrchestratorChats;
export const saveOrchestratorChats = backend.saveOrchestratorChats;
export const loadVibeSessions = backend.loadVibeSessions;
export const saveVibeSessions = backend.saveVibeSessions;
export const loadProjects = backend.loadProjects;
export const saveProjects = backend.saveProjects;
export const deleteStoreKeys = backend.deleteStoreKeys;
export const loadUsageHistory = backend.loadUsageHistory;
export const saveUsageHistory = backend.saveUsageHistory;
export const loadSettings = backend.loadSettings;
export const saveSettings = backend.saveSettings;
export const loadSchemaVersion = backend.loadSchemaVersion;
export const saveSchemaVersion = backend.saveSchemaVersion;
export const fetchCodexAccountLimits = backend.fetchCodexAccountLimits;
