// Orchestrator chat store (Phase 4) — the chat sidebar's state, colocated
// with the rest of the orchestrator plumbing instead of growing store.ts
// further (same standalone-zustand pattern as lib/updates.ts / lib/limits.ts).
// Persists in swarmz.json under `orchestratorChats` (chats + active id +
// panel open/width), debounced like the grid snapshot, flushed by
// flushAllPersists at quit and hydrated from store.ts hydrate(). The Codex
// side (events, resume, delta batching) lives in controller.ts.

import { create } from "zustand";
import { nanoid } from "nanoid";
import { loadOrchestratorChats, saveOrchestratorChats } from "@/lib/transport";
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
import { collapseEmptyChats, isReusableEmptyChat } from "./chat-reuse";

/** Per-chat message cap — oldest messages drop first (display + persistence). */
export const MAX_CHAT_MESSAGES = 200;
/** Total chat cap — the oldest chats are deleted first. */
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
// writes a bit wider than the grid snapshot's debounce.
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function snapshot(): PersistedOrchestratorChats {
  const s = useOrchestrator.getState();
  return {
    version: 1,
    chats: s.chats,
    activeId: s.activeChatId,
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
  /** all chats, newest first */
  chats: OrchestratorChat[];
  activeChatId: string | null;
  /** chats with a turn in flight — set by the controller (in-memory) */
  busy: Record<string, boolean>;
  /** latest per-chat token accounting (in-memory, never persisted) — codex
   * chats get it from the `token_usage` chat event (thread/tokenUsage/updated) */
  tokenUsage: Record<string, VibeTokenUsage>;
  /** codex app-server availability, checked on first panel open (in-memory) */
  status: OrchestratorChatStatus | null;

  /**
   * Create a chat (reusing an existing empty one) and activate it. Model +
   * effort are stamped here as the chat's initial override; a reused EMPTY
   * chat is re-stamped with the current values (it has no history yet, so it
   * must follow the current setting). Callers go through controller.ts
   * `createChat()`, which reads the settings.
   */
  newChat: (model?: string, effort?: string) => string;
  /**
   * Remove a chat from SwarmZ. The codex thread rollout stays on disk —
   * deliberate; it just never gets resumed again.
   */
  deleteChat: (id: string) => void;
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

export const useOrchestrator = create<OrchestratorState>((set, get) => ({
  chats: [],
  activeChatId: null,
  busy: {},
  tokenUsage: {},
  status: null,

  newChat: (model, effort) => {
    const s = get();
    // don't stack empties — the + button reuses an untouched chat. "Untouched"
    // means no user/assistant turn (system pings + warnings don't count, or a
    // restart would stack a new chat behind that noise). A reusable-empty chat
    // has no backend thread yet, so re-stamping model/effort to the CURRENT
    // setting is safe (and what the user expects after switching it).
    const empty = s.chats.find((c) => isReusableEmptyChat(c));
    if (empty) {
      const stamp = empty.model !== model || empty.effort !== effort;
      if (s.activeChatId !== empty.id || stamp) {
        set({
          activeChatId: empty.id,
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
      threadId: null,
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      title: DEFAULT_CHAT_TITLE,
      createdAt: Date.now(),
      messages: [],
      touchedPanes: {},
      pendingPings: [],
    };
    // newest first — the cap drops from the end, i.e. the oldest chats
    const chats = [chat, ...s.chats].slice(0, MAX_CHATS);
    set({ chats, activeChatId: chat.id });
    schedulePersist();
    return chat.id;
  },

  deleteChat: (id) => {
    const s = get();
    const idx = s.chats.findIndex((c) => c.id === id);
    if (idx < 0) return;
    const chats = s.chats.filter((c) => c.id !== id);
    const { [id]: _gone, ...busy } = s.busy;
    const { [id]: _u, ...tokenUsage } = s.tokenUsage;
    set({
      chats,
      busy,
      tokenUsage,
      activeChatId:
        s.activeChatId === id
          ? (chats[Math.min(idx, chats.length - 1)]?.id ?? null)
          : s.activeChatId,
    });
    schedulePersist();
  },

  setActiveChat: (id) => {
    const s = get();
    if (s.activeChatId === id || !s.chats.some((c) => c.id === id)) return;
    set({ activeChatId: id });
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
 * Load the persisted chats — called from store.ts hydrate(). Per-entry
 * graceful degradation (grid-snapshot philosophy): a malformed chat or
 * message only costs itself, never the whole restore.
 */
export async function hydrateOrchestratorChats(): Promise<void> {
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
  const state = useOrchestrator.getState();
  // a chat created before hydrate resolved survives — merge persisted after
  const merged = state.chats.length
    ? [
        ...state.chats,
        ...chats.filter((c) => !state.chats.some((x) => x.id === c.id)),
      ].slice(0, MAX_CHATS)
    : chats.slice(0, MAX_CHATS);
  const mergedActive =
    state.activeChatId ??
    (typeof data.activeId === "string" &&
    merged.some((c) => c.id === data.activeId)
      ? data.activeId
      : (merged[0]?.id ?? null));
  // fold multiple reusable-empty chats (the reload race + old-bug pollution)
  // into one before it hits the store — "at most one empty chat" invariant
  const collapsed = collapseEmptyChats(merged, mergedActive);
  // pre-rebuild persists may carry panelOpen/panelWidth (the removed ⌘⇧O
  // side panel) — ignored tolerantly
  useOrchestrator.setState({
    chats: collapsed.chats,
    activeChatId: collapsed.activeId,
  });
  // persist the cleaned list so the on-disk pollution heals immediately (not
  // only after the next interaction)
  if (collapsed.chats.length !== merged.length) schedulePersist();
  // Fresh start per launch: yesterday's chat context must not silently absorb
  // today's first order — activate a new chat (createChat reuses a leftover
  // empty one, so restarts never stack empties; old chats stay in the
  // switcher). Skipped when a chat was already opened before hydrate resolved.
  // Deferred import: controller statically imports this module.
  if (!state.chats.length) {
    try {
      const { createChat } = await import("./controller");
      createChat();
    } catch {
      /* non-fatal — the restored active chat stays selected */
    }
  }
}
