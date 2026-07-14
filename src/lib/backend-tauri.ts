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
  PersistedAutonomyBudgets,
  PersistedConductorTimers,
  PersistedOrchestratorChats,
  PersistedProjects,
  PersistedVibeSessions,
  QuickNotesData,
  UsageHistoryEntry,
} from "@/types";
import type { Backend } from "./backend-types";
import type { PersistedMissions } from "@/lib/missions/types";
import type { PersistedMissionOutbox } from "@/lib/missions/outbox";
import type { PersistedRuntimeEnvironments } from "@/lib/runtime/core";

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
    if (!(await isPermissionGranted())) {
      throw new Error("Native notification permission is not granted");
    }
    sendNotification({ title, body });
  },

  loadQuickNotes: async () => {
    return (await store.get<QuickNotesData>("quickNotes")) ?? null;
  },
  saveQuickNotes: async (data) => {
    await store.set("quickNotes", data);
    await store.save();
  },

  loadOrchestratorChats: async () => {
    return (
      (await store.get<PersistedOrchestratorChats>("orchestratorChats")) ?? null
    );
  },
  saveOrchestratorChats: async (data) => {
    await store.set("orchestratorChats", data);
    await store.save();
  },

  loadVibeSessions: async () => {
    return (await store.get<PersistedVibeSessions>("vibeSessions")) ?? null;
  },
  saveVibeSessions: async (data) => {
    await store.set("vibeSessions", data);
    await store.save();
  },

  loadProjects: async () => {
    return (await store.get<PersistedProjects>("projects")) ?? null;
  },
  saveProjects: async (data) => {
    await store.set("projects", data);
    await store.save();
  },

  loadAutonomyBudgets: async () => {
    // a store READ ERROR must THROW (like loadConductorTimers) — swallowing it
    // would make "unreadable" look like "fresh install" and silently un-latch
    // a tripped breaker / mint a fresh allowance after a corrupt store. The
    // hydrate distinguishes the throw (fail closed — pause autonomy) from a
    // genuinely missing key (null = fresh, no restriction).
    return (
      (await store.get<PersistedAutonomyBudgets>("autonomyBudgets")) ?? null
    );
  },
  saveAutonomyBudgets: async (data) => {
    await store.set("autonomyBudgets", data);
    await store.save();
  },

  loadMissions: async () => {
    // A read failure must throw. The mission store then remains write-gated;
    // unreadable durable work must never be replaced by an empty event log.
    return (await store.get<PersistedMissions>("missions")) ?? null;
  },
  saveMissions: async (data) => {
    await store.set("missions", data);
    await store.save();
  },

  loadMissionOutbox: async () => {
    // Unknown outbox state must throw so startup dispatch remains fail-closed.
    return (await store.get<PersistedMissionOutbox>("missionOutbox")) ?? null;
  },
  saveMissionOutbox: async (data) => {
    await store.set("missionOutbox", data);
    await store.save();
  },

  loadRuntimeEnvironments: async () => {
    return (await store.get<PersistedRuntimeEnvironments>("runtimeEnvironments")) ?? null;
  },
  saveRuntimeEnvironments: async (data) => {
    await store.set("runtimeEnvironments", data);
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
    return (await store.get<UsageHistoryEntry[]>("usageHistory")) ?? null;
  },
  saveUsageHistory: async (entries) => {
    await store.set("usageHistory", entries);
    await store.save();
  },

  loadSettings: async () => {
    return (await store.get<AppSettings>("settings")) ?? null;
  },
  saveSettings: async (settings) => {
    await store.set("settings", settings);
    await store.save();
  },

  loadSchemaVersion: async () => {
    return (await store.get<number>("schemaVersion")) ?? null;
  },
  saveSchemaVersion: async (version) => {
    await store.set("schemaVersion", version);
    await store.save();
  },

  fetchCodexAccountLimits: () =>
    invoke<CodexAccountLimits>("codex_account_limits"),
};
