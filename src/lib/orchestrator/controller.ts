// Orchestrator chat controller (Phase 4) — bridges the Phase-3 chat plumbing
// (chat.ts commands + event stream) and the chat store, OUTSIDE React (the
// lib/term-host.ts / lib/dictation.ts pattern). Responsibilities:
//   · lazily create the backend chat behind a store chat, or resume its
//     persisted codex thread (threadId) after an app restart
//   · map streamed chat events into store messages, batching the word-level
//     `delta` events (~80 ms flushes → ≤ ~12 store writes/s per chat)
//   · per-chat busy flag (one turn at a time — the backend enforces it too)
//     and interrupt
//   · pane jump chips: tool args referencing live pane ids, plus panes born
//     during a create_panes call (order diff — the tool RESULT flows
//     Rust → codex and never reaches the frontend), attach `paneRefs` to the
//     tool message for the UI
//   · status pings (Phase 5): watch agents' activity OUTSIDE React; a
//     touched pane finishing (busy → idle/waiting) pings its owning chat(s)
//     with a persisted system message, and undelivered pings are injected
//     into the WIRE text of the next send (never into the stored bubble)
//   · provider routing (Phase 6): every chat carries a fixed provider,
//     stamped at creation (`createChat`). Codex chats go through the
//     app-server plumbing above; OpenRouter chats run the webview tool loop
//     (openrouter-loop.ts), which synthesizes the SAME chat events through
//     `handleEvent` — delta batching, tool chips and pane-ref diffs are
//     shared, not duplicated. Rust streams OpenRouter deltas under the
//     STORE chat id, so the backend↔chat map self-links those chats.

import { useSwarm } from "@/store";
import type {
  ClaudeActivity,
  OrchestratorPaneRef,
  OrchestratorPingRecord,
} from "@/types";
import {
  chatInterrupt,
  chatResume,
  chatSend,
  chatStart,
  chatStatus,
  onChatEvent,
  type OrchestratorChatEvent,
} from "./chat";
import {
  useOrchestrator,
  type OrchestratorMessagePatch,
} from "./chat-store";
import {
  DEFAULT_ORCHESTRATOR_MODEL,
  dropOpenRouterChat,
  interruptOpenRouterTurn,
  runOpenRouterTurn,
} from "./openrouter-loop";

/** Trailing-edge delta flush — word-level deltas never write per event. */
const DELTA_FLUSH_MS = 80;
/** Auto-title length (first user message, once). */
const TITLE_MAX_CHARS = 40;

// store chat id ↔ backend chat id (the app-server's in-process handle).
// Backend ids survive respawns (Rust transparently thread/resumes), so the
// mapping lives for the whole app run. Stale entries after deleteChat are
// harmless — events routed to a deleted chat no-op in the store.
const backendByChat = new Map<string, string>();
const chatByBackend = new Map<string, string>();

/**
 * Store chat behind a backend chat id — the bus uses this to hand executors
 * their chat context. Null for unknown ids (e.g. dev-hook chats).
 */
export function chatIdForBackend(
  backendId: string | null | undefined,
): string | null {
  return backendId ? (chatByBackend.get(backendId) ?? null) : null;
}

interface PendingTool {
  tool: string;
  messageId: string;
  /** pane order snapshot around a create_panes call, for the ref diff */
  orderBefore: string[] | null;
}

/** Per-chat streaming state (keyed by STORE chat id). */
interface StreamState {
  buffer: string;
  /** the streaming assistant message being accumulated into */
  messageId: string | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** tool calls awaiting their tool_done, matched FIFO per tool name */
  pendingTools: PendingTool[];
  /** a turn_failed event already surfaced its warning this turn */
  turnFailed: boolean;
}

const streams = new Map<string, StreamState>();

function streamOf(chatId: string): StreamState {
  let st = streams.get(chatId);
  if (!st) {
    st = {
      buffer: "",
      messageId: null,
      flushTimer: null,
      pendingTools: [],
      turnFailed: false,
    };
    streams.set(chatId, st);
  }
  return st;
}

