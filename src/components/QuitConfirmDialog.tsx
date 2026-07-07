import { Loader2, Terminal } from "lucide-react";
import { useSwarm } from "@/store";
import { agentIsBusy, resolveQuitConfirm } from "@/lib/quit";
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
 * Raised when the app is about to close while quitting would lose something:
 * An agent still working in one or more panes (the run gets interrupted), or —
 * with restore-on-launch disabled — terminals that are simply still open.
 */
export function QuitConfirmDialog() {
  const quitConfirm = useSwarm((s) => s.quitConfirm);
  const agents = useSwarm((s) => s.agents);
  const floats = useSwarm((s) => s.floatingTerminals);
  const vibeSessions = useVibe((s) => s.sessions);

  // blocker ids are agent panes, floating terminals (floats block when a
  // process still runs in them — never restored) or busy Vibe sessions
  const listed = (quitConfirm ?? [])
    .map((id) => {
      const a = agents[id];
      if (a) return { id, name: a.name, cwd: a.cwd, busy: agentIsBusy(a) };
      const f = floats[id];
      if (f) return { id, name: f.name, cwd: f.cwd, busy: true };
      const v = vibeSessions[id]?.session;
      if (v) return { id, name: v.name, cwd: v.projectDir, busy: true };
      return null;
    })
    .filter((e): e is NonNullable<typeof e> => !!e);
  const busyCount = listed.filter((e) => e.busy).length;

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
          <DialogDescription>
            {busyCount > 0
              ? busyCount === 1
                ? "An agent is still working — quitting will interrupt it."
                : `${busyCount} agents are still working — quitting will interrupt them.`
              : listed.length === 1
                ? "A terminal is still open — it won't be restored on the next launch."
                : `${listed.length} terminals are still open — they won't be restored on the next launch.`}
          </DialogDescription>
        </DialogHeader>

        <ul className="mb-4 space-y-1">
          {listed.map((a) => (
            <li
              key={a.id}
              className="flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-2 py-1.5 font-mono text-[11px] text-foreground"
            >
              {a.busy ? (
                <Loader2
                  size={12}
                  className="shrink-0 animate-spin text-warning"
                />
              ) : (
                <Terminal size={12} className="shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{a.name}</span>
              {a.cwd && (
                <span className="ml-auto truncate pl-2 text-faint">
                  {a.cwd}
                </span>
              )}
            </li>
          ))}
        </ul>

        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
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
