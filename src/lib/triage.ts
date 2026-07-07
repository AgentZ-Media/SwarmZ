// Shared triage ordering — every needs-you pane app-wide, oldest waiting
// first (unknown ages last). Single source for the Deck's triage queue and
// the fleet overview's initial selection / Tab cycle, so "next pane to
// handle" means the same thing everywhere. Pure: pass `useSwarm.getState()`
// (or a selector's state) in; the store import is type-only.

import type { SwarmState } from "@/store";

export interface TriageEntry {
  id: string;
  name: string;
  workspaceId: string;
  /** epoch ms the pane entered needs-you, when known */
  since: number | null;
}

export function triageEntries(s: SwarmState): TriageEntry[] {
  const entries: TriageEntry[] = [];
  for (const id of s.order) {
    const a = s.agents[id];
    if (!a || a.status === "exited") continue;
    if (!a.attention && a.activity !== "waiting") continue;
    entries.push({
      id,
      name: a.name,
      workspaceId: a.workspaceId,
      // busy → waiting stamps lastBusyEndAt — that IS the waiting-since;
      // bell-attention-only panes carry waitingSince (stamped in
      // setAttention), so they sort by age too instead of always last
      since:
        (a.activity === "waiting" ? a.lastBusyEndAt : undefined) ??
        a.waitingSince ??
        null,
    });
  }
  entries.sort(
    (a, b) =>
      (a.since ?? Number.MAX_SAFE_INTEGER) -
      (b.since ?? Number.MAX_SAFE_INTEGER),
  );
  return entries;
}
