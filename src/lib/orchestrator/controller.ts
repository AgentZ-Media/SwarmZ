// Orchestrator chat controller — bridges the chat plumbing (chat.ts
// commands + event stream) and the chat store, OUTSIDE React (the
// vibe/controller.ts pattern). Responsibilities:
//   · lazily create the backend chat behind a store chat, or resume its
//     persisted codex thread (threadId) after an app restart
//   · map streamed chat events into store messages, batching the word-level
//     `delta` events (~80 ms flushes → ≤ ~12 store writes/s per chat)
//   · per-chat busy flag (one turn at a time — the backend enforces it too)
//     and interrupt
//   · session jump chips: tool args referencing live session ids, plus
//     sessions born during a create_panes call (order diff — the tool RESULT
//     flows Rust → codex and never reaches the frontend), attach `paneRefs`
//     to the tool message for the UI
//   · status pings: watch sessions' busy/approval state OUTSIDE React; a
//     touched session finishing (busy → idle) or raising an approval pings
//     its owning chat(s) with a persisted system message, and undelivered
//     pings are injected into the WIRE text of the next send (never into the
//     stored bubble)

import { useVibe } from "@/lib/vibe/session-store";
import { hasPendingApproval } from "@/lib/vibe/ui";
import { useProjects } from "@/lib/projects/store";
import type {
  OrchestratorPaneRef,
  OrchestratorPingRecord,
} from "@/types";
import { useSwarm } from "@/store";
import {
  chatInterrupt,
  chatResume,
  chatSend,
  chatStart,
  chatStatus,
  onChatEvent,
  type OrchestratorChatEvent,
  type ProjectContextWire,
} from "./chat";
import {
  useOrchestrator,
  type OrchestratorMessagePatch,
} from "./chat-store";

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
  /** session order snapshot around a create_panes call, for the ref diff */
  sessionOrderBefore: string[] | null;
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

/**
 * The project a store chat belongs to — `""` (legacy, unassigned) degrades
 * to null = unscoped.
 */
function chatProjectId(chatId: string): string | null {
  return (
    useOrchestrator.getState().chats.find((c) => c.id === chatId)?.projectId ||
    null
  );
}

/**
 * Session ids in rail order, scoped to one project (null = all). The chip
 * extraction and the create_panes order diff both scan THIS list — never the
 * global one, or parallel activity in project B would attach B-chips to A's
 * chats.
 */
function projectSessionIds(projectId: string | null): string[] {
  const v = useVibe.getState();
  return v.order.filter(
    (id) =>
      projectId === null || v.sessions[id]?.session.projectId === projectId,
  );
}

/**
 * Live sessions of the chat's project whose id appears in the text (args
 * summaries are one line). The chip resolves the id to a session
 * (focusSession) at click time.
 */
