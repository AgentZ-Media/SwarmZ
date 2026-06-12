import type {
  AppSettings,
  DetectedCommand,
  FolderCommands,
  GitInfo,
  PersistedGrid,
  PersistedWorkspaces,
  Profile,
  SubscriptionLimits,
  UsageHistoryEntry,
  WorkspacePreset,
} from "@/types";
import type { Backend, PtyDataEvent, PtyExitEvent, Unlisten } from "./backend-types";
import { requestDirectory } from "./dirpicker";

// ---- WebSocket PTY multiplexer ----
type OutMsg =
  | { t: "spawn"; id: string; cwd?: string; startup?: string; cols: number; rows: number }
  | { t: "input"; id: string; data: string }
  | { t: "resize"; id: string; cols: number; rows: number }
  | { t: "kill"; id: string };

const dataCbs = new Map<string, Set<(e: PtyDataEvent) => void>>();
const exitCbs = new Map<string, Set<(e: PtyExitEvent) => void>>();

function subscribe<T>(map: Map<string, Set<(e: T) => void>>, id: string, cb: (e: T) => void) {
  let set = map.get(id);
  if (!set) {
    set = new Set();
    map.set(id, set);
  }
  set.add(cb);
  return () => {
    set.delete(cb);
    if (set.size === 0) map.delete(id);
  };
}

let ws: WebSocket | null = null;
let queue: OutMsg[] = [];

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

function ensureWs() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))
    return;
  ws = new WebSocket(wsUrl());
  ws.onopen = () => {
    const pending = queue;
    queue = [];
    for (const m of pending) ws?.send(JSON.stringify(m));
  };
  ws.onmessage = (ev) => {
    let msg: { t: string; id: string; data?: string };
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.t === "data" && msg.data !== undefined) {
      dataCbs.get(msg.id)?.forEach((cb) => cb({ id: msg.id, data: msg.data! }));
    } else if (msg.t === "exit") {
      exitCbs.get(msg.id)?.forEach((cb) => cb({ id: msg.id }));
    }
  };
  ws.onclose = () => {
    ws = null;
  };
  ws.onerror = () => {
    /* onclose will follow */
  };
}

function sendWs(msg: OutMsg) {
  ensureWs();
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  else queue.push(msg);
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  return (await r.json()) as T;
}

