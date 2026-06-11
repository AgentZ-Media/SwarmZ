import { Loader2 } from "lucide-react";
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
 * Raised when a pane is closed while claude is actively working in it (OSC
 * 9;4 busy): a misclick on the header ✕ or a habitual ⌘W must not interrupt
 * a long-running job without asking. Idle panes close without this dialog.
 */
export function CloseBusyDialog() {
  const agentId = useSwarm((s) => s.closeBusyConfirm);
  const resolve = useSwarm((s) => s.resolveCloseBusy);
  const agent = useSwarm((s) =>
    s.closeBusyConfirm ? s.agents[s.closeBusyConfirm] : undefined,
  );

  return (
    <Dialog
      open={!!agentId}
      onOpenChange={(open) => {
        if (!open) resolve(false);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Close {agent?.name ?? "agent"}?</DialogTitle>
          <DialogDescription>
            Claude is still working in this pane — closing it will interrupt
            the run.
          </DialogDescription>
        </DialogHeader>

        <div className="mb-4 flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-2 py-1.5 font-mono text-[11px] text-foreground">
          <Loader2 size={12} className="shrink-0 animate-spin text-warning" />
          <span className="truncate">{agent?.name}</span>
          {agent?.cwd && (
            <span className="ml-auto truncate pl-2 text-faint">{agent.cwd}</span>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => resolve(false)}>
            Keep working
          </Button>
          <Button variant="danger" size="sm" onClick={() => resolve(true)}>
            Close anyway
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
