import type { ReactNode } from "react";
import { closeProjectAndAlign, closeSession } from "@/lib/vibe/controller";
import { useVibe } from "@/lib/vibe/session-store";
import { useVibeUi } from "@/lib/vibe/ui-store";
import { useProjects } from "@/lib/projects/store";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Confirm hiding a project tab while its workers keep running. */
export function CloseProjectConfirm() {
  const confirm = useVibeUi((state) => state.closeProjectConfirm);
  const setConfirm = useVibeUi((state) => state.setCloseProjectConfirm);
  const name = useProjects((state) =>
    confirm ? (state.projects[confirm.projectId]?.name ?? "") : "",
  );

  const open = !!confirm && !!name;
  return (
    <Dialog open={open} onOpenChange={(next) => !next && setConfirm(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Close «{name}»?</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <ContextLine glyph="▸" glyphCls="text-acc" textCls="text-txt">
            {confirm?.busyCount === 1
              ? "1 worker in this project is still working."
              : `${confirm?.busyCount ?? 0} workers in this project are still working.`}
          </ContextLine>
          <ContextLine glyph="·" glyphCls="text-fnt" textCls="text-mut">
            They keep running in the background — closing only hides the tab;
            reopening the folder brings everything back.
          </ContextLine>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirm(null)}>
            Keep it open
          </Button>
          <Button
            onClick={() => {
              if (confirm) closeProjectAndAlign(confirm.projectId);
              setConfirm(null);
            }}
          >
            Close tab
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Confirm stopping and closing a worker whose turn is still running. */
export function CloseSessionConfirm() {
  const id = useVibeUi((state) => state.closeConfirmId);
  const setId = useVibeUi((state) => state.setCloseConfirmId);
  const name = useVibe((state) =>
    id ? state.sessions[id]?.session.name : null,
  );
  const branch = useVibe((state) =>
    id ? (state.sessions[id]?.session.worktree?.branch ?? "") : "",
  );

  const open = !!id && !!name;
  return (
    <Dialog open={open} onOpenChange={(next) => !next && setId(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Close «{name}»?</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <ContextLine glyph="■" glyphCls="text-err" textCls="text-txt">
            This worker is mid-turn — closing stops it and ends the process.
          </ContextLine>
          <ContextLine glyph="·" glyphCls="text-fnt" textCls="text-mut">
            The transcript is discarded.
          </ContextLine>
          {branch && (
            <ContextLine glyph="⎇" glyphCls="text-mut" textCls="text-mut">
              Its worktree ({branch}) stays on disk — clean it up via the
              worktree panel.
            </ContextLine>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setId(null)}>
            Keep it
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (id) void closeSession(id);
              setId(null);
            }}
          >
            Stop & close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ContextLine({
  glyph,
  glyphCls,
  textCls,
  children,
}: {
  glyph: string;
  glyphCls: string;
  textCls: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex gap-2 text-12 leading-normal", textCls)}>
      <span aria-hidden className={cn("shrink-0", glyphCls)}>
        {glyph}
      </span>
      <span>{children}</span>
    </div>
  );
}