function paneRefsFromText(
  text: string,
  projectId: string | null,
): OrchestratorPaneRef[] {
  if (!text) return [];
  const refs: OrchestratorPaneRef[] = [];
  const v = useVibe.getState();
  for (const id of projectSessionIds(projectId)) {
    if (text.includes(id))
      refs.push({ id, name: v.sessions[id]?.session.name ?? id });
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
      const projectId = chatProjectId(chatId);
      const paneRefs = paneRefsFromText(argsSummary, projectId);
      const messageId = store.appendMessage(chatId, {
        role: "tool",
        tool,
        argsSummary,
        ...(paneRefs.length ? { paneRefs } : {}),
      });
      st.pendingTools.push({
        tool,
        messageId,
        // project-scoped snapshot — a parallel create_panes in another
        // project must never diff into this chat's chips
        sessionOrderBefore:
          tool === "create_panes" ? projectSessionIds(projectId) : null,
      });
      break;
    }
    case "tool_done": {
      const tool = typeof data.tool === "string" ? data.tool : "tool";
      const idx = st.pendingTools.findIndex((p) => p.tool === tool);
      if (idx < 0) break;
      const [pending] = st.pendingTools.splice(idx, 1);
      const patch: OrchestratorMessagePatch = { ok: data.ok !== false };
      if (pending.sessionOrderBefore) {
        // sessions born while create_panes ran become jump chips (the tool
        // result never reaches the frontend, so diff the order) — scoped to
        // the chat's project, like the before-snapshot
        const before = new Set(pending.sessionOrderBefore);
        const v = useVibe.getState();
        const created: OrchestratorPaneRef[] = [];
        for (const id of projectSessionIds(chatProjectId(chatId)))
          if (!before.has(id))
            created.push({ id, name: v.sessions[id]?.session.name ?? id });
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
    case "token_usage": {
      // in-memory context accounting for the chat's context gauge
      store.setChatTokenUsage(chatId, {
        total: (data.total as Record<string, number>) ?? null,
        last: (data.last as Record<string, number>) ?? null,
        modelContextWindow:
          typeof data.modelContextWindow === "number"
            ? data.modelContextWindow
            : null,
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

// ---- status pings ----

/** A repeated finish of the same session within this window is flapping — skip. */
const PING_FLAP_MS = 3_000;
/** Transitions within this window of the chat's prompt are startup noise. */
const PROMPT_SETTLE_MS = 2_000;

/** last emitted ping per session id (flap debounce, across chats) */
const lastPingAt = new Map<string, number>();

/**
 * A touched session finished (busy → idle) or waits on an approval: ping
 * every chat that prompted it — persisted system message (jump chip +
 * "Review" via paneRefs) plus an undelivered ping record for the next send's
 * context injection. Runs regardless of the chat's turn state; a running
 * turn just means the ping rides along with the NEXT send (never auto-starts
 * a turn).
 */
function onSessionFinished(
  sessionId: string,
  sessionName: string,
  activity: "idle" | "waiting",
): void {
  const now = Date.now();
  const last = lastPingAt.get(sessionId);
  if (last !== undefined && now - last < PING_FLAP_MS) return;
  const sessionProject =
    useVibe.getState().sessions[sessionId]?.session.projectId ?? null;
  // session already gone from the store (removed between transition and
  // ping) → no project to scope on. Skip instead of opening the filter — a
  // null here must never broadcast the ping into every touching chat across
  // foreign projects.
  if (sessionProject === null) return;
  const orch = useOrchestrator.getState();
  let pinged = false;
  for (const chat of orch.chats) {
    // pings stay within the Conductor's project — a chat never hears about
    // sessions of OTHER projects, even if it somehow touched one
    if (chat.projectId !== sessionProject) continue;
    const touched = chat.touchedPanes[sessionId];
    if (!touched) continue;
    // startup noise: the prompt just went in
    if (now - touched.lastPromptAt < PROMPT_SETTLE_MS) continue;
    const name = sessionName || touched.name;
    orch.appendMessage(chat.id, {
      role: "system",
      text:
        activity === "waiting"
          ? `«${name}» waiting for input`
          : `«${name}» finished`,
      paneRefs: [{ id: sessionId, name }],
    });
    orch.addPendingPing(chat.id, {
      paneId: sessionId,
      paneName: name,
      activity,
      at: now,
    });
    pinged = true;
  }
  if (pinged) lastPingAt.set(sessionId, now);
}

/** last observed busy flag per session id */
const prevSessBusy = new Map<string, boolean>();
/** last observed pending-approval flag per session id */
const prevSessPending = new Map<string, boolean>();
let vibePingsStarted = false;

/**
 * Watch sessions' busy/approval transitions OUTSIDE React (the vibe store is
 * a plain zustand store). Started once from App.tsx next to
 * startOrchestratorBus; returns a stop function. Only sessions some chat
 * touched (prompt_pane / create_panes) ping.
 */
export function startVibeSessionActivityWatcher(): () => void {
  if (vibePingsStarted) return () => {};
  vibePingsStarted = true;
  const seed = useVibe.getState();
  prevSessBusy.clear();
  prevSessPending.clear();
  for (const [id, entry] of Object.entries(seed.sessions)) {
    prevSessBusy.set(id, !!seed.busy[id]);
    prevSessPending.set(id, hasPendingApproval(entry));
  }
  const unsub = useVibe.subscribe((state) => {
    for (const id of state.order) {
      const entry = state.sessions[id];
      if (!entry) continue;
      const busy = !!state.busy[id];
      const pending = hasPendingApproval(entry);
      const pBusy = prevSessBusy.get(id);
      const pPending = prevSessPending.get(id);
      prevSessBusy.set(id, busy);
      prevSessPending.set(id, pending);
      const name = entry.session.name;
      // a new pending approval waits on the human ("waiting" variant)
      if (pPending === false && pending) onSessionFinished(id, name, "waiting");
      // turn genuinely finished (busy → idle, nothing waiting)
      else if (pBusy === true && !busy && !pending)
        onSessionFinished(id, name, "idle");
    }
    for (const id of prevSessBusy.keys())
      if (!state.sessions[id]) {
        prevSessBusy.delete(id);
        prevSessPending.delete(id);
        lastPingAt.delete(id);
      }
  });
  return () => {
    vibePingsStarted = false;
    unsub();
  };
}

function hhmm(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * The `[Status update]` block injected before the user's wire text — one
 * English sentence per ping, absolute HH:MM times. The stored user message
 * stays the raw text; the pings are already visible as system messages.
 */
function statusUpdateBlock(pings: OrchestratorPingRecord[]): string {
  const lines = pings.map((p) =>
    p.activity === "waiting"
      ? `«${p.paneName}» waiting for input since ${hhmm(p.at)}.`
      : `«${p.paneName}» finished at ${hhmm(p.at)}.`,
  );
  return `[Status update] ${lines.join("\n")}`;
}

// ---- public surface (used by the Conductor stage) ----

/**
 * The wire project context for a project id — resolved live from the project
 * store. A lost project record degrades to an id-only context (Rust then
 * falls back to the home dir as thread cwd).
 */
function projectWire(projectId: string): ProjectContextWire {
  const p = useProjects.getState().projects[projectId];
  return {
    id: projectId,
    dir: p?.dir ?? "",
    name: p?.name ?? "",
  };
}

/** The active project's wire context (null when no project is open). */
function activeProjectWire(): ProjectContextWire | null {
  const id = useProjects.getState().activeProjectId;
  return id ? projectWire(id) : null;
}

/**
 * Create (or reuse an empty) chat FOR ONE PROJECT (default: the active one),
 * stamped with the CURRENT model/effort settings — the stamp is fixed at
 * creation; switching the setting only affects new chats. The stage always
 * goes through this instead of the raw store action. Returns null when no
 * project exists to attach the chat to.
 */
export function createChat(projectId?: string): string | null {
  const pid = projectId ?? useProjects.getState().activeProjectId;
  if (!pid) return null;
  const { orchestratorCodexModel, orchestratorCodexEffort } =
    useSwarm.getState().settings;
  // chats get the Settings defaults (a per-chat override the picker can
  // change later); empty defaults = no stamp = the user's plain codex config
  return useOrchestrator
    .getState()
    .newChat(
      pid,
      orchestratorCodexModel?.trim() || undefined,
      orchestratorCodexEffort?.trim() || undefined,
    );
}

/** Projects whose stage already got its fresh-start chat this app run. */
const freshenedProjects = new Set<string>();

/**
 * Fresh start per launch, per project: the first time a project's Conductor
 * stage shows this app run, activate a new (or reused-empty) chat — so
 * yesterday's chat context never silently absorbs today's first order. Old
 * chats stay reachable in the switcher.
 */
export function ensureFreshProjectChat(projectId: string): void {
  if (freshenedProjects.has(projectId)) return;
  freshenedProjects.add(projectId);
  createChat(projectId);
}

/**
 * Resolve the backend chat behind a store chat: reuse the in-process handle,
 * else resume the persisted thread (app restart) on the chat's PROJECT
 * instance, else start fresh there. A failed resume (thread rollout deleted)
 * warns in the chat and falls back to a new thread — the displayed history
 * stays, the model's context doesn't.
 */
async function ensureBackendChat(chatId: string): Promise<string> {
  const existing = backendByChat.get(chatId);
  if (existing) return existing;
  const chat = useOrchestrator.getState().chats.find((c) => c.id === chatId);
  const project = projectWire(chat?.projectId ?? "");
  if (chat?.threadId) {
    try {
      const ref = await chatResume(chat.threadId, project);
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
  const ref = await chatStart(project);
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
 * Undelivered status pings are marked delivered and prepended as a
 * `[Status update]` block to the WIRE text only — the stored user bubble
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
  // point stay undelivered and ride along with the NEXT send.
  const pings = useOrchestrator.getState().takePendingPings(chatId);
  const wireText = pings.length
    ? `${statusUpdateBlock(pings)}\n\n${trimmed}`
    : trimmed;
  try {
    const backendId = await ensureBackendChat(chatId);
    // per-chat model/effort ride along as a turn/start override
    await chatSend(backendId, wireText, chat.model, chat.effort);
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
  const backendId = backendByChat.get(chatId);
  if (backendId) void chatInterrupt(backendId).catch(() => {});
}

/**
 * Delete a chat: interrupt a running turn, drop the controller state, then
 * remove it from the store. The codex thread rollout stays on disk.
 */
export function removeChat(chatId: string): void {
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
 * run on first stage open so a dead/logged-out codex shows a quiet notice
 * instead of the first send erroring.
 */
export async function refreshStatus(): Promise<void> {
  const { setStatus } = useOrchestrator.getState();
  try {
    setStatus(await chatStatus(activeProjectWire() ?? undefined));
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
