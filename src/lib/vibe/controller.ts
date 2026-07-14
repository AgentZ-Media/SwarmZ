// Session controller — bridges the native Codex session plumbing (the
// `vibe_session_*` Tauri commands + the `vibe://session-event` stream,
// codex/sessions.rs) and the session store, OUTSIDE React (the
// orchestrator/controller.ts pattern). No UI here. Responsibilities:
//   · typed `invoke` wrappers for the eleven session commands (native-only,
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
import { useProjects, openProjectIds } from "@/lib/projects/store";
import type {
  ModelUsage,
  UsageHistoryEntry,
  VibeAccess,
  VibeApprovalStatus,
  VibeFileChange,
  VibeItem,
  VibePlanStep,
  VibeSessionWorktree,
  VibeSpawnedBy,
  VibeTokenUsage,
} from "@/types";
import { shouldAutoCompact } from "@/lib/compact";
import { beginInflight } from "@/lib/inflight";
import {
  useVibe,
  type NewVibeSession,
} from "./session-store";
import { pickAgentName } from "./names";
import { reportItemIdOf } from "./report-item";
import { useVibeUi } from "./ui-store";

/** Trailing-edge delta flush — word-level deltas never write per event. */
const DELTA_FLUSH_MS = 80;

/** The kinds emitted on `vibe://session-event` (see codex/sessions.rs). */
export type VibeSessionEventKind =
  | "turn_started"
  | "delta"
  | "message"
  | "item_started"
  | "item_completed"
  | "item_output_delta"
  | "turn_diff"
  | "plan"
  | "token_usage"
  | "approval_request"
  | "turn_completed"
  | "turn_failed"
  | "compacted"
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
  outputSchema?: Record<string, unknown>,
  requireWorkspace?: boolean,
): Promise<{ turn_id: string | null }> {
  return invoke("vibe_session_send", {
    sessionId,
    text,
    outputSchema: outputSchema ?? null,
    // the Conductor path passes true → Rust refuses a full-access session
    // (capability-reuse guard), authoritative at the backend boundary
    requireWorkspace: requireWorkspace ?? false,
  });
}

function invokeInterrupt(sessionId: string): Promise<void> {
  return invoke("vibe_session_interrupt", { sessionId });
}

/** Blocks until the compaction turn genuinely completed (Rust waits on the
 * turn's terminal event — a following send never races the compaction). */
function invokeCompact(sessionId: string): Promise<{ status: string }> {
  return invoke("vibe_session_compact", { sessionId });
}