function link(chatId: string, backendId: string) {
  backendByChat.set(chatId, backendId);
  chatByBackend.set(backendId, chatId);
}

// ---- event stream ----

let eventsStarted = false;

/** Subscribe once, lazily — only chats we started/resumed are routed. */
function ensureEvents() {
  if (eventsStarted) return;
  eventsStarted = true;
  onChatEvent((event) => {
    const chatId = chatByBackend.get(event.chat_id);
    if (!chatId) return; // e.g. dev-hook chats (__orch)
    handleEvent(chatId, event);
  });
}

function scheduleFlush(chatId: string, st: StreamState) {
  if (st.flushTimer) return;
  st.flushTimer = setTimeout(() => {
    st.flushTimer = null;
    if (st.messageId)
      useOrchestrator
        .getState()
        .patchMessage(chatId, st.messageId, { text: st.buffer });
  }, DELTA_FLUSH_MS);
}

/**
 * Close out the streaming assistant message: `finalText` (the `message`
 * event) replaces the delta accumulation; without one (turn end/interrupt)
 * the accumulated text stands. Either way the caret stops pulsing.
 */
function finalizeStream(chatId: string, st: StreamState, finalText?: string) {
  if (st.flushTimer) {
    clearTimeout(st.flushTimer);
    st.flushTimer = null;
  }
  const store = useOrchestrator.getState();
  if (st.messageId) {
    store.patchMessage(chatId, st.messageId, {
      text: finalText ?? st.buffer,
      streaming: false,
    });
  } else if (finalText) {
    store.appendMessage(chatId, { role: "assistant", text: finalText });
  }
  st.messageId = null;
  st.buffer = "";
}

/** Live panes whose id appears in the text (args summaries are one line). */
function paneRefsFromText(text: string): OrchestratorPaneRef[] {
  if (!text) return [];
  const s = useSwarm.getState();
  const refs: OrchestratorPaneRef[] = [];
  for (const id of s.order) {
    if (text.includes(id)) refs.push({ id, name: s.agents[id]?.name ?? id });
  }
  return refs;
}

function handleEvent(chatId: string, event: OrchestratorChatEvent) {
  const store = useOrchestrator.getState();
  const st = streamOf(chatId);
  const data = event.data ?? {};
  switch (event.kind) {
    case "turn_started": {
      if (st.flushTimer) {
        clearTimeout(st.flushTimer);
        st.flushTimer = null;
      }
      st.buffer = "";
      st.messageId = null;
      st.pendingTools = [];
      break;
    }
    case "delta": {
      const text = typeof data.text === "string" ? data.text : "";
      if (!text) break;
      if (!st.messageId) {
        st.messageId = store.appendMessage(chatId, {
          role: "assistant",
          text: "",
          streaming: true,
        });
      }
      st.buffer += text;
      scheduleFlush(chatId, st);
      break;
    }
    case "message": {
      const text = typeof data.text === "string" ? data.text : "";
      finalizeStream(chatId, st, text || undefined);
      break;
    }
    case "tool_call": {
      const tool = typeof data.tool === "string" ? data.tool : "tool";
      const argsSummary =
        typeof data.args_summary === "string" ? data.args_summary : "";
      const paneRefs = paneRefsFromText(argsSummary);
      const messageId = store.appendMessage(chatId, {
        role: "tool",
        tool,
        argsSummary,
        ...(paneRefs.length ? { paneRefs } : {}),
      });
      st.pendingTools.push({
        tool,
        messageId,
        orderBefore:
          tool === "create_panes" ? [...useSwarm.getState().order] : null,
      });
      break;
    }
    case "tool_done": {
      const tool = typeof data.tool === "string" ? data.tool : "tool";
      const idx = st.pendingTools.findIndex((p) => p.tool === tool);
      if (idx < 0) break;
      const [pending] = st.pendingTools.splice(idx, 1);
      const patch: OrchestratorMessagePatch = { ok: data.ok !== false };
      if (pending.orderBefore) {
        // panes born while create_panes ran become jump chips
        const before = new Set(pending.orderBefore);
        const s = useSwarm.getState();
        const created = s.order
          .filter((id) => !before.has(id))
          .map((id) => ({ id, name: s.agents[id]?.name ?? id }));
        if (created.length) {
          const message = useOrchestrator
            .getState()
            .chats.find((c) => c.id === chatId)
            ?.messages.find((m) => m.id === pending.messageId);
          const existing =
            message?.role === "tool" ? (message.paneRefs ?? []) : [];
          patch.paneRefs = [
            ...existing,
            ...created.filter((r) => !existing.some((x) => x.id === r.id)),
          ];
        }
      }
      store.patchMessage(chatId, pending.messageId, patch);
      break;
    }
    case "turn_completed": {
      // interrupted turns keep their partial text; the caret stops
      finalizeStream(chatId, st);
      break;
    }
    case "turn_failed": {
      st.turnFailed = true;
      finalizeStream(chatId, st);
      const error = typeof data.error === "string" ? data.error : "unknown error";
      store.appendMessage(chatId, {
        role: "warning",
        text: `Turn failed: ${error}`,
      });
      break;
    }
    case "warning": {
      const text =
        typeof data.message === "string" ? data.message : JSON.stringify(data);
      store.appendMessage(chatId, { role: "warning", text });
      break;
    }
  }
}

