import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { IS_TAURI } from "./transport";
import { useSwarm } from "@/store";

// Same logic as ScriptZ: silent background poll (30s after startup, then
// hourly) plus a manual check with visible feedback. Native (Tauri) only —
// the web build keeps the store but every action is a no-op.

export type UpdateStage = "idle" | "available" | "downloading" | "ready" | "error";

export type ManualCheckState = "checking" | "uptodate" | "error" | null;

const HOUR_MS = 60 * 60 * 1000;
const STARTUP_DELAY_MS = 30_000;

interface UpdatesState {
  stage: UpdateStage;
  /** version string of the available update, once discovered */
  version: string | null;
  /** download progress 0–100 while stage === "downloading" */
  progress: number;
  /** feedback for the manual "Check for updates" action only */
  manualCheck: ManualCheckState;

  checkNow: () => Promise<void>;
  downloadAndInstall: () => Promise<void>;
  restart: () => Promise<void>;
  startBackgroundPolling: () => void;
  stopBackgroundPolling: () => void;
}

let availableUpdate: Update | null = null;
let inFlight = false;
let backgroundStarted = false;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let hourlyTimer: ReturnType<typeof setInterval> | null = null;
let manualResetTimer: ReturnType<typeof setTimeout> | null = null;

export const useUpdates = create<UpdatesState>((set, get) => {
  async function poll(opts: { manual: boolean }): Promise<void> {
    if (!IS_TAURI || inFlight) return;
    const s = get().stage;
    if (s === "downloading" || s === "ready") return;
    inFlight = true;
    if (opts.manual) {
      if (manualResetTimer) clearTimeout(manualResetTimer);
      set({ manualCheck: "checking" });
    }
    try {
      const update = await check();
      if (update) {
        availableUpdate = update;
        set({ stage: "available", version: update.version, manualCheck: null });
        // auto-update (Settings): download right away — installing still
        // happens on restart, the title-bar pill flips to "Restart to update"
        if (useSwarm.getState().settings.autoUpdate) {
          void get().downloadAndInstall();
        }
      } else if (opts.manual) {
        set({ manualCheck: "uptodate" });
      }
    } catch {
      // background poll stays silent (offline, rate-limit, …)
      if (opts.manual) set({ manualCheck: "error" });
    } finally {
      inFlight = false;
      if (opts.manual && get().manualCheck !== "checking") {
        manualResetTimer = setTimeout(() => set({ manualCheck: null }), 4000);
      }
    }
  }

  return {
    stage: "idle",
    version: null,
    progress: 0,
    manualCheck: null,

    checkNow: () => poll({ manual: true }),

    downloadAndInstall: async () => {
      const update = availableUpdate;
      const s = get().stage;
      if (!update || s === "downloading" || s === "ready") return;
      set({ stage: "downloading", progress: 0 });
      let total = 0;
      let got = 0;
      try {
        await update.downloadAndInstall((event) => {
          switch (event.event) {
            case "Started":
              total = event.data.contentLength ?? 0;
              got = 0;
              set({ progress: 0 });
              break;
            case "Progress":
              got += event.data.chunkLength;
              if (total > 0) {
                set({ progress: Math.min(99, Math.floor((got / total) * 100)) });
              }
              break;
            case "Finished":
              set({ progress: 100 });
              break;
          }
        });
        set({ stage: "ready" });
      } catch {
        set({ stage: "error" });
        setTimeout(() => {
          if (get().stage === "error") set({ stage: "available" });
        }, 4000);
      }
    },

    restart: async () => {
      try {
        await relaunch();
      } catch {
        set({ stage: "error" });
      }
    },

    startBackgroundPolling: () => {
      if (!IS_TAURI || backgroundStarted || import.meta.env.DEV) return;
      backgroundStarted = true;
      startupTimer = setTimeout(() => void poll({ manual: false }), STARTUP_DELAY_MS);
      hourlyTimer = setInterval(() => void poll({ manual: false }), HOUR_MS);
    },

    stopBackgroundPolling: () => {
      backgroundStarted = false;
      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = null;
      }
      if (hourlyTimer) {
        clearInterval(hourlyTimer);
        hourlyTimer = null;
      }
    },
  };
});
