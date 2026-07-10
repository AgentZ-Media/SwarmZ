// Conductor chat store (Phase 3: project-scoped) — the chat state behind the
// Conductor stage, colocated with the rest of the orchestrator plumbing
// instead of growing store.ts further (same standalone-zustand pattern as
// lib/vibe/session-store.ts). Every chat belongs to exactly one PROJECT (the
// Conductor instance it runs on); the stage shows only the active project's
// chats and the active chat is remembered PER PROJECT (`activeByProject`).
// Persists in swarmz.json under `orchestratorChats` (v2: chats carry
// projectId + the active map), debounced, flushed by flushAllPersists at quit
// and hydrated from store.ts hydrate() AFTER projects + vibe sessions — the
// Phase-3 chat→project migration resolves against both. The Codex side
// (events, resume, delta batching) lives in controller.ts.

import { create } from "zustand";
import { nanoid } from "nanoid";
import { loadOrchestratorChats, saveOrchestratorChats } from "@/lib/transport";
import { useProjects } from "@/lib/projects/store";
import { useVibe } from "@/lib/vibe/session-store";
import type {
  OrchestratorChat,
  OrchestratorChatMessage,
  OrchestratorPaneRef,
  OrchestratorPingRecord,
  OrchestratorTouchedPane,
  PersistedOrchestratorChats,
  VibeTokenUsage,
} from "@/types";
// type-only: no runtime cycle (chat.ts imports the main store)
import type { OrchestratorChatStatus } from "./chat";
import {
  applyChatAssignments,
  assignChatsToProjects,
  capChats,
  collapseEmptyChats,
  isReusableEmptyChat,
  type MigratableChat,
} from "./chat-reuse";

/** Per-chat message cap — oldest messages drop first (display + persistence). */
export const MAX_CHAT_MESSAGES = 200;
/** Total chat cap — the oldest chats are deleted first (`capChats`). Chats
 * still awaiting their project assignment (projectId "") are EXEMPT until
 * healed — they must never be evicted before the migration could resolve
 * them. */
export const MAX_CHATS = 30;
/** Per-chat ping cap (delivered + undelivered) — oldest drop first. */
export const MAX_PENDING_PINGS = 20;
export const DEFAULT_CHAT_TITLE = "New chat";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** A message before the store stamps id + timestamp. */
export type NewOrchestratorMessage = DistributiveOmit<
  OrchestratorChatMessage,
  "id" | "at"
>;

/** Fields the controller may patch on an existing message. */
export interface OrchestratorMessagePatch {
  text?: string;
  streaming?: boolean;
  ok?: boolean;
  paneRefs?: OrchestratorPaneRef[];
}

// Chats stream store patches every ~80 ms — batch the (whole-file) disk
// writes a bit wider than usual.
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function snapshot(): PersistedOrchestratorChats {
  const s = useOrchestrator.getState();
  return {
    // v2 = chats carry projectId + the per-project active map
    version: 2,
    chats: s.chats,
    activeByProject: s.activeByProject,
  };
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void saveOrchestratorChats(snapshot());
  }, 800);
}

/** Write the pending debounce NOW — called from flushAllPersists at quit. */
export async function flushOrchestratorPersist(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    await saveOrchestratorChats(snapshot());
  } catch {
    /* never block quitting on a failed write */
  }
}

export interface OrchestratorState {
  /** all chats across all projects, newest first */
  chats: OrchestratorChat[];
  /** active chat per project — the stage restores per tab (persisted) */
  activeByProject: Record<string, string>;
  /** chats with a turn in flight — set by the controller (in-memory) */
  busy: Record<string, boolean>;
  /** latest per-chat token accounting (in-memory, never persisted) — codex
   * chats get it from the `token_usage` chat event (thread/tokenUsage/updated) */
  tokenUsage: Record<string, VibeTokenUsage>;
  /** codex app-server availability, checked on first stage open (in-memory) */
  status: OrchestratorChatStatus | null;