// ---- status pings (Phase 5) ----

/** A repeated finish of the same pane within this window is flapping — skip. */
const PING_FLAP_MS = 3_000;
/** Transitions within this window of the chat's prompt are startup noise. */
const PROMPT_SETTLE_MS = 2_000;

/** last observed activity per pane id (transition detection) */
const prevActivity = new Map<string, ClaudeActivity | undefined>();
/** last emitted ping per pane id (flap debounce, across chats) */
const lastPingAt = new Map<string, number>();
let lastAgents: unknown = null;
let pingsStarted = false;

/**
 * A touched pane finished (busy → idle/waiting): ping every chat that
 * prompted it — persisted system message (jump chip + "Auswerten" via
 * paneRefs) plus an undelivered ping record for the next send's context
 * injection. Runs regardless of the chat's turn state; a running turn just
 * means the ping rides along with the NEXT send (never auto-starts a turn).
 */
function onPaneFinished(
  paneId: string,
  paneName: string,
  activity: "idle" | "waiting",
): void {
  const now = Date.now();
  const last = lastPingAt.get(paneId);
  if (last !== undefined && now - last < PING_FLAP_MS) return;
  const orch = useOrchestrator.getState();
  let pinged = false;
  for (const chat of orch.chats) {
    const touched = chat.touchedPanes[paneId];
    if (!touched) continue;
    // startup noise: the prompt just went in; the CLI bouncing through
    // idle/waiting while it takes over is not a "finished"
    if (now - touched.lastPromptAt < PROMPT_SETTLE_MS) continue;
    const name = paneName || touched.name;
    orch.appendMessage(chat.id, {
      role: "system",
      text:
        activity === "waiting"
          ? `«${name}» wartet auf Eingabe`
          : `«${name}» ist fertig`,
      paneRefs: [{ id: paneId, name }],
    });
    orch.addPendingPing(chat.id, { paneId, paneName: name, activity, at: now });
    pinged = true;
  }
  if (pinged) lastPingAt.set(paneId, now);
}

/**
 * Watch agents' activity in the main store (OUTSIDE React, like the bus).
 * Started once from App.tsx next to startOrchestratorBus; returns a stop
 * function. Only busy → idle/waiting transitions of panes some chat touched
 * become pings — everything else just updates the transition memory.
 */
