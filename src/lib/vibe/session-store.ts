// Vibe-Mode session store (Phase 2 data layer) — the state behind the native
// Codex sessions, a standalone zustand store like lib/orchestrator/chat-store.ts
// (kept out of the already-large store.ts). The Rust side (a private
// app-server per session, events) lives in codex/sessions.rs; the event bridge
// + typed invoke wrappers live in controller.ts. No UI here — that is Phase 3.
//
// Items are NORMALIZED per session (`items: Record<id, VibeItem>` + `order`)
// so a streaming delta replaces ONLY its own item object and every other item
// keeps its reference (the t3code identity-preservation lesson — one row
// re-renders per delta batch). Persisted under store key `vibeSessions`,
// debounced ~800 ms, flushed by flushAllPersists at quit, hydrated from
// store.ts hydrate(). Sanitizing is per entry (chat-store philosophy: a broken
// entry only costs itself); `streaming` is never restored and pending
// approvals are marked `cancelled` on hydrate (their process is gone).

import { create } from "zustand";
import { loadVibeSessions, saveVibeSessions } from "@/lib/transport";
import { useProjects } from "@/lib/projects/store";
import type { MigratableSession } from "@/lib/projects/core";
import type {
  PersistedVibeSession,
  PersistedVibeSessions,
  VibeAccess,
  VibeApprovalStatus,
  VibeFileChange,
  VibeItem,
  VibePlanStep,
  VibeSession,
  VibeSessionWorktree,
  VibeSpawnedBy,
  VibeTokenUsage,
} from "@/types";

/** Per-session item cap — oldest items drop first (display + persistence). */
export const MAX_ITEMS = 500;
/** Session cap PER PROJECT — a project's oldest sessions are dropped first. */
export const MAX_SESSIONS_PER_PROJECT = 30;
/** Live command output cap held in memory (per command item). */
export const OUTPUT_CAP = 64 * 1024;
/** Command output cap written to disk (per item) — smaller than the live one. */
export const PERSIST_OUTPUT_CAP = 8 * 1024;

/** Keep the tail of an over-long string on a code-point boundary. */
function capTail(s: string, max: number): string {
  if (s.length <= max) return s;
  return `…[truncated]…${s.slice(s.length - max)}`;
}

/** One live session: meta + normalized transcript + transient turn state. */
export interface VibeSessionEntry {
  session: VibeSession;
  items: Record<string, VibeItem>;
  order: string[];
  // ---- transient (never persisted) ----
  /** running turn id (interrupt target); null between turns */
  turnId: string | null;
  /** latest aggregated unified diff of the running/last turn */
  diff: string | null;
  /** latest turn plan (turn/plan/updated) */
  plan: { explanation?: string | null; steps: VibePlanStep[] } | null;
  /** latest token accounting */
  tokenUsage: VibeTokenUsage | null;
  /** epoch ms the session last left busy → idle; powers the ephemeral
   * "✓ finished · Xm ago" moment in the rail (transient, never persisted) */
  lastBusyEndAt: number | null;
}

/** A new session before the store fills in the transient fields. */
export interface NewVibeSession {
  id: string;
  name: string;
  /** owning project tab — resolved by the controller (never empty) */
  projectId: string;
  /** the generated agent identity (defaults to `name` when omitted) */
  agentName?: string;
  spawnedBy?: VibeSpawnedBy;
  worktree?: VibeSessionWorktree | null;
  projectDir: string;
  model?: string;
  effort?: string;
  access: VibeAccess;
  threadId?: string | null;
}

// Sessions stream item patches during turns — batch disk writes ~800 ms.
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function persistOneItem(item: VibeItem): VibeItem {
  // never persist a live-streaming caret; cap command output smaller on disk
  if (item.kind === "assistant" && item.streaming) {
    const { streaming: _s, ...rest } = item;
    return rest;
  }
  if (item.kind === "command" && item.output.length > PERSIST_OUTPUT_CAP) {
    return { ...item, output: capTail(item.output, PERSIST_OUTPUT_CAP) };
  }
  return item;
}

/** Build the persist snapshot (session meta + capped items). Exported so the
 * DEV perf bench (`window.__vibe.bench`) can time the exact production code. */
export function buildVibePersistSnapshot(): PersistedVibeSessions {
  return snapshot();
}

