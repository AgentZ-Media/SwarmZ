// Vibe-session triage — the needs-you sessions (a pending approval) folded
// into the Deck's queue alongside pane triage (lib/triage.ts). Kept separate
// from the pane triage so the fleet ops board census stays pane-only; the
// Deck is the single place that merges both worlds. Pure: pass the vibe state.

import { folderName } from "@/lib/utils";
import type { VibeState } from "./session-store";
import { oldestPendingApprovalAt } from "./ui";

export interface VibeTriageEntry {
  id: string;
  name: string;
  /** project folder basename (mono, faint in the queue) */
  project: string;
  /** epoch ms the oldest pending approval arrived */
  since: number | null;
}

/** Sessions waiting on the human, oldest approval first. */
export function vibeTriageEntries(s: VibeState): VibeTriageEntry[] {
  const entries: VibeTriageEntry[] = [];
  for (const id of s.order) {
    const entry = s.sessions[id];
    if (!entry) continue;
    // Builder sessions live only in their modal — never in the Deck queue.
    if (entry.session.builderForSlug) continue;
    const since = oldestPendingApprovalAt(entry);
    if (since === null) continue;
    entries.push({
      id,
      name: entry.session.name,
      project: folderName(entry.session.projectDir),
      since,
    });
  }
  entries.sort(
    (a, b) =>
      (a.since ?? Number.MAX_SAFE_INTEGER) -
      (b.since ?? Number.MAX_SAFE_INTEGER),
  );
  return entries;
}