  /**
   * Create a chat FOR ONE PROJECT (reusing that project's empty one) and
   * activate it there. Model + effort are stamped here as the chat's initial
   * override; a reused EMPTY chat is re-stamped with the current values (it
   * has no history yet, so it must follow the current setting). Callers go
   * through controller.ts `createChat()`, which reads the settings.
   */
  newChat: (projectId: string, model?: string, effort?: string) => string;
  /**
   * Remove a chat from SwarmZ. The codex thread rollout stays on disk —
   * deliberate; it just never gets resumed again.
   */
  deleteChat: (id: string) => void;
  /** activate a chat within ITS project (stamps `activeByProject`) */
  setActiveChat: (id: string) => void;
  setStatus: (status: OrchestratorChatStatus | null) => void;
  /**
   * Override this chat's model / reasoning effort (persisted) — carried into
   * its next turn/start. `undefined` clears back to the default.
   */
  setChatModelEffort: (
    chatId: string,
    patch: { model?: string; effort?: string },
  ) => void;
  /** in-memory: store the latest token accounting for a chat (not persisted) */
  setChatTokenUsage: (chatId: string, usage: VibeTokenUsage) => void;

  // controller internals
  setBusy: (chatId: string, busy: boolean) => void;
  setChatThreadId: (chatId: string, threadId: string) => void;
  setChatTitle: (chatId: string, title: string) => void;
  /** append a message (stamps id + timestamp, enforces the message cap) */
  appendMessage: (chatId: string, msg: NewOrchestratorMessage) => string;
  patchMessage: (
    chatId: string,
    messageId: string,
    patch: OrchestratorMessagePatch,
  ) => void;

  // status pings
  /** remember that this chat prompted a session (prompt_pane / create_panes) */
  recordTouchedPane: (chatId: string, paneId: string, name: string) => void;
  /** record an undelivered ping (cap MAX_PENDING_PINGS, oldest dropped) */
  addPendingPing: (
    chatId: string,
    ping: Omit<OrchestratorPingRecord, "delivered">,
  ) => void;
  /** mark the chat's undelivered pings delivered and return them (in order) */
  takePendingPings: (chatId: string) => OrchestratorPingRecord[];
}

/**
 * The active chat of one project: the remembered one if it still exists and
 * belongs there, else the project's newest chat, else null. The Conductor
 * stage selects this (a primitive — never a fresh array).
 */
export function activeChatIdFor(
  s: Pick<OrchestratorState, "chats" | "activeByProject">,
  projectId: string,
): string | null {
  const remembered = s.activeByProject[projectId];
  if (
    remembered &&
    s.chats.some((c) => c.id === remembered && c.projectId === projectId)
  ) {
    return remembered;
  }
  return s.chats.find((c) => c.projectId === projectId)?.id ?? null;
}