function snapshot(): PersistedVibeSessions {
  const s = useVibe.getState();
  return {
    // v2 = sessions carry projectId/agentName/spawnedBy/worktree
    version: 2,
    sessions: s.order
      .map((id) => s.sessions[id])
      .filter((e): e is VibeSessionEntry => !!e)
      .map<PersistedVibeSession>((e) => ({
        session: e.session,
        items: e.order
          .map((iid) => e.items[iid])
          .filter((i): i is VibeItem => !!i)
          .map(persistOneItem),
      })),
    activeId: s.activeId,
    activeIdByProject: s.activeIdByProject,
  };
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void saveVibeSessions(snapshot());
  }, 800);
}

/** Write the pending debounce NOW — called from flushAllPersists at quit. */
export async function flushVibePersist(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    await saveVibeSessions(snapshot());
  } catch {
    /* never block quitting on a failed write */
  }
}

export interface VibeState {
  /** sessions by id */
  sessions: Record<string, VibeSessionEntry>;
  /** session order, newest first */
  order: string[];
  activeId: string | null;
  /** remembered selection per project — `activateProject` restores it when
   * switching tabs (persisted; entries validate on hydrate) */
  activeIdByProject: Record<string, string>;
  /** sessions with a turn in flight — set by the controller (in-memory) */
  busy: Record<string, boolean>;
  /** true once hydrateVibeSessions SUCCEEDED (incl. a fresh install) — the
   * chat→project migration resolves touched sessions against this store and
   * must not run before/without it. In-memory, never persisted. */
  hydrated: boolean;

  setActive: (id: string | null) => void;

  // ---- lifecycle (controller) ----
  createSession: (s: NewVibeSession) => void;
  dropSession: (id: string) => void;
  setThreadId: (id: string, threadId: string) => void;
  renameSession: (id: string, name: string) => void;
  setAccess: (id: string, access: VibeAccess) => void;
  /** override the session's model / reasoning effort (applies next turn) */
  setModelEffort: (
    id: string,
    patch: { model?: string; effort?: string },
  ) => void;
  /**
   * Re-home the session (worktree assignment, Phase 4): new working
   * directory + worktree meta in one identity-preserving patch. The backend
   * cwd switch (thread/settings/update) is the controller's job.
   */
  assignWorktree: (
    id: string,
    patch: { projectDir: string; worktree: VibeSessionWorktree | null },
  ) => void;
  /** flip the shared flag of a session's worktree meta (co-tenant joined) */
  setWorktreeShared: (id: string, shared: boolean) => void;

  // ---- turn state (controller) ----
  setBusy: (id: string, busy: boolean) => void;
  setTurnId: (id: string, turnId: string | null) => void;
  setDiff: (id: string, diff: string) => void;
  setPlan: (
    id: string,
    plan: { explanation?: string | null; steps: VibePlanStep[] },
  ) => void;
  setTokenUsage: (id: string, usage: VibeTokenUsage) => void;

  // ---- transcript (controller) ----
  /** insert a new item or replace an existing one by id (normalized upsert) */
  upsertItem: (id: string, item: VibeItem) => void;
  /** patch fields of one existing item (identity-preserving) */
  patchItem: (id: string, itemId: string, patch: Partial<VibeItem>) => void;
  /** append text to a command item's output (capped) */
  appendCommandOutput: (id: string, itemId: string, delta: string) => void;
  /** set an approval item's status */
  setApprovalStatus: (
    id: string,
    approvalId: string,
    status: VibeApprovalStatus,
  ) => void;
}

/**
 * Enforce the per-project session cap on a newest-first id order: each
 * project keeps its newest MAX_SESSIONS_PER_PROJECT sessions. Ids without a
 * live entry drop out too.
 */
function capPerProject(
  order: string[],
  sessions: Record<string, VibeSessionEntry>,
): string[] {
  const counts = new Map<string, number>();
  const kept: string[] = [];
  for (const id of order) {
    const e = sessions[id];
    if (!e) continue;
    const n = (counts.get(e.session.projectId) ?? 0) + 1;
    counts.set(e.session.projectId, n);
    if (n <= MAX_SESSIONS_PER_PROJECT) kept.push(id);
  }
  return kept;
}

/** Replace one session entry immutably, only touching that entry's reference. */
function withEntry(
  state: VibeState,
  id: string,
  fn: (e: VibeSessionEntry) => VibeSessionEntry,
): Partial<VibeState> | null {
  const entry = state.sessions[id];
  if (!entry) return null;
  return { sessions: { ...state.sessions, [id]: fn(entry) } };
}

