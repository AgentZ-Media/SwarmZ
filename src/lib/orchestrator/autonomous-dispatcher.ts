// Autonomous Conductor dispatcher — the single budgeted delivery path for
// fleet events, approvals and timers. Runtime claims are isolated here;
// chat transport remains behind chat-delivery's explicit boundary.

import type { AutonomousTriggerKind } from "@/types";
import { useProjects } from "@/lib/projects/store";
import { useOrchestrator } from "./chat-store";
import { timerWireText } from "./timers-core";
import {
  checkAutonomyBudget,
  noteAutonomousTurn,
  persistAutonomyReservation,
  releaseAutonomousTurn,
} from "./autonomy";
import { runExclusiveAutonomous } from "./triggers";
import {
  createChat,
  dispatchTurn,
  markProjectChatFreshened,
  type DispatchResult,
} from "./chat-delivery";

// ---- autonomous turns (the Phase-5 loop core) ----
//
// EVERY autonomous Conductor turn — agent finished/blocked, approval
// escalation, timer fire, idle follow-up — funnels through
// `runAutonomousTurn`: a visible system marker (stamped `autonomous: true`
// + the trigger kind, so the UI can render it distinctly) followed by the
// wire turn. The EVENT triggers additionally route through the trigger
// router (./triggers.ts — dedupe per (project, kind, subject), per-project
// serialization, bounded retries); timers keep their own retry machinery but
// share the serialization chain. EVERY turn passes the per-project autonomy
// budget (autonomy.ts: max 5 consecutive without a human message, max 20 per
// rolling hour) — an exhausted budget trips a visible circuit breaker that
// only a human message resets. This is the HARD cap against prompt-injected
// approval/finish cascades: an autonomous turn that spawns an agent whose
// finish fires the next turn burns the same budget and STOPS at the breaker.

/** Minimum gap between autonomous turns per chat (burst damping). */
const AUTONOMOUS_MIN_GAP_MS = 5_000;

/** Runtime-only claims for autonomous delivery. */
export class AutonomousDispatchState {
  private readonly lastAt = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private readonly markerByKey = new Map<string, string>();

  isInFlight(chatId: string | null): boolean {
    return chatId !== null && this.inFlight.has(chatId);
  }

  isThrottled(chatId: string, now: number, minGapMs: number): boolean {
    const last = this.lastAt.get(chatId);
    return last !== undefined && now - last < minGapMs;
  }

  noteDispatch(chatId: string, at: number): void {
    this.lastAt.set(chatId, at);
  }

  enter(chatId: string): void {
    this.inFlight.add(chatId);
  }

  leave(chatId: string): void {
    this.inFlight.delete(chatId);
  }

  marker(key: string): string | null {
    return this.markerByKey.get(key) ?? null;
  }

  rememberMarker(key: string, messageId: string): void {
    this.markerByKey.set(key, messageId);
  }

  clearMarker(key: string): void {
    this.markerByKey.delete(key);
  }
}

const dispatchState = new AutonomousDispatchState();

/** Is the given Conductor chat's in-flight turn an autonomous one? */
export function isAutonomousTurnInFlight(chatId: string | null): boolean {
  return dispatchState.isInFlight(chatId);
}

/**
 * Resolve (or create) the Conductor chat an autonomous turn for a project
 * lands in. Null = no project record (nothing to talk to). Resolving also
 * claims the project's per-launch fresh-chat slot (`freshenedProjects`):
 * autonomous content delivered before the stage first shows (missed timers,
 * early finishes) must stay in THIS chat — `ensureFreshProjectChat` would
 * otherwise open a new empty chat on top and hide the reports/breaker
 * notices in the switcher.
 */
function autonomousChatFor(projectId: string): string | null {
  if (!useProjects.getState().projects[projectId]) return null;
  const s = useOrchestrator.getState();
  const chatId =
    activeChatIdForProject(s.chats, s.activeByProject, projectId) ??
    createChat(projectId);
  if (chatId) markProjectChatFreshened(projectId);
  return chatId;
}

/** The project's active chat id (remembered, else newest) — local helper. */
function activeChatIdForProject(
  chats: { id: string; projectId: string }[],
  activeByProject: Record<string, string>,
  projectId: string,
): string | null {
  const remembered = activeByProject[projectId];
  if (
    remembered &&
    chats.some((c) => c.id === remembered && c.projectId === projectId)
  ) {
    return remembered;
  }
  return chats.find((c) => c.projectId === projectId)?.id ?? null;
}

/** Marker messages of autonomous turns whose dispatch never started —
 * a retry with the same chat+marker PATCHES/reuses that message instead of
 * stacking a misleading second "⚡ autonomous" marker per failed attempt. */
/**
 * Run one autonomous Conductor turn: a visible system marker (stamped
 * `autonomous: true` + the trigger kind — Phase 6 renders these distinctly)
 * + the wire text, no user bubble. Returns "delivered", "retry" (chat busy,
 * throttled, budget exhausted or the dispatch failed — try again later) or
 * "drop" (no project/chat to deliver into). Registered as the trigger
 * router's runner from App.tsx (`registerAutonomousRunner`).
 *
 * Budget accounting is a RESERVATION: booked before the dispatch (the
 * per-project serialization means nothing races it), kept once the turn
 * actually STARTED (a mid-turn failure still burned real work), and
 * RELEASED on a definitive pre-start failure — five dead-codex attempts must
 * not trip the breaker with "5 turns ran" while zero turns ran.
 */