export const useOrchestrator = create<OrchestratorState>((set, get) => ({
  chats: [],
  activeByProject: {},
  busy: {},
  tokenUsage: {},
  status: null,

  newChat: (projectId, model, effort) => {
    const s = get();
    // don't stack empties — the + button reuses THIS project's untouched
    // chat. "Untouched" means no user/assistant turn (system pings + warnings
    // don't count, or a restart would stack a new chat behind that noise). A
    // reusable-empty chat has no backend thread yet, so re-stamping
    // model/effort to the CURRENT setting is safe (and what the user expects
    // after switching it).
    const empty = s.chats.find(
      (c) => c.projectId === projectId && isReusableEmptyChat(c),
    );
    if (empty) {
      const stamp = empty.model !== model || empty.effort !== effort;
      if (s.activeByProject[projectId] !== empty.id || stamp) {
        set({
          activeByProject: { ...s.activeByProject, [projectId]: empty.id },
          chats: stamp
            ? s.chats.map((c) =>
                c.id === empty.id ? { ...c, model, effort } : c,
              )
            : s.chats,
        });
        schedulePersist();
      }
      return empty.id;
    }
    const chat: OrchestratorChat = {
      id: nanoid(8),
      projectId,
      threadId: null,
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      title: DEFAULT_CHAT_TITLE,
      createdAt: Date.now(),
      messages: [],
      touchedPanes: {},
      pendingPings: [],
    };
    // newest first — the cap drops the oldest chats (unassigned ones exempt)
    const chats = capChats([chat, ...s.chats], MAX_CHATS);
    set({
      chats,
      activeByProject: { ...s.activeByProject, [projectId]: chat.id },
    });
    schedulePersist();
    return chat.id;
  },

  deleteChat: (id) => {
    const s = get();
    const chat = s.chats.find((c) => c.id === id);
    if (!chat) return;
    const chats = s.chats.filter((c) => c.id !== id);
    const { [id]: _gone, ...busy } = s.busy;
    const { [id]: _u, ...tokenUsage } = s.tokenUsage;
    const activeByProject = { ...s.activeByProject };
    if (activeByProject[chat.projectId] === id) {
      const next = chats.find((c) => c.projectId === chat.projectId)?.id;
      if (next) activeByProject[chat.projectId] = next;
      else delete activeByProject[chat.projectId];
    }
    set({ chats, busy, tokenUsage, activeByProject });
    schedulePersist();
  },

  setActiveChat: (id) => {
    const s = get();
    const chat = s.chats.find((c) => c.id === id);
    if (!chat || s.activeByProject[chat.projectId] === id) return;
    set({ activeByProject: { ...s.activeByProject, [chat.projectId]: id } });
    schedulePersist();
  },

  setStatus: (status) => set({ status }),

  setChatModelEffort: (chatId, patch) => {
    const s = get();
    const chat = s.chats.find((c) => c.id === chatId);
    if (!chat) return;
    const model = "model" in patch ? patch.model : chat.model;
    const effort = "effort" in patch ? patch.effort : chat.effort;
    if (chat.model === model && chat.effort === effort) return;
    set({
      chats: s.chats.map((c) =>
        c.id === chatId ? { ...c, model, effort } : c,
      ),
    });
    schedulePersist();
  },

  setChatTokenUsage: (chatId, usage) => {
    const s = get();
    if (!s.chats.some((c) => c.id === chatId)) return;
    set({ tokenUsage: { ...s.tokenUsage, [chatId]: usage } });
  },

  setBusy: (chatId, busy) => {
    const s = get();
    if (!!s.busy[chatId] === busy) return;
    set({ busy: { ...s.busy, [chatId]: busy } });
  },

  setChatThreadId: (chatId, threadId) => {
    const s = get();
    const chat = s.chats.find((c) => c.id === chatId);
    if (!chat || chat.threadId === threadId) return;
    set({
      chats: s.chats.map((c) => (c.id === chatId ? { ...c, threadId } : c)),
    });
    schedulePersist();
  },

  setChatTitle: (chatId, title) => {
    const s = get();
    const trimmed = title.trim();
    const chat = s.chats.find((c) => c.id === chatId);
    if (!chat || !trimmed || chat.title === trimmed) return;
    set({
      chats: s.chats.map((c) =>
        c.id === chatId ? { ...c, title: trimmed } : c,
      ),
    });
    schedulePersist();
  },

  appendMessage: (chatId, msg) => {
    const id = nanoid(8);
    const s = get();
    const chat = s.chats.find((c) => c.id === chatId);
    if (!chat) return id; // chat deleted mid-turn — late events are a no-op
    const message = { ...msg, id, at: Date.now() } as OrchestratorChatMessage;
    const messages = [...chat.messages, message].slice(-MAX_CHAT_MESSAGES);
    set({
      chats: s.chats.map((c) => (c.id === chatId ? { ...c, messages } : c)),
    });
    schedulePersist();
    return id;
  },

  patchMessage: (chatId, messageId, patch) => {
    const s = get();
    const chat = s.chats.find((c) => c.id === chatId);
    if (!chat || !chat.messages.some((m) => m.id === messageId)) return;
    set({
      chats: s.chats.map((c) =>
        c.id === chatId
          ? {
              ...c,
              messages: c.messages.map((m) =>
                m.id === messageId
                  ? ({ ...m, ...patch } as OrchestratorChatMessage)
                  : m,
              ),
            }
          : c,
      ),
    });
    schedulePersist();
  },

  recordTouchedPane: (chatId, paneId, name) => {
    const s = get();
    if (!s.chats.some((c) => c.id === chatId)) return;
    set({
      chats: s.chats.map((c) =>
        c.id === chatId
          ? {
              ...c,
              touchedPanes: {
                ...c.touchedPanes,
                [paneId]: { name, lastPromptAt: Date.now() },
              },
            }
          : c,
      ),
    });
    schedulePersist();
  },

  addPendingPing: (chatId, ping) => {
    const s = get();
    if (!s.chats.some((c) => c.id === chatId)) return;
    set({
      chats: s.chats.map((c) =>
        c.id === chatId
          ? {
              ...c,
              pendingPings: [
                ...c.pendingPings,
                { ...ping, delivered: false },
              ].slice(-MAX_PENDING_PINGS),
            }
          : c,
      ),
    });
    schedulePersist();
  },

  takePendingPings: (chatId) => {
    const s = get();
    const chat = s.chats.find((c) => c.id === chatId);
    if (!chat) return [];
    const undelivered = chat.pendingPings.filter((p) => !p.delivered);
    if (!undelivered.length) return [];
    set({
      chats: s.chats.map((c) =>
        c.id === chatId
          ? {
              ...c,
              pendingPings: c.pendingPings.map((p) =>
                p.delivered ? p : { ...p, delivered: true },
              ),
            }
          : c,
      ),
    });
    schedulePersist();
    return undelivered;
  },
}));

