// Conductor chat delivery service — owns backend handles, streaming state,
// human delivery claims and chat lifecycle outside React. The public
// controller facade composes this service with the fleet watcher and the
// autonomous dispatcher.
// It bridges chat commands/event streaming and the chat store outside React.
// Responsibilities:
//   · lazily create the backend chat behind a store chat, or resume its
//     persisted codex thread (threadId) after an app restart
//   · map streamed chat events into store messages, batching the word-level
//     `delta` events (~80 ms flushes → ≤ ~12 store writes/s per chat)
//   · per-chat busy flag (one turn at a time — the backend enforces it too)
//     and interrupt
//   · session jump chips: tool args referencing live session ids, plus
//     sessions born during a spawn_agents call (order diff — the tool RESULT
//     flows Rust → codex and never reaches the frontend), attach `paneRefs`
//     to the tool message for the UI
//   · status-ping injection into the wire (the watcher produces the pings)

import { useVibe } from "@/lib/vibe/session-store";
import { useProjects } from "@/lib/projects/store";
import type {
  OrchestratorPaneRef,
  OrchestratorPingRecord,
} from "@/types";
import { useSwarm } from "@/store";
import {
  chatCompact,
  chatInterrupt,
  chatResume,
  chatSend,
  chatStart,
  chatStatus,
  onChatEvent,
  type OrchestratorChatEvent,
  type ProjectContextWire,
} from "./chat";
import { shouldAutoCompact } from "@/lib/compact";
import {
  ORCHESTRATOR_TOOLSET_VERSION,
  useOrchestrator,
  type OrchestratorMessagePatch,
} from "./chat-store";
import { noteHumanTurn } from "./autonomy";

/** Trailing-edge delta flush — word-level deltas never write per event. */
const DELTA_FLUSH_MS = 80;
/** Auto-title length (first user message, once). */
const TITLE_MAX_CHARS = 40;

// store chat id ↔ backend chat id (the app-server's in-process handle).
// Backend ids survive respawns (Rust transparently thread/resumes), so the
// mapping lives for the whole app run. Stale entries after deleteChat are
// harmless — events routed to a deleted chat no-op in the store.
interface PendingTool {
  tool: string;
  messageId: string;
  /** session order snapshot around a spawn_agents call, for the ref diff */
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
  /** the dispatch's turn actually STARTED (turn_started seen) — a failure
   * after this point means real work ran (budget stays booked); before it,
   * nothing ran (a reservation may be released) */
  turnStarted: boolean;
}

/** Runtime-only state for chat delivery, hidden behind one explicit owner. */
export class ChatDeliveryState {
  private readonly backendByChat = new Map<string, string>();
  private readonly chatByBackend = new Map<string, string>();
  private readonly streams = new Map<string, StreamState>();
  private readonly humanClaims = new Set<string>();
  private readonly lastAutoCompactAt = new Map<string, number>();
  private readonly freshenedProjects = new Set<string>();

  chatForBackend(backendId: string | null | undefined): string | null {
    return backendId ? (this.chatByBackend.get(backendId) ?? null) : null;
  }

  backendForChat(chatId: string): string | null {
    return this.backendByChat.get(chatId) ?? null;
  }

  hasBackend(chatId: string): boolean {
    return this.backendByChat.has(chatId);
  }

  link(chatId: string, backendId: string): void {
    const replaced = this.backendByChat.get(chatId);
    if (replaced && replaced !== backendId) this.chatByBackend.delete(replaced);
    this.backendByChat.set(chatId, backendId);
    this.chatByBackend.set(backendId, chatId);
  }

  stream(chatId: string): StreamState {
    let stream = this.streams.get(chatId);
    if (!stream) {
      stream = {
        buffer: "",
        messageId: null,
        flushTimer: null,
        pendingTools: [],
        turnFailed: false,
        turnStarted: false,
      };
      this.streams.set(chatId, stream);
    }
    return stream;
  }

  claimHuman(chatId: string): boolean {
    if (this.humanClaims.has(chatId)) return false;
    this.humanClaims.add(chatId);
    return true;
  }

  releaseHuman(chatId: string): void {
    this.humanClaims.delete(chatId);
  }

