import { FolderGit2 } from "lucide-react";
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
 * Raised (via `requestCloseWorktree`) when a worktree is being finished while
 * it still holds work (uncommitted changes or commits no other branch has):
 * keep the worktree on disk (it stays reachable in the title-bar worktree
 * panel), or delete the folder and its branch for good. Clean worktrees never
 * get here — they are removed silently. Dormant in the Phase-1 interim state;
 * Phase 4 wires session-worktree close into this flow.
 */
export function CloseWorktreeDialog() {
  const confirm = useSwarm((s) => s.closeWorktreeConfirm);
  const resolve = useSwarm((s) => s.resolveCloseWorktree);

  const status = confirm?.status;
  const reasons: string[] = [];
  if (status?.dirty) reasons.push("uncommitted changes");
  if (status && status.ahead > 0)
    reasons.push(
      `${status.ahead} commit${status.ahead === 1 ? "" : "s"} no other branch has`,
    );

  return (
    <Dialog
      open={!!confirm}
      onOpenChange={(open) => {
        if (!open) resolve("cancel");
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove worktree?</DialogTitle>
          <DialogDescription>
            This git worktree still holds {reasons.join(" and ")}.
          </DialogDescription>
        </DialogHeader>

        <div className="mb-4 flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-2 py-1.5 font-mono text-[11px] text-foreground">
          <FolderGit2 size={12} className="shrink-0 text-faint" />
          <span className="truncate">
            {status?.branch ?? confirm?.meta.branch}
          </span>
        </div>

        <p className="mb-4 text-xs text-muted-foreground">
          Keep it to come back later (it stays available in the worktree panel),
          or delete the worktree and its branch for good.
        </p>

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => resolve("cancel")}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" onClick={() => resolve("delete")}>
            Delete worktree
          </Button>
          <Button size="sm" onClick={() => resolve("keep")}>
            Keep worktree
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