function sanitizePaneRefs(raw: unknown): OrchestratorPaneRef[] {
  return Array.isArray(raw)
    ? raw.filter(
        (r): r is OrchestratorPaneRef =>
          !!r &&
          typeof (r as OrchestratorPaneRef).id === "string" &&
          typeof (r as OrchestratorPaneRef).name === "string",
      )
    : [];
}

/** One persisted message, hardened field by field. Unknown roles are dropped. */
function sanitizeMessage(raw: unknown): OrchestratorChatMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const id = typeof m.id === "string" ? m.id : nanoid(8);
  const at = typeof m.at === "number" ? m.at : Date.now();
  const text = typeof m.text === "string" ? m.text : "";
  switch (m.role) {
    case "user":
    case "warning":
      return { id, at, role: m.role, text };
    case "system": {
      // status pings carry the pinged pane (jump chip + "Review")
      const paneRefs = sanitizePaneRefs(m.paneRefs);
      return {
        id,
        at,
        role: "system",
        text,
        ...(paneRefs.length ? { paneRefs } : {}),
      };
    }
    case "assistant":
      // never restore `streaming` — a quit mid-stream must not leave a
      // forever-pulsing caret behind
      return { id, at, role: "assistant", text };
    case "tool": {
      if (typeof m.tool !== "string") return null;
      const paneRefs = sanitizePaneRefs(m.paneRefs);
      return {
        id,
        at,
        role: "tool",
        tool: m.tool,
        argsSummary: typeof m.argsSummary === "string" ? m.argsSummary : "",
        ...(typeof m.ok === "boolean" ? { ok: m.ok } : {}),
        ...(paneRefs.length ? { paneRefs } : {}),
      };
    }
    default:
      return null;
  }
}

/** Persisted touchedPanes map, entry by entry (malformed entries dropped). */
function sanitizeTouchedPanes(
  raw: unknown,
): Record<string, OrchestratorTouchedPane> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, OrchestratorTouchedPane> = {};
  for (const [paneId, v] of Object.entries(raw as Record<string, unknown>)) {
    const t = v as OrchestratorTouchedPane | null;
    if (t && typeof t.name === "string" && typeof t.lastPromptAt === "number")
      out[paneId] = { name: t.name, lastPromptAt: t.lastPromptAt };
  }
  return out;
}

/** Persisted ping records, entry by entry (malformed entries dropped). */
function sanitizePings(raw: unknown): OrchestratorPingRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is OrchestratorPingRecord => {
      const r = p as OrchestratorPingRecord | null;
      return (
        !!r &&
        typeof r.paneId === "string" &&
        typeof r.paneName === "string" &&
        (r.activity === "idle" || r.activity === "waiting") &&
        typeof r.at === "number" &&
        typeof r.delivered === "boolean"
      );
    })
    .slice(-MAX_PENDING_PINGS);
}

/**
 * Re-run the project assignment for chats still carrying projectId "" (the
 * unresolved-migration state) against the CURRENT project + session stores.
 * Only ever assigns a real project — a "" stays "" until one exists. Called
 * from hydrate and from a projects-store watcher, so unassigned chats heal
 * as soon as projects become available (they are also exempt from the chat
 * cap until then).
 */
