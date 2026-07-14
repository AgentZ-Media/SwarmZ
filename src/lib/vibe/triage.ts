// Vibe-session triage — the needs-you sessions (a pending approval) folded
// into the Deck's queue alongside pane triage (lib/triage.ts). Kept separate
// from the pane triage so the fleet ops board census stays pane-only; the
// Deck is the single place that merges both worlds. Pure: pass the vibe state.

import { folderName } from "@/lib/utils";
import type { VibeState } from "./session-store";
import { humanAttention } from "./attention";

export interface VibeTriageEntry {
  id: string;
  name: string;
  /** project folder basename (mono, faint in the queue) */
  project: string;
  /** epoch ms the oldest pending approval arrived */
  since: number | null;
  /** why the lane needs attention; reports are first-class, not transcript-only */
  kind: "approval" | "report";
  /** bounded human-facing question/summary for richer inbox surfaces */
  summary: string | null;
}

/**
 * Timestamp of the latest unresolved structured `needs_human` report. A
 * later human-authored message acknowledges the question immediately; a
 * newer report supersedes the older one. Conductor-authored prompts do not
 * silently clear human attention.
 */
export { unresolvedNeedsHumanReport } from "./attention";

/** Sessions waiting on the human, oldest approval first. */
export function vibeTriageEntries(s: VibeState): VibeTriageEntry[] {
  const entries: VibeTriageEntry[] = [];
  for (const id of s.order) {
    const entry = s.sessions[id];
    if (!entry) continue;
    const attention = humanAttention(entry);
    if (!attention) continue;
    entries.push({
      id,
      name: entry.session.name,
      project: folderName(entry.session.projectDir),
      since: attention.since,
      kind: attention.kind,
      summary: attention.summary,
    });
  }
  entries.sort(
    (a, b) =>
      (a.since ?? Number.MAX_SAFE_INTEGER) -
      (b.since ?? Number.MAX_SAFE_INTEGER),
  );
  return entries;
}