export const useVibe = create<VibeState>((set, get) => ({
  sessions: {},
  order: [],
  activeId: null,
  activeIdByProject: {},
  busy: {},
  hydrated: false,

  setActive: (id) => {
    const state = get();
    if (state.activeId === id) return;
    const entry = id !== null ? state.sessions[id] : undefined;
    if (id !== null && !entry) return;
    set({
      activeId: id,
      // remember the pick per project so a tab switch can restore it
      ...(entry
        ? {
            activeIdByProject: {
              ...state.activeIdByProject,
              [entry.session.projectId]: id as string,
            },
          }
        : {}),
    });
    schedulePersist();
  },

  createSession: (s) => {
    const state = get();
    if (state.sessions[s.id]) return;
    const entry: VibeSessionEntry = {
      session: {
        id: s.id,
        name: s.name,
        projectId: s.projectId,
        agentName: s.agentName ?? s.name,
        spawnedBy: s.spawnedBy ?? "user",
        worktree: s.worktree ?? null,
        projectDir: s.projectDir,
        ...(s.model !== undefined ? { model: s.model } : {}),
        ...(s.effort !== undefined ? { effort: s.effort } : {}),
        access: s.access,
        threadId: s.threadId ?? null,
        createdAt: Date.now(),
      },
      items: {},
      order: [],
      turnId: null,
      diff: null,
      plan: null,
      tokenUsage: null,
      lastBusyEndAt: null,
    };
    // newest first — the PER-PROJECT cap drops that project's oldest sessions
    const sessions = { ...state.sessions, [s.id]: entry };
    const order = capPerProject([s.id, ...state.order], sessions);
    for (const oid of state.order) {
      if (!order.includes(oid)) delete sessions[oid];
    }
    set({
      sessions,
      order,
      activeId: s.id,
      activeIdByProject: {
        ...state.activeIdByProject,
        [s.projectId]: s.id,
      },
    });
    schedulePersist();
  },

  dropSession: (id) => {
    const state = get();
    if (!state.sessions[id]) return;
    const order = state.order.filter((oid) => oid !== id);
    const idx = state.order.indexOf(id);
    const { [id]: _gone, ...sessions } = state.sessions;
    const { [id]: _b, ...busy } = state.busy;
    const activeIdByProject = { ...state.activeIdByProject };
    for (const [pid, sid] of Object.entries(activeIdByProject)) {
      if (sid === id) delete activeIdByProject[pid];
    }
    set({
      sessions,
      order,
      busy,
      activeIdByProject,
      activeId:
        state.activeId === id
          ? (order[Math.min(idx, order.length - 1)] ?? null)
          : state.activeId,
    });
    schedulePersist();
  },

  setThreadId: (id, threadId) => {
    const patch = withEntry(get(), id, (e) =>
      e.session.threadId === threadId
        ? e
        : { ...e, session: { ...e.session, threadId } },
    );
    if (!patch) return;
    set(patch);
    schedulePersist();
  },

  renameSession: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const patch = withEntry(get(), id, (e) =>
      e.session.name === trimmed
        ? e
        : { ...e, session: { ...e.session, name: trimmed } },
    );
    if (!patch) return;
    set(patch);
    schedulePersist();
  },

  setAccess: (id, access) => {
    const patch = withEntry(get(), id, (e) =>
      e.session.access === access
        ? e
        : { ...e, session: { ...e.session, access } },
    );
    if (!patch) return;
    set(patch);
    schedulePersist();
  },

  setModelEffort: (id, { model, effort }) => {
    const patch = withEntry(get(), id, (e) =>
      e.session.model === model && e.session.effort === effort
        ? e
        : {
            ...e,
            session: {
              ...e.session,
              ...(model !== undefined ? { model } : { model: undefined }),
              ...(effort !== undefined ? { effort } : { effort: undefined }),
            },
          },
    );
    if (!patch) return;
    set(patch);
    schedulePersist();
  },

  assignWorktree: (id, { projectDir, worktree }) => {
    const patch = withEntry(get(), id, (e) =>
      e.session.projectDir === projectDir && e.session.worktree === worktree
        ? e
        : { ...e, session: { ...e.session, projectDir, worktree } },
    );
    if (!patch) return;
    set(patch);
    schedulePersist();
  },

  setWorktreeShared: (id, shared) => {
    const patch = withEntry(get(), id, (e) =>
      !e.session.worktree || e.session.worktree.shared === shared
        ? e
        : {
            ...e,
            session: {
              ...e.session,
              worktree: { ...e.session.worktree, shared },
            },
          },
    );
    if (!patch) return;
    set(patch);
    schedulePersist();
  },

  setBusy: (id, busy) => {
    const state = get();
    const prev = !!state.busy[id];
    if (prev === busy) return;
    const next: Partial<VibeState> = { busy: { ...state.busy, [id]: busy } };
    // just left busy → stamp the ephemeral "finished" moment (transient)
    if (prev && !busy) {
      const patch = withEntry(state, id, (e) => ({
        ...e,
        lastBusyEndAt: Date.now(),
      }));
      if (patch) next.sessions = patch.sessions;
    }
    set(next);
  },

  setTurnId: (id, turnId) => {
    const patch = withEntry(get(), id, (e) =>
      e.turnId === turnId ? e : { ...e, turnId },
    );
    if (patch) set(patch); // transient — not persisted
  },

  setDiff: (id, diff) => {
    const patch = withEntry(get(), id, (e) => ({ ...e, diff }));
    if (patch) set(patch);
  },

  setPlan: (id, plan) => {
    const patch = withEntry(get(), id, (e) => ({ ...e, plan }));
    if (patch) set(patch);
  },

  setTokenUsage: (id, tokenUsage) => {
    const patch = withEntry(get(), id, (e) => ({ ...e, tokenUsage }));
    if (patch) set(patch);
  },

  upsertItem: (id, item) => {
    const patch = withEntry(get(), id, (e) => {
      const exists = !!e.items[item.id];
      let order = e.order;
      let items = { ...e.items, [item.id]: item };
      if (!exists) {
        order = [...e.order, item.id];
        // enforce the per-session cap — oldest items drop from map + order
        if (order.length > MAX_ITEMS) {
          const overflow = order.length - MAX_ITEMS;
          const removed = order.slice(0, overflow);
          order = order.slice(overflow);
          items = { ...items };
          for (const rid of removed) delete items[rid];
        }
      }
      return { ...e, items, order };
    });
    if (!patch) return;
    set(patch);
    schedulePersist();
  },

  patchItem: (id, itemId, patch) => {
    const next = withEntry(get(), id, (e) => {
      const item = e.items[itemId];
      if (!item) return e;
      return {
        ...e,
        items: { ...e.items, [itemId]: { ...item, ...patch } as VibeItem },
      };
    });
    if (!next) return;
    set(next);
    schedulePersist();
  },

  appendCommandOutput: (id, itemId, delta) => {
    const next = withEntry(get(), id, (e) => {
      const item = e.items[itemId];
      if (!item || item.kind !== "command") return e;
      const output = capTail(item.output + delta, OUTPUT_CAP);
      return {
        ...e,
        items: { ...e.items, [itemId]: { ...item, output } },
      };
    });
    if (!next) return;
    set(next);
    schedulePersist();
  },

  setApprovalStatus: (id, approvalId, status) => {
    const next = withEntry(get(), id, (e) => {
      const item = e.items[approvalId];
      if (!item || item.kind !== "approval") return e;
      return {
        ...e,
        items: { ...e.items, [approvalId]: { ...item, status } },
      };
    });
    if (!next) return;
    set(next);
    schedulePersist();
  },
}));

