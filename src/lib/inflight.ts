// In-flight background operations that hold NO session/conductor busy flag
// but would be killed mid-write by quitting: detached codex reviews (manual,
// review_agent, the autonomous auto-review) and git worktree add/remove.
// Tiny shared counter registry — the quit guard reads it as hard blockers
// (lib/quit.ts). Pure, unit-tested.

export type InflightKind = "review" | "worktree";

const counts: Record<InflightKind, number> = { review: 0, worktree: 0 };

/**
 * Mark one operation as running; call the returned function when it settled
 * (idempotent — a double call never underflows the counter).
 */
export function beginInflight(kind: InflightKind): () => void {
  counts[kind] += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    counts[kind] -= 1;
  };
}

/** Current number of running operations of one kind. */
export function inflightCount(kind: InflightKind): number {
  return counts[kind];
}
