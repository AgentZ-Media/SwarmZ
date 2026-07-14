// The main app store — Codex-only. After the great subtraction (rebuild
// Phase 1) this holds only: settings, the all-time usage history, quick
// notes, the worktree panel state and a handful of UI flags. Sessions live
// in lib/vibe/session-store.ts; orchestrator chats in
// lib/orchestrator/chat-store.ts.

import { create } from "zustand";
import { nanoid } from "nanoid";
import {
  deleteStoreKeys,
  IS_TAURI,
  loadAutonomyBudgets,
  loadQuickNotes,
  loadSchemaVersion,
  loadSettings,
  loadUsageHistory,
  saveAutonomyBudgets,
  saveQuickNotes,
  saveSchemaVersion,
  saveSettings,
  saveUsageHistory,
} from "@/lib/transport";
import { DEAD_STORE_KEYS, planSchemaMigration } from "@/lib/schema-version";
import type {
  AppSettings,
  NoteItem,
  QuickNotesData,
  QuitBlockers,
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
import {
  flushProjectsPersist,
  hydrateProjects,
  useProjects,
} from "@/lib/projects/store";
import {
  flushConductorTimersPersist,
  hydrateConductorTimers,
} from "@/lib/orchestrator/timers";
import {
  hydrateAutonomyBudgets,
  latchAutonomyUnavailable,
  registerAutonomyPersist,
  serializeAutonomyBudgets,
} from "@/lib/orchestrator/autonomy";

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

// ---- autonomy-budget persistence (the pure module registers a dirty sink;
// the actual load/save lives here next to the other slices) ----

let persistAutonomyTimer: ReturnType<typeof setTimeout> | null = null;

/** Autonomy-budget writes are SERIALIZED on this chain: a quit-flush must
 * never return while a debounce write is still in flight (the flush could
 * otherwise finish before it and a racing writer restore a stale breaker/
 * budget), and two overlapping saves must never invert on disk. Snapshots
 * are taken at write time, so the last chained write always carries the
 * freshest state. Never rejects. */
let autonomyWriteChain: Promise<void> = Promise.resolve();

/** Immediate retries for a contended/transient budget write before failing
 * closed — a truly persistent failure must not be treated as success. */
const AUTONOMY_WRITE_RETRIES = 3;

function writeAutonomyBudgetsNow(): Promise<void> {
  autonomyWriteChain = autonomyWriteChain.then(async () => {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= AUTONOMY_WRITE_RETRIES; attempt++) {
      try {
        await saveAutonomyBudgets(serializeAutonomyBudgets());
        return; // persisted — the durable copy now tracks the in-memory one
      } catch (e) {
        lastErr = e;
      }
    }
    // Every attempt failed. A lost autonomy-budget write means a tripped
    // breaker / consumed budget may NOT have reached disk, so a relaunch could
    // resume with a silently stale (more permissive) allowance. Do NOT treat
    // this as success: fail closed IN MEMORY (`latchAutonomyUnavailable`) so
    // this run stops dispatching autonomous turns — no further un-persisted
    // budget accrues, the breaker indicator lights (autonomyTripped now
    // reflects the global latch), and the human message that clears it is the
    // same authority that re-arms a breaker AND its write will persist. Never
    // blocks quitting or inverts overlapping writes.
    console.error(
      "[autonomy] failed to persist budget state — pausing autonomy fail-closed:",
      lastErr,
    );
    latchAutonomyUnavailable();
  });
  return autonomyWriteChain;
}

function scheduleAutonomyPersist() {
  if (persistAutonomyTimer) return;
  persistAutonomyTimer = setTimeout(() => {
    persistAutonomyTimer = null;
    void writeAutonomyBudgetsNow();
  }, 300);
}

/** Flush the autonomy-budget slice (flushAllPersists): a PENDING debounce
 * writes now; otherwise only JOIN any in-flight write — never mint a fresh
 * one (a run whose budget hydrate failed and that never booked a turn must
 * not clobber the persisted breaker with an empty snapshot at quit). */
async function flushAutonomyPersist(): Promise<void> {
  if (persistAutonomyTimer) {
    clearTimeout(persistAutonomyTimer);
    persistAutonomyTimer = null;
    await writeAutonomyBudgetsNow();
    return;
  }
  await autonomyWriteChain;
}

// Registered at module init — every budget mutation (reserve/release/trip/
// human re-arm) marks the slice dirty so a relaunch sees the same state.
registerAutonomyPersist(scheduleAutonomyPersist);