// ---------------------------------------------------------------------------
// Hydration — per-entry graceful degradation (a broken entry costs only itself)
// ---------------------------------------------------------------------------

/** Tolerant worktree hydration — Phase 4 fills the field, Phase 2 carries it. */
function sanitizeWorktree(raw: unknown): VibeSessionWorktree | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Record<string, unknown>;
  if (typeof w.root !== "string" || typeof w.branch !== "string") return null;
  return { root: w.root, branch: w.branch, shared: w.shared === true };
}

/**
 * One persisted session, hardened field by field. Pre-v2 sessions come out
 * with `projectId: ""` — the hydrate migration assigns them to a project
 * derived from their `projectDir` (see `useProjects.adoptSessions`).
 */
function sanitizeSession(raw: unknown): VibeSession | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== "string" || typeof s.projectDir !== "string") return null;
  const access: VibeAccess = s.access === "full" ? "full" : "workspace";
  const name =
    typeof s.name === "string" && s.name.trim() ? s.name : "Vibe session";
  return {
    id: s.id,
    name,
    projectId: typeof s.projectId === "string" ? s.projectId : "",
    // migrated (pre-v2) sessions carry their old display name as identity
    agentName:
      typeof s.agentName === "string" && s.agentName.trim()
        ? s.agentName
        : name,
    spawnedBy: s.spawnedBy === "conductor" ? "conductor" : "user",
    worktree: sanitizeWorktree(s.worktree),
    projectDir: s.projectDir,
    ...(typeof s.model === "string" && s.model ? { model: s.model } : {}),
    ...(typeof s.effort === "string" && s.effort ? { effort: s.effort } : {}),
    access,
    threadId: typeof s.threadId === "string" ? s.threadId : null,
    createdAt: typeof s.createdAt === "number" ? s.createdAt : Date.now(),
  };
}

