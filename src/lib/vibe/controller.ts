// Vibe-Mode session controller (Phase 2 data layer) — bridges the native
// Codex session plumbing (the `vibe_session_*` Tauri commands + the
// `vibe://session-event` stream, codex/sessions.rs) and the session store,
// OUTSIDE React (the lib/term-host.ts / orchestrator/controller.ts pattern).
// No UI here — Phase 3 wires the panel. Responsibilities:
//   · typed `invoke` wrappers for the eight session commands (native-only,
//     direct invoke like lib/worktree.ts) + the one event listener
//   · map streamed session events into normalized store items, batching the
//     word-level `delta` events (~80 ms flushes) — only the streaming
//     assistant item's store write is batched; the persist debounce is separate
//   · a per-session busy flag (one turn at a time — Rust enforces it too) and
//     the public surface startSession / resumeSession / sendMessage / interrupt
//     / respondApproval / setAccess / closeSession
//   · lazy resume: after an app restart the Rust registry is empty, so the
//     first send resumes the persisted thread (a lost rollout falls back to a
//     fresh thread, surfaced as a warning item)

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { nanoid } from "nanoid";
import { useSwarm } from "@/store";
import { pushFleetEvent, type FleetEventKind } from "@/lib/events";
import type {
  VibeAccess,
  VibeApprovalStatus,
  VibeFileChange,
  VibeItem,
  VibePlanStep,
  VibeTokenUsage,
} from "@/types";
import { useVibe, type NewVibeSession } from "./session-store";
import { useVibeUi } from "./ui-store";

/** Trailing-edge delta flush — word-level deltas never write per event. */
const DELTA_FLUSH_MS = 80;

/** The kinds emitted on `vibe://session-event` (see codex/sessions.rs). */
export type VibeSessionEventKind =
  | "turn_started"
  | "delta"
  | "message"
  | "item_started"
  | "item_updated"
  | "item_completed"
  | "item_output_delta"
  | "turn_diff"
  | "plan"
  | "token_usage"
  | "approval_request"
  | "turn_completed"
  | "turn_failed"
  | "warning"
  | "process_exited";

export interface VibeSessionEvent {
  session_id: string;
  kind: VibeSessionEventKind;
  data: Record<string, unknown>;
}

/** The decisions a pending approval can be answered with. */
export type VibeApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel";

// ---- typed invoke wrappers ----

/** The Settings codex-binary override, passed on every process-touching call. */
function codexPath(): string {
  return useSwarm.getState().settings.codexPath ?? "";
}

function invokeStart(
  sessionId: string,
  opts: StartOpts,
): Promise<{ thread_id: string }> {
  return invoke("vibe_session_start", {
    sessionId,
    cwd: opts.projectDir,
    model: opts.model ?? null,
    effort: opts.effort ?? null,
    access: opts.access,
    codexPath: codexPath(),
  });
}

function invokeResume(
  sessionId: string,
  threadId: string,
  opts: StartOpts,
): Promise<{ thread_id: string; resumed: boolean }> {
  return invoke("vibe_session_resume", {
    sessionId,
    threadId,
    cwd: opts.projectDir,
    model: opts.model ?? null,
    effort: opts.effort ?? null,
    access: opts.access,
    codexPath: codexPath(),
  });
}

function invokeSend(
  sessionId: string,
  text: string,
): Promise<{ turn_id: string | null }> {
  return invoke("vibe_session_send", { sessionId, text });
}

function invokeInterrupt(sessionId: string): Promise<void> {
  return invoke("vibe_session_interrupt", { sessionId });
}

function invokeRespondApproval(
  sessionId: string,
  approvalId: string,
  decision: VibeApprovalDecision,
): Promise<void> {
  return invoke("vibe_session_respond_approval", {
    sessionId,
    approvalId,
    decision,
  });
}

function invokeSetAccess(sessionId: string, access: VibeAccess): Promise<void> {
  return invoke("vibe_session_set_access", { sessionId, access });
}

function invokeSetModelEffort(
  sessionId: string,
  model: string | undefined,
  effort: string | undefined,
): Promise<void> {
  return invoke("vibe_session_set_model_effort", {
    sessionId,
    model: model ?? null,
    effort: effort ?? null,
  });
}

function invokeClose(sessionId: string): Promise<void> {
  return invoke("vibe_session_close", { sessionId });
}

// ---- streaming state ----

