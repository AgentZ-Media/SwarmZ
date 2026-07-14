// Pure quit-guard logic (rebuild Phase 8) — no tauri imports, unit-tested.
// The stateful guard (window close interception, blocker gathering, persist
// flush) lives in ./quit.ts.

import type { QuitBlockers } from "@/types";

/**
 * Does anything actually block a clean quit? Busy sessions, busy Conductors,
 * a Conductor timer mid-fire (its durable claim is stamped — quitting now
 * drops it on the next hydrate), an in-flight gh/git write (`ghWrites: -1`
 * means the counter query FAILED — unknown state confirms, fail closed), a
 * detached codex review or a worktree git op would all be interrupted by
 * quitting now. Pending timers are NOT a blocker on their own — they persist
 * and re-fire on the next launch, so they never force the dialog.
 */
export function hasHardBlocker(b: QuitBlockers): boolean {
  return (
    b.sessionIds.length > 0 ||
    b.conductorProjects.length > 0 ||
    b.claimedTimers > 0 ||
    b.ghWrites !== 0 ||
    b.reviews > 0 ||
    b.worktreeOps > 0 ||
    b.runtimeOps !== 0
  );
}

/** One-line summary for the dialog header ("2 sessions, a Conductor still …"). */
export function summarizeBlockers(b: QuitBlockers): string {
  const parts: string[] = [];
  if (b.sessionIds.length)
    parts.push(b.sessionIds.length === 1 ? "1 session" : `${b.sessionIds.length} sessions`);
  if (b.conductorProjects.length)
    parts.push(
      b.conductorProjects.length === 1
        ? "a Conductor"
        : `${b.conductorProjects.length} Conductors`,
    );
  if (b.claimedTimers > 0)
    parts.push(b.claimedTimers === 1 ? "a firing timer" : `${b.claimedTimers} firing timers`);
  if (b.ghWrites > 0)
    parts.push(b.ghWrites === 1 ? "a GitHub write" : `${b.ghWrites} GitHub writes`);
  else if (b.ghWrites < 0) parts.push("possibly a GitHub write");
  if (b.reviews > 0)
    parts.push(b.reviews === 1 ? "a code review" : `${b.reviews} code reviews`);
  if (b.worktreeOps > 0)
    parts.push(
      b.worktreeOps === 1 ? "a worktree operation" : `${b.worktreeOps} worktree operations`,
    );
  if (b.runtimeOps > 0)
    parts.push(
      b.runtimeOps === 1
        ? "a Runtime Environment process"
        : `${b.runtimeOps} Runtime Environment processes`,
    );
  else if (b.runtimeOps < 0) parts.push("possibly a Runtime Environment process");
  if (parts.length === 0) return "Work is still running — quitting will interrupt it.";
  const total =
    b.sessionIds.length +
    b.conductorProjects.length +
    b.claimedTimers +
    (b.ghWrites !== 0 ? Math.max(b.ghWrites, 1) : 0) +
    b.reviews +
    b.worktreeOps +
    (b.runtimeOps !== 0 ? Math.max(b.runtimeOps, 1) : 0);
  const it = total === 1 ? "it" : "them";
  return `${parts.join(", ")} still running — quitting will interrupt ${it}.`;
}
