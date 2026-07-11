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

        <div className="mb-4 space-y-1">
          <div className="flex items-center gap-2 rounded-md border border-line bg-card px-2 py-1.5 text-12 text-txt">
            <span className="shrink-0 font-mono leading-none text-mut">⎇</span>
            <span className="truncate font-mono">
              {status?.branch ?? confirm?.meta.branch}
            </span>
          </div>
          {status?.dirty && (
            <div className="flex items-center gap-2 rounded-md border border-line bg-card px-2 py-1.5 text-12 text-mut">
              <span className="shrink-0 font-mono leading-none text-mut">
                Δ
              </span>
              <span className="truncate">uncommitted changes</span>
            </div>
          )}
        </div>

        <p className="mb-4 text-12 text-mut">
          Keep it to come back later (it stays available in the worktree panel),
          or delete the worktree and its branch for good.
        </p>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => resolve("cancel")}>
            Cancel
          </Button>
          <Button variant="secondary" size="sm" onClick={() => resolve("keep")}>
            Keep worktree
          </Button>
          <Button variant="danger" size="sm" onClick={() => resolve("delete")}>
            Delete worktree
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