export function healUnassignedChats(): void {
  const s = useOrchestrator.getState();
  if (!s.chats.some((c) => c.projectId === "")) return;
  const projects = useProjects.getState();
  const validIds = new Set(Object.keys(projects.projects));
  if (validIds.size === 0) return;
  const fallback =
    projects.activeProjectId ??
    Object.values(projects.projects).sort(
      (a, b) => b.lastActiveAt - a.lastActiveAt,
    )[0]?.id ??
    null;
  const vibe = useVibe.getState();
  const migratable: MigratableChat[] = s.chats
    .filter((c) => c.projectId === "")
    .map((c) => ({
      id: c.id,
      projectId: null,
      touched: Object.fromEntries(
        Object.entries(c.touchedPanes).map(([sid, t]) => [sid, t.lastPromptAt]),
      ),
    }));
  const assignments = assignChatsToProjects(
    migratable,
    validIds,
    (sessionId) => vibe.sessions[sessionId]?.session.projectId ?? null,
    fallback,
  );
  let changed = false;
  const chats = s.chats.map((c) => {
    const assigned = assignments[c.id];
    if (c.projectId === "" && assigned) {
      changed = true;
      return { ...c, projectId: assigned };
    }
    return c;
  });
  if (!changed) return;
  useOrchestrator.setState({ chats });
  schedulePersist();
}

let healWatcherStarted = false;

/** Heal unassigned chats whenever the project store changes (rare events). */
function startHealWatcher(): void {
  if (healWatcherStarted) return;
  healWatcherStarted = true;
  useProjects.subscribe(() => healUnassignedChats());
}

/** What the surrounding hydrate() knows about the other slices. */
export interface ChatHydrateContext {
  /** projects AND vibe sessions hydrated without throwing — only then may
   * the chat→project migration reassign, collapse and persist */
  migrationReady: boolean;
}

/**
 * Load the persisted chats — called from store.ts hydrate() AFTER projects
 * and vibe sessions (the Phase-3 chat→project migration resolves against
 * both stores). Per-entry graceful degradation: a malformed chat or message
 * only costs itself, never the whole restore.
 *
 * Migration rule for chats without a (valid) `projectId`, in order: (1) the
 * project of the session the chat touched most recently; (2) the last active
 * project; (3) "" — invisible until healed. Documented in
 * `assignChatsToProjects`. SAFETY: when the project/session hydration did
 * not succeed (`migrationReady` false) or no projects exist, NOTHING is
 * reassigned, collapsed or persisted — a transient load failure must never
 * permanently rewrite chat→project assignments on disk; and an existing
 * non-empty `projectId` is never downgraded to "" (the project record may
 * come back).
 */