// ---- settings + quick-notes persistence ----
//
// Both save on every mutation (no debounce), but the writes are SERIALIZED
// on per-slice chains so `flushAllPersists` can JOIN them at quit — a quit
// right after a change must not race the webview teardown against an
// in-flight write. The chains snapshot at write time (latest state wins) and
// never write on their own at quit, so a failed hydrate can never be
// clobbered by an empty quit-save.

let settingsWriteChain: Promise<void> = Promise.resolve();
function persistSettings(): Promise<void> {
  settingsWriteChain = settingsWriteChain
    .then(() => saveSettings(useSwarm.getState().settings))
    .catch(() => {
      /* never block quitting on a failed write */
    });
  return settingsWriteChain;
}

let quickNotesWriteChain: Promise<void> = Promise.resolve();
function persistQuickNotes(): Promise<void> {
  quickNotesWriteChain = quickNotesWriteChain
    .then(() => saveQuickNotes(useSwarm.getState().quickNotes))
    .catch(() => {
      /* never block quitting on a failed write */
    });
  return quickNotesWriteChain;
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
  // allSettled, not all: one failed write must never abandon the others
  // mid-flight (quit would proceed while they still race the teardown)
  await Promise.allSettled([
    saveUsageHistory(
      Object.values(s.usageHistory)
        .sort((a, b) => b.last_updated - a.last_updated)
        .slice(0, MAX_HISTORY_ENTRIES),
    ),
    // settings + quick notes persist on every mutation — join their write
    // chains so a quit right after a change still lands the latest snapshot
    // (the chains never mint a write of their own, so a failed hydrate is
    // never clobbered by an empty quit-save)
    settingsWriteChain,
    quickNotesWriteChain,
    // the orchestrator chats keep their own debounced slice
    flushOrchestratorPersist(),
    // the vibe sessions keep their own debounced slice
    flushVibePersist(),
    // the project tabs keep their own debounced slice
    flushProjectsPersist(),
    // the conductor timers keep their own debounced slice
    flushConductorTimersPersist(),
    // the autonomy budgets keep their own debounced slice
    flushAutonomyPersist(),
  ]);
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
  /** GitHub panel drawer (title bar / Deck PR indicator) */
  githubOpen: boolean;
  /** command palette (⌘K) */
  paletteOpen: boolean;
  /** pending app-quit while work is still running (see lib/quit.ts) */
  quitConfirm: QuitBlockers | null;
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

  /** open/close the quit warning (running-work blockers; null = dismissed) */
  setQuitConfirm: (blockers: QuitBlockers | null) => void;

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
  /** `force` defaults to true (user-confirmed panel deletions); silent
   * cleanup paths pass false → Rust re-checks and refuses late dirt. */
  deleteWorktree: (entry: WorktreeEntry, force?: boolean) => Promise<void>;
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
  setGithubOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
}