export function startOrchestratorActivityWatcher(): () => void {
  if (pingsStarted) return () => {};
  pingsStarted = true;
  // seed so panes already busy at start ping on their NEXT transition, and
  // pre-existing idle states never ping retroactively
  lastAgents = useSwarm.getState().agents;
  prevActivity.clear();
  for (const [id, a] of Object.entries(useSwarm.getState().agents))
    prevActivity.set(id, a.activity);
  const unsub = useSwarm.subscribe((state) => {
    if (state.agents === lastAgents) return; // cheap out for unrelated updates
    lastAgents = state.agents;
    for (const [id, agent] of Object.entries(state.agents)) {
      const prev = prevActivity.get(id);
      const activity = agent.activity;
      if (prev === activity) continue;
      prevActivity.set(id, activity);
      if (prev === "busy" && (activity === "idle" || activity === "waiting"))
        onPaneFinished(id, agent.name, activity);
    }
    for (const id of prevActivity.keys())
      if (!state.agents[id]) {
        prevActivity.delete(id);
        lastPingAt.delete(id);
      }
  });
  return () => {
    pingsStarted = false;
    unsub();
  };
}

function hhmm(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * The `[Status-Update]` block injected before the user's wire text — one
 * German sentence per ping, absolute HH:MM times. The stored user message
 * stays the raw text; the pings are already visible as system messages.
 */
function statusUpdateBlock(pings: OrchestratorPingRecord[]): string {
  const lines = pings.map((p) =>
    p.activity === "waiting"
      ? `«${p.paneName}» wartet seit ${hhmm(p.at)} auf Eingabe.`
      : `«${p.paneName}» ist um ${hhmm(p.at)} fertig geworden.`,
  );
  return `[Status-Update] ${lines.join("\n")}`;
}

// ---- public surface (used by OrchestratorPanel) ----

/**
 * Create (or reuse an empty) chat, stamped with the CURRENT provider/model
 * settings — the stamp is fixed for the chat's lifetime; switching the
 * setting only affects new chats. The panel always goes through this
 * instead of the raw store action.
 */
export function createChat(): string {
  const { orchestratorProvider, orchestratorModel } =
    useSwarm.getState().settings;
  const provider = orchestratorProvider ?? "codex";
  return useOrchestrator
    .getState()
    .newChat(
      provider,
      provider === "openrouter"
        ? orchestratorModel?.trim() || DEFAULT_ORCHESTRATOR_MODEL
        : undefined,
    );
}

/**
 * Resolve the backend chat behind a store chat: reuse the in-process handle,
 * else resume the persisted thread (app restart), else start fresh. A failed
 * resume (thread rollout deleted) warns in the chat and falls back to a new
 * thread — the displayed history stays, the model's context doesn't.
 */
async function ensureBackendChat(chatId: string): Promise<string> {
  const existing = backendByChat.get(chatId);
  if (existing) return existing;
  const chat = useOrchestrator.getState().chats.find((c) => c.id === chatId);
  if (chat?.threadId) {
    try {
      const ref = await chatResume(chat.threadId);
      link(chatId, ref.chat_id);
      useOrchestrator.getState().setChatThreadId(chatId, ref.thread_id);
      return ref.chat_id;
    } catch (err) {
      useOrchestrator.getState().appendMessage(chatId, {
        role: "warning",
        text: `Couldn't resume the previous thread (${errorText(err)}) — starting a fresh one. The history above stays visible, but the model can't see it.`,
      });
    }
  }
  const ref = await chatStart();
  link(chatId, ref.chat_id);
  useOrchestrator.getState().setChatThreadId(chatId, ref.thread_id);
  return ref.chat_id;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Send one user message: append it, ensure the backend chat exists, stream
 * the turn into the store. One turn per chat at a time — a busy chat's send
 * is ignored (the UI shows a stop button instead).
 *
 * Phase 5: undelivered status pings are marked delivered and prepended as a
 * `[Status-Update]` block to the WIRE text only — the stored user bubble
 * stays the raw text (the pings are already visible as system messages).
 * Rust's chat_send additionally prepends its `[fleet status: …]` line; both
 * stay — the fleet line is the current snapshot, the status block is what
 * happened since the last turn.
 */
export async function sendMessage(chatId: string, text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  const store = useOrchestrator.getState();
  const chat = store.chats.find((c) => c.id === chatId);
  if (!chat || store.busy[chatId]) return;
  ensureEvents();
  // auto-title once, from the first user message
  if (!chat.messages.some((m) => m.role === "user")) {
    const firstLine = trimmed.split("\n")[0];
    store.setChatTitle(
      chatId,
      firstLine.length > TITLE_MAX_CHARS
        ? `${firstLine.slice(0, TITLE_MAX_CHARS).trimEnd()}…`
        : firstLine,
    );
  }
  store.appendMessage(chatId, { role: "user", text: trimmed });
  store.setBusy(chatId, true);
  const st = streamOf(chatId);
  st.turnFailed = false;
  // collect-and-mark just before the wire write: pings arriving after this
  // point stay undelivered and ride along with the NEXT send. Ping injection
  // is provider-agnostic — it happens before the routing below.
  const pings = useOrchestrator.getState().takePendingPings(chatId);
  const wireText = pings.length
    ? `${statusUpdateBlock(pings)}\n\n${trimmed}`
    : trimmed;
  try {
    if ((chat.provider ?? "codex") === "openrouter") {
      // Rust streams this chat's deltas under the STORE chat id — self-link
      // so the shared event listener routes them (and executors resolve the
      // chat context through the same map as codex tool calls)
      link(chatId, chatId);
      // the loop synthesizes every other event through handleEvent, so tool
      // chips / stream finalization / turn state reuse the codex plumbing
      await runOpenRouterTurn(chatId, wireText, {
        emit: (kind, data) =>
          handleEvent(chatId, { chat_id: chatId, kind, data }),
      });
    } else {
      const backendId = await ensureBackendChat(chatId);
      await chatSend(backendId, wireText);
    }
  } catch (err) {
    // a turn_failed event already surfaced its own warning; everything else
    // (spawn failure, dead process, resume+start both failing) lands here
    finalizeStream(chatId, st);
    if (!st.turnFailed) {
      useOrchestrator.getState().appendMessage(chatId, {
        role: "warning",
        text: `Send failed: ${errorText(err)}`,
      });
    }
  } finally {
    useOrchestrator.getState().setBusy(chatId, false);
  }
}

/** Stop the chat's running turn (its send resolves as "interrupted"). */
export function interrupt(chatId: string): void {
  const chat = useOrchestrator.getState().chats.find((c) => c.id === chatId);
  if ((chat?.provider ?? "codex") === "openrouter") {
    interruptOpenRouterTurn(chatId);
    return;
  }
  const backendId = backendByChat.get(chatId);
  if (backendId) void chatInterrupt(backendId).catch(() => {});
}

/**
 * Delete a chat: interrupt a running turn, drop the controller state, then
 * remove it from the store. The codex thread rollout stays on disk; an
 * OpenRouter chat's wire history goes down with the chat.
 */
export function removeChat(chatId: string): void {
  const chat = useOrchestrator.getState().chats.find((c) => c.id === chatId);
  if ((chat?.provider ?? "codex") === "openrouter") dropOpenRouterChat(chatId);
  const backendId = backendByChat.get(chatId);
  if (backendId) {
    if (useOrchestrator.getState().busy[chatId]) interrupt(chatId);
    backendByChat.delete(chatId);
    chatByBackend.delete(backendId);
  }
  const st = streams.get(chatId);
  if (st?.flushTimer) clearTimeout(st.flushTimer);
  streams.delete(chatId);
  useOrchestrator.getState().deleteChat(chatId);
}

/**
 * Check codex availability (spawns the app-server lazily) into the store —
 * run on first panel open so a dead/logged-out codex shows a quiet notice
 * instead of the first send erroring.
 */
export async function refreshStatus(): Promise<void> {
  const { setStatus } = useOrchestrator.getState();
  try {
    setStatus(await chatStatus());
  } catch (err) {
    // chatStatus itself never rejects for a dead process — this is the
    // safety net for a broken invoke (e.g. non-Tauri dev context)
    setStatus({
      running: false,
      version: null,
      account: null,
      error: errorText(err),
    });
  }
}
