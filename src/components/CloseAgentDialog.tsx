import { SquareTerminal } from "lucide-react";
import { useSwarm } from "@/store";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

/**
 * Raised when a pane is closed while one of its floating terminals still has
 * a process running (dev server, build, …): kill everything, or detach the
 * busy terminals so they keep running as unowned floating pills.
 */
export function CloseAgentDialog() {
  const confirm = useSwarm((s) => s.closeConfirm);
  const resolve = useSwarm((s) => s.resolveCloseConfirm);
  const agentName = useSwarm((s) =>
    s.closeConfirm ? s.agents[s.closeConfirm.agentId]?.name : undefined,
  );
  const terms = useSwarm((s) => s.floatingTerminals);

  const busy = confirm?.termIds
    .map((id) => terms[id])
    .filter((t): t is NonNullable<typeof t> => !!t);

  return (
    <Dialog
      open={!!confirm}
      onOpenChange={(open) => {
        if (!open) resolve("cancel");
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Close {agentName ?? "agent"}?</DialogTitle>
          <DialogDescription>
            {busy && busy.length === 1
              ? "A floating terminal of this pane still has a process running."
              : `${busy?.length ?? 0} floating terminals of this pane still have processes running.`}
          </DialogDescription>
        </DialogHeader>

        <ul className="mb-4 space-y-1">
          {busy?.map((t) => (
            <li
              key={t.id}
              className="flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-2 py-1.5 font-mono text-[11px] text-foreground"
            >
              <SquareTerminal size={12} className="shrink-0 text-faint" />
              <span className="truncate">{t.name}</span>
            </li>
          ))}
        </ul>

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => resolve("cancel")}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" onClick={() => resolve("kill")}>
            Close everything
          </Button>
          <Button size="sm" onClick={() => resolve("detach")}>
            Detach &amp; close pane
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
