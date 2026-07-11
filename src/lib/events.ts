// Fleet event feed — the Deck's ticker/history source. A tiny standalone
// zustand store fed via `pushFleetEvent` from the places that already know
// about lifecycle transitions: the vibe controller (finished / waiting /
// exited) and the orchestrator executors (orch_prompt). Deliberately
// IN-MEMORY ONLY and capped — this is a glanceable "what just happened"
// trail, not an audit log.

import { create } from "zustand";
import { nanoid } from "nanoid";

export type FleetEventKind =
  | "finished" // a session's turn completed
  | "waiting" // a session raised a pending approval (needs-you)
  | "orch_prompt" // the orchestrator delivered a prompt into a session
  | "created" // a session was created
  | "exited" // a session's turn failed / the session was closed
  | "pr"; // a GitHub PR changed (watcher; ticker-only, no toast)

export interface FleetEvent {
  id: string;
  /** epoch ms */
  at: number;
  kind: FleetEventKind;
  /** vibe session id ("" for non-session events like "pr") */
  sessionId: string;
  /** session name captured at event time (the session may be gone later) */
  sessionName: string;
  /** pre-built ticker label (kind "pr") — session kinds derive theirs */
  label?: string;
  /** external link the ticker chip opens (kind "pr": the PR URL) */
  url?: string;
}

/** Feed cap — oldest events fall off first. */
const MAX_EVENTS = 50;

/**
 * No repeated "waiting" for the same session within this window — aligned
 * with the ping flap debounce (PING_FLAP_MS in orchestrator/controller.ts).
 */
const WAITING_DEDUPE_MS = 3_000;

/** last "waiting" event per session id (dedupe; entries die with the feed cap) */
const lastWaitingAt = new Map<string, number>();

interface FleetEventsState {
  /** oldest first, capped at MAX_EVENTS */
  events: FleetEvent[];
}

export const useFleetEvents = create<FleetEventsState>(() => ({
  events: [],
}));

/**
 * Most recent event for one session, or null. Pure — pass `state.events` in;
 * the returned reference only changes when a newer event for the session
 * lands, so zustand's Object.is check keeps re-renders scoped.
 */
export function lastEventForSession(
  events: FleetEvent[],
  sessionId: string,
): FleetEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].sessionId === sessionId) return events[i];
  }
  return null;
}

/**
 * Append one event (stamps id + timestamp). "waiting" events for a session
 * that emitted one < 3 s ago are dropped — flapping must not spam the ticker.
 */
export function pushFleetEvent(
  e: Omit<FleetEvent, "id" | "at"> & { at?: number },
): void {
  const at = e.at ?? Date.now();
  if (e.kind === "waiting") {
    const last = lastWaitingAt.get(e.sessionId);
    if (last !== undefined && at - last < WAITING_DEDUPE_MS) return;
    lastWaitingAt.set(e.sessionId, at);
  }
  const { events } = useFleetEvents.getState();
  useFleetEvents.setState({
    events: [
      ...events.slice(Math.max(0, events.length - (MAX_EVENTS - 1))),
      { ...e, at, id: nanoid(8) },
    ],
  });
}