export const useSwarm = create<SwarmState>((set, get) => ({
  settings: {},
  usageHistory: {},
  quickNotes: { global: [], folders: {} },
  notesOpen: false,
  dashboardOpen: false,
  githubOpen: false,
  paletteOpen: false,
  quitConfirm: null,
  worktrees: [],
  closeWorktreeConfirm: null,

  hydrate: async () => {
    try {
      // schemaVersion — the migration anchor (lib/schema-version.ts).
      // v2 (projects & swarm): stores below v2 (incl. pre-versioning ones)
      // get the one-time cleanup of the dead pane-era keys, then the stamp;
      // a valid current-or-newer version is left untouched. The storefile.rs
      // rescue path stays version-agnostic. The per-slice VALUE migration
      // (sessions → projects) runs tolerantly in the slice hydrators below.
      const plan = planSchemaMigration(await loadSchemaVersion());
      if (plan.cleanupDeadKeys) await deleteStoreKeys([...DEAD_STORE_KEYS]);
      if (plan.stampVersion !== null) await saveSchemaVersion(plan.stampVersion);
    } catch {
      /* ignore */
    }
    try {
      const settings = await loadSettings();
      if (settings) {
        // Ultra is a multi-agent mode, not a single-turn effort in SwarmZ.
        // Drop stale persisted values before they can reach a chat/session.
        const safeSettings =
          settings.orchestratorCodexEffort?.trim().toLowerCase() === "ultra"
            ? { ...settings, orchestratorCodexEffort: undefined }
            : settings;
        set({ settings: safeSettings });
      }
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
      // autonomy budgets — FIRST, before the project hydration: every
      // autonomous delivery path (trigger router eligibility, timer
      // delivery) gates on the projects store being hydrated, so budgets
      // restored here are guaranteed in place before any turn can pass the
      // budget check. A relaunch must never mint a fresh allowance or
      // un-latch a tripped breaker without a human message.
      hydrateAutonomyBudgets(await loadAutonomyBudgets());
    } catch {
      // a store READ ERROR (not a missing key — loadAutonomyBudgets throws on
      // a genuine read failure) means we can't know which breakers were
      // tripped: FAIL CLOSED and pause autonomy globally until a human message
      // clears it, rather than minting a fresh allowance / un-latching a trip.
      latchAutonomyUnavailable();
    }
    // readiness for the chat→project migration: only when projects AND
    // sessions hydrated cleanly may the chat hydrator reassign/persist — a
    // transient load failure must never rewrite assignments on disk
    let migrationReady = true;
    try {
      // project tabs — MUST hydrate before the vibe sessions: the session
      // migration assigns projectIds into this store
      await hydrateProjects();
    } catch {
      migrationReady = false;
    }
    try {
      // vibe native codex sessions — hydrates its own store (and runs the
      // schema-v2 project assignment against the hydrated project store)
      await hydrateVibeSessions();
    } catch {
      migrationReady = false;
    }
    // both hydrators also SWALLOW load failures internally (per-slice
    // tolerance) — their `hydrated` flags are the authoritative success
    // signal, the try/catch above only covers unexpected throws
    migrationReady =
      migrationReady &&
      useProjects.getState().hydrated &&
      useVibe.getState().hydrated;
    try {
      // orchestrator chats — LAST: the Phase-3 chat→project migration
      // resolves against the hydrated project AND session stores
      await hydrateOrchestratorChats({ migrationReady });
    } catch {
      /* ignore */
    }
    try {
      // conductor timers — after projects (drop decisions) AND chats
      // (missed timers fire autonomous turns into the project chats)
      await hydrateConductorTimers();
    } catch {
      /* ignore */
    }
    // initial worktree scan — restores the title-bar panel/icon
    void get().refreshWorktrees();
  },

  updateSettings: (patch) => {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    void persistSettings();
  },

  setQuitConfirm: (blockers) => set({ quitConfirm: blockers }),

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

  deleteWorktree: async (entry, force = true) => {
    try {
      await removeWorktree({
        root: entry.root,
        path: entry.path,
        branch: entry.branch,
        force,
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
        entry.ahead === 0 &&
        !entry.ahead_unknown,
    );
    if (entries.length === 0) return;
    const gitBin = state.settings.gitPath?.trim() || undefined;
    await Promise.allSettled(
      entries.map(async (entry) => {
        try {
          // re-check at execution time — the panel data may be minutes old;
          // an UNKNOWN ahead count refuses (fail closed)
          const st = await worktreeStatus(entry.path, gitBin);
          if (st.exists && (st.dirty || st.ahead > 0 || st.ahead_unknown)) return;
          // non-force: Rust re-checks once more inside the removal call
          await removeWorktree({
            root: entry.root,
            path: entry.path,
            branch: entry.branch,
            force: false,
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
    if (!status.dirty && status.ahead === 0 && !status.ahead_unknown) {
      // clean — remove silently (re-checked just now; non-force so Rust
      // refuses work that appears between this check and the removal)
      await get().deleteWorktree(
        {
          root: meta.root,
          repo: "",
          path,
          branch: meta.branch,
          dirty: false,
          ahead: 0,
          ahead_unknown: false,
          missing: false,
        },
        false,
      );
      return;
    }
    set({ closeWorktreeConfirm: { meta, path, status } });
  },

  resolveCloseWorktree: (choice) => {
    const confirm = get().closeWorktreeConfirm;
    set({ closeWorktreeConfirm: null });
    if (!confirm || choice !== "delete") return;
    // explicit user decision — no re-check, force
    void removeWorktree({
      root: confirm.meta.root,
      path: confirm.path,
      branch: confirm.meta.branch,
      force: true,
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
    void persistQuickNotes();
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
    void persistQuickNotes();
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
    void persistQuickNotes();
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
    void persistQuickNotes();
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
    void persistQuickNotes();
  },

  setDashboardOpen: (open) => set({ dashboardOpen: open }),
  setGithubOpen: (open) => set({ githubOpen: open }),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
}));
