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
import type {
  PersistedVibeSession,
  PersistedVibeSessions,
  VibeAccess,
  VibeApprovalStatus,
  VibeFileChange,
  VibeItem,
  VibePlanStep,
  VibeSession,
  VibeTokenUsage,
} from "@/types";

/** Per-session item cap — oldest items drop first (display + persistence). */
export const MAX_ITEMS = 500;
/** Total session cap — oldest sessions are dropped first. */
export const MAX_SESSIONS = 30;
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
  projectDir: string;
  model?: string;
  effort?: string;
  access: VibeAccess;
  threadId?: string | null;
  /** slug of the custom agent this session runs as, if any */
  agentSlug?: string;
  /** slug of the agent this session is a BUILDER for (Phase C), if any */
  builderForSlug?: string;
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
    version: 1,
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
  /** sessions with a turn in flight — set by the controller (in-memory) */
  busy: Record<string, boolean>;

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
  busy: {},

  setActive: (id) => {
    if (get().activeId === id) return;
    if (id !== null && !get().sessions[id]) return;
    set({ activeId: id });
    schedulePersist();
  },

  createSession: (s) => {
    const state = get();
    if (state.sessions[s.id]) return;
    const entry: VibeSessionEntry = {
      session: {
        id: s.id,
        name: s.name,
        projectDir: s.projectDir,
        ...(s.model !== undefined ? { model: s.model } : {}),
        ...(s.effort !== undefined ? { effort: s.effort } : {}),
        access: s.access,
        threadId: s.threadId ?? null,
        createdAt: Date.now(),
        ...(s.agentSlug ? { agentSlug: s.agentSlug } : {}),
        ...(s.builderForSlug ? { builderForSlug: s.builderForSlug } : {}),
      },
      items: {},
      order: [],
      turnId: null,
      diff: null,
      plan: null,
      tokenUsage: null,
      lastBusyEndAt: null,
    };
    // newest first — the cap drops the oldest sessions from the end
    const order = [s.id, ...state.order].slice(0, MAX_SESSIONS);
    const dropped = state.order.filter((oid) => !order.includes(oid));
    const sessions = { ...state.sessions, [s.id]: entry };
    for (const oid of dropped) delete sessions[oid];
    set({ sessions, order, activeId: s.id });
    schedulePersist();
  },

  dropSession: (id) => {
    const state = get();
    if (!state.sessions[id]) return;
    const order = state.order.filter((oid) => oid !== id);
    const idx = state.order.indexOf(id);
    const { [id]: _gone, ...sessions } = state.sessions;
    const { [id]: _b, ...busy } = state.busy;
    set({
      sessions,
      order,
      busy,
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

function sanitizeSession(raw: unknown): VibeSession | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== "string" || typeof s.projectDir !== "string") return null;
  const access: VibeAccess = s.access === "full" ? "full" : "workspace";
  return {
    id: s.id,
    name: typeof s.name === "string" && s.name.trim() ? s.name : "Vibe session",
    projectDir: s.projectDir,
    ...(typeof s.model === "string" && s.model ? { model: s.model } : {}),
    ...(typeof s.effort === "string" && s.effort ? { effort: s.effort } : {}),
    access,
    threadId: typeof s.threadId === "string" ? s.threadId : null,
    createdAt: typeof s.createdAt === "number" ? s.createdAt : Date.now(),
    ...(typeof s.agentSlug === "string" && s.agentSlug
      ? { agentSlug: s.agentSlug }
      : {}),
    ...(typeof s.builderForSlug === "string" && s.builderForSlug
      ? { builderForSlug: s.builderForSlug }
      : {}),
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
 * Load persisted sessions — called from store.ts hydrate(). A session created
 * before hydrate resolved survives (merged after the persisted ones). Sessions
 * are NOT auto-reconnected here — the controller resumes a session's thread
 * lazily on the next send (Phase 3 wires the UI).
 */
export async function hydrateVibeSessions(): Promise<void> {
  let data: PersistedVibeSessions | null = null;
  try {
    data = await loadVibeSessions();
  } catch {
    return;
  }
  if (!data) return;
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
  const state = useVibe.getState();
  // a session created before hydrate resolved wins; append persisted after
  const mergedOrder = state.order.length
    ? [...state.order, ...order.filter((id) => !state.sessions[id])].slice(
        0,
        MAX_SESSIONS,
      )
    : order.slice(0, MAX_SESSIONS);
  const mergedSessions: Record<string, VibeSessionEntry> = { ...sessions };
  for (const id of Object.keys(state.sessions))
    mergedSessions[id] = state.sessions[id];
  // drop anything beyond the cap
  for (const id of Object.keys(mergedSessions))
    if (!mergedOrder.includes(id)) delete mergedSessions[id];
  useVibe.setState({
    sessions: mergedSessions,
    order: mergedOrder,
    activeId:
      state.activeId ??
      (typeof data.activeId === "string" && mergedOrder.includes(data.activeId)
        ? data.activeId
        : (mergedOrder[0] ?? null)),
  });
}
