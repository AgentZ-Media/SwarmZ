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
  OrchestratorWireMessage,
  OrchestratorWireToolCall,
  PersistedOrchestratorChats,
} from "@/types";
// type-only: no runtime cycle (chat.ts imports the main store)
import type { OrchestratorChatStatus } from "./chat";

/** Per-chat message cap — oldest messages drop first (display + persistence). */
export const MAX_CHAT_MESSAGES = 200;
/** Total chat cap — the oldest chats are deleted first. */
export const MAX_CHATS = 30;
/** Per-chat ping cap (delivered + undelivered) — oldest drop first. */
export const MAX_PENDING_PINGS = 20;
/**
 * OpenRouter wire-history cap (Phase 6) — oldest wire messages drop first.
 * A capped history simply loses old context, like any long chat; the model
 * never sees a `tool` result whose assistant call was cut (leading orphans
 * are trimmed after the cap).
 */
export const MAX_WIRE_MESSAGES = 60;
export const PANEL_DEFAULT_WIDTH = 380;
export const PANEL_MIN_WIDTH = 300;
export const PANEL_MAX_WIDTH = 640;
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

function clampWidth(width: number): number {
  return Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, Math.round(width)));
}

/**
 * Apply the wire-history cap: newest MAX_WIRE_MESSAGES, then drop leading
 * `tool` results — a tool message without its preceding assistant tool_calls
 * message is invalid OpenAI wire history.
 */
function capWire(wire: OrchestratorWireMessage[]): OrchestratorWireMessage[] {
  const capped = wire.slice(-MAX_WIRE_MESSAGES);
  let start = 0;
  while (start < capped.length && capped[start].role === "tool") start++;
  return start > 0 ? capped.slice(start) : capped;
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
    panelOpen: s.panelOpen,
    panelWidth: s.panelWidth,
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
  /** the right sidebar (⌘⇧O) — persisted */
  panelOpen: boolean;
  /** panel width in px, clamped 300–640 — persisted */
  panelWidth: number;
  /** chats with a turn in flight — set by the controller (in-memory) */
  busy: Record<string, boolean>;
  /** codex app-server availability, checked on first panel open (in-memory) */
  status: OrchestratorChatStatus | null;

  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
  setPanelWidth: (width: number) => void;
  /**
   * Create a chat (reusing an existing empty one) and activate it. Provider
   * + model are stamped here and stay fixed for the chat's lifetime; a
   * reused EMPTY chat is re-stamped with the current values (it has no
   * history yet, so it must follow the current setting). Callers go through
   * controller.ts `createChat()`, which reads the settings.
   */
  newChat: (provider?: "codex" | "openrouter", model?: string) => string;
  /**
   * Remove a chat from SwarmZ. The codex thread rollout stays on disk —
   * deliberate; it just never gets resumed again.
   */
  deleteChat: (id: string) => void;
  setActiveChat: (id: string) => void;
  setStatus: (status: OrchestratorChatStatus | null) => void;

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

  // Phase-6 OpenRouter wire history
  /** append wire messages (applies the cap; persisted with the chat) */
  appendWireMessages: (
    chatId: string,
    messages: OrchestratorWireMessage[],
  ) => void;

  // Phase-5 status pings
  /** remember that this chat prompted a pane (prompt_pane / startup prompt) */
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
  panelOpen: false,
  panelWidth: PANEL_DEFAULT_WIDTH,
  busy: {},
  status: null,

  setPanelOpen: (open) => {
    if (get().panelOpen === open) return;
    set({ panelOpen: open });
    schedulePersist();
  },
  togglePanel: () => get().setPanelOpen(!get().panelOpen),
  setPanelWidth: (width) => {
    const clamped = clampWidth(width);
    if (get().panelWidth === clamped) return;
    set({ panelWidth: clamped });
    schedulePersist();
  },

  newChat: (provider = "codex", model) => {
    const s = get();
    // don't stack empties — the + button reuses an untouched chat. An empty
    // chat has no history, so re-stamping provider/model to the CURRENT
    // setting is safe (and what the user expects after switching it).
    const empty = s.chats.find((c) => c.messages.length === 0);
    if (empty) {
      const stamp =
        (empty.provider ?? "codex") !== provider || empty.model !== model;
      if (s.activeChatId !== empty.id || stamp) {
        set({
          activeChatId: empty.id,
          chats: stamp
            ? s.chats.map((c) =>
                c.id === empty.id ? { ...c, provider, model } : c,
              )
            : s.chats,
        });
        schedulePersist();
      }
      return empty.id;
    }
    const chat: OrchestratorChat = {
      id: nanoid(8),
      provider,
      threadId: null,
      ...(model !== undefined ? { model } : {}),
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
    set({
      chats,
      busy,
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

  appendWireMessages: (chatId, messages) => {
    if (!messages.length) return;
    const s = get();
    const chat = s.chats.find((c) => c.id === chatId);
    if (!chat) return; // chat deleted mid-turn — late appends are a no-op
    const wire = capWire([...(chat.wire ?? []), ...messages]);
    set({
      chats: s.chats.map((c) => (c.id === chatId ? { ...c, wire } : c)),
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
      // status pings carry the pinged pane (jump chip + "Auswerten")
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

function sanitizeWireToolCalls(raw: unknown): OrchestratorWireToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is OrchestratorWireToolCall => {
    const t = c as OrchestratorWireToolCall | null;
    return (
      !!t &&
      typeof t.id === "string" &&
      typeof t.name === "string" &&
      typeof t.arguments_json === "string"
    );
  });
}

/** Persisted OpenRouter wire history, entry by entry (malformed dropped). */
function sanitizeWire(raw: unknown): OrchestratorWireMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: OrchestratorWireMessage[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const m = entry as Record<string, unknown>;
    switch (m.role) {
      case "user":
        if (typeof m.content === "string")
          out.push({ role: "user", content: m.content });
        break;
      case "assistant": {
        const content = typeof m.content === "string" ? m.content : null;
        const toolCalls = sanitizeWireToolCalls(m.tool_calls);
        out.push({
          role: "assistant",
          content,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        });
        break;
      }
      case "tool":
        if (typeof m.tool_call_id === "string" && typeof m.content === "string")
          out.push({
            role: "tool",
            tool_call_id: m.tool_call_id,
            content: m.content,
          });
        break;
      default:
        break; // system messages are never persisted; unknown roles drop
    }
  }
  return capWire(out);
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
      const wire = sanitizeWire(raw.wire);
      chats.push({
        id: raw.id,
        ...(raw.provider === "codex" || raw.provider === "openrouter"
          ? { provider: raw.provider }
          : {}),
        threadId: typeof raw.threadId === "string" ? raw.threadId : null,
        ...(typeof raw.model === "string" && raw.model
          ? { model: raw.model }
          : {}),
        ...(wire.length ? { wire } : {}),
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
  useOrchestrator.setState({
    chats: merged,
    activeChatId:
      state.activeChatId ??
      (typeof data.activeId === "string" &&
      merged.some((c) => c.id === data.activeId)
        ? data.activeId
        : (merged[0]?.id ?? null)),
    panelOpen:
      typeof data.panelOpen === "boolean" ? data.panelOpen : state.panelOpen,
    panelWidth: clampWidth(
      typeof data.panelWidth === "number" ? data.panelWidth : state.panelWidth,
    ),
  });
}
