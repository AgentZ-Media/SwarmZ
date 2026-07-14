import { useEffect } from "react";
import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import {
  DIFF_POOL_SIZE,
  DIFF_PRELOAD_LANGS,
  SWARMZ_DIFF_THEME,
} from "@/lib/vibe/diff-pierre";
import { useVibe } from "@/lib/vibe/session-store";
import { useVibeUi } from "@/lib/vibe/ui-store";
import { ConductorSidebar } from "./ConductorSidebar";
import { FleetGrid } from "./FleetGrid";
import { FocusStage } from "./FocusStage";
import { PersistenceHealthBanner } from "@/components/PersistenceHealthBanner";
import {
  CloseProjectConfirm,
  CloseSessionConfirm,
  NewVibeSessionDialog,
} from "./NewVibeSessionDialog";

// stable references — recreating these per render could tear down and
// re-initialize the whole worker pool on every focus/unfocus transition
const POOL_OPTIONS = {
  workerFactory: () => new DiffsWorker(),
  poolSize: DIFF_POOL_SIZE,
};
const HIGHLIGHTER_OPTIONS = {
  theme: SWARMZ_DIFF_THEME,
  preferredHighlighter: "shiki-js" as const,
  langs: [...DIFF_PRELOAD_LANGS],
};

/**
 * The app's one and only view (Vibe v3): the Conductor SIDEBAR on the left
 * (collapsible ⌘B, resizable) and the fleet on the right — the agent-card
 * GRID by default, or one focused session (wide mode fills the window).
 * Dialogs that are only reachable from this view mount here too.
 *
 * The @pierre/diffs worker pool wraps the whole layer: every DiffCard in
 * every transcript shares the same 2 highlight workers (shiki-js engine —
 * see lib/vibe/diff-pierre.ts for the WKWebView reasoning).
 */
export function VibeLayer() {
  const focused = useVibeUi(
    (s) => s.stageMode === "session",
  );
  const hasActive = useVibe((s) => !!(s.activeId && s.sessions[s.activeId]));

  // Normalize stale focus state: when the focused session vanishes (closed
  // from the grid/conductor, dropped by the per-project cap) the grid shows —
  // stageMode/wide must follow, or the NEXT card click would inherit a stale
  // wide=true (fullscreen jump) and the first ⎋ would be an invisible no-op.
  useEffect(() => {
    if (focused && !hasActive) useVibeUi.getState().backToFleet();
  }, [focused, hasActive]);

  return (
    <WorkerPoolContextProvider
      poolOptions={POOL_OPTIONS}
      highlighterOptions={HIGHLIGHTER_OPTIONS}
    >
      <div className="flex h-full w-full min-h-0 bg-bg">
        <ConductorSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <PersistenceHealthBanner />
          {focused && hasActive ? <FocusStage /> : <FleetGrid />}
        </div>
        <NewVibeSessionDialog />
        <CloseSessionConfirm />
        <CloseProjectConfirm />
      </div>
    </WorkerPoolContextProvider>
  );
}