  lastAutoCompact(chatId: string): number | undefined {
    return this.lastAutoCompactAt.get(chatId);
  }

  noteAutoCompact(chatId: string, at: number): void {
    this.lastAutoCompactAt.set(chatId, at);
  }

  claimFreshProject(projectId: string): boolean {
    if (this.freshenedProjects.has(projectId)) return false;
    this.freshenedProjects.add(projectId);
    return true;
  }

  markProjectFreshened(projectId: string): void {
    this.freshenedProjects.add(projectId);
  }

  remove(chatId: string): StreamState | null {
    const backendId = this.backendByChat.get(chatId);
    if (backendId) this.chatByBackend.delete(backendId);
    this.backendByChat.delete(chatId);
    const stream = this.streams.get(chatId) ?? null;
    this.streams.delete(chatId);
    this.humanClaims.delete(chatId);
    this.lastAutoCompactAt.delete(chatId);
    return stream;
  }
}

const deliveryState = new ChatDeliveryState();

/** Store chat behind a backend id; null for unknown/dev-hook chats. */
export function chatIdForBackend(
  backendId: string | null | undefined,
): string | null {
  return deliveryState.chatForBackend(backendId);
}

// ---- event stream ----

let eventsStarted = false;

/** Subscribe once, lazily — only chats we started/resumed are routed. */
function ensureEvents() {
  if (eventsStarted) return;
  eventsStarted = true;
  onChatEvent((event) => {
    const chatId = deliveryState.chatForBackend(event.chat_id);
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
 * extraction and the spawn_agents order diff both scan THIS list — never the
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
  const st = deliveryState.stream(chatId);
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
      st.turnStarted = true;
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
        // project-scoped snapshot — a parallel spawn_agents in another
        // project must never diff into this chat's chips
        sessionOrderBefore:
          tool === "spawn_agents" ? projectSessionIds(projectId) : null,
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
        // sessions born while spawn_agents ran become jump chips (the tool
        // result never reaches the frontend, so diff the order) — scoped to
        // the chat's project, like the before-snapshot
        const before = new Set(pending.sessionOrderBefore);
        const v = useVibe.getState();
        const created: OrchestratorPaneRef[] = [];
        for (const id of projectSessionIds(chatProjectId(chatId)))
          if (!before.has(id)) {
            const session = v.sessions[id]?.session;
            created.push({
              id,
              name: session?.name ?? id,
              runtime: {
                model: session?.model ?? null,
                effort: session?.effort ?? null,
              },
            });
          }
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
    case "compacted": {
      // the model-visible context was summarized (thread/compact/start) — the
      // chat history above stays; a neutral system line marks it
      store.appendMessage(chatId, {
        role: "system",
        text: "Context compacted — earlier history summarized for the model.",
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

/**
 * Compact a Conductor chat's thread (thread/compact/start): summarize the
 * model-visible history so the next turn runs on a smaller context. The
 * visible chat stays. Blocks until the compaction turn finishes. A busy chat
 * or a backend error surfaces as a warning message and rejects.
 */
export async function compactChat(chatId: string): Promise<void> {
  const store = useOrchestrator.getState();
  if (!store.chats.some((c) => c.id === chatId)) return;
  if (store.busy[chatId])
    throw new Error("a turn is running — interrupt it or wait before compacting");
  ensureEvents();
  store.setBusy(chatId, true);
  try {
    const backendId = await ensureBackendChat(chatId);
    await chatCompact(backendId);
  } catch (err) {
    useOrchestrator.getState().appendMessage(chatId, {
      role: "warning",
      text: `Couldn't compact the context: ${errorText(err)}`,
    });
    throw err instanceof Error ? err : new Error(errorText(err));
  } finally {
    useOrchestrator.getState().setBusy(chatId, false);
  }
}

/**
 * Before a chat's next turn: auto-compact when its context footprint crossed
 * the threshold (Settings `autoCompact`, default on). Conservative (idle,
 * past threshold, past cooldown) and best-effort — a failure never blocks the
 * send. Awaits completion so the send genuinely runs on the compacted context.
 */
async function maybeAutoCompactChat(chatId: string): Promise<void> {
  const store = useOrchestrator.getState();
  // only once a backend chat exists (a real thread with context this run)
  if (!deliveryState.hasBackend(chatId)) return;
  const enabled = useSwarm.getState().settings.autoCompact !== false;
  if (
    !shouldAutoCompact({
      usage: store.tokenUsage[chatId] ?? null,
      enabled,
      busy: !!store.busy[chatId],
      lastCompactAt: deliveryState.lastAutoCompact(chatId),
      now: Date.now(),
    })
  ) {
    return;
  }
  deliveryState.noteAutoCompact(chatId, Date.now());
  try {
    await compactChat(chatId);
  } catch {
    /* surfaced as a warning; the turn proceeds on the fuller context */
  }
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

/** Reserve the per-launch fresh-chat slot for autonomous delivery. */
export function markProjectChatFreshened(projectId: string): void {
  deliveryState.markProjectFreshened(projectId);
}

/**
 * Fresh start per launch, per project: the first time a project's Conductor
 * stage shows this app run, activate a new (or reused-empty) chat — so
 * yesterday's chat context never silently absorbs today's first order. Old
 * chats stay reachable in the switcher.
 */
export function ensureFreshProjectChat(projectId: string): void {
  if (!deliveryState.claimFreshProject(projectId)) return;
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
  const existing = deliveryState.backendForChat(chatId);
  if (existing) return existing;
  const chat = useOrchestrator.getState().chats.find((c) => c.id === chatId);
  const project = projectWire(chat?.projectId ?? "");
  if (
    chat?.threadId &&
    chat.toolsetVersion === ORCHESTRATOR_TOOLSET_VERSION
  ) {
    try {
      const ref = await chatResume(chat.threadId, project);
      deliveryState.link(chatId, ref.chat_id);
      useOrchestrator
        .getState()
        .setChatThreadId(
          chatId,
          ref.thread_id,
          ORCHESTRATOR_TOOLSET_VERSION,
        );
      return ref.chat_id;
    } catch (err) {
      useOrchestrator.getState().appendMessage(chatId, {
        role: "warning",
        text: `Couldn't resume the previous thread (${errorText(err)}) — starting a fresh one. The history above stays visible, but the model can't see it.`,
      });
    }
  } else if (chat?.threadId) {
    useOrchestrator.getState().appendMessage(chatId, {
      role: "system",
      text: "Conductor tools upgraded — starting a fresh backend context so this chat can use the current tool catalog. The visible history stays here.",
    });
  }
  const ref = await chatStart(project);
  deliveryState.link(chatId, ref.chat_id);
  useOrchestrator
    .getState()
    .setChatThreadId(chatId, ref.thread_id, ORCHESTRATOR_TOOLSET_VERSION);
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
  if (!chat) throw new Error("The Orchestrator chat no longer exists.");
  // Claim synchronously, before the first append/await. Two same-tick sends
  // can no longer both pass the busy check and create a phantom user bubble.
  if (store.busy[chatId] || !deliveryState.claimHuman(chatId)) {
    throw new Error("The Orchestrator is busy — one turn at a time.");
  }
  ensureEvents();
  const firstUserMessage = !chat.messages.some((m) => m.role === "user");
  const userMessageId = store.appendMessage(chatId, {
    role: "user",
    text: trimmed,
  });
  let turnStarted = false;
  try {
    // A human intent re-arms only this project's known breaker. A globally
    // unreadable budget remains fail-closed until verified rehydration.
    const projectId = chatProjectId(chatId);
    if (projectId) noteHumanTurn(projectId);
    const result = await dispatchTurn(chatId, trimmed);
    turnStarted = result !== "never-started";
    if (result === "never-started") {
      useOrchestrator.getState().removeMessage(chatId, userMessageId);
    } else if (firstUserMessage) {
      const firstLine = trimmed.split("\n")[0];
      useOrchestrator.getState().setChatTitle(
        chatId,
        firstLine.length > TITLE_MAX_CHARS
          ? `${firstLine.slice(0, TITLE_MAX_CHARS).trimEnd()}…`
          : firstLine,
      );
    }
    if (result !== "completed") {
      throw new Error(
        result === "never-started"
          ? "The Orchestrator turn could not start. Your draft was kept."
          : "The Orchestrator turn failed. Your draft was kept.",
      );
    }
  } catch (error) {
    // Pre-dispatch failures outside dispatchTurn's guarded section (for
    // example compaction setup) are also definitive non-deliveries.
    const current = useOrchestrator.getState();
    const stillVisible = current.chats
      .find((candidate) => candidate.id === chatId)
      ?.messages.some((message) => message.id === userMessageId);
    if (stillVisible && !turnStarted && !current.busy[chatId]) {
      current.removeMessage(chatId, userMessageId);
    }
    throw error;
  } finally {
    deliveryState.releaseHuman(chatId);
  }
}

/** How a dispatch ended: "completed" = the turn ran to its end; "failed" =
 * the turn STARTED but broke mid-way (work ran — budget stays booked);
 * "never-started" = nothing ran at all (spawn failure, dead codex — a
 * budget reservation may be released). */
export type DispatchResult = "completed" | "failed" | "never-started";

/**
 * The turn-dispatch core shared by the user send path and the autonomous
 * turns (timers, approval escalations): claim busy, prepend undelivered
 * status pings to the WIRE text, resolve the backend chat, run the turn.
 * Callers append their own visible message (user bubble / system marker)
 * BEFORE dispatching. Returns how the turn ended — a failed dispatch (codex
 * unavailable, spawn failure) must NOT count as delivered (timers stay alive
 * and retry instead of silently vanishing).
 */
export async function dispatchTurn(
  chatId: string,
  wireBody: string,
): Promise<DispatchResult> {
  const store = useOrchestrator.getState();
  const chat = store.chats.find((c) => c.id === chatId);
  if (!chat || store.busy[chatId]) return "never-started";
  ensureEvents();
  // near the context window? compact first (idle, conservative). Its own busy
  // flag guards the window; a fresh read of busy follows below.
  await maybeAutoCompactChat(chatId);
  if (useOrchestrator.getState().busy[chatId]) return "never-started";
  useOrchestrator.getState().setBusy(chatId, true);
  const st = deliveryState.stream(chatId);
  st.turnFailed = false;
  st.turnStarted = false;
  // collect-and-mark just before the wire write: pings arriving after this
  // point stay undelivered and ride along with the NEXT send.
  const pings = useOrchestrator.getState().takePendingPings(chatId);
  const wireText = pings.length
    ? `${statusUpdateBlock(pings)}\n\n${wireBody}`
    : wireBody;
  try {
    const backendId = await ensureBackendChat(chatId);
    // per-chat model/effort ride along as a turn/start override
    await chatSend(backendId, wireText, chat.model, chat.effort);
    return "completed";
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
    if (!st.turnStarted && !st.turnFailed) {
      useOrchestrator.getState().restorePendingPings(chatId, pings);
    }
    // turn_started/turn_failed seen = real work ran before the failure
    return st.turnStarted || st.turnFailed ? "failed" : "never-started";
  } finally {
    useOrchestrator.getState().setBusy(chatId, false);
  }
}

/**
 * Project names whose Conductor has a turn in flight (busy chat) — the quit
 * guard lists these (a running Conductor turn would be interrupted on quit).
 * Deduped by project; a chat whose project record is gone falls back to a
 * generic label.
 */
export function busyConductorProjectNames(): string[] {
  const { busy, chats } = useOrchestrator.getState();
  const projects = useProjects.getState().projects;
  const names = new Set<string>();
  for (const chat of chats) {
    if (!busy[chat.id]) continue;
    const name = projects[chat.projectId]?.name?.trim();
    names.add(name || "Conductor");
  }
  return [...names];
}

/** Stop the chat's running turn (its send resolves as "interrupted"). */
export function interrupt(chatId: string): void {
  const backendId = deliveryState.backendForChat(chatId);
  if (backendId) void chatInterrupt(backendId).catch(() => {});
}

/**
 * Delete a chat: interrupt a running turn, drop the controller state, then
 * remove it from the store. The codex thread rollout stays on disk.
 */
export function removeChat(chatId: string): void {
  const backendId = deliveryState.backendForChat(chatId);
  if (backendId) {
    if (useOrchestrator.getState().busy[chatId]) interrupt(chatId);
  }
  const st = deliveryState.remove(chatId);
  if (st?.flushTimer) clearTimeout(st.flushTimer);
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