interface StreamState {
  buffer: string;
  /** id of the streaming assistant item being accumulated into */
  itemId: string | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

const streams = new Map<string, StreamState>();

function streamOf(sessionId: string): StreamState {
  let st = streams.get(sessionId);
  if (!st) {
    st = { buffer: "", itemId: null, flushTimer: null };
    streams.set(sessionId, st);
  }
  return st;
}

function resetStream(sessionId: string) {
  const st = streams.get(sessionId);
  if (!st) return;
  if (st.flushTimer) clearTimeout(st.flushTimer);
  st.buffer = "";
  st.itemId = null;
  st.flushTimer = null;
}

function scheduleFlush(sessionId: string, st: StreamState) {
  if (st.flushTimer) return;
  st.flushTimer = setTimeout(() => {
    st.flushTimer = null;
    if (st.itemId)
      useVibe.getState().patchItem(sessionId, st.itemId, { text: st.buffer });
  }, DELTA_FLUSH_MS);
}

/** Close out the streaming assistant item: `finalText` replaces the delta
 * accumulation; either way the caret stops pulsing. */
function finalizeStream(
  sessionId: string,
  finalText?: string,
  phase?: string | null,
) {
  const st = streamOf(sessionId);
  if (st.flushTimer) {
    clearTimeout(st.flushTimer);
    st.flushTimer = null;
  }
  const store = useVibe.getState();
  if (st.itemId) {
    store.patchItem(sessionId, st.itemId, {
      text: finalText ?? st.buffer,
      streaming: false,
      ...(phase !== undefined ? { phase } : {}),
    });
  } else if (finalText) {
    store.upsertItem(sessionId, {
      id: `msg-${nanoid(8)}`,
      at: Date.now(),
      kind: "assistant",
      text: finalText,
      ...(phase !== undefined ? { phase } : {}),
    });
  }
  st.itemId = null;
  st.buffer = "";
}

// ---- item normalization (raw codex ThreadItem → VibeItem) ----

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Convert one raw codex item to a store item, or null to drop it. */
function toVibeItem(raw: unknown): VibeItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  const at = Date.now();
  switch (r.type) {
    case "commandExecution":
      return {
        id,
        at,
        kind: "command",
        command: str(r.command),
        ...(typeof r.cwd === "string" ? { cwd: r.cwd } : {}),
        status: str(r.status),
        exitCode:
          typeof r.exitCode === "number" || r.exitCode === null
            ? (r.exitCode as number | null)
            : null,
        output: typeof r.aggregatedOutput === "string" ? r.aggregatedOutput : "",
      };
    case "fileChange":
      return {
        id,
        at,
        kind: "fileChange",
        status: str(r.status),
        changes: Array.isArray(r.changes)
          ? (r.changes as VibeFileChange[])
          : [],
      };
    case "webSearch":
      return {
        id,
        at,
        kind: "webSearch",
        query: str(r.query),
        ...(r.action !== undefined ? { action: r.action } : {}),
      };
    case "plan":
      // a plan ITEM carries free text; the step list arrives via turn/plan
      return {
        id,
        at,
        kind: "plan",
        explanation: str(r.text) || null,
        steps: [],
      };
    // userMessage is dropped — the controller adds the user item optimistically
    // on send; reasoning never surfaces text over ChatGPT auth (drop it too).
    default:
      return null;
  }
}

// ---- event handling ----

let eventsStarted = false;

/** Subscribe once, lazily — only sessions we started/resumed emit events. */
function ensureEvents() {
  if (eventsStarted) return;
  eventsStarted = true;
  void listen<VibeSessionEvent>("vibe://session-event", (ev) => {
    handleEvent(ev.payload.session_id, ev.payload);
  });
}

function warn(sessionId: string, text: string) {
  useVibe.getState().upsertItem(sessionId, {
    id: `warn-${nanoid(8)}`,
    at: Date.now(),
    kind: "warning",
    text,
  });
}

/** Mirror a session lifecycle moment into the shared Deck ticker (source=vibe;
 * the ticker jumps into Vibe Mode for these). */
function pushSessionEvent(sessionId: string, kind: FleetEventKind) {
  const entry = useVibe.getState().sessions[sessionId];
  if (!entry) return;
  pushFleetEvent({
    kind,
    paneId: sessionId,
    paneName: entry.session.name,
    workspaceId: "",
    source: "vibe",
  });
}

