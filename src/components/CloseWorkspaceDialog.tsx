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
 * Raised when a workspace tab is closed while agents still live in it —
 * closing kills their terminals (running floating terminals stay only if
 * they were detached earlier).
 */
export function CloseWorkspaceDialog() {
  const confirmId = useSwarm((s) => s.closeWorkspaceConfirm);
  const resolve = useSwarm((s) => s.resolveCloseWorkspace);
  const wsName = useSwarm((s) =>
    s.closeWorkspaceConfirm
      ? s.workspaces[s.closeWorkspaceConfirm]?.name
      : undefined,
  );
  const agents = useSwarm((s) => s.agents);
  const order = useSwarm((s) => s.order);

  const inside = confirmId
    ? order
        .map((id) => agents[id])
        .filter((a): a is NonNullable<typeof a> => a?.workspaceId === confirmId)
    : [];
  const busy = inside.filter((a) => a.activity === "busy").length;

  return (
    <Dialog
      open={!!confirmId}
      onOpenChange={(open) => {
        if (!open) resolve(false);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Close “{wsName}”?</DialogTitle>
          <DialogDescription>
            {inside.length === 1
              ? "Its agent will be closed"
              : `Its ${inside.length} agents will be closed`}
            {busy > 0
              ? ` — ${busy === 1 ? "one is" : `${busy} are`} still working.`
              : "."}
          </DialogDescription>
        </DialogHeader>

        <ul className="mb-4 space-y-1">
          {inside.map((a) => (
            <li
              key={a.id}
              className="flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-2 py-1.5 font-mono text-[11px] text-foreground"
            >
              {a.activity === "busy" ? (
                <Loader2 size={12} className="shrink-0 animate-spin text-warning" />
              ) : (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-faint" />
              )}
              <span className="truncate">{a.name}</span>
              {a.cwd && (
                <span className="ml-auto truncate pl-2 text-faint">{a.cwd}</span>
              )}
            </li>
          ))}
        </ul>

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => resolve(false)}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" onClick={() => resolve(true)}>
            Close workspace
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
