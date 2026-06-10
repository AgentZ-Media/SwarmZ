import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
  GitInfo,
  Profile,
  SessionUsage,
  SubscriptionLimits,
  UsageHistoryEntry,
  UsageTotals,
} from "@/types";
import type { Backend, PtyDataEvent, PtyExitEvent } from "./backend-types";

const store = new LazyStore("swarmz.json");

export const tauriBackend: Backend = {
  ptySpawn: (args) => invoke<void>("pty_spawn", args),
  ptyWrite: (id, data) => invoke<void>("pty_write", { id, data }),
  ptyResize: (id, cols, rows) => invoke<void>("pty_resize", { id, cols, rows }),
  ptyKill: (id) => invoke<void>("pty_kill", { id }),

  onPtyData: (id: string, cb: (e: PtyDataEvent) => void) =>
    listen<PtyDataEvent>(`pty://data/${id}`, (ev) => cb(ev.payload)),
  onPtyExit: (id: string, cb: (e: PtyExitEvent) => void) =>
    listen<PtyExitEvent>(`pty://exit/${id}`, (ev) => cb(ev.payload)),

  fetchUsageForDir: (cwd) =>
    invoke<SessionUsage | null>("usage_for_dir", { cwd }),
  fetchUsageForSession: (cwd, sinceMs, sessionId, excludeSessionIds) =>
    invoke<SessionUsage | null>("usage_for_session", {
      cwd,
      since: sinceMs,
      session: sessionId,
      exclude: excludeSessionIds,
    }),
  fetchUsageTotals: () => invoke<UsageTotals>("usage_totals"),
  onUsageChanged: (cb) =>
    listen<string[]>("usage://changed", (ev) => cb(ev.payload)),

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

  loadProfiles: async () => {
    try {
      return (await store.get<Profile[]>("profiles")) ?? null;
    } catch {
      return null;
    }
  },
  saveProfiles: async (profiles) => {
    await store.set("profiles", profiles);
    await store.save();
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

  fetchSubscriptionLimits: () =>
    invoke<SubscriptionLimits | null>("subscription_limits"),
};