function handleEvent(sessionId: string, event: VibeSessionEvent) {
  const store = useVibe.getState();
  if (!store.sessions[sessionId]) return; // deleted mid-turn — late events no-op
  const data = event.data ?? {};
  switch (event.kind) {
    case "turn_started": {
      resetStream(sessionId);
      store.setBusy(sessionId, true);
      store.setTurnId(
        sessionId,
        typeof data.turn_id === "string" ? data.turn_id : null,
      );
      break;
    }
    case "delta": {
      const text = str(data.text);
      const itemId = str(data.item_id) || `msg-${nanoid(8)}`;
      if (!text) break;
      const st = streamOf(sessionId);
      if (st.itemId !== itemId) {
        // a new streaming item — flush the previous, start this one
        if (st.itemId) finalizeStream(sessionId);
        st.itemId = itemId;
        st.buffer = "";
        store.upsertItem(sessionId, {
          id: itemId,
          at: Date.now(),
          kind: "assistant",
          text: "",
          streaming: true,
        });
      }
      st.buffer += text;
      scheduleFlush(sessionId, st);
      break;
    }
    case "message": {
      const phase =
        typeof data.phase === "string" || data.phase === null
          ? (data.phase as string | null)
          : undefined;
      finalizeStream(sessionId, str(data.text) || undefined, phase);
      break;
    }
    case "item_started":
    case "item_updated":
    case "item_completed": {
      const item = toVibeItem(data.item);
      if (item) store.upsertItem(sessionId, item);
      break;
    }
    case "item_output_delta": {
      const itemId = str(data.item_id);
      const delta = str(data.delta);
      if (itemId && delta) store.appendCommandOutput(sessionId, itemId, delta);
      break;
    }
    case "turn_diff": {
      store.setDiff(sessionId, str(data.diff));
      break;
    }
    case "plan": {
      const explanation =
        typeof data.explanation === "string" || data.explanation === null
          ? (data.explanation as string | null)
          : null;
      const steps = Array.isArray(data.plan)
        ? (data.plan as VibePlanStep[])
        : [];
      store.setPlan(sessionId, { explanation, steps });
      break;
    }
    case "token_usage": {
      store.setTokenUsage(sessionId, data as VibeTokenUsage);
      break;
    }
    case "approval_request": {
      const approvalId = str(data.approval_id);
      if (!approvalId) break;
      const kind = data.kind === "fileChange" ? "fileChange" : "command";
      store.upsertItem(sessionId, {
        id: approvalId,
        at: Date.now(),
        kind: "approval",
        approvalKind: kind,
        status: "pending",
        payload:
          data.request && typeof data.request === "object"
            ? (data.request as Record<string, unknown>)
            : {},
      });
      pushSessionEvent(sessionId, "waiting");
      break;
    }
    case "turn_completed": {
      finalizeStream(sessionId);
      store.setBusy(sessionId, false);
      store.setTurnId(sessionId, null);
      pushSessionEvent(sessionId, "finished");
      break;
    }
    case "turn_failed": {
      finalizeStream(sessionId);
      warn(sessionId, `Turn failed: ${str(data.error) || "unknown error"}`);
      store.setBusy(sessionId, false);
      store.setTurnId(sessionId, null);
      pushSessionEvent(sessionId, "exited");
      break;
    }
    case "warning": {
      warn(sessionId, str(data.message) || "warning");
      break;
    }
    case "process_exited": {
      finalizeStream(sessionId);
      warn(sessionId, str(data.message) || "the session process exited");
      store.setBusy(sessionId, false);
      store.setTurnId(sessionId, null);
      break;
    }
  }
}

// ---- backend liveness ----

/** Sessions whose Rust-side registry entry is live this app run. After a
 * restart the set is empty, so the first send resumes the persisted thread. */
const liveBackends = new Set<string>();