export const webBackend: Backend = {
  ptySpawn: async (args) => {
    sendWs({ t: "spawn", ...args });
  },
  ptyWrite: (id, data) => sendWs({ t: "input", id, data }),
  ptyResize: (id, cols, rows) => sendWs({ t: "resize", id, cols, rows }),
  ptyKill: (id) => sendWs({ t: "kill", id }),
  ptyHasChildren: async (id) => {
    try {
      return await getJson<boolean>(
        `/api/pty/has-children?id=${encodeURIComponent(id)}`,
      );
    } catch {
      return false;
    }
  },

  onPtyData: async (id, cb): Promise<Unlisten> => {
    ensureWs();
    return subscribe(dataCbs, id, cb);
  },
  onPtyExit: async (id, cb): Promise<Unlisten> => {
    return subscribe(exitCbs, id, cb);
  },

  fetchUsageForDir: (cwd) =>
    getJson(`/api/usage/dir?cwd=${encodeURIComponent(cwd)}`),
  fetchUsageForSession: (cwd, sinceMs, sessionId, excludeSessionIds) => {
    const sid = sessionId ? `&sid=${encodeURIComponent(sessionId)}` : "";
    const ex = excludeSessionIds?.length
      ? `&exclude=${encodeURIComponent(excludeSessionIds.join(","))}`
      : "";
    return getJson(
      `/api/usage/session?cwd=${encodeURIComponent(cwd)}&since=${sinceMs}${sid}${ex}`,
    );
  },
  fetchUsageTotals: () => getJson("/api/usage/totals"),
  onUsageChanged: async (cb): Promise<Unlisten> => {
    const es = new EventSource("/api/usage/stream");
    es.addEventListener("changed", (ev) => {
      let dirs: string[] | undefined;
      try {
        dirs = JSON.parse((ev as MessageEvent).data)?.dirs;
      } catch {
        /* malformed payload → treat as "unknown" */
      }
      cb(dirs);
    });
    return () => es.close();
  },

  pickDirectory: () => requestDirectory(),
  getHome: async () => {
    try {
      const { home } = await getJson<{ home: string }>("/api/home");
      return home;
    } catch {
      return "";
    }
  },

  fetchGitInfo: async (cwd, gitBin) => {
    try {
      const bin = gitBin ? `&bin=${encodeURIComponent(gitBin)}` : "";
      return await getJson<GitInfo | null>(
        `/api/git?cwd=${encodeURIComponent(cwd)}${bin}`,
      );
    } catch {
      return null;
    }
  },
  openUrl: async (url) => {
    window.open(url, "_blank", "noopener");
  },

  ensureNotifyPermission: async () => {
    if (!("Notification" in window)) return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    return (await Notification.requestPermission()) === "granted";
  },
  notify: async (title, body) => {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body });
    }
  },

  detectProjectCommands: async (cwd) => {
    try {
      return await getJson<DetectedCommand[]>(
        `/api/project-commands?cwd=${encodeURIComponent(cwd)}`,
      );
    } catch {
      return [];
    }
  },

  loadProfiles: async () => {
    try {
      const raw = localStorage.getItem("swarmz.profiles");
      return raw ? (JSON.parse(raw) as Profile[]) : null;
    } catch {
      return null;
    }
  },
  saveProfiles: async (profiles) => {
    try {
      localStorage.setItem("swarmz.profiles", JSON.stringify(profiles));
    } catch {
      /* ignore */
    }
  },

  loadCommandPresets: async () => {
    try {
      const raw = localStorage.getItem("swarmz.command-presets");
      return raw ? (JSON.parse(raw) as Record<string, FolderCommands>) : null;
    } catch {
      return null;
    }
  },
  saveCommandPresets: async (presets) => {
    try {
      localStorage.setItem("swarmz.command-presets", JSON.stringify(presets));
    } catch {
      /* ignore */
    }
  },

  // web mode is abandoned — dead stubs only
  loadCustomCommands: async () => null,
  saveCustomCommands: async () => {},
  loadQuickNotes: async () => null,
  saveQuickNotes: async () => {},

  loadUsageHistory: async () => {
    try {
      const raw = localStorage.getItem("swarmz.usage-history");
      return raw ? (JSON.parse(raw) as UsageHistoryEntry[]) : null;
    } catch {
      return null;
    }
  },
  saveUsageHistory: async (entries) => {
    try {
      localStorage.setItem("swarmz.usage-history", JSON.stringify(entries));
    } catch {
      /* ignore */
    }
  },

  loadSettings: async () => {
    try {
      const raw = localStorage.getItem("swarmz.settings");
      return raw ? (JSON.parse(raw) as AppSettings) : null;
    } catch {
      return null;
    }
  },
  saveSettings: async (settings) => {
    try {
      localStorage.setItem("swarmz.settings", JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  },

  loadWorkspaces: async () => {
    try {
      const raw = localStorage.getItem("swarmz.workspaces");
      return raw ? (JSON.parse(raw) as PersistedWorkspaces) : null;
    } catch {
      return null;
    }
  },
  saveWorkspaces: async (ws) => {
    try {
      localStorage.setItem("swarmz.workspaces", JSON.stringify(ws));
    } catch {
      /* ignore */
    }
  },

  loadGrid: async () => {
    try {
      const raw = localStorage.getItem("swarmz.grid");
      return raw ? (JSON.parse(raw) as PersistedGrid) : null;
    } catch {
      return null;
    }
  },
  saveGrid: async (grid) => {
    try {
      localStorage.setItem("swarmz.grid", JSON.stringify(grid));
    } catch {
      /* ignore */
    }
  },

  loadWorkspacePresets: async () => {
    try {
      const raw = localStorage.getItem("swarmz.workspacePresets");
      return raw ? (JSON.parse(raw) as WorkspacePreset[]) : null;
    } catch {
      return null;
    }
  },
  saveWorkspacePresets: async (presets) => {
    try {
      localStorage.setItem("swarmz.workspacePresets", JSON.stringify(presets));
    } catch {
      /* ignore */
    }
  },

  fetchSubscriptionLimits: async () => {
    // null = no Claude login (hide); errors propagate so the store keeps
    // the last known values instead of blanking out.
    const r = await fetch("/api/limits");
    if (!r.ok) throw new Error(`limits fetch failed: ${r.status}`);
    return (await r.json()) as SubscriptionLimits | null;
  },
};
