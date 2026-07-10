// The main app store — Codex-only. After the great subtraction (rebuild
// Phase 1) this holds only: settings, the all-time usage history, quick
// notes, the worktree panel state and a handful of UI flags. Sessions live
// in lib/vibe/session-store.ts; orchestrator chats in
// lib/orchestrator/chat-store.ts.

import { create } from "zustand";
import { nanoid } from "nanoid";
import {
  IS_TAURI,
  loadQuickNotes,
  loadSchemaVersion,
  loadSettings,
  loadUsageHistory,
  saveQuickNotes,
  saveSchemaVersion,
  saveSettings,
  saveUsageHistory,
} from "@/lib/transport";
import { normalizeSchemaVersion } from "@/lib/schema-version";
import type {
  AppSettings,
  NoteItem,
  QuickNotesData,
  UsageHistoryEntry,
  WorktreeEntry,
  WorktreeMeta,
  WorktreeStatus,
} from "@/types";
import { listWorktrees, removeWorktree, worktreeStatus } from "@/lib/worktree";
import {
  flushOrchestratorPersist,
  hydrateOrchestratorChats,
} from "@/lib/orchestrator/chat-store";
import {
  flushVibePersist,
  hydrateVibeSessions,
  useVibe,
} from "@/lib/vibe/session-store";

// Keep the persisted usage history bounded; oldest sessions fall off first.
const MAX_HISTORY_ENTRIES = 1000;

// Usage refreshes can arrive in bursts — batch disk writes.
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

/**
 * Write every debounced slice NOW — quit must not lose any debounce window.
 * Called from lib/quit.ts before the window closes.
 */
export async function flushAllPersists(): Promise<void> {
  if (persistHistoryTimer) {
    clearTimeout(persistHistoryTimer);
    persistHistoryTimer = null;
  }
  const s = useSwarm.getState();
  try {
    await Promise.all([
      saveUsageHistory(
        Object.values(s.usageHistory)
          .sort((a, b) => b.last_updated - a.last_updated)
          .slice(0, MAX_HISTORY_ENTRIES),
      ),
      // the orchestrator chats keep their own debounced slice
      flushOrchestratorPersist(),
      // the vibe sessions keep their own debounced slice
      flushVibePersist(),
    ]);
  } catch {
    /* never block quitting on a failed write */
  }
}