interface StartOpts {
  projectDir: string;
  model?: string;
  effort?: string;
  access: VibeAccess;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---- public surface ----

export interface StartSessionOpts {
  name: string;
  projectDir: string;
  model?: string;
  effort?: string;
  access?: VibeAccess;
}

/**
 * Start a fresh Vibe session: create the store entry, spawn its dedicated
 * app-server + thread. The session id is assigned here (keys both stores).
 * Rejects (and drops the store entry) if the process can't start.
 */
export async function startSession(opts: StartSessionOpts): Promise<string> {
  ensureEvents();
  const id = nanoid(10);
  const access = opts.access ?? "full";
  const newSession: NewVibeSession = {
    id,
    name: opts.name,
    projectDir: opts.projectDir,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
    access,
    threadId: null,
  };
  useVibe.getState().createSession(newSession);
  try {
    const res = await invokeStart(id, { ...opts, access });
    liveBackends.add(id);
    useVibe.getState().setThreadId(id, res.thread_id);
    return id;
  } catch (err) {
    useVibe.getState().dropSession(id);
    throw new Error(errorText(err));
  }
}

/**
 * Ensure a session's Rust-side backend is live: reuse it, or resume the
 * persisted thread (after an app restart). A lost rollout falls back to a
 * fresh thread — the transcript stays, the agent's context doesn't.
 */
export async function resumeSession(sessionId: string): Promise<void> {
  if (liveBackends.has(sessionId)) return;
  ensureEvents();
  const session = useVibe.getState().sessions[sessionId]?.session;
  if (!session) throw new Error(`unknown vibe session "${sessionId}"`);
  if (!session.threadId) throw new Error("this session has no thread to resume");
  const res = await invokeResume(sessionId, session.threadId, {
    projectDir: session.projectDir,
    model: session.model,
    effort: session.effort,
    access: session.access,
  });
  liveBackends.add(sessionId);
  useVibe.getState().setThreadId(sessionId, res.thread_id);
  if (!res.resumed) {
    warn(
      sessionId,
      "Couldn't restore the previous session thread — continuing in a fresh one. The transcript above stays, but the agent can't see it.",
    );
  }
}

/**
 * Send one user message (non-blocking backend): append the user item, ensure
 * the backend session is live, fire the turn. Progress streams as events; busy
 * is cleared by the turn's completion event, not here. A busy session ignores.
 */
export async function sendMessage(
  sessionId: string,
  text: string,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  const store = useVibe.getState();
  if (!store.sessions[sessionId] || store.busy[sessionId]) return;
  ensureEvents();
  store.upsertItem(sessionId, {
    id: `user-${nanoid(8)}`,
    at: Date.now(),
    kind: "user",
    text: trimmed,
  });
  store.setBusy(sessionId, true);
  resetStream(sessionId);
  try {
    await resumeSession(sessionId);
    await invokeSend(sessionId, trimmed);
    // send returns after the turn/start ack — busy stays true until the turn
    // completion event clears it
  } catch (err) {
    useVibe.getState().setBusy(sessionId, false);
    warn(sessionId, `Send failed: ${errorText(err)}`);
  }
}

/** Stop the session's running turn (its turn resolves as "interrupted"). */
export function interrupt(sessionId: string): void {
  if (!liveBackends.has(sessionId)) return;
  void invokeInterrupt(sessionId).catch(() => {});
}

const DECISION_STATUS: Record<VibeApprovalDecision, VibeApprovalStatus> = {
  accept: "accepted",
  acceptForSession: "acceptedForSession",
  decline: "declined",
  cancel: "cancelled",
};

/** Answer a pending approval — optimistically marks the item, then tells Rust. */
export async function respondApproval(
  sessionId: string,
  approvalId: string,
  decision: VibeApprovalDecision,
): Promise<void> {
  useVibe
    .getState()
    .setApprovalStatus(sessionId, approvalId, DECISION_STATUS[decision]);
  try {
    await invokeRespondApproval(sessionId, approvalId, decision);
  } catch (err) {
    warn(sessionId, `Couldn't answer the approval: ${errorText(err)}`);
  }
}

/** Change the session's access mode (takes effect on the next turn). */
export async function setAccess(
  sessionId: string,
  access: VibeAccess,
): Promise<void> {
  useVibe.getState().setAccess(sessionId, access);
  if (liveBackends.has(sessionId)) {
    try {
      await invokeSetAccess(sessionId, access);
    } catch (err) {
      warn(sessionId, `Couldn't change access: ${errorText(err)}`);
    }
  }
}

/**
 * Change the session's model / reasoning effort (takes effect on the next
 * turn — a per-turn override). Updates the store immediately (so a not-yet-live
 * session picks it up on its next start/resume) and, when the backend is live,
 * updates the running process's profile too.
 */
export async function setModelEffort(
  sessionId: string,
  model: string | undefined,
  effort: string | undefined,
): Promise<void> {
  useVibe.getState().setModelEffort(sessionId, { model, effort });
  if (liveBackends.has(sessionId)) {
    try {
      await invokeSetModelEffort(sessionId, model, effort);
    } catch (err) {
      warn(sessionId, `Couldn't change model/effort: ${errorText(err)}`);
    }
  }
}

/** Close a session: end its process, drop controller state + the store entry. */
export async function closeSession(sessionId: string): Promise<void> {
  if (liveBackends.has(sessionId)) {
    liveBackends.delete(sessionId);
    try {
      await invokeClose(sessionId);
    } catch {
      /* best effort — the process dies with the app anyway */
    }
  }
  resetStream(sessionId);
  streams.delete(sessionId);
  useVibe.getState().dropSession(sessionId);
}

/**
 * Bring a session into view: switch the app to Vibe Mode and select it —
 * the Deck triage/ticker and cross-session jumps route through here.
 */
export function focusSession(sessionId: string): void {
  if (!useVibe.getState().sessions[sessionId]) return;
  useSwarm.getState().setUiMode("vibe");
  useVibe.getState().setActive(sessionId);
  // a jump targets a session — leave the Conductor stage (Phase 5)
  useVibeUi.getState().setStageMode("session");
}

/** Busy session ids — used by the quit guard (they count like busy panes). */
export function vibeBusyIds(): string[] {
  const { busy, order } = useVibe.getState();
  return order.filter((id) => busy[id]);
}
