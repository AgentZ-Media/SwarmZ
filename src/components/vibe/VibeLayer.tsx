import { lazy, Suspense, useEffect, useState } from "react";
import { useVibe } from "@/lib/vibe/session-store";
import { useVibeUi } from "@/lib/vibe/ui-store";
import { ConductorSidebar } from "./ConductorSidebar";
import { MissionWorkspace } from "@/components/missions/MissionWorkspace";
import { PersistenceHealthBanner } from "@/components/PersistenceHealthBanner";
import {
  CloseProjectConfirm,
  CloseSessionConfirm,
} from "./CloseConfirmDialogs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

const FocusStage = lazy(() =>
  import("./FocusStage").then((module) => ({ default: module.FocusStage })),
);
const NewVibeSessionDialog = lazy(() =>
  import("./NewVibeSessionDialog").then((module) => ({
    default: module.NewVibeSessionDialog,
  })),
);
const MissionCreateDialog = lazy(() =>
  import("@/components/missions/MissionCreateDialog").then((module) => ({
    default: module.MissionCreateDialog,
  })),
);

/**
 * The app's one and only view (Vibe v3): the Conductor SIDEBAR on the left
 * (collapsible ⌘B, resizable) and the fleet on the right — the agent-card
 * GRID by default, or one focused session (wide mode fills the window).
 * Dialogs that are only reachable from this view mount here too.
 *
 * Diff highlighting is loaded separately on the first expanded diff. Pierre
 * keeps one singleton worker pool across those lazily mounted renderers.
 */
export function VibeLayer() {
  const focused = useVibeUi((s) => s.stageMode === "session");
  const hasActive = useVibe((s) => !!(s.activeId && s.sessions[s.activeId]));
  const newSessionOpen = useVibeUi((state) => state.newSessionOpen);
  const missionCreateOpen = useVibeUi((state) => state.missionCreateOpen);
  const [newSessionRequested, setNewSessionRequested] = useState(newSessionOpen);
  useEffect(() => {
    if (newSessionOpen) setNewSessionRequested(true);
  }, [newSessionOpen]);

  // Normalize stale focus state: when the focused session vanishes (closed
  // from the grid/conductor, dropped by the per-project cap) the grid shows —
  // stageMode/wide must follow, or the NEXT card click would inherit a stale
  // wide=true (fullscreen jump) and the first ⎋ would be an invisible no-op.
  useEffect(() => {
    if (focused && !hasActive) useVibeUi.getState().backToFleet();
  }, [focused, hasActive]);

  return (
    <div className="flex h-full w-full min-h-0 bg-bg">
      <ConductorSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <PersistenceHealthBanner />
        {focused && hasActive ? (
          <Suspense fallback={<StageLoading />}>
            <FocusStage />
          </Suspense>
        ) : (
          <MissionWorkspace />
        )}
      </div>
      {(newSessionRequested || newSessionOpen) && (
        <Suspense
          fallback={(
            <LazyDialogLoading
              open={newSessionOpen}
              title="Opening new worker"
              message="Opening new worker…"
              onClose={() => useVibeUi.getState().setNewSessionOpen(false)}
            />
          )}
        >
          <NewVibeSessionDialog />
        </Suspense>
      )}
      {missionCreateOpen && (
        <Suspense
          fallback={(
            <LazyDialogLoading
              open={missionCreateOpen}
              title="Opening mission intake"
              message="Opening mission intake…"
              onClose={() => useVibeUi.getState().setMissionCreateOpen(false)}
            />
          )}
        >
          <MissionCreateDialog />
        </Suspense>
      )}
      <CloseSessionConfirm />
      <CloseProjectConfirm />
    </div>
  );
}

function LazyDialogLoading({
  open,
  title,
  message,
  onClose,
}: {
  open: boolean;
  title: string;
  message: string;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent className="max-w-[min(88vw,30rem)] p-0">
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">
          The requested interface is loading. Press Escape to cancel.
        </DialogDescription>
        <div
          role="status"
          aria-live="polite"
          className="flex h-24 items-center justify-center px-10"
        >
          <span aria-hidden className="mr-2 h-2 w-2 animate-pulse rounded-full bg-acc" />
          <span className="font-mono text-12 text-mut">{message}</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StageLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-0 flex-1 items-center justify-center bg-bg"
    >
      <span aria-hidden className="mr-2 h-2 w-2 animate-pulse rounded-full bg-acc" />
      <span className="font-mono text-12 text-mut">Opening worker…</span>
    </div>
  );
}