function usageHistoryKey(runtime: string | undefined, sessionId: string): string {
  // entries without a runtime predate the rebuild and were written by the
  // Claude parser — keying them "codex" would collide/mislabel them
  return `${runtime ?? "claude"}:${sessionId}`;
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

export interface SwarmState {
  /** persisted app preferences (Settings dialog) */
  settings: AppSettings;
  /** all-time usage of Codex sessions launched inside SwarmZ, keyed by runtime+session id */
  usageHistory: Record<string, UsageHistoryEntry>;
  /** quick notes (checklists) — global + per project folder (persisted) */
  quickNotes: QuickNotesData;
  /** quick-notes drawer (title bar / ⌘N) */
  notesOpen: boolean;
  /** usage dashboard drawer */
  dashboardOpen: boolean;
  /** command palette (⌘K) */
  paletteOpen: boolean;
  /** pending app-quit while these sessions are still working (see lib/quit.ts) */
  quitConfirm: string[] | null;
  /** SwarmZ worktrees on disk (title-bar panel + icon visibility) — refreshed on demand (in-memory) */
  worktrees: WorktreeEntry[];
  /**
   * A close flow waiting on a keep-vs-delete decision for a worktree that
   * still holds work (CloseWorktreeDialog). Dormant in the Phase-1 interim
   * state — Phase 4 wires session-worktree close into it.
   */
  closeWorktreeConfirm:
    | { meta: WorktreeMeta; path: string; status: WorktreeStatus }
    | null;

  // lifecycle
  hydrate: () => Promise<void>;

  /** merge + persist app preferences (Settings dialog) */
  updateSettings: (patch: Partial<AppSettings>) => void;

  /** open/close the quit warning (busy session ids; null = dismissed) */
  setQuitConfirm: (sessionIds: string[] | null) => void;

  // usage history
  /** mirror one session's usage into the persistent all-time history */
  recordUsageHistory: (entry: UsageHistoryEntry) => void;
  clearUsageHistory: () => void;

  // git worktrees
  /** rescan all known repos for SwarmZ worktrees (panel + icon visibility) */
  refreshWorktrees: () => Promise<void>;
  /** remember a repo root for the worktree scan (persisted in settings) */
  registerWorktreeRepo: (root: string) => void;
  /** delete a worktree from the management panel (folder + branch) */
  deleteWorktree: (entry: WorktreeEntry) => Promise<void>;
  /** delete every safe, unattached worktree currently shown in the panel */
  cleanupSafeWorktrees: (root?: string) => Promise<void>;
  /**
   * Ask about a worktree that still holds work: clean/gone worktrees are
   * removed (or ignored) silently, dirty/local-only ones raise the
   * keep-vs-delete dialog.
   */
  requestCloseWorktree: (meta: WorktreeMeta, path: string) => Promise<void>;
  /** resolve the keep-vs-delete decision of the pending worktree dialog */
  resolveCloseWorktree: (choice: "keep" | "delete" | "cancel") => void;

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

  // ui
  setDashboardOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
}

export const useSwarm = create<SwarmState>((set, get) => ({
  settings: {},
  usageHistory: {},
  quickNotes: { global: [], folders: {} },
  notesOpen: false,
  dashboardOpen: false,
  paletteOpen: false,
  quitConfirm: null,
  worktrees: [],
  closeWorktreeConfirm: null,

  hydrate: async () => {
    try {
      // schemaVersion — the migration anchor (lib/schema-version.ts): a
      // pre-versioning/invalid store is stamped with the current version;
      // a valid (even newer) version is left untouched. No migrations yet.
      const { version, stamp } = normalizeSchemaVersion(
        await loadSchemaVersion(),
      );
      if (stamp) await saveSchemaVersion(version);
    } catch {
      /* ignore */
    }
    try {
      const settings = await loadSettings();
      if (settings) set({ settings });
    } catch {
      /* ignore */
    }
    try {
      const history = await loadUsageHistory();
      if (history?.length) {
        const map: Record<string, UsageHistoryEntry> = {};
        for (const e of history) {
          map[usageHistoryKey(e.runtime, e.session_id)] = e;
        }
        set({ usageHistory: map });
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
      // orchestrator chats — hydrates its own store (chat-store.ts)
      await hydrateOrchestratorChats();
    } catch {
      /* ignore */
    }
    try {
      // vibe native codex sessions — hydrates its own store
      await hydrateVibeSessions();
    } catch {
      /* ignore */
    }
    // initial worktree scan — restores the title-bar panel/icon
    void get().refreshWorktrees();
  },

  updateSettings: (patch) => {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    void saveSettings(settings);
  },

  setQuitConfirm: (sessionIds) => set({ quitConfirm: sessionIds }),

  recordUsageHistory: (entry) => {
    const state = get();
    const key = usageHistoryKey(entry.runtime, entry.session_id);
    const prev = state.usageHistory[key];
    const changed =
      !prev ||
      prev.message_count !== entry.message_count ||
      prev.cost_usd !== entry.cost_usd ||
      prev.input_tokens !== entry.input_tokens ||
      prev.output_tokens !== entry.output_tokens ||
      prev.agent_name !== entry.agent_name;
    if (!changed) return;
    set({
      usageHistory: {
        ...state.usageHistory,
        [key]: { ...entry, started_at: prev?.started_at ?? entry.started_at },
      },
    });
    schedulePersistHistory();
  },

  clearUsageHistory: () => {
    set({ usageHistory: {} });
    void saveUsageHistory([]);
  },

  refreshWorktrees: async () => {
    if (!IS_TAURI) return;
    const state = get();
    const roots = new Set(state.settings.worktreeRepos ?? []);
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
      // disappears again once every worktree is gone. Only roots whose scan
      // actually succeeded may be pruned (an unmounted volume or a broken
      // git override is not "no worktrees"), and the prune is computed
      // against the *current* registry, not the pre-await snapshot.
      const live = new Set(scan.entries.map((e) => e.root));
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
    // never delete a worktree a live session works in
    const vibe = useVibe.getState();
    const openPaths = new Set(
      vibe.order
        .map((id) => vibe.sessions[id]?.session.projectDir)
        .filter((p): p is string => !!p),
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
          // re-check at execution time — the panel data may be minutes old
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

  requestCloseWorktree: async (meta, path) => {
    const gitBin = get().settings.gitPath?.trim() || undefined;
    let status: WorktreeStatus | null = null;
    try {
      status = await worktreeStatus(path, gitBin);
    } catch {
      // can't tell → keep the worktree, never silent-delete
      return;
    }
    if (!status.exists) return; // folder gone — nothing left to decide
    if (!status.dirty && status.ahead === 0) {
      // clean — remove silently (re-checked just now)
      await get().deleteWorktree({
        root: meta.root,
        repo: "",
        path,
        branch: meta.branch,
        dirty: false,
        ahead: 0,
        missing: false,
      });
      return;
    }
    set({ closeWorktreeConfirm: { meta, path, status } });
  },

  resolveCloseWorktree: (choice) => {
    const confirm = get().closeWorktreeConfirm;
    set({ closeWorktreeConfirm: null });
    if (!confirm || choice !== "delete") return;
    // explicit user decision — no re-check
    void removeWorktree({
      root: confirm.meta.root,
      path: confirm.path,
      branch: confirm.meta.branch,
      gitBin: get().settings.gitPath?.trim() || undefined,
    })
      .catch(() => {})
      .finally(() => void get().refreshWorktrees());
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

  setDashboardOpen: (open) => set({ dashboardOpen: open }),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
}));
