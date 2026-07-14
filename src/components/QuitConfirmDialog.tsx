import { useSwarm } from "@/store";
import { resolveQuitConfirm } from "@/lib/quit";
import { summarizeBlockers } from "@/lib/quit-core";
import { useVibe } from "@/lib/vibe/session-store";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

/**
 * Raised when the app is about to close while quitting would interrupt work:
 * sessions with a turn running, a Conductor mid-turn, a Conductor timer
 * mid-fire (its durable claim is stamped — quitting drops it), a gh/git
 * write in flight (a push / PR mutation), a detached code review or a
 * worktree git op. Pending timers are listed as info — they persist and
 * re-fire on the next launch, so they never block on their own.
 */
export function QuitConfirmDialog() {
  const quitConfirm = useSwarm((s) => s.quitConfirm);
  const vibeSessions = useVibe((s) => s.sessions);

  const sessions = (quitConfirm?.sessionIds ?? [])
    .map((id) => {
      const v = vibeSessions[id]?.session;
      if (v) return { id, name: v.name, cwd: v.projectDir };
      return null;
    })
    .filter((e): e is NonNullable<typeof e> => !!e);

  const conductors = quitConfirm?.conductorProjects ?? [];
  const pendingTimers = quitConfirm?.pendingTimers ?? 0;
  const claimedTimers = quitConfirm?.claimedTimers ?? 0;
  const ghWrites = quitConfirm?.ghWrites ?? 0;
  const reviews = quitConfirm?.reviews ?? 0;
  const worktreeOps = quitConfirm?.worktreeOps ?? 0;
  const summary = quitConfirm
    ? summarizeBlockers(quitConfirm)
    : "Work is still running — quitting will interrupt it.";

  return (
    <Dialog
      open={!!quitConfirm}
      onOpenChange={(open) => {
        if (!open) resolveQuitConfirm(false);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Quit SwarmZ?</DialogTitle>
          <DialogDescription>{summary}</DialogDescription>
        </DialogHeader>

        <ul className="mb-4 space-y-1">
          {sessions.map((a) => (
            <li
              key={a.id}
              className="flex items-center gap-2 rounded-md border border-line bg-card px-2 py-1.5 text-12 text-txt"
            >
              <span className="shrink-0 font-mono leading-none text-err">■</span>
              <span className="truncate">{a.name}</span>
              {a.cwd && (
                <span className="ml-auto truncate pl-2 font-mono text-10 text-fnt">
                  {a.cwd}
                </span>
              )}
            </li>
          ))}
          {conductors.map((name) => (
            <li
              key={`cond-${name}`}
              className="flex items-center gap-2 rounded-md border border-line bg-card px-2 py-1.5 text-12 text-txt"
            >
              <span className="shrink-0 font-mono leading-none text-err">■</span>
              <span className="truncate">Orchestrator · {name}</span>
              <span className="ml-auto pl-2 font-mono text-10 text-fnt">mid-turn</span>
            </li>
          ))}
          {claimedTimers > 0 && (
            <li className="flex items-center gap-2 rounded-md border border-line bg-card px-2 py-1.5 text-12 text-txt">
              <span className="shrink-0 font-mono leading-none text-err">■</span>
              <span className="truncate">
                {claimedTimers === 1
                  ? "An Orchestrator timer is firing right now — quitting drops it"
                  : `${claimedTimers} Orchestrator timers are firing right now — quitting drops them`}
              </span>
            </li>
          )}
          {ghWrites > 0 && (
            <li className="flex items-center gap-2 rounded-md border border-line bg-card px-2 py-1.5 text-12 text-txt">
              <span className="shrink-0 font-mono leading-none text-err">■</span>
              <span className="truncate">
                {ghWrites === 1
                  ? "A GitHub write (push / PR) is in progress"
                  : `${ghWrites} GitHub writes (push / PR) are in progress`}
              </span>
            </li>
          )}
          {ghWrites < 0 && (
            <li className="flex items-center gap-2 rounded-md border border-line bg-card px-2 py-1.5 text-12 text-txt">
              <span className="shrink-0 font-mono leading-none text-err">■</span>
              <span className="truncate">
                Couldn't verify GitHub writes — one may still be in progress
              </span>
            </li>
          )}
          {reviews > 0 && (
            <li className="flex items-center gap-2 rounded-md border border-line bg-card px-2 py-1.5 text-12 text-txt">
              <span className="shrink-0 font-mono leading-none text-err">■</span>
              <span className="truncate">
                {reviews === 1
                  ? "A code review is running"
                  : `${reviews} code reviews are running`}
              </span>
            </li>
          )}
          {worktreeOps > 0 && (
            <li className="flex items-center gap-2 rounded-md border border-line bg-card px-2 py-1.5 text-12 text-txt">
              <span className="shrink-0 font-mono leading-none text-err">■</span>
              <span className="truncate">
                {worktreeOps === 1
                  ? "A worktree operation (git) is running"
                  : `${worktreeOps} worktree operations (git) are running`}
              </span>
            </li>
          )}
        </ul>

        {pendingTimers > 0 && (
          <p className="mb-4 text-11 text-fnt">
            {pendingTimers === 1
              ? "1 Orchestrator timer is pending"
              : `${pendingTimers} Orchestrator timers are pending`}{" "}
            — they persist and fire again on the next launch.
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => resolveQuitConfirm(false)}
          >
            Keep working
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => resolveQuitConfirm(true)}
          >
            Quit anyway
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
