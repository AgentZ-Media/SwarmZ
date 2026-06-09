import type { Backend } from "./backend-types";
import { tauriBackend } from "./backend-tauri";
import { webBackend } from "./backend-web";

export const IS_TAURI =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

// Pick the backend once. Tauri webview → Rust commands; a plain browser on
// localhost → the Node engine over WebSocket/HTTP. Both are bundled; module
// import has no side effects, so selecting at runtime is safe.
const backend: Backend = IS_TAURI ? tauriBackend : webBackend;

export const ptySpawn = backend.ptySpawn;
export const ptyWrite = backend.ptyWrite;
export const ptyResize = backend.ptyResize;
export const ptyKill = backend.ptyKill;
export const onPtyData = backend.onPtyData;
export const onPtyExit = backend.onPtyExit;
export const fetchUsageForDir = backend.fetchUsageForDir;
export const fetchUsageForSession = backend.fetchUsageForSession;
export const fetchUsageTotals = backend.fetchUsageTotals;
export const onUsageChanged = backend.onUsageChanged;
export const pickDirectory = backend.pickDirectory;
export const getHome = backend.getHome;
export const ensureNotifyPermission = backend.ensureNotifyPermission;
export const notify = backend.notify;
export const loadProfiles = backend.loadProfiles;
export const saveProfiles = backend.saveProfiles;
export const loadUsageHistory = backend.loadUsageHistory;
export const saveUsageHistory = backend.saveUsageHistory;

export type { PtyDataEvent, PtyExitEvent } from "./backend-types";