function invokeRespondApproval(
  sessionId: string,
  approvalId: string,
  decision: VibeApprovalDecision,
  requireRoutine: boolean,
): Promise<void> {
  return invoke("vibe_session_respond_approval", {
    sessionId,
    approvalId,
    decision,
    requireRoutine,
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

function invokeSteer(
  sessionId: string,
  text: string,
  requireWorkspace?: boolean,
): Promise<{ turn_id: string | null; steered: boolean }> {
  return invoke("vibe_session_steer", {
    sessionId,
    text,
    requireWorkspace: requireWorkspace ?? false,
  });
}

function invokeSetCwd(sessionId: string, cwd: string): Promise<void> {
  return invoke("vibe_session_set_cwd", { sessionId, cwd });
}

function invokeReview(
  sessionId: string,
  target: string,
  requireWorkspace?: boolean,
): Promise<{
  status: string;
  review: string | null;
  review_thread_id: string;
}> {
  return invoke("vibe_session_review", {
    sessionId,
    target,
    // C3: the detached review must not reuse a HUMAN-granted full-access
    // profile under the Conductor (danger-full-access + approvalPolicy "never"
    // = no approval to cancel). Every review caller is a Conductor path, so we
    // pass the strict flag; the AUTHORITATIVE gate is Rust's
    // `conductor_access_gate` on `session_review` (a full-access session
    // refuses). Harmless if the backend confines review unconditionally.
    requireWorkspace: requireWorkspace ?? false,
  });
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

function notice(sessionId: string, text: string) {
  useVibe.getState().upsertItem(sessionId, {
    id: `notice-${nanoid(8)}`,
    at: Date.now(),
    kind: "notice",
    text,
  });
}

/**
 * Sessions with a SwarmZ-initiated `thread/compact/start` in flight. Its
 * turn/completed must NOT read as an agent finish (no Deck ticker, no
 * autonomous-loop trigger) — the outcome is recorded as "compacted" instead.
 * Only turns WE start count; codex' own auto-compaction (inside a work turn)
 * never enters this set, so a real finish is never suppressed.
 *
 * The marker doubles as the per-session compaction SERIALIZATION claim:
 * `compactSession` refuses while it is set (a manual and an automatic
 * compaction can never share — and clear — one bit), and it is consumed
 * EXACTLY by the compaction's terminal event (`consumeCompactionMarker`,
 * which also resolves the settle handshake below).
 */
const compactingSessions = new Set<string>();

/** Settle handshake: resolvers waiting for the webview to have PROCESSED the
 * compaction's terminal event (busy flip included) — see `compactSession`. */
const compactionWaiters = new Map<string, () => void>();

/** Consume the compaction marker (terminal-event side): returns whether this
 * terminal event belonged to a SwarmZ-initiated compaction, and releases any
 * settle waiter. */
function consumeCompactionMarker(sessionId: string): boolean {
  const wasCompaction = compactingSessions.delete(sessionId);
  const waiter = compactionWaiters.get(sessionId);
  if (waiter) {
    compactionWaiters.delete(sessionId);
    waiter();
  }
  return wasCompaction;
}

/** When a session was last AUTO-compacted (cooldown; manual ignores it). */
const lastAutoCompactAt = new Map<string, number>();

/** Mirror a session lifecycle moment into the shared Deck ticker. */
function pushSessionEvent(sessionId: string, kind: FleetEventKind) {
  const entry = useVibe.getState().sessions[sessionId];
  if (!entry) return;
  pushFleetEvent({
    kind,
    sessionId,
    sessionName: entry.session.name,
  });
}

/**
 * How a session's LAST turn ended (transient, per app run) — recorded BEFORE
 * the busy flag clears, so the orchestrator's activity watcher (which reacts
 * to the busy→idle transition) can distinguish a genuinely completed turn
 * from a failed / interrupted / process-exited one and never report a
 * crashed lane as success. `turnId` is the turn the outcome belongs to
 * (null when codex never handed one out).
 */
export interface LastTurnOutcome {
  outcome: "completed" | "interrupted" | "failed" | "exited" | "compacted";
  turnId: string | null;
}

const lastTurnOutcomes = new Map<string, LastTurnOutcome>();

/**
 * Sessions whose CURRENT turn carries an `outputSchema` (an `expect_report`
 * turn) — its final assistant message is the schema-forced status report.
 * Marked BEFORE the send goes out (a very fast completion must never beat
 * the registration), bound to the acked turn id after, and consumed at
 * `turn_completed` to stamp `report: true` on the final assistant item (the
 * UI then renders a report card instead of raw JSON). Independent of the
 * orchestrator's one-shot report-expectation registry (report.ts), which the
 * autonomous finish trigger consumes for the WIRE — this marker only drives
 * the transcript presentation. In-memory: a restart mid-turn degrades to the
 * plain-text rendering, same as the orchestrator's free-text path.
 */
const schemaTurns = new Map<string, { turnId: string | null }>();

/** Stamp the completed schema turn's final assistant message as the report
 * (consume the marker). Only a genuinely COMPLETED turn stamps — the schema
 * forces the final message only when the turn runs to its end. */
function stampReportItem(sessionId: string, completed: boolean) {
  const marker = schemaTurns.get(sessionId);
  if (!marker) return;
  const store = useVibe.getState();
  const currentTurnId = store.sessions[sessionId]?.turnId ?? null;
  // a bound marker only matches ITS turn — a definite mismatch means the
  // completion belongs to another turn (stale event); leave the marker
  if (
    marker.turnId !== null &&
    currentTurnId !== null &&
    marker.turnId !== currentTurnId
  )
    return;
  schemaTurns.delete(sessionId);
  if (!completed) return;
  const entry = store.sessions[sessionId];
  if (!entry) return;
  const itemId = reportItemIdOf(entry.order, entry.items);
  if (itemId) store.patchItem(sessionId, itemId, { report: true });
}

/** The session's last turn outcome (null = no turn ended this app run). */
export function lastTurnOutcomeOf(sessionId: string): LastTurnOutcome | null {
  return lastTurnOutcomes.get(sessionId) ?? null;
}

/** Record how the current turn ended — MUST run before setBusy(false)
 * (zustand subscribers fire synchronously on the busy transition). */
function recordTurnOutcome(
  sessionId: string,
  outcome: LastTurnOutcome["outcome"],
) {
  const store = useVibe.getState();
  const turnId = store.sessions[sessionId]?.turnId ?? null;
  lastTurnOutcomes.set(sessionId, { outcome, turnId });
  store.setTurnOutcome(sessionId, outcome);
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
      // session accounting: mirror into the persistent all-time usage
      // history (UsageDashboard) — debounced, never per delta tick
      scheduleUsageMirror(sessionId);
      break;
    }
    case "approval_request": {
      const approvalId = str(data.approval_id);
      if (!approvalId) break;
      const kind = data.kind === "fileChange" ? "fileChange" : "command";
      // Conductor routing class (classified in Rust, conservative) —
      // anything unexpected degrades to "destructive" (human-only)
      const escalation = data.escalation === "routine" ? "routine" : "destructive";
      store.upsertItem(sessionId, {
        id: approvalId,
        at: Date.now(),
        kind: "approval",
        approvalKind: kind,
        status: "pending",
        escalation,
        payload:
          data.request && typeof data.request === "object"
            ? (data.request as Record<string, unknown>)
            : {},
      });
      pushSessionEvent(sessionId, "waiting");
      break;
    }
    case "compacted": {
      // the model-visible context was summarized (thread/compact/start) — the
      // transcript above stays; drop a subtle divider so the user sees it
      notice(sessionId, "Context compacted — earlier history summarized for the model.");
      break;
    }
    case "turn_completed": {
      finalizeStream(sessionId);
      // a SwarmZ-initiated compaction's turn is not an agent finish
      const wasCompaction = consumeCompactionMarker(sessionId);
      // stamp the schema turn's report BEFORE the turn id clears (the marker
      // is bound to it) and BEFORE the busy flip (the orchestrator's watcher
      // renders the transcript synchronously on the busy→idle tick)
      stampReportItem(sessionId, data.status !== "interrupted");
      // outcome BEFORE the busy flip — the activity watcher reads it during
      // the synchronous busy→idle subscription tick ("interrupted"/"compacted"
      // are deliberate, never autonomous-loop "finished" events)
      recordTurnOutcome(
        sessionId,
        wasCompaction
          ? "compacted"
          : data.status === "interrupted"
            ? "interrupted"
            : "completed",
      );
      store.setBusy(sessionId, false);
      store.setTurnId(sessionId, null);
      if (!wasCompaction) pushSessionEvent(sessionId, "finished");
      break;
    }
    case "turn_failed": {
      finalizeStream(sessionId);
      const wasCompaction = consumeCompactionMarker(sessionId);
      stampReportItem(sessionId, false); // consume the marker, never stamp
      warn(sessionId, `Turn failed: ${str(data.error) || "unknown error"}`);
      // a failed compaction is deliberate work, not an agent finish → don't
      // wake the autonomous loop with a "turn FAILED" trigger
      recordTurnOutcome(sessionId, wasCompaction ? "compacted" : "failed");
      store.setBusy(sessionId, false);
      store.setTurnId(sessionId, null);
      if (!wasCompaction) pushSessionEvent(sessionId, "exited");
      break;
    }
    case "warning": {
      warn(sessionId, str(data.message) || "warning");
      break;
    }
    case "process_exited": {
      finalizeStream(sessionId);
      const wasCompaction = consumeCompactionMarker(sessionId);
      schemaTurns.delete(sessionId); // the schema turn died with the process
      warn(sessionId, str(data.message) || "the session process exited");
      recordTurnOutcome(sessionId, wasCompaction ? "compacted" : "exited");
      store.setBusy(sessionId, false);
      store.setTurnId(sessionId, null);
      break;
    }
  }
}

// ---- session accounting (usage-history mirror) ----

/** Trailing-edge debounce for the usage mirror — never per delta tick. */
const USAGE_MIRROR_MS = 2_000;
const usageMirrorTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleUsageMirror(sessionId: string) {
  if (usageMirrorTimers.has(sessionId)) return;
  usageMirrorTimers.set(
    sessionId,
    setTimeout(() => {
      usageMirrorTimers.delete(sessionId);
      mirrorUsageHistory(sessionId);
    }, USAGE_MIRROR_MS),
  );
}

function cancelUsageMirror(sessionId: string) {
  const t = usageMirrorTimers.get(sessionId);
  if (t) {
    clearTimeout(t);
    usageMirrorTimers.delete(sessionId);
  }
}

function bucketNum(
  bucket: Record<string, number> | null | undefined,
  key: string,
): number {
  const v = bucket?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Mirror one session's latest cumulative token accounting into the
 * persistent all-time history (store key `usageHistory`) so the
 * UsageDashboard covers native sessions. Keyed `codex:<session id>`;
 * `total` is the thread's cumulative accounting, so each write REPLACES the
 * entry (recordUsageHistory dedupes unchanged snapshots). Codex ChatGPT-plan
 * turns carry no reliable USD cost — cost stays 0. Cached input is reported
 * as cache reads and subtracted from fresh input to avoid double counting.
 */
function mirrorUsageHistory(sessionId: string): void {
  const entry = useVibe.getState().sessions[sessionId];
  const usage = entry?.tokenUsage;
  if (!entry || !usage) return;
  const t = usage.total ?? usage.last;
  if (!t) return;
  const inputAll = bucketNum(t, "inputTokens");
  const cached = Math.min(bucketNum(t, "cachedInputTokens"), inputAll);
  const output = bucketNum(t, "outputTokens");
  const reasoning = bucketNum(t, "reasoningOutputTokens");
  if (inputAll + output === 0) return;
  // turns the human/orchestrator sent into this session so far
  let messages = 0;
  for (const iid of entry.order) {
    if (entry.items[iid]?.kind === "user") messages++;
  }
  const model = entry.session.model ?? "codex default";
  const byModel: ModelUsage = {
    model,
    input_tokens: inputAll - cached,
    output_tokens: output,
    cache_creation_tokens: 0,
    cache_read_tokens: cached,
    reasoning_output_tokens: reasoning,
    message_count: Math.max(messages, 1),
    cost_usd: 0,
  };
  const record: UsageHistoryEntry = {
    runtime: "codex",
    session_id: entry.session.id,
    agent_name: entry.session.name,
    cwd: entry.session.projectDir,
    started_at: entry.session.createdAt,
    last_updated: Date.now(),
    message_count: Math.max(messages, 1),
    input_tokens: inputAll - cached,
    output_tokens: output,
    cache_creation_tokens: 0,
    cache_read_tokens: cached,
    reasoning_output_tokens: reasoning,
    cost_usd: 0,
    by_model: [byModel],
  };
  useSwarm.getState().recordUsageHistory(record);
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
  /** display name — omitted = the generated agent name */
  name?: string;
  projectDir: string;
  /**
   * Owning project tab. Omitted = the project is resolved from `projectDir`
   * (opened/reused via the canonical-path dedupe; conductor spawns never
   * steal the active tab, user spawns activate it).
   */
  projectId?: string;
  /** generated identity — omitted = `name`, or a fresh pool pick */
  agentName?: string;
  spawnedBy?: VibeSpawnedBy;
  /** worktree the session works in (WorktreePanel flow; Phase 4 tools) */
  worktree?: VibeSessionWorktree | null;
  model?: string;
  effort?: string;
  access?: VibeAccess;
}

/** Names already used by sessions of one project (collision set). */
function takenAgentNames(projectId: string): string[] {
  const v = useVibe.getState();
  const taken: string[] = [];
  for (const id of v.order) {
    const s = v.sessions[id]?.session;
    if (!s || s.projectId !== projectId) continue;
    taken.push(s.agentName, s.name);
  }
  return taken;
}

/**
 * Start a fresh Vibe session: resolve its project, create the store entry,
 * spawn its dedicated app-server + thread. The session id is assigned here
 * (keys both stores). Rejects (and drops the store entry) if the process
 * can't start.
 */
export async function startSession(opts: StartSessionOpts): Promise<string> {
  ensureEvents();
  const spawnedBy = opts.spawnedBy ?? "user";
  // every session belongs to a project tab: reuse/open one for the dir when
  // the caller didn't resolve it — conductor spawns don't steal the active tab
  const projectId =
    opts.projectId ??
    (await useProjects
      .getState()
      .openProject(opts.projectDir, { activate: spawnedBy === "user" }));
  const agentName =
    opts.agentName?.trim() ||
    opts.name?.trim() ||
    pickAgentName(takenAgentNames(projectId));
  const id = nanoid(10);
  const access = opts.access ?? "full";
  const newSession: NewVibeSession = {
    id,
    name: opts.name?.trim() || agentName,
    projectId,
    agentName,
    spawnedBy,
    worktree: opts.worktree ?? null,
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
 * Deliver one user message (non-blocking backend): append the user item,
 * ensure the backend session is live, fire the turn. Progress streams as
 * events; busy is cleared by the turn's completion event, not here.
 *
 * STRICT: every failure (unknown/busy session, resume/start/send errors)
 * REJECTS — this is the orchestrator's delivery contract (`prompt_agent` /
 * `spawn_agents` tasks must never report `delivered:true` for a turn that
 * never started). Backend failures still surface as a warning item in the
 * transcript before rejecting, so the human sees them too. Resolves with the
 * acked turn id (the Phase-5 report expectations bind to it).
 */
export async function sendMessageStrict(
  sessionId: string,
  text: string,
  opts?: SendTurnOpts,
): Promise<{ turnId: string | null }> {
  const trimmed = text.trim();
  if (!trimmed) return { turnId: null };
  const store = useVibe.getState();
  if (!store.sessions[sessionId])
    throw new Error(`unknown vibe session "${sessionId}"`);
  // the SYNCHRONOUS delivery claim: `deliverTurn` awaits (auto-compaction)
  // BEFORE it flips the busy flag, so the busy check alone would let two
  // same-tick sends both pass, both append their user item, and the losing
  // Rust send would then clear the winner's busy flag. The claim is taken
  // here — before the append and before any await — and held until the
  // delivery settled (busy then owns the one-turn guard again).
  if (store.busy[sessionId] || deliveryClaims.has(sessionId))
    throw new Error("session is busy — one turn at a time");
  if (compactingSessions.has(sessionId))
    throw new Error(
      "the session is compacting its context — wait for the compaction to finish",
    );
  ensureEvents();
  deliveryClaims.add(sessionId);
  try {
    store.upsertItem(sessionId, {
      id: `user-${nanoid(8)}`,
      at: Date.now(),
      kind: "user",
      text: trimmed,
      ...(opts?.via ? { via: opts.via } : {}),
    });
    return await deliverTurn(sessionId, trimmed, opts);
  } finally {
    deliveryClaims.delete(sessionId);
  }
}

/**
 * Sessions with a `sendMessageStrict` delivery in flight that has not yet
 * claimed the busy flag (the pre-claim window spans the auto-compaction
 * await). Checked synchronously next to the busy flag — one turn at a time
 * holds across the whole delivery.
 */
const deliveryClaims = new Set<string>();

/** Per-turn options of the strict send path. */
export interface SendTurnOpts {
  /**
   * ONE-TURN-ONLY codex `outputSchema` — constrains the turn's FINAL
   * assistant message to a JSON Schema (Phase 5: the structured
   * agent→Conductor status reports).
   */
  outputSchema?: Record<string, unknown>;
  /**
   * Marks the mirrored user item as Conductor-authored (prompt_agent /
   * spawn_agents) so the feed can attribute it. Only the orchestrator
   * executors pass this — the human composer never does.
   */
  via?: "conductor";
  /**
   * Conductor path only: asks Rust to REFUSE the turn if the target session
   * runs at `full` access (the capability-reuse guard — the Conductor may not
   * autonomously drive a human-granted full-access agent). The human composer
   * never sets this.
   */
  requireWorkspace?: boolean;
}

/**
 * The turn-delivery core shared by sendMessageStrict and the steer-race
 * fallback (which already appended its user item): claim busy, ensure the
 * backend, fire the turn. Rejects on every failure, after surfacing it as a
 * warning item.
 */
async function deliverTurn(
  sessionId: string,
  trimmed: string,
  opts?: SendTurnOpts,
): Promise<{ turnId: string | null }> {
  // near the context window? compact first (idle, conservative — see
  // maybeAutoCompactBeforeTurn). Runs BEFORE we claim busy for this turn.
  await maybeAutoCompactBeforeTurn(sessionId);
  const store = useVibe.getState();
  store.setBusy(sessionId, true);
  resetStream(sessionId);
  // schema turn: mark BEFORE the send (a racing completion event must find
  // the marker), bind to the acked turn id after
  if (opts?.outputSchema) schemaTurns.set(sessionId, { turnId: null });
  try {
    await resumeSession(sessionId);
    const res = await invokeSend(
      sessionId,
      trimmed,
      opts?.outputSchema,
      opts?.requireWorkspace,
    );
    // send returns after the turn/start ack — busy stays true until the turn
    // completion event clears it
    if (opts?.outputSchema) {
      const marker = schemaTurns.get(sessionId);
      if (marker && res.turn_id) marker.turnId = res.turn_id;
    }
    return { turnId: res.turn_id ?? null };
  } catch (err) {
    if (opts?.outputSchema) schemaTurns.delete(sessionId);
    useVibe.getState().setBusy(sessionId, false);
    warn(sessionId, `Send failed: ${errorText(err)}`);
    throw err instanceof Error ? err : new Error(errorText(err));
  }
}

/** How long the steer-race fallback waits for the busy flag to clear. */
const STEER_RACE_IDLE_TIMEOUT_MS = 2_000;

/**
 * Wait until the session's busy flag clears — a real handshake on the store
 * instead of a fixed sleep. Resolves false when the deadline passes with the
 * session still busy. Used by the steer-race fallback (the turn-completion
 * event is already in flight when a steer loses its race) and by
 * spawn_agents' shared-lane serialization (one writer per worktree).
 */
export function waitForSessionIdle(
  sessionId: string,
  timeoutMs: number,
): Promise<boolean> {
  if (!useVibe.getState().busy[sessionId]) return Promise.resolve(true);
  return new Promise((resolve) => {
    let unsub: () => void = () => {};
    const timer = setTimeout(() => {
      unsub();
      resolve(!useVibe.getState().busy[sessionId]);
    }, timeoutMs);
    unsub = useVibe.subscribe((s) => {
      if (!s.busy[sessionId]) {
        clearTimeout(timer);
        unsub();
        resolve(true);
      }
    });
  });
}

/**
 * The orchestrator's prompt path for a BUSY session: STEER the running turn
 * (turn/steer — the instruction is absorbed mid-flight; live-verified on
 * codex 0.144.1). Race-safe: when the turn ended between the busy check and
 * the steer, Rust tags the failure "steer-race:" (BOTH the wire-level
 * mismatch and the early "no turn" case — Rust clears its turn id before the
 * frontend busy flag clears) and the text falls back to a normal next-turn
 * send. The user item is appended only AFTER a confirmed delivery — a lost
 * race never leaves a phantom "delivered-looking" item in the transcript.
 * Returns how the text was delivered. STRICT like sendMessageStrict.
 */
/** Options of the steer path on top of the fresh-turn `SendTurnOpts`. */
export interface SteerTurnOpts extends SendTurnOpts {
  /**
   * Text used ONLY when the delivery starts a FRESH turn (idle session /
   * lost steer race) — e.g. the base prompt plus the report suffix. The
   * plain `text` goes into an actual steer, where no report schema (and
   * hence no report instruction) applies to the running turn.
   */
  freshTurnText?: string;
}

export async function steerMessageStrict(
  sessionId: string,
  text: string,
  /** `outputSchema`/`freshTurnText` apply ONLY when the text starts a fresh
   * turn (idle / lost steer race) — a steered running turn keeps its own
   * output format */
  opts?: SteerTurnOpts,
): Promise<{ mode: "steered" | "queued"; turnId: string | null }> {
  const trimmed = text.trim();
  if (!trimmed) return { mode: "queued", turnId: null };
  const freshText = opts?.freshTurnText?.trim() || trimmed;
  const store = useVibe.getState();
  if (!store.sessions[sessionId])
    throw new Error(`unknown vibe session "${sessionId}"`);
  // a compaction's turn must never be steered — the instruction would be
  // absorbed by the summarization turn and lost. STRICT: reject; the caller
  // (prompt_agent) retries once the short compaction is over.
  if (compactingSessions.has(sessionId))
    throw new Error(
      "the session is compacting its context — retry in a moment",
    );
  if (!store.busy[sessionId]) {
    const res = await sendMessageStrict(sessionId, freshText, opts);
    return { mode: "queued", turnId: res.turnId };
  }
  ensureEvents();
  try {
    const res = await invokeSteer(sessionId, trimmed, opts?.requireWorkspace);
    // steered into the running turn — NOW mirror the text (confirmed)
    useVibe.getState().upsertItem(sessionId, {
      id: `user-${nanoid(8)}`,
      at: Date.now(),
      kind: "user",
      text: trimmed,
      ...(opts?.via ? { via: opts.via } : {}),
    });
    return { mode: "steered", turnId: res.turn_id ?? null };
  } catch (err) {
    const msg = errorText(err);
    if (msg.includes("steer-race:")) {
      // the turn ended mid-steer — hand the text to the NEXT turn once the
      // completion event has cleared the busy flag
      const idle = await waitForSessionIdle(sessionId, STEER_RACE_IDLE_TIMEOUT_MS);
      if (!idle) {
        // a new turn claimed the session first — nothing was delivered and
        // nothing was appended; the caller re-sends deliberately
        throw new Error(
          "steer lost the race and the session is busy again — re-send the prompt",
        );
      }
      const res = await sendMessageStrict(sessionId, freshText, opts);
      return { mode: "queued", turnId: res.turnId };
    }
    warn(sessionId, `Steer failed: ${msg}`);
    throw err instanceof Error ? err : new Error(msg);
  }
}

/**
 * Re-home a session into a worktree (Phase 4 `assign_worktree`). Guarded
 * against split-brain: a BUSY session refuses (the running turn would keep
 * writing into the OLD cwd while the occupancy metadata already claims the
 * new one — a cleanup could then force-delete the agent's real cwd), and a
 * live backend's metadata commits only AFTER the thread/settings/update
 * roundtrip succeeded — an RPC failure leaves store and backend consistent
 * on the old worktree. A not-yet-live session updates the store only and
 * picks the new cwd up on resume.
 */
export async function assignWorktreeToSession(
  sessionId: string,
  args: { path: string; root: string; branch: string; shared: boolean },
): Promise<void> {
  const store = useVibe.getState();
  if (!store.sessions[sessionId])
    throw new Error(`unknown vibe session "${sessionId}"`);
  if (store.busy[sessionId])
    throw new Error(
      "the agent is mid-turn — wait for the turn to finish (or interrupt it) before re-homing",
    );
  if (liveBackends.has(sessionId)) {
    // backend FIRST — the store commits only on its ack
    await invokeSetCwd(sessionId, args.path);
  }
  useVibe.getState().assignWorktree(sessionId, {
    projectDir: args.path,
    worktree: { root: args.root, branch: args.branch, shared: args.shared },
  });
}

/**
 * Run a detached codex review over a session's work (Phase 4
 * `review_agent`). Ensures the backend session is live first (the review
 * needs the Rust registry entry + the thread's rollout), then blocks until
 * the review turn finishes. STRICT: failures reject.
 */
export async function reviewSession(
  sessionId: string,
  target: string,
  opts: { requireWorkspace?: boolean } = {},
): Promise<{ status: string; review: string | null; review_thread_id: string }> {
  const session = useVibe.getState().sessions[sessionId]?.session;
  if (!session) throw new Error(`unknown vibe session "${sessionId}"`);
  ensureEvents();
  // a detached review holds NO session/conductor busy flag — surface it to
  // the quit guard so quitting can't silently kill minutes of review work
  const endInflight = beginInflight("review");
  try {
    await resumeSession(sessionId);
    return await invokeReview(sessionId, target, opts.requireWorkspace);
  } finally {
    endInflight();
  }
}

/**
 * The human/UI send path: same delivery, but failures never reject — a
 * backend failure is already visible in the transcript (the warning item),
 * and a busy/unknown session stays a silent no-op (the composer is disabled
 * while busy anyway).
 */
export async function sendMessage(
  sessionId: string,
  text: string,
): Promise<void> {
  try {
    await sendMessageStrict(sessionId, text);
  } catch {
    /* surfaced as a warning item in the transcript */
  }
}

/** Stop the session's running turn (its turn resolves as "interrupted"). */
export function interrupt(sessionId: string): void {
  if (!liveBackends.has(sessionId)) return;
  void invokeInterrupt(sessionId).catch(() => {});
}

/** How long `compactSession` waits, AFTER the blocking Rust RPC returned,
 * for the webview to process the compaction's terminal event. The events are
 * emitted before the RPC resolves, so this is a formality — generous anyway. */
const COMPACT_SETTLE_TIMEOUT_MS = 5_000;

/**
 * Compact the session's thread (thread/compact/start): summarize the
 * model-visible history so the next turn runs on a smaller context. The
 * VISIBLE transcript stays; a "compacted" event drops a divider. The
 * compaction runs as a real turn and RESOLVES ONLY AFTER IT GENUINELY ENDED:
 * Rust blocks until the turn's terminal event (mirroring `chat_compact`), and
 * a settle handshake then waits until the webview processed that event too —
 * so a send fired right after never races the compaction's busy flip in
 * either direction. Compactions are SERIALIZED per session (a second call
 * while one runs rejects — manual and auto can never share the marker), and
 * the marker is tagged so the compaction never reads as an agent finish.
 * STRICT: a busy/unknown session or a backend error rejects. `resumeSession`
 * first so a not-yet-live backend can compact.
 */
export async function compactSession(
  sessionId: string,
  opts?: {
    /** set by the auto-compaction inside `deliverTurn`, which legitimately
     * runs UNDER the session's own delivery claim */
    fromDelivery?: boolean;
  },
): Promise<void> {
  const store = useVibe.getState();
  if (!store.sessions[sessionId])
    throw new Error(`unknown vibe session "${sessionId}"`);
  if (compactingSessions.has(sessionId))
    throw new Error("a compaction is already running in this session");
  if (store.busy[sessionId])
    throw new Error("session is busy — interrupt the turn or wait before compacting");
  // a send mid-delivery (claim held, busy not yet flipped) would race the
  // compaction into Rust's one-turn guard — refuse early. The auto-compact
  // path is exempt: it runs inside that very claim.
  if (!opts?.fromDelivery && deliveryClaims.has(sessionId))
    throw new Error("a message is being delivered — try again in a moment");
  ensureEvents();
  // claim the marker BEFORE the first await — two same-tick compactions
  // (manual + auto) must never both pass the checks and share one bit
  compactingSessions.add(sessionId);
  const settled = new Promise<void>((resolve) => {
    compactionWaiters.set(sessionId, resolve);
  });
  try {
    await resumeSession(sessionId);
    await invokeCompact(sessionId); // blocks until the turn genuinely ended
    // settle handshake: the terminal event was emitted before the RPC
    // resolved — wait (bounded) until the webview processed it, so the
    // busy-flip and the "compacted" outcome are recorded before we return
    if (compactingSessions.has(sessionId)) {
      await Promise.race([
        settled,
        new Promise<void>((resolve) =>
          setTimeout(resolve, COMPACT_SETTLE_TIMEOUT_MS),
        ),
      ]);
    }
  } catch (err) {
    warn(sessionId, `Couldn't compact the context: ${errorText(err)}`);
    throw err instanceof Error ? err : new Error(errorText(err));
  } finally {
    // normally consumed by the terminal event. A still-busy session means
    // the compaction turn is STILL running (the bounded Rust wait timed out)
    // — keep the marker so its eventual terminal event still reads as a
    // compaction, never as an agent finish. Otherwise clean up so a stale
    // marker can never leak into a later turn's completion.
    if (!useVibe.getState().busy[sessionId]) consumeCompactionMarker(sessionId);
  }
}

/**
 * Before a fresh turn: auto-compact when the session's context footprint
 * crossed the threshold (Settings `autoCompact`, default on). Conservative —
 * only when idle + live + past the threshold + past the cooldown (see
 * `shouldAutoCompact`). Best-effort: a compaction failure never blocks the
 * send (the turn just runs on the fuller context). Awaits completion so the
 * following turn genuinely runs on the compacted context.
 */
async function maybeAutoCompactBeforeTurn(sessionId: string): Promise<void> {
  if (!liveBackends.has(sessionId)) return; // no live context to compact yet
  const store = useVibe.getState();
  const entry = store.sessions[sessionId];
  if (!entry) return;
  const enabled = useSwarm.getState().settings.autoCompact !== false;
  if (
    !shouldAutoCompact({
      usage: entry.tokenUsage ?? null,
      enabled,
      busy: !!store.busy[sessionId],
      lastCompactAt: lastAutoCompactAt.get(sessionId),
      now: Date.now(),
    })
  ) {
    return;
  }
  lastAutoCompactAt.set(sessionId, Date.now());
  try {
    await compactSession(sessionId, { fromDelivery: true });
  } catch {
    /* surfaced as a warning item; the turn proceeds on the fuller context */
  }
}

const DECISION_STATUS: Record<VibeApprovalDecision, VibeApprovalStatus> = {
  accept: "accepted",
  acceptForSession: "acceptedForSession",
  decline: "declined",
  cancel: "cancelled",
};

/** The HUMAN's answer to a pending approval — optimistically marks the item,
 * then tells Rust (the human may decide any class). */
export async function respondApproval(
  sessionId: string,
  approvalId: string,
  decision: VibeApprovalDecision,
): Promise<void> {
  useVibe
    .getState()
    .setApprovalStatus(sessionId, approvalId, DECISION_STATUS[decision], "human");
  try {
    await invokeRespondApproval(sessionId, approvalId, decision, false);
  } catch (err) {
    warn(sessionId, `Couldn't answer the approval: ${errorText(err)}`);
    // revert the optimistic mark — Rust never recorded the decision, the
    // agent is still waiting (the strict path below commits only on confirm)
    useVibe.getState().setApprovalStatus(sessionId, approvalId, "pending");
  }
}

/**
 * The CONDUCTOR's answer (decide_approval) — the STRICT server-anchored
 * path: Rust applies the decision only when the request was classified
 * "routine" at arrival (checked atomically next to the Responder — the
 * frontend's own escalation field is a courtesy copy, never the authority).
 * NOTHING is marked optimistically: the item status commits only after Rust
 * confirms, so a refusal (destructive class, already-resolved approval,
 * dead session) leaves the human's card exactly as it was and the error
 * propagates to the tool result.
 */
export async function respondApprovalStrict(
  sessionId: string,
  approvalId: string,
  decision: VibeApprovalDecision,
): Promise<void> {
  await invokeRespondApproval(sessionId, approvalId, decision, true);
  useVibe
    .getState()
    .setApprovalStatus(
      sessionId,
      approvalId,
      DECISION_STATUS[decision],
      "conductor",
    );
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

/**
 * Tear down one session's backend PROCESS + all controller-side per-session
 * maps — but NOT the store entry (the caller owns that). Shared by
 * closeSession (which drops the store entry after). The final usage mirror +
 * map deletes run before the invokeClose await while the entry still exists.
 */
async function cleanupSessionBackend(sessionId: string): Promise<void> {
  // flush a pending accounting mirror before the entry disappears
  cancelUsageMirror(sessionId);
  mirrorUsageHistory(sessionId);
  resetStream(sessionId);
  streams.delete(sessionId);
  lastTurnOutcomes.delete(sessionId);
  schemaTurns.delete(sessionId);
  compactingSessions.delete(sessionId);
  if (liveBackends.has(sessionId)) {
    liveBackends.delete(sessionId);
    try {
      await invokeClose(sessionId);
    } catch {
      /* best effort — the process dies with the app anyway */
    }
  }
}

/** Close a session: end its process, drop controller state + the store entry. */
export async function closeSession(sessionId: string): Promise<void> {
  await cleanupSessionBackend(sessionId);
  useVibe.getState().dropSession(sessionId);
}

/**
 * Bring a session into view: switch to its PROJECT tab first (reopening a
 * closed one — the Deck triage/counters are global across projects), then
 * select it and leave the Conductor stage. The triage queue, ticker chips,
 * palette rows and cross-session jumps all route through here.
 */
export function focusSession(sessionId: string): void {
  const session = useVibe.getState().sessions[sessionId]?.session;
  if (!session) return;
  const projects = useProjects.getState();
  if (session.projectId && projects.activeProjectId !== session.projectId) {
    // setActiveProject reopens a closed tab; a session whose project record
    // was lost entirely still focuses (the rail falls back to showing all)
    if (projects.projects[session.projectId])
      projects.setActiveProject(session.projectId);
  }
  useVibe.getState().setActive(sessionId);
  // a jump targets a session — leave the Conductor stage
  useVibeUi.getState().setStageMode("session");
}

/**
 * Align the Vibe selection + stage with one project: keep the current
 * session if it already belongs there, else restore the project's REMEMBERED
 * session (`activeIdByProject`), else its newest session; a session-less
 * project (or `null` = no open project at all) lands on the Conductor stage.
 * Shared by tab activation AND project-tab close (both must never leave the
 * stage on another project's session).
 */
function alignStageToProject(projectId: string | null): void {
  const v = useVibe.getState();
  if (projectId === null) {
    v.setActive(null);
    useVibeUi.getState().setStageMode("conductor");
    return;
  }
  const activeBelongs =
    !!v.activeId && v.sessions[v.activeId]?.session.projectId === projectId;
  if (activeBelongs) return;
  const remembered = v.activeIdByProject[projectId];
  const target =
    remembered && v.sessions[remembered]?.session.projectId === projectId
      ? remembered
      : v.order.find((id) => v.sessions[id]?.session.projectId === projectId);
  v.setActive(target ?? null);
  if (!target && useVibeUi.getState().stageMode === "session")
    useVibeUi.getState().setStageMode("conductor");
}

/**
 * Switch the active project tab (TitleBar click, ⌘1–9, palette) and align
 * the stage (see `alignStageToProject`).
 */
export function activateProject(projectId: string): void {
  const projects = useProjects.getState();
  if (!projects.projects[projectId]) return;
  projects.setActiveProject(projectId);
  alignStageToProject(projectId);
}

/**
 * Close a project TAB and realign the stage — the ONE close path (both the
 * immediate close and the CloseProjectConfirm resolution go through here).
 * Closing the ACTIVE tab moves the project store to a successor tab; without
 * realignment the rail/header would show the successor while stage+composer
 * keep operating on the closed project's session.
 */
export function closeProjectAndAlign(projectId: string): void {
  const wasActive = useProjects.getState().activeProjectId === projectId;
  useProjects.getState().closeProject(projectId);
  if (!wasActive) return;
  alignStageToProject(useProjects.getState().activeProjectId);
}

/**
 * Close a project TAB, with a confirm line when work is still running:
 * closing never blocks and never stops anything (sessions keep working in
 * the background; the tab reopens with everything intact), but with N busy
 * sessions the close goes through the CloseProjectConfirm dialog first.
 */
export function requestCloseProject(projectId: string): void {
  const v = useVibe.getState();
  const busyCount = v.order.filter(
    (id) => v.sessions[id]?.session.projectId === projectId && v.busy[id],
  ).length;
  if (busyCount === 0) {
    closeProjectAndAlign(projectId);
    return;
  }
  useVibeUi.getState().setCloseProjectConfirm({ projectId, busyCount });
}

/** Activate the n-th open project tab (⌘1–⌘9). */
export function activateProjectByIndex(index: number): void {
  const ids = openProjectIds(useProjects.getState());
  const id = ids[index];
  if (id) activateProject(id);
}

/** Busy session ids — used by the quit guard (they count like busy panes). */
export function vibeBusyIds(): string[] {
  const { busy, order } = useVibe.getState();
  return order.filter((id) => busy[id]);
}
