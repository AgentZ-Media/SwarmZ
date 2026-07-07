// Fleet event feed — the Deck's ticker/history source. A tiny standalone
// zustand store (the lib/limits.ts pattern) fed via `pushFleetEvent` from the
// places that already know about lifecycle transitions: store.ts (finished /
// waiting / created / exited) and the orchestrator executors (orch_prompt).
// Deliberately IN-MEMORY ONLY and capped — this is a glanceable "what just
// happened" trail, not an audit log; persistence would add quit-flush and
// hydration surface for no current feature.

import { create } from "zustand";
import { nanoid } from "nanoid";

export type FleetEventKind =
  | "finished" // a pane left busy → idle
  | "waiting" // a pane entered needs-you (OSC waiting or bell attention)
  | "orch_prompt" // an orchestrator chat delivered a prompt into a pane
  | "created" // a pane was created
  | "exited"; // a pane's process ended / the pane was closed

export interface FleetEvent {
  id: string;
  /** epoch ms */
  at: number;
  kind: FleetEventKind;
  paneId: string;
  /** pane name captured at event time (the pane may be gone later) */
  paneName: string;
  workspaceId: string;
}

/** Feed cap — oldest events fall off first. */
const MAX_EVENTS = 50;

/**
 * No repeated "waiting" for the same pane within this window — aligned with
 * the Stage-1 flap debounce (PING_FLAP_MS in orchestrator/controller.ts).
 */
const WAITING_DEDUPE_MS = 3_000;

/** last "waiting" event per pane id (dedupe; entries die with the feed cap) */
const lastWaitingAt = new Map<string, number>();

interface FleetEventsState {
  /** oldest first, capped at MAX_EVENTS */
  events: FleetEvent[];
}

export const useFleetEvents = create<FleetEventsState>(() => ({
  events: [],
}));

/**
 * Append one event (stamps id + timestamp). "waiting" events for a pane that
 * emitted one < 3 s ago are dropped — activity flapping must not spam the
 * ticker. Callers pass the pane's CURRENT name/workspace; the feed keeps the
 * snapshot so closed panes still render.
 */
/**
 * Most recent event for one pane, or null. Pure — pass `state.events` in
 * (component usage: `useFleetEvents((s) => lastEventForPane(s.events, id))`;
 * the returned reference only changes when a newer event for the pane lands,
 * so zustand's Object.is check keeps re-renders scoped).
 */
export function lastEventForPane(
  events: FleetEvent[],
  paneId: string,
): FleetEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].paneId === paneId) return events[i];
  }
  return null;
}

export function pushFleetEvent(
  e: Omit<FleetEvent, "id" | "at"> & { at?: number },
): void {
  const at = e.at ?? Date.now();
  if (e.kind === "waiting") {
    const last = lastWaitingAt.get(e.paneId);
    if (last !== undefined && at - last < WAITING_DEDUPE_MS) return;
    lastWaitingAt.set(e.paneId, at);
  }
  const { events } = useFleetEvents.getState();
  useFleetEvents.setState({
    events: [
      ...events.slice(Math.max(0, events.length - (MAX_EVENTS - 1))),
      { ...e, at, id: nanoid(8) },
    ],
  });
}
