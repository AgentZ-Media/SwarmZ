import { Loader2 } from "lucide-react";
import { useSwarm } from "@/store";
import { resolveQuitConfirm } from "@/lib/quit";
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
 * one or more sessions with a turn still running (the run gets interrupted).
 */
export function QuitConfirmDialog() {
  const quitConfirm = useSwarm((s) => s.quitConfirm);
  const vibeSessions = useVibe((s) => s.sessions);

  const listed = (quitConfirm ?? [])
    .map((id) => {
      const v = vibeSessions[id]?.session;
      if (v) return { id, name: v.name, cwd: v.projectDir };
      return null;
    })
    .filter((e): e is NonNullable<typeof e> => !!e);

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
            {listed.length === 1
              ? "A session is still working — quitting will interrupt it."
              : `${listed.length} sessions are still working — quitting will interrupt them.`}
          </DialogDescription>
        </DialogHeader>

        <ul className="mb-4 space-y-1">
          {listed.map((a) => (
            <li
              key={a.id}
              className="flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-2 py-1.5 font-mono text-[11px] text-foreground"
            >
              <Loader2 size={12} className="shrink-0 animate-spin text-warning" />
              <span className="truncate">{a.name}</span>
              {a.cwd && (
                <span className="ml-auto truncate pl-2 text-faint">{a.cwd}</span>
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