export async function runAutonomousTurn(
  projectId: string,
  marker: string,
  wireText: string,
  trigger: AutonomousTriggerKind,
): Promise<"delivered" | "retry" | "drop"> {
  const chatId = autonomousChatFor(projectId);
  if (!chatId) return "drop";
  const store = useOrchestrator.getState();
  if (store.busy[chatId]) return "retry";
  if (dispatchState.isThrottled(chatId, Date.now(), AUTONOMOUS_MIN_GAP_MS)) {
    return "retry";
  }
  // the HARD autonomy cap (per project) — a fresh trip is announced once,
  // visibly, in the chat; only a human message re-arms the breaker
  const verdict = checkAutonomyBudget(projectId);
  if (!verdict.ok) {
    if (verdict.freshTrip) {
      store.appendMessage(chatId, {
        role: "system",
        text: `⛔ Autonomy budget exhausted — ${verdict.reason}. Autonomous turns are paused until you send a message.`,
      });
    }
    return "retry";
  }
  const reservedAt = Date.now();
  noteAutonomousTurn(projectId, reservedAt);
  // The reservation is a durable claim: never begin an autonomous Codex turn
  // while its consumed budget exists only in memory. The store's write path
  // serializes/retries and latches autonomy fail-closed on persistent errors.
  if (!(await persistAutonomyReservation())) {
    releaseAutonomousTurn(projectId, reservedAt);
    // Best-effort persistence of the compensating release. The global
    // fail-closed latch still prevents another autonomous dispatch if this
    // write cannot recover.
    await persistAutonomyReservation();
    return "retry";
  }
  dispatchState.noteDispatch(chatId, reservedAt);
  // ONE marker across retries: a previous never-started attempt left its
  // message — reuse it instead of stacking markers (verified still present;
  // the 200-message cap may have dropped it)
  const markerKey = `${chatId}|${marker}`;
  const chat = store.chats.find((c) => c.id === chatId);
  const existing = dispatchState.marker(markerKey);
  if (!existing || !chat?.messages.some((m) => m.id === existing)) {
    const messageId = store.appendMessage(chatId, {
      role: "system",
      text: marker,
      autonomous: true,
      trigger,
    });
    dispatchState.rememberMarker(markerKey, messageId);
  }
  // a failed dispatch (codex unavailable, spawn failure) is NOT "delivered"
  // — the caller keeps its trigger (timers stay persisted and retry).
  // Mark the chat autonomous for the dispatch so tool executors can refuse
  // outward side effects (github writes) that need a human this turn.
  dispatchState.enter(chatId);
  let result: DispatchResult;
  try {
    result = await dispatchTurn(chatId, wireText);
  } finally {
    dispatchState.leave(chatId);
  }
  if (result === "never-started") {
    // nothing ran — release the reservation, keep the marker for the retry
    releaseAutonomousTurn(projectId, reservedAt);
    await persistAutonomyReservation();
    return "retry";
  }
  dispatchState.clearMarker(markerKey);
  return result === "completed" ? "delivered" : "retry";
}

/**
 * A Conductor timer fired (lib/orchestrator/timers.ts): deliver the
 * autonomous follow-up turn in the timer's project. "retry" keeps the timer
 * alive (the timers module re-arms in 30 s, bounded). A NOT-YET-HYDRATED
 * projects store answers "retry", never "drop" — a load failure must not
 * make missing project records look authoritative and eat the timer. The
 * turn itself runs INSIDE the project's autonomous serialization chain, so a
 * timer never interleaves with an event-triggered turn in the same chat.
 *
 * The durable at-most-once `claim` is invoked INSIDE the chain, immediately
 * before the dispatch — never before the (possibly minutes-long) chain wait:
 * a quit while the timer queues behind a long turn/review must re-fire it as
 * missed on the next launch, not hydrate-drop a never-delivered timer. The
 * claim also re-checks that the timer still exists — one cancelled while
 * queued (cancel_timer from the very turn it waited behind) aborts as
 * "drop" instead of firing anyway.
 */
export async function deliverTimerTurn(
  projectId: string,
  note: string,
  missed: boolean,
  claim: () => Promise<boolean>,
): Promise<"delivered" | "retry" | "drop"> {
  if (!useProjects.getState().hydrated) return "retry";
  return runExclusiveAutonomous(projectId, async () => {
    if (!(await claim())) return "drop"; // cancelled while queued
    return runAutonomousTurn(
      projectId,
      `⏰ Timer fired: ${note}`,
      timerWireText(note, missed),
      "timer",
    );
  });
}

/**
 * A timer could not be delivered (bounded retries exhausted / an at-most-once
 * claim was dropped on hydrate): make the state VISIBLE as a system message
 * in the project's Conductor chat — never a silent disappearance.
 */
export function notifyTimerNotice(projectId: string, text: string): void {
  const chatId = autonomousChatFor(projectId);
  if (!chatId) return;
  useOrchestrator.getState().appendMessage(chatId, { role: "system", text });
}