function sanitizeFileChanges(raw: unknown): VibeFileChange[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c) => {
    if (!c || typeof c !== "object") return [];
    const ch = c as Record<string, unknown>;
    if (typeof ch.path !== "string") return [];
    return [
      {
        path: ch.path,
        kind: ch.kind ?? null,
        diff: typeof ch.diff === "string" ? ch.diff : "",
      },
    ];
  });
}

function sanitizePlanSteps(raw: unknown): VibePlanStep[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((p) => {
    if (!p || typeof p !== "object") return [];
    const s = p as Record<string, unknown>;
    if (typeof s.step !== "string") return [];
    return [{ step: s.step, status: typeof s.status === "string" ? s.status : "" }];
  });
}

/** One persisted item, hardened field by field. Unknown kinds are dropped. */
function sanitizeItem(raw: unknown): VibeItem | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== "string") return null;
  const id = m.id;
  const at = typeof m.at === "number" ? m.at : Date.now();
  const text = typeof m.text === "string" ? m.text : "";
  switch (m.kind) {
    case "user":
    case "warning":
      return { id, at, kind: m.kind, text };
    case "assistant":
      // never restore `streaming` — a quit mid-stream must not leave a caret
      return {
        id,
        at,
        kind: "assistant",
        text,
        ...(typeof m.phase === "string" ? { phase: m.phase } : {}),
        // the report stamp survives restarts — the card keeps rendering
        ...(m.report === true ? { report: true } : {}),
      };
    case "command":
      return {
        id,
        at,
        kind: "command",
        command: typeof m.command === "string" ? m.command : "",
        ...(typeof m.cwd === "string" ? { cwd: m.cwd } : {}),
        status: typeof m.status === "string" ? m.status : "",
        exitCode:
          typeof m.exitCode === "number" || m.exitCode === null
            ? (m.exitCode as number | null)
            : null,
        output: typeof m.output === "string" ? m.output : "",
      };
    case "fileChange":
      return {
        id,
        at,
        kind: "fileChange",
        status: typeof m.status === "string" ? m.status : "",
        changes: sanitizeFileChanges(m.changes),
      };
    case "plan":
      return {
        id,
        at,
        kind: "plan",
        ...(typeof m.explanation === "string" || m.explanation === null
          ? { explanation: m.explanation as string | null }
          : {}),
        steps: sanitizePlanSteps(m.steps),
      };
    case "webSearch":
      return {
        id,
        at,
        kind: "webSearch",
        query: typeof m.query === "string" ? m.query : "",
        ...(m.action !== undefined ? { action: m.action } : {}),
      };
    case "approval": {
      const approvalKind = m.approvalKind === "fileChange" ? "fileChange" : "command";
      // the process behind a persisted pending approval is gone → cancelled
      const rawStatus = m.status;
      const status: VibeApprovalStatus =
        rawStatus === "accepted" ||
        rawStatus === "acceptedForSession" ||
        rawStatus === "declined"
          ? rawStatus
          : "cancelled";
      return {
        id,
        at,
        kind: "approval",
        approvalKind,
        status,
        // routing class survives hydration; anything else = destructive
        ...(m.escalation === "routine" || m.escalation === "destructive"
          ? { escalation: m.escalation }
          : {}),
        payload:
          m.payload && typeof m.payload === "object"
            ? (m.payload as Record<string, unknown>)
            : {},
      };
    }
    default:
      return null;
  }
}

