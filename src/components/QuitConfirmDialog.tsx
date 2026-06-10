import { Loader2 } from "lucide-react";
import { useSwarm } from "@/store";
import { resolveQuitConfirm } from "@/lib/quit";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

/**
 * Raised when the app is about to close (window close or ⌘Q) while Claude is
 * still working in one or more panes — quitting would kill those runs.
 */
export function QuitConfirmDialog() {
  const quitConfirm = useSwarm((s) => s.quitConfirm);
  const agents = useSwarm((s) => s.agents);

  const busy = (quitConfirm ?? [])
    .map((id) => agents[id])
    .filter((a): a is NonNullable<typeof a> => !!a);

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
            {busy.length === 1
              ? "An agent is still working — quitting will interrupt it."
              : `${busy.length} agents are still working — quitting will interrupt them.`}
          </DialogDescription>
        </DialogHeader>

        <ul className="mb-4 space-y-1">
          {busy.map((a) => (
            <li
              key={a.id}
              className="flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-2 py-1.5 font-mono text-[11px] text-foreground"
            >
              <Loader2
                size={12}
                className="shrink-0 animate-spin text-warning"
              />
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