export async function hydrateOrchestratorChats(
  ctx: ChatHydrateContext = { migrationReady: true },
): Promise<void> {
  let data: PersistedOrchestratorChats | null = null;
  try {
    data = await loadOrchestratorChats();
  } catch {
    return;
  }
  if (!data) return;
  const chats: OrchestratorChat[] = [];
  for (const raw of Array.isArray(data.chats) ? data.chats : []) {
    try {
      if (
        !raw ||
        typeof raw.id !== "string" ||
        chats.some((c) => c.id === raw.id)
      )
        continue;
      const messages = (Array.isArray(raw.messages) ? raw.messages : [])
        .map(sanitizeMessage)
        .filter((m): m is OrchestratorChatMessage => m !== null)
        .slice(-MAX_CHAT_MESSAGES);
      // pre-rebuild chats may carry `provider`/`wire` (OpenRouter era) — both
      // are dropped tolerantly here; codex is the only brain now. An old
      // OpenRouter chat keeps its visible history but its `model` stamp is
      // cleared (it named an OpenRouter model id, not a codex one).
      const wasOpenRouter =
        (raw as { provider?: unknown }).provider === "openrouter";
      chats.push({
        id: raw.id,
        // pre-Phase-3 chats carry no projectId — assigned below
        projectId: typeof raw.projectId === "string" ? raw.projectId : "",
        threadId: typeof raw.threadId === "string" ? raw.threadId : null,
        ...(typeof raw.model === "string" && raw.model && !wasOpenRouter
          ? { model: raw.model }
          : {}),
        ...(typeof raw.effort === "string" && raw.effort
          ? { effort: raw.effort }
          : {}),
        title:
          typeof raw.title === "string" && raw.title.trim()
            ? raw.title
            : DEFAULT_CHAT_TITLE,
        createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
        messages,
        touchedPanes: sanitizeTouchedPanes(raw.touchedPanes),
        pendingPings: sanitizePings(raw.pendingPings),
      });
    } catch {
      /* skip this chat only */
    }
  }

  // ---- chat → project assignment (Phase-3 migration + self-heal) ----
  // Guarded: only with successfully hydrated projects + sessions AND at
  // least one project record. A transient load failure or an (unexpectedly)
  // empty project store must never force-reassign every chat to "" and
  // persist that — the on-disk assignment survives until a clean hydrate.
  let migrated = false;
  const projectsState = useProjects.getState();
  const migrationSafe =
    ctx.migrationReady && Object.keys(projectsState.projects).length > 0;
  if (migrationSafe) {
    try {
      const validIds = new Set(Object.keys(projectsState.projects));
      const fallback =
        projectsState.activeProjectId ??
        Object.values(projectsState.projects)
          .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]?.id ??
        null;
      const vibe = useVibe.getState();
      const migratable: MigratableChat[] = chats.map((c) => ({
        id: c.id,
        projectId: c.projectId || null,
        touched: Object.fromEntries(
          Object.entries(c.touchedPanes).map(([sid, t]) => [
            sid,
            t.lastPromptAt,
          ]),
        ),
      }));
      const assignments = assignChatsToProjects(
        migratable,
        validIds,
        (sessionId) => vibe.sessions[sessionId]?.session.projectId ?? null,
        fallback,
      );
      // pure apply with the downgrade guard (never "" over an existing id)
      const applied = applyChatAssignments(chats, assignments);
      if (applied.changed) {
        chats.splice(0, chats.length, ...applied.chats);
        migrated = true;
      }
    } catch {
      /* keep chats hydrated even if the assignment failed */
    }
  }

  const state = useOrchestrator.getState();
  // a chat created before hydrate resolved survives — merge persisted after
  // (the cap exempts unassigned chats until they heal)
  const merged = capChats(
    state.chats.length
      ? [
          ...state.chats,
          ...chats.filter((c) => !state.chats.some((x) => x.id === c.id)),
        ]
      : chats,
    MAX_CHATS,
  );

  // per-project active map: live entries win; then the persisted v2 map;
  // a v1 `activeId` legacy value lands in ITS chat's project slot
  const activeByProject: Record<string, string> = {};
  const persistedMap =
    data.activeByProject && typeof data.activeByProject === "object"
      ? data.activeByProject
      : {};
  for (const [projectId, id] of Object.entries(persistedMap)) {
    if (
      typeof id === "string" &&
      merged.some((c) => c.id === id && c.projectId === projectId)
    )
      activeByProject[projectId] = id;
  }
  if (typeof data.activeId === "string") {
    const legacy = merged.find((c) => c.id === data.activeId);
    if (legacy && legacy.projectId && !activeByProject[legacy.projectId])
      activeByProject[legacy.projectId] = legacy.id;
  }
  for (const [projectId, id] of Object.entries(state.activeByProject)) {
    activeByProject[projectId] = id; // pre-hydrate selections win
  }

  // fold multiple reusable-empty chats per project (the reload race +
  // old-bug pollution) into one before it hits the store — only when the
  // migration ran (projectIds are trustworthy this run)
  const collapsed = migrationSafe
    ? collapseEmptyChats(merged, activeByProject)
    : { chats: merged, activeByProject };
  // pre-rebuild persists may carry panelOpen/panelWidth (the removed ⌘⇧O
  // side panel) — ignored tolerantly
  useOrchestrator.setState({
    chats: collapsed.chats,
    activeByProject: collapsed.activeByProject,
  });
  // unassigned chats heal as soon as projects (re)appear
  if (collapsed.chats.some((c) => c.projectId === "")) startHealWatcher();
  // persist the migrated/cleaned list so the on-disk state heals immediately
  // (not only after the next interaction) — never off an unsafe migration run
  if (
    migrationSafe &&
    (migrated ||
      collapsed.chats.length !== merged.length ||
      (data.version ?? 1) < 2)
  )
    schedulePersist();
}
