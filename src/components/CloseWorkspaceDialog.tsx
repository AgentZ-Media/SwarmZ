import { FolderGit2, Loader2, Trash2 } from "lucide-react";
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
      ? s.workspaces[s.closeWorkspaceConfirm.id]?.name
      : undefined,
  );
  const agents = useSwarm((s) => s.agents);
  const order = useSwarm((s) => s.order);

  const inside = confirmId
    ? order
        .map((id) => agents[id])
        .filter((a): a is NonNullable<typeof a> => a?.workspaceId === confirmId.id)
    : [];
  const busy = inside.filter((a) => a.activity === "busy").length;
  const worktreeAgents = inside.filter((a) => a.worktree && a.cwd);

  return (
    <Dialog
      open={!!confirmId}
      onOpenChange={(open) => {
        if (!open) resolve("cancel");
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

        <ul className="mb-3 max-h-64 space-y-1 overflow-auto">
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
              {a.worktree && (
                <span className="flex shrink-0 items-center gap-1 rounded bg-secondary px-1 text-[10px] text-faint">
                  <FolderGit2 size={10} />
                  worktree
                </span>
              )}
              {a.cwd && (
                <span className="ml-auto truncate pl-2 text-faint">{a.cwd}</span>
              )}
            </li>
          ))}
        </ul>

        {worktreeAgents.length > 0 && (
          <div className="mb-4 rounded-md border border-border bg-secondary/30 px-2.5 py-2 text-xs text-muted-foreground">
            <div className="mb-1 flex items-center gap-2 text-foreground">
              <Trash2 size={13} className="text-faint" />
              Optional worktree cleanup
            </div>
            <p>
              Safe cleanup removes only worktrees that are still clean after their
              terminals stop. Worktrees with uncommitted files or local-only
              commits stay in the worktree panel.
            </p>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => resolve("cancel")}>
            Cancel
          </Button>
          <Button variant="outline" size="sm" onClick={() => resolve("close")}>
            Close workspace
          </Button>
          {worktreeAgents.length > 0 && (
            <Button
              variant="danger"
              size="sm"
              onClick={() => resolve("cleanup-safe")}
            >
              Close & clean safe
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