/**
 * Load persisted sessions — called from store.ts hydrate() AFTER the project
 * store hydrated. A session created before hydrate resolved survives (merged
 * after the persisted ones). Sessions are NOT auto-reconnected here — the
 * controller resumes a session's thread lazily on the next send.
 *
 * Schema-v2 migration: every hydrated session is run through the project
 * assignment (`useProjects.adoptSessions`) — a valid `projectId` passes
 * through, pre-v2 sessions (and sessions whose project record was lost) get
 * projects derived/created from their `projectDir`s (deduped). The stamped
 * result is persisted right away so the migration runs once.
 */
export async function hydrateVibeSessions(): Promise<void> {
  let data: PersistedVibeSessions | null = null;
  try {
    data = await loadVibeSessions();
  } catch {
    // load failed — `hydrated` stays false, downstream migrations skip
    return;
  }
  if (!data) {
    // fresh install: nothing persisted IS a successful hydration
    useVibe.setState({ hydrated: true });
    return;
  }
  const sessions: Record<string, VibeSessionEntry> = {};
  const order: string[] = [];
  for (const raw of Array.isArray(data.sessions) ? data.sessions : []) {
    try {
      const session = sanitizeSession((raw as PersistedVibeSession)?.session);
      if (!session || sessions[session.id]) continue;
      const items: Record<string, VibeItem> = {};
      const itemOrder: string[] = [];
      const rawItems = Array.isArray((raw as PersistedVibeSession).items)
        ? (raw as PersistedVibeSession).items
        : [];
      for (const ri of rawItems.slice(-MAX_ITEMS)) {
        const item = sanitizeItem(ri);
        if (!item || items[item.id]) continue;
        items[item.id] = item;
        itemOrder.push(item.id);
      }
      sessions[session.id] = {
        session,
        items,
        order: itemOrder,
        turnId: null,
        diff: null,
        plan: null,
        tokenUsage: null,
        lastBusyEndAt: null,
      };
      order.push(session.id);
    } catch {
      /* skip this session only */
    }
  }

  // ---- project assignment (v2 migration + self-heal) ----
  let migrated = false;
  try {
    const migratable: MigratableSession[] = order.map((id) => ({
      id,
      projectDir: sessions[id].session.projectDir,
      projectId: sessions[id].session.projectId || null,
    }));
    const assignments = useProjects.getState().adoptSessions(migratable);
    for (const id of order) {
      const assigned = assignments[id];
      if (assigned && sessions[id].session.projectId !== assigned) {
        sessions[id] = {
          ...sessions[id],
          session: { ...sessions[id].session, projectId: assigned },
        };
        migrated = true;
      }
    }
  } catch {
    /* keep sessions hydrated even if the assignment failed */
  }

  const state = useVibe.getState();
  // a session created before hydrate resolved wins; append persisted after
  const mergedSessions: Record<string, VibeSessionEntry> = { ...sessions };
  for (const id of Object.keys(state.sessions))
    mergedSessions[id] = state.sessions[id];
  const mergedOrder = capPerProject(
    state.order.length
      ? [...state.order, ...order.filter((id) => !state.sessions[id])]
      : order,
    mergedSessions,
  );
  // drop anything beyond the per-project cap
  for (const id of Object.keys(mergedSessions))
    if (!mergedOrder.includes(id)) delete mergedSessions[id];
  // per-project selection map: only entries whose session survived AND still
  // belongs to that project; live (pre-hydrate) picks win
  const activeIdByProject: Record<string, string> = {};
  const rawMap =
    data.activeIdByProject && typeof data.activeIdByProject === "object"
      ? data.activeIdByProject
      : {};
  for (const [pid, sid] of Object.entries(rawMap)) {
    if (
      typeof sid === "string" &&
      mergedSessions[sid]?.session.projectId === pid
    )
      activeIdByProject[pid] = sid;
  }
  for (const [pid, sid] of Object.entries(state.activeIdByProject)) {
    activeIdByProject[pid] = sid;
  }
  useVibe.setState({
    sessions: mergedSessions,
    order: mergedOrder,
    activeIdByProject,
    activeId:
      state.activeId ??
      (typeof data.activeId === "string" && mergedOrder.includes(data.activeId)
        ? data.activeId
        : (mergedOrder[0] ?? null)),
    hydrated: true,
  });
  // the one-time migration result must survive a quit without further edits
  if (migrated || (data.version ?? 1) < 2) schedulePersist();
}
