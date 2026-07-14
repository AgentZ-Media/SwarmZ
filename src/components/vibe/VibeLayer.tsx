import { lazy, Suspense, useEffect, useState } from "react";
import { useVibe } from "@/lib/vibe/session-store";
import { useVibeUi } from "@/lib/vibe/ui-store";
import { ConductorSidebar } from "./ConductorSidebar";
import { FleetGrid } from "./FleetGrid";
import { PersistenceHealthBanner } from "@/components/PersistenceHealthBanner";
import {
  CloseProjectConfirm,
  CloseSessionConfirm,
} from "./CloseConfirmDialogs";

const FocusStage = lazy(() =>
  import("./FocusStage").then((module) => ({ default: module.FocusStage })),
);
const NewVibeSessionDialog = lazy(() =>
  import("./NewVibeSessionDialog").then((module) => ({
    default: module.NewVibeSessionDialog,
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
          <FleetGrid />
        )}
      </div>
      {(newSessionRequested || newSessionOpen) && (
        <Suspense fallback={<NewWorkerLoading />}>
          <NewVibeSessionDialog />
        </Suspense>
      )}
      <CloseSessionConfirm />
      <CloseProjectConfirm />
    </div>
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

function NewWorkerLoading() {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Opening new worker"
      className="fixed inset-0 z-50 flex bg-black/45"
    >
      <div
        role="status"
        aria-live="polite"
        className="m-auto flex h-24 w-[min(88vw,30rem)] items-center justify-center rounded-xl border border-line bg-panel shadow-2xl"
      >
        <span aria-hidden className="mr-2 h-2 w-2 animate-pulse rounded-full bg-acc" />
        <span className="font-mono text-12 text-mut">Opening new worker…</span>
      </div>
    </div>
  );
}
