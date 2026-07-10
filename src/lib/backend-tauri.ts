import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl as openerOpenUrl } from "@tauri-apps/plugin-opener";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { LazyStore } from "@tauri-apps/plugin-store";
import type {
  AppSettings,
  CodexAccountLimits,
  GitInfo,
  PersistedConductorTimers,
  PersistedOrchestratorChats,
  PersistedProjects,
  PersistedVibeSessions,
  QuickNotesData,
  UsageHistoryEntry,
} from "@/types";
import type { Backend } from "./backend-types";

const store = new LazyStore("swarmz.json");

export const tauriBackend: Backend = {
  pickDirectory: async () => {
    const sel = await openDialog({ directory: true, multiple: false });
    return typeof sel === "string" ? sel : undefined;
  },
  getHome: () => homeDir(),

  fetchGitInfo: (cwd, gitBin) =>
    invoke<GitInfo | null>("git_info", { cwd, bin: gitBin }),
  openUrl: (url) => openerOpenUrl(url),

  ensureNotifyPermission: async () => {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    return granted;
  },
  notify: async (title, body) => {
    sendNotification({ title, body });
  },

  loadQuickNotes: async () => {
    try {
      return (await store.get<QuickNotesData>("quickNotes")) ?? null;
    } catch {
      return null;
    }
  },
  saveQuickNotes: async (data) => {
    await store.set("quickNotes", data);
    await store.save();
  },

  loadOrchestratorChats: async () => {
    try {
      return (
        (await store.get<PersistedOrchestratorChats>("orchestratorChats")) ??
        null
      );
    } catch {
      return null;
    }
  },
  saveOrchestratorChats: async (data) => {
    await store.set("orchestratorChats", data);
    await store.save();
  },

  loadVibeSessions: async () => {
    try {
      return (await store.get<PersistedVibeSessions>("vibeSessions")) ?? null;
    } catch {
      return null;
    }
  },
  saveVibeSessions: async (data) => {
    await store.set("vibeSessions", data);
    await store.save();
  },

  loadProjects: async () => {
    try {
      return (await store.get<PersistedProjects>("projects")) ?? null;
    } catch {
      return null;
    }
  },
  saveProjects: async (data) => {
    await store.set("projects", data);
    await store.save();
  },

  loadConductorTimers: async () => {
    // a store READ ERROR must throw (the hydrate keeps its in-memory state
    // and persists nothing then) — only a genuinely missing key is null.
    // Swallowing the error here would make "unreadable" look like "fresh
    // install" and let the hydrate persist every timer away.
    return (
      (await store.get<PersistedConductorTimers>("conductorTimers")) ?? null
    );
  },
  saveConductorTimers: async (data) => {
    await store.set("conductorTimers", data);
    await store.save();
  },

  deleteStoreKeys: async (keys) => {
    let changed = false;
    for (const key of keys) {
      // delete() resolves true only when the key existed
      if (await store.delete(key)) changed = true;
    }
    if (changed) await store.save();
  },

  loadUsageHistory: async () => {
    try {
      return (await store.get<UsageHistoryEntry[]>("usageHistory")) ?? null;
    } catch {
      return null;
    }
  },
  saveUsageHistory: async (entries) => {
    await store.set("usageHistory", entries);
    await store.save();
  },

  loadSettings: async () => {
    try {
      return (await store.get<AppSettings>("settings")) ?? null;
    } catch {
      return null;
    }
  },
  saveSettings: async (settings) => {
    await store.set("settings", settings);
    await store.save();
  },

  loadSchemaVersion: async () => {
    try {
      return (await store.get<number>("schemaVersion")) ?? null;
    } catch {
      return null;
    }
  },
  saveSchemaVersion: async (version) => {
    await store.set("schemaVersion", version);
    await store.save();
  },

  fetchCodexAccountLimits: () =>
    invoke<CodexAccountLimits>("codex_account_limits"),
};
